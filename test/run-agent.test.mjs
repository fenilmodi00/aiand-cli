import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { withTestEnv } from "./helpers.mjs";

const execFileAsync = promisify(execFile);
const BIN = join(dirname(import.meta.dirname), "dist", "index.js");

// --- Stub-agent scaffolding ------------------------------------------------
// A temp bin dir holds shell stub scripts (chmod 0755) that dump the child
// env + argv to capture files and exit 42. The catalog cache is seeded so
// getCatalog never touches the network.

const STUB_SCRIPT = `#!/bin/sh
env > "$AIAND_CAPTURE.env"
printf '%s\\n' "$@" > "$AIAND_CAPTURE.args"
exit 42
`;

let home, cfg, binDir;
let stubCli;

function model(id) {
  return {
    id,
    object: "model",
    created: 1,
    owned_by: "fixture",
    provider: "fixture",
    context_window: 1000,
    capabilities: ["tools"],
    reasoning_efforts: null,
    reasoning_effort_default: null,
    description: null,
    currency: "usd",
    input_per_1m: "1",
    output_per_1m: "1",
    cached_input_per_1m: null,
  };
}

function plantStub(name) {
  const path = join(binDir, name);
  writeFileSync(path, STUB_SCRIPT, { mode: 0o755 });
  return path;
}

// A stub that always writes a marker file, so an invalid --model (which must
// never spawn the child) can be detected by the marker's absence.
const MARKER_STUB = `#!/bin/sh
touch "$AIAND_MARKER"
exit 42
`;
function plantMarkerStub(name) {
  const path = join(binDir, name);
  writeFileSync(path, MARKER_STUB, { mode: 0o755 });
  return path;
}

