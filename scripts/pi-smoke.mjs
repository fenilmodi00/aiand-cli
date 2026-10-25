// Live Pi smoke: the only proof stubs cannot give — a real pinned `pi`
// binary accepting the config `aiand pi on` generates (models.json is
// TypeBox-validated upstream, so schema drift breaks here first) and a
// headless --print round-trip through the loopback mock gateway.
//
// Run by CI after scripts/e2e.mjs (the build job installs the pinned
// @earendil-works/pi-coding-agent). No real gateway, no key: the loopback
// double serves /v1/models and /v1/chat/completions, per the repo rule that
// CLI-error coverage drives through the mock gateway.
//
// Requires: dist/index.js built, `pi` on PATH. Exits non-zero on any failure.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, "dist", "index.js");

// One catalog model the double serves; aiand pi on renders it into
// models.json and pi --list-models must list it back.
const SMOKE_MODEL = {
  id: "zai-org/glm-5.3",
  name: "GLM 5.3",
  object: "model",
  created: 1,
  owned_by: "zai-org",
  provider: "zai-org",
  context_window: 200000,
  capabilities: ["text", "vision", "tool_calling"],
  // Pi's default thinking level is medium. This model does not publish
  // medium, so Pi moves up to high. The double is lenient, but the shape
  // must stay honest: the request must not send medium.
  reasoning_efforts: ["low", "high", "max"],
  reasoning_effort_default: "max",
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
// Why bespoke instead of test/mock-gateway.mjs + withMockGateway: the smoke
// must prove the clamped level, so the catalog serves a reasoning model
// (reasoning_efforts low, high, max) the shared double has no equivalent of.
// And pi streams chat completions: this double serves
// the SSE chunk + [DONE] dialect pi's openai-completions path expects,
// while the shared double replies with a single JSON body.
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
      // Pi streams: serve SSE the openai-completions dialect expects.
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

const S = mkdtempSync(join(tmpdir(), "aiand-pi-smoke-"));
let doubleChild;
let failed = false;

function fail(message) {
  process.stderr.write(`FAIL ${message}\n`);
  failed = true;
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
  const env = {
    ...process.env,
    HOME: home,
    AIAND_HOME: home,
    AIAND_CONFIG_DIR: cfg,
    AIAND_API_KEY: "sk-e2e-pi-smoke-key-0000000000000000",
    AIAND_BASE_URL: baseUrl,
    // The real pi, never a stub. HOME points at the sandbox so pi reads
    // the config aiand pi on wrote (~/.pi/agent under it).
    PATH: process.env.PATH,
  };
  delete env.PI_CODING_AGENT_DIR;
  delete env.PI_CODING_AGENT_SESSION_DIR;

  // 1. Wire with the real CLI.
  const on = JSON.parse(
    execFileSync(process.execPath, [DIST, "pi", "on", "--json"], { env, encoding: "utf8" }),
  );
  if (on.state === "on") process.stdout.write("PASS aiand pi on\n");
  else fail(`aiand pi on: ${JSON.stringify(on)}`);

  // 2. The real pi accepts our generated config and lists our model.
  try {
    const listing = execFileSync("pi", ["--list-models"], {
      env: { ...env, NO_COLOR: "1" },
      encoding: "utf8",
      timeout: 120_000,
    });
    if (listing.includes("zai-org/glm-5.3"))
      process.stdout.write("PASS pi --list-models lists the aiand model\n");
    else fail(`pi --list-models output lacked the model:\n${listing}`);
  } catch (error) {
    fail(`pi --list-models rejected the config: ${error.stderr ?? error.message}`);
  }

  // 3. Headless round-trip: a real request through the gateway dialect.
  try {
    const printed = execFileSync(
      "pi",
      ["--print", "--provider", "aiand", "--model", "zai-org/glm-5.3", "Say hi"],
      { env: { ...env, NO_COLOR: "1" }, encoding: "utf8", timeout: 180_000 },
    );
    if (printed.includes("echo:zai-org/glm-5.3:effort=high"))
      process.stdout.write("PASS pi --print sends high, the next published level above medium\n");
    else fail(`pi --print round-trip did not send the clamped level:\n${printed}`);
  } catch (error) {
    fail(`pi --print round-trip failed: ${error.stderr ?? error.message}`);
  }
} catch (error) {
  fail(String(error.stderr ?? error.message ?? error));
} finally {
  doubleChild?.kill();
  rmSync(S, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
