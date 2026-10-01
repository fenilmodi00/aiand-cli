// Live OMP smoke: the only proof stubs cannot give — a real pinned `omp`
// binary accepting the config `aiand omp on` generates (models.yml is
// schema-validated upstream, so provider drift breaks here first), a
// headless -p round-trip through the loopback mock gateway, and `off`
// putting the seeded user files back byte-identical.
//
// Run by CI after scripts/e2e.mjs (the build job installs the pinned omp
// via the omp.sh installer). No real gateway, no key: the loopback double
// serves /v1/models and /v1/chat/completions, per the repo rule that
// CLI-error coverage drives through the mock gateway.
//
// Requires: dist/index.js built, `omp` on PATH. Exits non-zero on any failure.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, "dist", "index.js");

// One catalog model the double serves; aiand omp on pins it as
// modelRoles.default and the -p round-trip must route back to it.
const SMOKE_MODEL = {
  id: "zai-org/glm-5.3",
  name: "GLM 5.3",
  object: "model",
  created: 1,
  owned_by: "zai-org",
  provider: "zai-org",
  context_window: 200000,
  capabilities: ["text", "vision", "tool_calling"],
  // A reasoning model: omp sends reasoning_effort from its bundled effort
  // ladder for it, and the echo proves the value survived the round-trip.
  // The served shape stays identical to pi-smoke's.
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

const S = mkdtempSync(join(tmpdir(), "aiand-omp-smoke-"));
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
  // Seed the user's own omp files so `off` has real bytes to restore and
  // `on` has unrelated keys and comments to preserve.
  const ompAgentDir = join(home, ".omp", "agent");
  mkdirSync(ompAgentDir, { recursive: true });
  const ompModelsPath = join(ompAgentDir, "models.yml");
  const ompConfigPath = join(ompAgentDir, "config.yml");
  writeFileSync(
    ompModelsPath,
    "# user's own providers, kept by aiand\nproviders:\n  openai:\n    baseUrl: https://api.openai.com/v1\n    apiKey: sk-user-openai\n",
  );
  writeFileSync(
    ompConfigPath,
    "symbolPreset: unicode\nmodelRoles:\n  default: anthropic/claude-haiku-4-5\n",
  );
  const modelsBefore = readFileSync(ompModelsPath);
  const configBefore = readFileSync(ompConfigPath);

  const env = {
    ...process.env,
    HOME: home,
    AIAND_HOME: home,
    AIAND_CONFIG_DIR: cfg,
    AIAND_API_KEY: "sk-e2e-omp-smoke-key-0000000000000000",
    AIAND_BASE_URL: baseUrl,
    // The real omp, never a stub. HOME points at the sandbox so omp reads
    // the config aiand omp on wrote (~/.omp/agent under it).
    PATH: process.env.PATH,
  };
  delete env.PI_CODING_AGENT_DIR;
  delete env.PI_CODING_AGENT_SESSION_DIR;
  // omp renames its .omp root with PI_CONFIG_DIR: a contributor-exported
  // value would retarget the seeded files the byte comparisons below read.
  delete env.PI_CONFIG_DIR;

  // 1. Wire with the real CLI.
  const on = JSON.parse(
    execFileSync(process.execPath, [DIST, "omp", "on", "--json"], { env, encoding: "utf8" }),
  );
  if (on.state === "on") process.stdout.write("PASS aiand omp on\n");
  else fail(`aiand omp on: ${JSON.stringify(on)}`);

  // 2. The real omp accepts our generated models.yml and round-trips. Its
  // bundled ladder decides the effort, so any value proves the route.
  try {
    const printed = execFileSync(
      "omp",
      ["--model", "aiand/zai-org/glm-5.3", "--no-session", "-p", "Say hi"],
      { env: { ...env, NO_COLOR: "1" }, encoding: "utf8", timeout: 180_000 },
    );
    if (/echo:zai-org\/glm-5\.3:effort=\w+/.test(printed))
      process.stdout.write("PASS omp -p routes through the gateway\n");
    else fail(`omp -p round-trip did not echo the routed model:\n${printed}`);
  } catch (error) {
    fail(`omp -p round-trip failed: ${error.stderr ?? error.message}`);
  }

  // 3. Off puts the seeded files back byte-identical.
  const off = JSON.parse(
    execFileSync(process.execPath, [DIST, "omp", "off", "--json"], { env, encoding: "utf8" }),
  );
  if (off.state !== "off") fail(`aiand omp off: ${JSON.stringify(off)}`);
  else if (
    !modelsBefore.equals(readFileSync(ompModelsPath)) ||
    !configBefore.equals(readFileSync(ompConfigPath))
  )
    fail("aiand omp off did not restore the seeded files byte-identical");
  else process.stdout.write("PASS aiand omp off restores the seeded files byte-identical\n");
} catch (error) {
  fail(String(error.stderr ?? error.message ?? error));
} finally {
  doubleChild?.kill();
  rmSync(S, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
