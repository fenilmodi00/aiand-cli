import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdtempSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Load the registry once at module scope (it starts empty and only mutates via
// registerAgent) so the adapter-dependent dispatch skip is decided before any
// test runs. The root wires claude/codex into AGENTS after this wave; until
// then those subprocess cases are skipped.
const registry = await import("../dist/agents/registry.js");
const ADAPTERS_WIRED = registry.AGENTS.length > 0;

// --- Fixture adapter ---------------------------------------------------------
// A minimal AgentAdapter the engine exercises against a temp AIAND_HOME. The
// registry stays empty here (claude/codex are wired by the root after their
// adapters land), so the engine tests call engine functions directly and the
// subprocess tests only cover registry-independent paths.

function makeFixture(home) {
  const file = () => join(home, ".fixture", "config.json");
  return {
    id: "fixture-agent",
    label: "Fixture Agent",
    bin: "fixture-agent",
    install: { command: "npm i -g fixture-agent", url: "https://example.com/fixture" },
    detect: () => ({ installed: true, path: "/usr/bin/fixture-agent" }),
    managedFiles: () => [file()],
    probe: async () => {
      try {
        const cfg = JSON.parse(readFileSync(file(), "utf8"));
        return {
          active: cfg.aiand === true,
          foreignTool: cfg.foreign ?? null,
          model: cfg.aiand ? cfg.model ?? null : null,
        };
      } catch {
        return { active: false, foreignTool: null, model: null };
      }
    },
    enable: async (input) => {
      mkdirSync(dirname(file()), { recursive: true });
      writeFileSync(file(), JSON.stringify({ aiand: true, model: input.model }));
      return { model: input.model, filesWritten: [file()] };
    },
    disable: async () => {},
  };
}

// --- Engines + shared temp env ------------------------------------------------
let eng;
let dir, home, cfg, bin;
const originalEnv = { ...process.env };
const SPY_ROOT = tmpdir();

before(async () => {
  dir = mkdtempSync(join(SPY_ROOT, "aiand-dispatch-"));
  home = join(dir, "home");
  cfg = join(dir, "cfg");
  mkdirSync(home, { recursive: true });
  process.env.AIAND_HOME = home;
  process.env.AIAND_CONFIG_DIR = cfg;
  process.env.AIAND_API_KEY = "sk-test-not-real";
  process.env.AIAND_BASE_URL = "https://fixture.test";

  // Seed a fresh catalog cache so agentOn never touches the network.
  const model = (id, price) => ({
    id,
    name: id,
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
    input_per_1m: price,
    output_per_1m: price,
    cached_input_per_1m: null,
  });
  mkdirSync(cfg, { recursive: true });
  writeFileSync(
    join(cfg, "model-catalog.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      baseUrl: "https://fixture.test",
      models: [model("zai-org/glm-5.3", "1"), model("other/model", "2")],
    })
  );

  eng = await import("../dist/agents/engine.js");
  bin = join(dirname(import.meta.dirname), "dist", "index.js");
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = originalEnv;
});

// --- Subprocess dispatch tests (built dist/index.js) --------------------------
// Run FIRST, while the in-process registry is still empty, so the skip decision
// here reflects a fresh build (the root wires claude/codex into AGENTS later).

