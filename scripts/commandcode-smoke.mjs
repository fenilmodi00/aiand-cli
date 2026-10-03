// Live Command Code smoke: the only proof stubs cannot give — a real
// pinned `cmd` binary accepting the config `aiand commandcode on`
// generates (the providers.json row, the auth.json credential and the
// config.json model pin are all read back by the real binary) and a
// headless -p round-trip through the loopback gateway double.
//
// Run by CI after scripts/e2e.mjs (the build job installs the pinned
// command-code). No real gateway, no key: the loopback double serves
// /v1/models and /v1/chat/completions, per the repo rule that
// CLI-error coverage drives through the mock gateway.
//
// Requires: dist/index.js built, `cmd` on PATH. Exits non-zero on any
// failure.
//
// Observed against command-code 1.74.0 (this script is the record):
//   - `cmd --list-models` reads providers.json and prints an
//     "ai& (byok)" section listing the row's models as the qualified
//     `aiand/<id>` — with no network, so the double is never dialed.
//     The bare id also appears in the built-in catalog, so the
//     qualified form below is the proof our row was accepted.
//   - The `-p` headless gate checks COMMAND_CODE_API_KEY before any
//     provider request; the request key itself comes from the
//     auth.json aiand credential (sent as Bearer to the double).
//   - DO_NOT_TRACK=1 keeps the gate's own telemetry (whoami/
//     fingerprint to Command Code's gateway) off, so the only
//     network here is loopback.
//   - A headless run rewrites nothing: providers.json stays
//     byte-identical after the round-trip.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, "dist", "index.js");

// One catalog model the double serves; aiand commandcode on renders
// it into the providers.json row and cmd --list-models must list it
// back, qualified, in the byok section.
const SMOKE_MODEL = {
  id: "zai-org/glm-5.3",
  name: "GLM 5.3",
  object: "model",
  created: 1,
  owned_by: "zai-org",
  provider: "zai-org",
  capabilities: ["text", "vision", "tool_calling"],
  reasoning_efforts: null,
  reasoning_effort_default: null,
  description: null,
  currency: "usd",
  input_per_1m: "0.60",
  output_per_1m: "2.40",
  cached_input_per_1m: "0.10",
};

// Loopback gateway double in its own process (the CLI child blocks in
// execFileSync, so the double cannot live here). Serves the catalog
// and a chat-completions echo.
//
// Why bespoke instead of test/mock-gateway.mjs + withMockGateway: the
// smoke must prove the openai-completions streaming dialect, so the
// double replies with the SSE chunk + [DONE] sequence cmd's
// openai-completions path expects, while the shared double replies
// with a single JSON body.
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
      try {
        model = JSON.parse(raw).model ?? "";
      } catch {}
      const content = "echo:" + model;
      const body = {
        id: "chatcmpl-smoke",
        object: "chat.completion",
        model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      // Command Code streams: serve SSE the openai-completions dialect expects.
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

const S = mkdtempSync(join(tmpdir(), "aiand-commandcode-smoke-"));
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
    AIAND_API_KEY: "sk-e2e-commandcode-smoke-key-000000000",
    AIAND_BASE_URL: baseUrl,
    // The real cmd, never a stub. HOME points at the sandbox so cmd
    // reads the config aiand commandcode on wrote (~/.commandcode
    // under it).
    PATH: process.env.PATH,
  };
  delete env.COMMAND_CODE_API_KEY;

  // 1. Wire with the real CLI.
  const on = JSON.parse(
    execFileSync(process.execPath, [DIST, "commandcode", "on", "--json"], {
      env,
      encoding: "utf8",
    }),
  );
  if (on.state === "on") process.stdout.write("PASS aiand commandcode on\n");
  else fail(`aiand commandcode on: ${JSON.stringify(on)}`);

  const providersPath = join(home, ".commandcode", "providers.json");
  const providersAfterOn = readFileSync(providersPath);

  // 2. The real cmd accepts our generated providers.json and lists
  // our model, qualified, in its byok section.
  try {
    const listing = execFileSync("cmd", ["--list-models"], {
      env: { ...env, NO_COLOR: "1" },
      encoding: "utf8",
      timeout: 120_000,
    });
    if (listing.includes("aiand/zai-org/glm-5.3"))
      process.stdout.write("PASS cmd --list-models lists the aiand model\n");
    else fail(`cmd --list-models output lacked the aiand model:\n${listing}`);
  } catch (error) {
    fail(`cmd --list-models rejected the config: ${error.stderr ?? error.message}`);
  }

  // 3. Headless round-trip: a real request through the gateway
  // dialect. COMMAND_CODE_API_KEY passes cmd's -p gate (the
  // documented Codex-style exception: no file the launcher writes
  // holds a key cmd accepts); DO_NOT_TRACK=1 keeps the gate's
  // telemetry from fingerprinting the key to Command Code's gateway.
  try {
    const printed = execFileSync("cmd", ["-p", "Say hi"], {
      env: {
        ...env,
        NO_COLOR: "1",
        COMMAND_CODE_API_KEY: "sk-e2e-commandcode-smoke-key-000000000",
        DO_NOT_TRACK: "1",
      },
      encoding: "utf8",
      timeout: 180_000,
    });
    if (printed.includes("echo:zai-org/glm-5.3"))
      process.stdout.write("PASS cmd -p routes through the gateway\n");
    else fail(`cmd -p round-trip did not reach the double:\n${printed}`);
  } catch (error) {
    fail(`cmd -p round-trip failed: ${error.stderr ?? error.message}`);
  }

  // 4. cmd rewrote nothing: the provider row is byte-identical after
  // a real headless run (unknown keys survive cmd's own writers).
  if (providersAfterOn.equals(readFileSync(providersPath)))
    process.stdout.write("PASS cmd leaves providers.json untouched\n");
  else fail("cmd rewrote providers.json during the headless run");
} catch (error) {
  fail(String(error.stderr ?? error.message ?? error));
} finally {
  doubleChild?.kill();
  rmSync(S, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
