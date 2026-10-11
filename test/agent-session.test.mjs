import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, test } from "node:test";
import {
  CLOSED_URL,
  catalogModel,
  cliEnv,
  FAKE_API_KEY,
  hermeticPath,
  plantStub,
  runCli,
  seedCatalogCache,
  withEnv,
  withTestEnv,
} from "./helpers.mjs";

const { runAgentCommand } = await import("../dist/commands/agent.js");
const { findAgent, registerAgent } = await import("../dist/agents/registry.js");

// The ephemeral wiring is the same launcher run-agent.ts uses, driven from the
// agent command: a stub binary dumps its argv + env so the test can prove the
// session ran on a throwaway file and that nothing persistent was written.
const CAPTURE_STUB = `env > "$AIAND_CAPTURE.env"
printf '%s\\n' "$@" > "$AIAND_CAPTURE.args"
exit 42`;

/** A registered adapter with config only and no session launch. */
const NOSESSION_AGENT = {
  id: "nosession-agent",
  label: "No Session Fixture",
  bin: "nosession-agent",
  install: { command: "npm i -g nosession-agent", url: "https://example.com/nosession" },
  detect: () => ({ installed: true, path: "/usr/bin/nosession-agent" }),
  managedFiles: () => [],
  probe: async () => ({ active: false, model: null }),
  enable: async () => ({ model: "x", filesWritten: [] }),
  disable: async () => ({ stripped: false }),
};

let binDir, home, cfg;

const box = withTestEnv("aiand-session-", (dir) => {
  home = join(dir, "home");
  cfg = join(dir, "cfg");
  binDir = join(dir, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  plantStub(binDir, "claude", CAPTURE_STUB);
  plantStub(binDir, "nosession-agent", CAPTURE_STUB);
  // A seeded catalog cache, so a session never needs the network.
  seedCatalogCache(cfg, { models: [catalogModel("zai-org/glm-5.3"), catalogModel("other/model")] });
  // Register in-process: the no-session fixture exists only in this registry.
  registerAgent(NOSESSION_AGENT);
});

const captureDir = () => mkdtempSync(join(box.dir, "cap-"));

const cli = (args, state, env = {}) =>
  runCli(args, {
    env: cliEnv({
      AIAND_HOME: home,
      AIAND_CONFIG_DIR: cfg,
      AIAND_API_KEY: FAKE_API_KEY,
      AIAND_BASE_URL: CLOSED_URL,
      AIAND_CAPTURE: join(state, "capture"),
      PATH: `${binDir}${delimiter}${process.env.PATH}`,
      ...env,
    }),
  });

const capturedArgs = (state) =>
  readFileSync(join(state, "capture.args"), "utf8").split("\n").slice(0, -1);
const capturedEnv = (state) => readFileSync(join(state, "capture.env"), "utf8");

/** Drive runAgentCommand in-process with the harness stubs and a fresh env. */
const inProcess = (agent, args, state) =>
  withEnv(
    {
      AIAND_HOME: home,
      AIAND_CONFIG_DIR: cfg,
      AIAND_API_KEY: FAKE_API_KEY,
      AIAND_BASE_URL: CLOSED_URL,
      AIAND_CAPTURE: join(state, "capture"),
      PATH: `${binDir}${delimiter}${process.env.PATH}`,
    },
    () => runAgentCommand(findAgent(agent), args),
  );

describe("aiand <agent> --session", () => {
  test("claude --session runs on a throwaway --settings file, then cleans it", async () => {
    const state = captureDir();
    try {
      const { code } = await cli(["claude", "--session", "--version"], state);
      assert.equal(code, 42, "the agent's exit code propagates");
      const args = capturedArgs(state);
      assert.equal(args[0], "--settings", "the session wiring came through --settings");
      assert.equal(args[2], "--version", "the user's args reach the agent verbatim");
      assert.equal(existsSync(args[1]), false, "the throwaway settings file is removed on exit");
      assert.doesNotMatch(capturedEnv(state), /sk-test-not-real/);
      assert.doesNotMatch(capturedEnv(state), /^CLAUDE_CODE_OAUTH_TOKEN=/m);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("claude --session passes the agent's own args through", async () => {
    const state = captureDir();
    try {
      const { code } = await cli(["claude", "--session", "-p", "hi"], state);
      assert.equal(code, 42);
      assert.deepEqual(capturedArgs(state).slice(2), ["-p", "hi"]);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("an inherited OAuth token never reaches the session child", async () => {
    const state = captureDir();
    try {
      await cli(["claude", "--session", "--version"], state, {
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-user-token",
      });
      assert.doesNotMatch(capturedEnv(state), /sk-ant-user-token/);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("claude on --session writes no config and no snapshot", async () => {
    const state = captureDir();
    try {
      const { code } = await cli(["claude", "on", "--session"], state);
      assert.equal(code, 42);
      assert.equal(existsSync(join(home, ".claude", "settings.json")), false);
      assert.equal(existsSync(join(cfg, "snapshots")), false);
      // The session wiring ran, not the persistent one.
      assert.equal(capturedArgs(state)[0], "--settings");
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("claude on --session --json reports the session, not persistent files", async () => {
    const state = captureDir();
    try {
      const { code, stdout } = await cli(["claude", "on", "--session", "--json"], state);
      assert.equal(code, 42);
      const body = JSON.parse(stdout);
      assert.equal(body.agent, "claude");
      assert.equal(body.mode, "session");
      assert.deepEqual(body.files, []);
      assert.equal(body.model, "zai-org/glm-5.3");
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("claude on --session says the config was left alone", async () => {
    const state = captureDir();
    try {
      const { code, stderr } = await cli(["claude", "on", "--session"], state);
      assert.equal(code, 42);
      assert.match(stderr, /config was not changed/);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("copilot-app --session errors: the desktop app has no session launch", async () => {
    const state = captureDir();
    try {
      const { code, stderr } = await cli(["copilot-app", "--session"], state);
      assert.equal(code, 1);
      assert.match(stderr, /desktop app/);
      assert.match(stderr, /copilot-app on/);
      assert.equal(existsSync(join(state, "capture.args")), false, "the agent never ran");
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("copilot-app on --session errors the same way", async () => {
    const state = captureDir();
    try {
      const { code, stderr } = await cli(["copilot-app", "on", "--session"], state);
      assert.equal(code, 1);
      assert.match(stderr, /desktop app/);
      assert.equal(existsSync(join(state, "capture.args")), false);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("an adapter without sessionLaunch is refused with a clear error", async () => {
    const state = captureDir();
    let thrown;
    try {
      await inProcess("nosession-agent", ["--session"], state);
    } catch (error) {
      thrown = error;
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
    assert.ok(thrown, "expected a CliError");
    assert.equal(thrown.name, "CliError");
    assert.match(thrown.message, /does not support --session/);
    assert.match(thrown.hint, /nosession-agent on/);
    assert.equal(existsSync(join(state, "capture.args")), false, "the agent never ran");
  });

  test("claude --session with no binary exits 127, never a login ceremony", async () => {
    const state = captureDir();
    const nobin = mkdtempSync(join(box.dir, "nobin-"));
    try {
      const { code, stderr } = await cli(["claude", "--session"], state, {
        PATH: hermeticPath(nobin, "/usr/bin"),
      });
      assert.equal(code, 127);
      assert.match(stderr, /Claude Code is not installed/);
      assert.equal(existsSync(join(state, "capture.args")), false, "the agent never ran");
    } finally {
      rmSync(state, { recursive: true, force: true });
      rmSync(nobin, { recursive: true, force: true });
    }
  });
});