const runCli = async (args, env) => {
  try {
    const { stdout, stderr } = await execFileAsync("node", [bin, ...args], {
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};

describe("dispatch subprocess", () => {
  test("unknown command -> 127 with a suggestion", async () => {
    const spy = mkdtempSync(join(SPY_ROOT, "aiand-spy-"));
    try {
      const { code, stderr } = await runCli(["sttaus"], {
        AIAND_HOME: join(spy, "h"),
        AIAND_CONFIG_DIR: join(spy, "c"),
      });
      assert.equal(code, 127);
      assert.match(stderr, /Did you mean .*status/);
    } finally {
      rmSync(spy, { recursive: true, force: true });
    }
  });

  test("unknown agent noun -> 127", async () => {
    const spy = mkdtempSync(join(SPY_ROOT, "aiand-spy-"));
    try {
      const { code, stderr } = await runCli(["not-an-agent"], {
        AIAND_HOME: join(spy, "h"),
        AIAND_CONFIG_DIR: join(spy, "c"),
      });
      assert.equal(code, 127);
      assert.match(stderr, /Unknown command/);
    } finally {
      rmSync(spy, { recursive: true, force: true });
    }
  });

  // Adapter-dependent dispatch: routes to the claude adapter once the root
  // wires claude/codex into AGENTS. Until then AGENTS is empty and the noun
  // falls through to unknown-command 127, so the case is skipped.
  if (ADAPTERS_WIRED) {
    test("claude noun dispatches to the claude adapter, not unknown-command", async () => {
      const spy = mkdtempSync(join(SPY_ROOT, "aiand-spy-"));
      try {
        // `status --json` needs no session; when wired it returns agent status
        // JSON (exit 0); when unwired it would be unknown-command (127).
        const r = await runCli(["claude", "status", "--json"], {
          AIAND_HOME: join(spy, "h"),
          AIAND_CONFIG_DIR: join(spy, "c"),
        });
        assert.notEqual(r.code, 127);
        assert.ok(JSON.parse(r.stdout).agent);
      } finally {
        rmSync(spy, { recursive: true, force: true });
      }
    });
  } else {
    test.skip("claude case skipped: AGENTS empty until root wires adapters");
  }

  test("aiand init --all with no detectable agents is friendly and exits 0", async () => {
    const spy = mkdtempSync(join(SPY_ROOT, "aiand-spy-"));
    try {
      // PATH holds only node's own directory: the registry now ships
      // claude/codex (real adapters), but `which` cannot resolve there, so
      // detection finds nothing and init has nothing to wire.
      const { code, stdout } = await runCli(["init", "--all"], {
        AIAND_HOME: join(spy, "h"),
        AIAND_CONFIG_DIR: join(spy, "c"),
        PATH: dirname(process.execPath),
      });
      assert.equal(code, 0);
      assert.match(stdout, /No coding agents detected/);
    } finally {
      rmSync(spy, { recursive: true, force: true });
    }
  });

  test("aiand status --json has the {auth, agents} shape", async () => {
    const spy = mkdtempSync(join(SPY_ROOT, "aiand-spy-"));
    try {
      const env = { ...process.env };
      // Parent harness sets AIAND_API_KEY; null it out so the child takes the
      // signed-out path (openSession treats an empty/absent key as unset).
      env.AIAND_API_KEY = "";
      const { code, stdout } = await runCli(
        ["status", "--json"],
        { ...env, AIAND_HOME: join(spy, "h"), AIAND_CONFIG_DIR: join(spy, "c") }
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.ok(parsed.auth && typeof parsed.auth === "object");
      assert.ok(Array.isArray(parsed.agents));
    } finally {
      rmSync(spy, { recursive: true, force: true });
    }
  });
});

// --- Engine-level tests (temp env, direct engine calls) ----------------------

function cleanFixture() {
  // The engine's backup manifest outlives the config file between tests —
  // clear both so each test starts from a genuinely pristine agent state.
  rmSync(join(cfg, "backups", "fixture-agent"), { recursive: true, force: true });
  const file = join(home, ".fixture", "config.json");
  if (existsSync(file)) unlinkSync(file);
}

function plant(content) {
  const file = join(home, ".fixture", "config.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

describe("engine: fixture adapter", () => {
  test("on writes via the adapter and reports files", async () => {
    cleanFixture();
    const result = await eng.agentOn(makeFixture(home));
    assert.equal(result.state, "on");
    assert.equal(result.model, "zai-org/glm-5.3");
    const file = join(home, ".fixture", "config.json");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).aiand, true);
    assert.deepEqual(result.files, [file]);
  });

  test("registerAgent is idempotent by id", async () => {
    const before = registry.AGENTS.length;
    registry.registerAgent(makeFixture(home));
    registry.registerAgent(makeFixture(home));
    assert.equal(registry.AGENTS.length, before + 1);
    assert.equal(registry.AGENTS.filter((a) => a.id === "fixture-agent").length, 1);
    assert.ok(registry.findAgent("fixture-agent"));
  });

  test("foreign config is refused without --force (non-TTY)", async () => {
    cleanFixture();
    plant(JSON.stringify({ foreign: "other-writer" }));
    await assert.rejects(
      eng.agentOn(makeFixture(home)),
      (e) =>
        e.exitCode === 1 &&
        e.hint === "Pass --force to overwrite it." &&
        /manages .* last writer wins/.test(e.message)
    );
  });

  test("--force overwrites a foreign config", async () => {
    cleanFixture();
    plant(JSON.stringify({ foreign: "other-writer" }));
    const result = await eng.agentOn(makeFixture(home), { force: true });
    assert.equal(result.state, "on");
    assert.equal(JSON.parse(readFileSync(join(home, ".fixture", "config.json"), "utf8")).aiand, true);
  });

  test("off restores byte-identical content", async () => {
    cleanFixture();
    const original = '{"permissions":{"allow":["Bash*"]}}\n';
    plant(original);
    await eng.agentOn(makeFixture(home));
    assert.notEqual(readFileSync(join(home, ".fixture", "config.json"), "utf8"), original);
    const off = await eng.agentOff(makeFixture(home));
    assert.equal(off.state, "off");
    assert.equal(readFileSync(join(home, ".fixture", "config.json"), "utf8"), original);
  });

  test("agentOn with no binary prints an install hint and exits 127", async () => {
    cleanFixture();
    const missing = {
      ...makeFixture(home),
      detect: () => ({ installed: false, path: null }),
    };
    await assert.rejects(eng.agentOn(missing), (e) => {
      assert.equal(e.exitCode, 127);
      assert.match(e.message, /is not installed/);
      assert.match(e.hint, /Install it with: npm i -g fixture-agent/);
      assert.match(e.hint, /See: https:\/\/example.com\/fixture/);
      return true;
    });
  });

  test("off without a snapshot reports nothing to turn off", async () => {
    cleanFixture();
    const off = await eng.agentOff(makeFixture(home));
    assert.equal(off.state, "off");
    assert.equal(off.note, "Already your own config — nothing to turn off.");
  });

  test("status reports on/off/foreign states", async () => {
    cleanFixture();
    // off (no file)
    assert.equal((await eng.agentStatus(makeFixture(home))).state, "off");

    // foreign
    plant(JSON.stringify({ foreign: "other-writer" }));
    let status = await eng.agentStatus(makeFixture(home));
    assert.equal(status.state, "foreign");
    assert.equal(status.foreign, "other-writer");

    // on
    await eng.agentOn(makeFixture(home), { force: true });
    status = await eng.agentStatus(makeFixture(home));
    assert.equal(status.state, "on");
    assert.equal(status.installed, true);
  });

  test("idempotent second on keeps the first backup", async () => {
    cleanFixture();
    const original = '{"original":true}\n';
    plant(original);
    await eng.agentOn(makeFixture(home)); // backup A = original
    // user edits the now-aiand file; second on must not re-snapshot
    writeFileSync(
      join(home, ".fixture", "config.json"),
      JSON.stringify({ aiand: true, model: "touched" })
    );
    await eng.agentOn(makeFixture(home));
    await eng.agentOff(makeFixture(home));
    assert.equal(readFileSync(join(home, ".fixture", "config.json"), "utf8"), original);
  });
});

describe("engine: not signed in", () => {
  test("agentOn without a session throws NotLoggedInError (exit 2)", async () => {
    const savedKey = process.env.AIAND_API_KEY;
    const savedBase = process.env.AIAND_BASE_URL;
    const savedCfg = process.env.AIAND_CONFIG_DIR;
    delete process.env.AIAND_API_KEY;
    delete process.env.AIAND_BASE_URL;
    const emptyCfg = join(dir, "empty-cfg");
    process.env.AIAND_CONFIG_DIR = emptyCfg;
    mkdirSync(emptyCfg, { recursive: true });
    try {
      const { NotLoggedInError } = await import("../dist/cli/errors.js");
      await assert.rejects(eng.agentOn(makeFixture(home)), (e) => {
        assert.ok(e instanceof NotLoggedInError);
        assert.equal(e.exitCode, 2);
        return true;
      });
    } finally {
      process.env.AIAND_CONFIG_DIR = savedCfg;
      if (savedKey !== undefined) process.env.AIAND_API_KEY = savedKey;
      if (savedBase !== undefined) process.env.AIAND_BASE_URL = savedBase;
    }
  });
});