// Standalone test double for the gateway's identity + token + catalog +
// chat-completions endpoints, run as its OWN process by test helpers via
// withMockGateway. It must be a separate process (not an in-test-process
// server) because specs drive the CLI with execFile, and a shared local
// server keeps the child from hanging on a blocked parent event loop. Zero
// dependencies, node:http only.
//
// Route selection is by path prefix so each test picks a behavior through
// AIAND_BASE_URL (the client builds URLs as baseUrl + path, so a prefix in
// the base URL routes here):
//   /stub/429/*          every identity endpoint answers 429 with Retry-After
//                        + X-RateLimit-Policy headers.
//   /stub/401/*          every identity endpoint answers 401.
//   /stub/401-then-200/* identity endpoints 401 unknown keys but 200 the
//                        rotated key; POST /auth/device/token mints it.
//   /stub/500/*          every endpoint answers 500 (gateway outage).
//   /stub/two-orgs/*     /api/orgs lists two Orgs (First Org, Second Org).
//   /stub/vision-catalog/* /v1/models serves one vision + one text-only model.
//   /stub/logs-window/*  /logs serves three wire-format rows (2 inside the
//                        last 20 minutes, one 2h old) for windowed --verify.
//   /stub/logs-window-drift/* the same, with win-0001 carrying 100 extra
//                        output tokens — a real in-window divergence.
//   (no prefix)          happy path: 200 identity + orgs.
//
// Response shapes match src/api/account.ts (/api/user, /api/orgs) and
// src/api/device.ts rotateTokens (/auth/device/token) exactly, and the 429
// headers match src/api/client.ts HEADERS.RATE_LIMIT_POLICY plus Retry-After.
// /v1/models returns a small catalog that includes the curated preferred
// default (zai-org/glm-5.3). POST /v1/chat/completions echoes the request
// model so run/chat default-resolution tests can assert what the CLI sent.
//
// Standalone use: `node test/mock-gateway.mjs --port 0` prints one JSON line
// {"port":<actual>} on stdout and serves until killed.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const NEW_ACCESS = "sk-new-mock-token";
const NEW_REFRESH = "rt-new-mock-token";

const HAPPY_USER = { id: "u1", email: "happy@example.com" };
const HAPPY_ORGS = [{ id: "org_1", name: "Happy Org" }];
const REFRESH_USER = { id: "u1", email: "refreshed@example.com" };
const REFRESH_ORGS = [{ id: "org_1", name: "Refreshed Org" }];
const TWO_ORGS = [
  { id: "org_1", name: "First Org" },
  { id: "org_2", name: "Second Org" },
];

function catalogModel(id, capabilities = ["tools"]) {
  return {
    id,
    name: id,
    object: "model",
    created: 0,
    owned_by: "aiand",
    provider: "aiand",
    context_window: 128000,
    capabilities,
    reasoning_efforts: null,
    reasoning_effort_default: null,
    description: null,
    currency: "usd",
    input_per_1m: "1",
    output_per_1m: "1",
    cached_input_per_1m: null,
  };
}

// openai/gpt-5 first so a wrong "first catalog entry" default is distinguishable
// from resolveDefault's curated preference for zai-org/glm-5.3.
const CATALOG = [
  catalogModel("openai/gpt-5"),
  catalogModel("zai-org/glm-5.3"),
  catalogModel("deepseek-ai/deepseek-v4-flash"),
];

const VISION_CATALOG = [
  catalogModel("vendor/vision-model", ["vision", "tool_calling"]),
  catalogModel("vendor/text-model", ["tool_calling"]),
];

// #96: rows served by the `logs-window` scenarios. `null` until the first
// /logs request builds them, so one mock process serves one consistent
// fixture across its sync + verify calls.
let WINDOW_ROWS = null;
function buildWindowRows() {
  // The gateway's verbatim wire format (space separator, `+00` offset) —
  // the exact shape the #86 store normalization and the OBS-BF-11 remote
  // filter both have to parse.
  const wireFormat = (date) =>
    `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 23)}+00`;
  const ago = (ms) => wireFormat(new Date(Date.now() - ms));
  const row = (id, created_at, input_tokens, output_tokens, cost) => ({
    id,
    model: "test/model",
    api_key: "sk-abcd...1234",
    status_code: 200,
    ttft_ms: 120,
    latency_ms: 1_400,
    input_tokens,
    output_tokens,
    cached_tokens: 0,
    cost,
    currency: "usd",
    created_at,
  });
  return [
    row("win-0001", ago(5 * 60_000), 1_000, 300, "0.0042"),
    row("win-0002", ago(15 * 60_000), 2_000, 500, "0.0100"),
    // Outside a 20-minute verify window: exercises the remote-side filter.
    row("win-0003", ago(2 * 3_600_000), 4_000, 700, "0.0200"),
  ];
}

