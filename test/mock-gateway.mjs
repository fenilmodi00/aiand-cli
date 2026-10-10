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
//   /stub/hung-logs/*    /logs accepts the request and never replies; every
//                        other route behaves as the happy path, so the
//                        footer fetch must abort for the CLI to exit.
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
    if (scenario === "hung-logs") return; // accept the request, never reply
    if (scenario === "logs-404") return reply(res, 404, { error: "not_found" });
    if (scenario === "session-usage") {
      // Footer fixture: one entry a minute before "now" (must be filtered
      // out client-side) and one at request time (must be summed). The
      // query check pins the bounded single-page fetch (range + limit).
      if (url.searchParams.get("range") !== "1h" || url.searchParams.get("limit") !== "100") {
        return reply(res, 500, { error: "unexpected logs query" });
      }
      const now = Date.now();
      const entry = (id, input_tokens, output_tokens, cost, created_at) => ({
        id,
        model: "aiand/glm-5.3",
        api_key: "sk-test",
        status_code: 200,
        ttft_ms: null,
        latency_ms: null,
        input_tokens,
        output_tokens,
        cached_tokens: 10,
        cost,
        currency: "usd",
        created_at,
      });
      return reply(res, 200, {
        data: [
          entry("log-old", 999999, 888888, "9.9999", new Date(now - 60_000).toISOString()),
          entry("log-new", 1000, 200, "0.0123", new Date(now).toISOString()),
        ],
        has_more: false,
        next_after: null,
        next_after_id: null,
      });
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