const env = withTestEnv("aiand-runagent-", (dir) => {
  home = join(dir, "home");
  cfg = join(dir, "cfg");
  binDir = join(dir, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(cfg, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  // Seed a fresh catalog cache so session launches never hit the network.
  writeFileSync(
    join(cfg, "model-catalog.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      baseUrl: "https://api.aiand.com",
      models: [model("aiand/glm-5.3"), model("aiand/other")],
    })
  );

  // One capture dir per subprocess run, created fresh inside each test.
  stubCli = (args, extraEnv, captureRoot) => {
    const envWithPaths = {
      AIAND_HOME: home,
      AIAND_CONFIG_DIR: cfg,
      AIAND_API_KEY: "sk-test-aiand",
      PATH: `${binDir}:${process.env.PATH}`,
      AIAND_CAPTURE: join(captureRoot, "capture"),
      ...extraEnv,
    };
    return execFileAsync("node", [BIN, "run-agent", ...args], {
      env: envWithPaths,
    }).then(
      () => ({ code: 0, stdout: "", stderr: "" }),
      (e) => ({ code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" })
    );
  };
});

describe("run-agent launcher", () => {
  test("claude: gateway env injected, stray ANTHROPIC_API_KEY cleared, exit 42 propagates", async () => {
    plantStub("claude");
    const capture = mkdtempSync(join(tmpdir(), "aiand-cap-"));
    try {
      const { code } = await stubCli(["claude", "--", "--version"], {}, capture);
      assert.equal(code, 42);

      const envText = readFileSync(join(capture, "capture.env"), "utf8");
      assert.match(envText, /ANTHROPIC_BASE_URL=https:\/\/api\.aiand\.com\n/);
      assert.match(envText, /ANTHROPIC_AUTH_TOKEN=sk-test-aiand\n/);
      // A stray key in the parent is cleared, never inherited intact.
      assert.doesNotMatch(envText, /ANTHROPIC_API_KEY=/);
      assert.match(readFileSync(join(capture, "capture.args"), "utf8"), /^--version\n/);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("claude: parent ANTHROPIC_API_KEY is exported but cleared in the child", async () => {
    plantStub("claude");
    const capture = mkdtempSync(join(tmpdir(), "aiand-cap-"));
    try {
      await stubCli(["claude", "status"], { ANTHROPIC_API_KEY: "sk-leak" }, capture);
      const envText = readFileSync(join(capture, "capture.env"), "utf8");
      assert.doesNotMatch(envText, /ANTHROPIC_API_KEY=/);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("codex: -c provider args + AIAND_CODEX_AUTH_TOKEN env", async () => {
    plantStub("codex");
    const capture = mkdtempSync(join(tmpdir(), "aiand-cap-"));
    try {
      const { code } = await stubCli(["codex"], {}, capture);
      assert.equal(code, 42);

      const args = readFileSync(join(capture, "capture.args"), "utf8").trim().split("\n");
      assert.ok(args.includes('model_provider="aiand"'));
      assert.ok(args.some((a) => a.startsWith('model="')));
      assert.ok(args.some((a) => a.startsWith('model_providers.aiand.base_url=')));
      assert.ok(args.some((a) => a.startsWith('model_providers.aiand.env_key=')));

      const envText = readFileSync(join(capture, "capture.env"), "utf8");
      assert.match(envText, /AIAND_CODEX_AUTH_TOKEN=sk-test-aiand\n/);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("-- passthrough preserves flags and order verbatim", async () => {
    plantStub("claude");
    const capture = mkdtempSync(join(tmpdir(), "aiand-cap-"));
    try {
      await stubCli(["claude", "--", "--version", "--flag", "x"], {}, capture);
      const args = readFileSync(join(capture, "capture.args"), "utf8").trim().split("\n");
      assert.deepEqual(args, ["--version", "--flag", "x"]);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("non-flag positional before -- is passthrough too", async () => {
    plantStub("claude");
    const capture = mkdtempSync(join(tmpdir(), "aiand-cap-"));
    try {
      await stubCli(["claude", "--model", "aiand/glm-5.3", "--", "extra", "--args"], {}, capture);
      const args = readFileSync(join(capture, "capture.args"), "utf8").trim().split("\n");
      assert.deepEqual(args, ["extra", "--args"]);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("no agent name -> CliError usage hint", async () => {
    const { code, stderr } = await stubCli([], {}, env.dir);
    assert.equal(code, 1);
    assert.match(stderr, /run-agent needs a coding agent name/i);
    assert.match(stderr, /aiand run-agent claude -- --version/i);
  });

  test("unknown agent -> CliError listing agents", async () => {
    const { code, stderr } = await stubCli(["not-an-agent"], {}, env.dir);
    assert.equal(code, 1);
    assert.match(stderr, /Unknown agent "not-an-agent"/);
    assert.match(stderr, /Agents:/);
  });

  test("invalid --model -> exit 1 with valid-ids hint, child never spawned", async () => {
    // claude stub writes a marker file only when actually spawned; an invalid
    // model must fail before spawn, so the marker never appears.
    plantMarkerStub("claude");
    const capture = mkdtempSync(join(tmpdir(), "aiand-cap-"));
    const marker = join(capture, "marker");
    try {
      const { code, stderr } = await stubCli(
        ["claude", "--model", "nope"],
        { AIAND_MARKER: marker },
        capture
      );
      assert.equal(code, 1);
      assert.match(stderr, /--model "nope" is not in the catalog/);
      assert.match(stderr, /Valid ids: aiand\/glm-5.3, aiand\/other/);
      assert.throws(() => readFileSync(marker, "utf8"), /ENOENT/);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("registered agent without sessionLaunch -> exit 1 with permanent-wiring hint", async () => {
    // Cursor is a registered adapter with no sessionLaunch.
    plantStub("cursor");
    const capture = mkdtempSync(join(tmpdir(), "aiand-cap-"));
    try {
      const { code, stderr } = await stubCli(["cursor"], {}, capture);
      assert.equal(code, 1);
      assert.match(stderr, /does not support session launches/);
      assert.match(stderr, /Run `aiand cursor on` for permanent wiring/);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("missing binary -> 127 with install hint", async () => {
    // Opencode is registered but its binary is not on the stripped PATH (no
    // stub planted; the system has no opencode), so detect() misses -> 127 +
    // install hint. Using a real AGENTS member keeps this hermetic.
    const capture = mkdtempSync(join(tmpdir(), "aiand-cap-"));
    try {
      const { code, stderr } = await stubCli(["opencode"], { PATH: process.env.PATH }, capture);
      assert.equal(code, 127);
      assert.match(stderr, /OpenCode is not installed/);
      assert.match(stderr, /Install it with:/);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("opencode: OPENCODE_CONFIG_CONTENT carries provider.aiand config", async () => {
    // opencode is registered and its sessionLaunch emits OPENCODE_CONFIG_CONTENT.
    // When --model is omitted the launcher resolves a default, so a concrete
    // aiand/<id> root ref appears.
    plantStub("opencode");
    const capture = mkdtempSync(join(tmpdir(), "aiand-cap-"));
    try {
      const { code } = await stubCli(["opencode"], {}, capture);
      assert.equal(code, 42);
      const envText = readFileSync(join(capture, "capture.env"), "utf8");
      const match = envText.match(/^OPENCODE_CONFIG_CONTENT=(.*)$/m);
      assert.ok(match, "OPENCODE_CONFIG_CONTENT in child env");
      const config = JSON.parse(match[1]);
      assert.ok(config.provider?.aiand, "provider.aiand present");
      assert.match(config.provider.aiand.options?.baseURL, /^https:\/\/api\.aiand\.com/);
      assert.ok(config.model, "a concrete model root ref resolved");
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });
});