function reply(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function reply429(res) {
  reply(
    res,
    429,
    { error: "rate_limited", error_description: "Too many requests." },
    { "Retry-After": "7", "X-RateLimit-Policy": "burst;w=60" },
  );
}

function reply401(res) {
  reply(res, 401, { error: "unauthorized" });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

/** A client that aborts mid-body rejects readBody; the reply was never
 * going out, so swallow the rejection instead of crashing the mock. */
function handleBody(req, fn) {
  readBody(req)
    .then(fn)
    .catch(() => {});
}

/** Split an optional /stub/<scenario> prefix off the pathname. */
function splitScenario(pathname) {
  const parts = pathname.split("/");
  if (parts[1] === "stub" && parts[2]) {
    const rest = `/${parts.slice(3).join("/")}`;
    return { scenario: parts[2], rest: rest === "/" ? "/" : rest };
  }
  return { scenario: "happy", rest: pathname };
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const { scenario, rest } = splitScenario(url.pathname);

  if (scenario === "500") return reply(res, 500, { error: "gateway is down" });

  if (rest === "/api/user" || rest === "/api/orgs") {
    const isUser = rest === "/api/user";
    if (scenario === "429") return reply429(res);
    if (scenario === "401") return reply401(res);
    if (scenario === "401-then-200") {
      // Unknown keys are rejected; the rotated key succeeds. Both endpoints
      // check so the CLI's parallel user+orgs fetch converges after refresh.
      if (req.headers.authorization === `Bearer ${NEW_ACCESS}`) {
        return reply(res, 200, isUser ? REFRESH_USER : REFRESH_ORGS);
      }
      return reply401(res);
    }
    if (scenario === "two-orgs") return reply(res, 200, isUser ? HAPPY_USER : TWO_ORGS);
    return reply(res, 200, isUser ? HAPPY_USER : HAPPY_ORGS);
  }

  if (rest === "/auth/device/token" && req.method === "POST") {
    if (scenario === "429") return reply429(res);
    if (scenario === "401") return reply401(res);
    // Token rotation: always mint the same key so concurrent refresh retries
    // (the CLI fires user+orgs in parallel) converge on one credential.
    handleBody(req, () => {
      if (res.writableEnded) return;
      reply(res, 200, {
        access_token: NEW_ACCESS,
        refresh_token: NEW_REFRESH,
        token_type: "Bearer",
        expires_in: 2592000,
      });
    });
    return;
  }

  if (rest === "/logs") {
    if (scenario === "logs-404") return reply(res, 404, { error: "not_found" });
    // #63: the accuracy gate verifies against /logs, so the 401 stub must
    // cover it too (a gateway auth failure must never verify as green).
    if (scenario === "401") return reply401(res);
    // #94: the gateway's paired-cursor contract violation, verbatim from the
    // raw probes. `logs-400` always rejects /logs with it (for driving the
    // error surface); `logs-400-pair` rejects only requests carrying exactly
    // one of after/after_id (the real contract shape).
    if (scenario === "logs-400") {
      return reply(res, 400, { error: "after and after_id must be sent together" });
    }
    if (scenario === "logs-400-pair") {
      const after = url.searchParams.get("after");
      const afterId = url.searchParams.get("after_id");
      if (Boolean(after) !== Boolean(afterId)) {
        return reply(res, 400, { error: "after and after_id must be sent together" });
      }
      return reply(res, 200, { data: [], has_more: false, next_after: null, next_after_id: null });
    }
    // #94: the pinned /logs semantics, probed raw on 2026-10-27 — newest-first
    // always, `after` an exclusive floor, `after_id` only breaking ties at the
    // anchor timestamp, and after/after_id required together. Rows come from
    // the JSON file named by AIAND_MOCK_LOG_FILE (gateway LogEntry shape, any
    // order — served newest-first); re-read per request so tests can land new
    // traffic between syncs by rewriting the file.
    if (scenario === "logs-pinned") {
      let rows = [];
      try {
        const file = process.env.AIAND_MOCK_LOG_FILE;
        rows = JSON.parse(file ? readFileSync(file, "utf8") : "[]");
      } catch {
        rows = [];
      }
      // Newest-first by INSTANT, not text: wire-format rows (`… …+00`, space
      // separator) must order above same-day ISO rows, exactly as the real
      // gateway orders them — a text sort puts `' '` before `'T'` and
      // misorders the burst that pins the #94 early-stop fix.
      const instant = (e) => Date.parse(e.created_at.replace(" ", "T").replace(/\+00$/, "Z"));
      const newestFirst = [...rows].sort((a, b) =>
        instant(a) < instant(b) ? 1 : instant(a) > instant(b) ? -1 : b.id.localeCompare(a.id),
      );
      const after = url.searchParams.get("after");
      const afterId = url.searchParams.get("after_id");
      if (Boolean(after) !== Boolean(afterId)) {
        return reply(res, 400, { error: "after and after_id must be sent together" });
      }
      let remaining = newestFirst;
      if (after) {
        // Cursor semantics: (after, after_id) names the LAST row served; the
        // next page continues downward — strictly older rows, with after_id
        // breaking ties at exactly the anchor timestamp. Compared as
        // instants, for the same wire-vs-ISO reason as the sort above.
        const afterMs = Date.parse(after.replace(" ", "T").replace(/\+00$/, "Z"));
        remaining = newestFirst.filter((e) => {
          const ms = instant(e);
          return ms < afterMs || (ms === afterMs && afterId !== null && e.id < afterId);
        });
      }
      const limit = Math.max(0, Math.min(100, Number(url.searchParams.get("limit") ?? 100)));
      const data = remaining.slice(0, limit);
      const last = data[data.length - 1];
      const hasMore = remaining.length > data.length;
      return reply(res, 200, {
        data,
        has_more: hasMore,
        next_after: hasMore && last ? last.created_at : null,
        next_after_id: hasMore && last ? last.id : null,
      });
    }
    // #96: wire-format rows for windowed `usage --verify` — two inside the
    // last 20 minutes, one 2h old. Built ONCE on first request so the sync
    // and the verify fetch see identical created_at values (fresh timestamps
    // per request would slide past the sync watermark and double-count).
    if (scenario === "logs-window" || scenario === "logs-window-drift") {
      if (WINDOW_ROWS === null) WINDOW_ROWS = buildWindowRows();
      const data =
        scenario === "logs-window-drift"
          ? WINDOW_ROWS.map((r) =>
              r.id === "win-0001" ? { ...r, output_tokens: r.output_tokens + 100 } : r,
            )
          : WINDOW_ROWS;
      return reply(res, 200, { data, has_more: false, next_after: null, next_after_id: null });
    }
    return reply(res, 200, { data: [], has_more: false, next_after: null, next_after_id: null });
  }

  if (rest === "/v1/models") {
    if (scenario === "429") return reply429(res);
    if (scenario === "401") return reply401(res);
    if (scenario === "catalog-down") return reply(res, 500, { error: "catalog_unavailable" });
    if (scenario === "vision-catalog")
      return reply(res, 200, { object: "list", data: VISION_CATALOG });
    return reply(res, 200, { object: "list", data: CATALOG });
  }

  if (rest === "/v1/chat/completions" && req.method === "POST") {
    if (scenario === "429") return reply429(res);
    if (scenario === "401") return reply401(res);
    // catalog-down still serves completions so a configured profile model can send.
    handleBody(req, (raw) => {
      if (res.writableEnded) return;
      let model = "";
      try {
        model = JSON.parse(raw).model ?? "";
      } catch {
        model = "";
      }
      reply(res, 200, {
        id: "chatcmpl-mock",
        object: "chat.completion",
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: `echo:${model}` },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    });
    return;
  }

  reply(res, 404, { error: "not found" });
});

let port = 0;
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i] ?? "";
  if (arg === "--port") {
    const raw = process.argv[i + 1] ?? "";
    port = Number(raw);
    if (!/^\d+$/.test(raw) || port < 0 || port > 65535) {
      process.stderr.write(`mock-gateway: invalid --port value: ${raw}\n`);
      process.exit(1);
    }
    i += 1;
  } else if (arg.startsWith("--port=")) {
    const raw = arg.slice("--port=".length);
    port = Number(raw);
    if (!/^\d+$/.test(raw) || port < 0 || port > 65535) {
      process.stderr.write(`mock-gateway: invalid --port value: ${raw}\n`);
      process.exit(1);
    }
  }
}

server.on("error", (error) => {
  process.stderr.write(`mock-gateway: listen failed: ${error.message}\n`);
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actual = address && typeof address === "object" ? address.port : port;
  process.stdout.write(`${JSON.stringify({ port: actual })}\n`);
});
