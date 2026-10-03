// Live Prime Agent smoke: the only proof stubs cannot give — a real pinned
// `prime-agent` binary accepting the config `aiand prime on` generates
// (models.json is JSON-schema-validated upstream, so schema drift breaks
// here first) and a headless `-p` round-trip through the loopback mock
// gateway.
//
// Run by CI after scripts/e2e.mjs (the build job installs the pinned
// release asset, digest-checked, at the version src/agents/prime/install.ts
// pins). No real gateway, no key: the loopback double
// serves /v1/models and /v1/chat/completions, per the repo rule that
// CLI-error coverage drives through the mock gateway.
//
// Requires: dist/index.js built, `prime-agent` on PATH. Exits non-zero on
// any failure.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, "dist", "index.js");

// One catalog model the double serves; aiand prime on renders it into
// models.json and `prime-agent model list` must list it back.
const SMOKE_MODEL = {
  id: "zai-org/glm-5.3",
  name: "GLM 5.3",
  object: "model",
  created: 1,
  owned_by: "zai-org",
  provider: "zai-org",
  context_window: 200000,
  capabilities: ["text", "vision", "tool_calling"],
  // Non-reasoning: the harness must not send a reasoning_effort the model
  // does not publish (the double echoes whatever arrived, so the assertion
  // below proves the field stayed absent).
  reasoning_efforts: null,
  reasoning_effort_default: null,
  description: null,
  currency: "usd",
  input_per_1m: "0.60",
  output_per_1m: "2.40",
  cached_input_per_1m: "0.10",
};

// Loopback gateway double in its own process (the CLI child blocks in
// execFileSync, so the double cannot live here). Serves the catalog and a
// chat-completions echo.
//
// Bespoke instead of test/mock-gateway.mjs: prime streams chat completions,
// and this double serves the SSE chunk + [DONE] dialect the binary's
// openai-completions path expects, while the shared double replies with a
// single JSON body.
const DOUBLE = `import { createServer } from "node:http";
const MODEL = ${JSON.stringify(SMOKE_MODEL)};
const server = createServer((req, res) => {
  if (req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [MODEL] }));
    return;
  }
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let model = "";
      let effort = "absent";
      try {
        const parsed = JSON.parse(raw);
        model = parsed.model ?? "";
        if (parsed.reasoning_effort != null) effort = String(parsed.reasoning_effort);
      } catch {}
      const content = "echo:" + model + ":effort=" + effort;
      const body = {
        id: "chatcmpl-smoke",
        object: "chat.completion",
        model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      // Prime streams: serve SSE the openai-completions dialect expects.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ ...body, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] }) + "\\n\\n");
      res.write("data: " + JSON.stringify({ ...body, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "\\n\\n");
      res.write("data: [DONE]\\n\\n");
      res.end();
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});
server.listen(0, "127.0.0.1", () => console.log("READY " + server.address().port));
`;

const S = mkdtempSync(join(tmpdir(), "aiand-prime-smoke-"));
let doubleChild;
let failed = false;

function fail(message) {
  process.stderr.write(`FAIL ${message}\n`);
  failed = true;
}

// The -p round-trip boots a background supervisor that survives the child.
// A leftover one wedges the next run (its worker roster answers the create
// with supervisor_generation_stale), so every run starts from a stopped
// daemon. Best-effort: absent or already dead is fine. Declared here so the
// finally can run it even when setup throws.
function stopDaemon() {
  try {
    execFileSync("prime-agent", ["shutdown", "--force"], {
      encoding: "utf8",
      timeout: 60_000,
      stdio: "ignore",
    });
  } catch {
    // no daemon to stop
  }
}

try {
  // Start the double and wait for its READY line.
  writeFileSync(join(S, "double.mjs"), DOUBLE);
  doubleChild = spawn(process.execPath, [join(S, "double.mjs")], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const baseUrl = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("smoke double did not start")), 15_000);
    doubleChild.stdout.on("data", (chunk) => {
      buf += String(chunk);
      const ready = buf.match(/READY (\d+)/);
      if (ready) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${ready[1]}`);
      }
    });
    doubleChild.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const home = join(S, "home");
  const cfg = join(S, "cfg");
  // The binary must read exactly the dir `aiand prime on` wired: the CLI
  // resolves it from AIAND_HOME, prime-agent from PRIME_AGENT_CODING_AGENT_DIR.
  const agentDir = join(home, ".prime", "agent");
  // The daemon socket pins INSIDE the sandbox: the shared per-uid default
  // ($TMPDIR/prime-agent-<uid>/daemon.sock) would collide with any ambient
  // daemon, whose worker roster carries a different generation — the headless
  // create then dies with `supervisor_generation_stale`.
  const daemonSocket = join(S, "daemon.sock");
  const env = {
    ...process.env,
    AIAND_HOME: home,
    AIAND_CONFIG_DIR: cfg,
    PRIME_AGENT_CODING_AGENT_DIR: agentDir,
    PRIME_AGENT_SESSION_DIR: join(agentDir, "sessions"),
    PRIME_AGENT_DAEMON_SOCKET: daemonSocket,
    AIAND_API_KEY: "sk-e2e-prime-smoke-key-000000000000000",
    AIAND_BASE_URL: baseUrl,
    NO_COLOR: "1",
    PATH: process.env.PATH,
  };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;

  stopDaemon();

  // 1. Wire with the real CLI.
  const on = JSON.parse(
    execFileSync(process.execPath, [DIST, "prime", "on", "--json"], { env, encoding: "utf8" }),
  );
  if (on.state === "on") process.stdout.write("PASS aiand prime on\n");
  else fail(`aiand prime on: ${JSON.stringify(on)}`);

  // 2. The real prime accepts our generated config (strict upstream JSON
  // schema) and lists our model.
  try {
    const listing = execFileSync("prime-agent", ["model", "list", "--no-session"], {
      env,
      encoding: "utf8",
      timeout: 120_000,
    });
    if (listing.includes("zai-org/glm-5.3"))
      process.stdout.write("PASS prime-agent model list lists the aiand model\n");
    else fail(`prime-agent model list output lacked the model:\n${listing}`);
  } catch (error) {
    fail(`prime-agent model list rejected the config: ${error.stderr ?? error.message}`);
  }

  // 3. Headless round-trip: a real request through the gateway dialect.
  try {
    const printed = execFileSync("prime-agent", ["--no-session", "-p", "Say hi"], {
      env,
      encoding: "utf8",
      timeout: 300_000,
    });
    if (printed.includes("echo:zai-org/glm-5.3:effort=absent"))
      process.stdout.write(
        "PASS prime-agent -p routes through the gateway with no reasoning_effort\n",
      );
    else fail(`prime-agent -p round-trip did not route through ai&:\n${printed}`);
  } catch (error) {
    fail(`prime-agent -p round-trip failed: ${error.stderr ?? error.message}`);
  }
} catch (error) {
  fail(String(error.stderr ?? error.message ?? error));
} finally {
  doubleChild?.kill();
  stopDaemon();
  rmSync(S, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
