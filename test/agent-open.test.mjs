import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import {
  CLOSED_URL,
  cliEnv,
  FAKE_API_KEY,
  hermeticPath,
  plantStub,
  runCli,
  seedCatalogCache,
  withEnv,
  withTestEnv,
} from "./helpers.mjs";

const { agentBaseEnv, installIfMissing, runAgentBinary } = await import("../dist/agents/launch.js");

const CAPTURE_STUB = `env > "$AIAND_CAPTURE.env"
printf '%s\\n' "$@" > "$AIAND_CAPTURE.args"
exit 42`;

let binDir;
const box = withTestEnv("aiand-open-", (dir) => {
  binDir = join(dir, "bin");
  for (const agent of ["opencode", "claude", "codex", "hermes", "jouzu"])
    plantStub(binDir, agent, CAPTURE_STUB);
});

function freshState() {
  const state = mkdtempSync(join(box.dir, "state-"));
  const cfg = join(state, "cfg");
  seedCatalogCache(cfg);
  return { home: join(state, "home"), cfg, capture: join(state, "capture") };
}

const cli = (args, state, env = {}) =>
  runCli(args, {
    env: cliEnv({
      AIAND_HOME: state.home,
      AIAND_CONFIG_DIR: state.cfg,
      AIAND_API_KEY: FAKE_API_KEY,
      AIAND_BASE_URL: CLOSED_URL,
      AIAND_CAPTURE: state.capture,
      PATH: `${binDir}${delimiter}${process.env.PATH}`,
      ...env,
    }),
  });

/** OpenCode's model map with both seeded catalog models. */
const OPENCODE_BOTH = {
  "zai-org/glm-5.3": { id: "zai-org/glm-5.3", name: "GLM 5.3" },
  "other/model": { id: "other/model", name: "Other" },
};

const capturedArgs = (state) =>
  readFileSync(`${state.capture}.args`, "utf8").split("\n").slice(0, -1);
const capturedEnv = (state) => readFileSync(`${state.capture}.env`, "utf8");
const opencodeJson = (state) => join(state.home, ".config", "opencode", "opencode.json");

describe("aiand <agent> opens the agent", () => {
  test("a fresh opencode is wired, then runs with the args verbatim", async () => {
    const state = freshState();
    const { code, stderr } = await cli(["opencode", "run", "--flag", "hi"], state);
    assert.equal(code, 42);
    assert.match(stderr, /OpenCode is now using ai&\./);
    const config = JSON.parse(readFileSync(opencodeJson(state), "utf8"));
    assert.equal(config.provider.aiand.options["x-aiand"], true);
    assert.equal(config.model, "aiand/zai-org/glm-5.3");
    assert.deepEqual(capturedArgs(state), ["run", "--flag", "hi"]);
    assert.doesNotMatch(capturedEnv(state), /^OPENCODE_CONFIG_CONTENT=/m);
  });

  test("an agent already on opens without wiring again", async () => {
    const state = freshState();
    assert.equal((await cli(["opencode"], state)).code, 42);
    const before = readFileSync(opencodeJson(state), "utf8");
    const { code, stderr } = await cli(["opencode"], state);
    assert.equal(code, 42);
    assert.doesNotMatch(stderr, /now using ai&/);
    assert.equal(readFileSync(opencodeJson(state), "utf8"), before);
  });

  test("aiand code is OpenCode", async () => {
    const state = freshState();
    const { code } = await cli(["code", "--continue"], state);
    assert.equal(code, 42);
    assert.ok(existsSync(opencodeJson(state)));
    assert.deepEqual(capturedArgs(state), ["--continue"]);
  });

  test("a model of the user's own stays in opencode.json, but OpenCode opens on ai&", async () => {
    const state = freshState();
    mkdirSync(dirname(opencodeJson(state)), { recursive: true });
    writeFileSync(opencodeJson(state), '{ "model": "anthropic/claude-sonnet-4-5" }\n');
    const { code, stderr } = await cli(["opencode"], state);
    assert.equal(code, 42);
    assert.match(stderr, /Left your existing model \(anthropic\/claude-sonnet-4-5\)/);
    assert.equal(
      JSON.parse(readFileSync(opencodeJson(state), "utf8")).model,
      "anthropic/claude-sonnet-4-5",
    );
    const inline = capturedEnv(state).match(/^OPENCODE_CONFIG_CONTENT=(.*)$/m);
    // Titles and summaries too (small_model): OpenCode's own pick could be another model.
    assert.deepEqual(JSON.parse(inline[1]), {
      model: "aiand/zai-org/glm-5.3",
      small_model: "aiand/zai-org/glm-5.3",
    });
  });

  // A model named in the agent's own args is the one wired and used.
  test("a fresh opencode opened with its own -m is wired on that model", async () => {
    const state = freshState();
    seedCatalogCache(state.cfg, { opencodeModels: OPENCODE_BOTH });
    const { code } = await cli(["opencode", "-m", "aiand/other/model", "run", "hi"], state);
    assert.equal(code, 42);
    assert.equal(JSON.parse(readFileSync(opencodeJson(state), "utf8")).model, "aiand/other/model");
    assert.deepEqual(capturedArgs(state), ["-m", "aiand/other/model", "run", "hi"]);
  });

  test("a model in OpenCode's args is not overridden by an inline default", async () => {
    const state = freshState();
    seedCatalogCache(state.cfg, { opencodeModels: OPENCODE_BOTH });
    mkdirSync(dirname(opencodeJson(state)), { recursive: true });
    writeFileSync(opencodeJson(state), '{ "model": "anthropic/claude-sonnet-4-5" }\n');
    assert.equal((await cli(["opencode", "--model=aiand/other/model"], state)).code, 42);
    // Not the inline default model; titles and summaries on the one named.
    const inline = capturedEnv(state).match(/^OPENCODE_CONFIG_CONTENT=(.*)$/m);
    assert.deepEqual(JSON.parse(inline[1]), { small_model: "aiand/other/model" });
  });

  test("OpenCode opens on a model its wired provider lists, catalog or not", async () => {
    const state = freshState();
    mkdirSync(dirname(opencodeJson(state)), { recursive: true });
    writeFileSync(opencodeJson(state), '{ "model": "anthropic/claude-sonnet-4-5" }\n');
    assert.equal((await cli(["config", "set", "model", "other/model"], state)).code, 0);
    const inline = () => JSON.parse(capturedEnv(state).match(/^OPENCODE_CONFIG_CONTENT=(.*)$/m)[1]);
    const glm = { model: "aiand/zai-org/glm-5.3", small_model: "aiand/zai-org/glm-5.3" };
    assert.equal((await cli(["opencode"], state)).code, 42);
    assert.deepEqual(inline(), glm);
    rmSync(join(state.cfg, "model-catalog.json"));
    assert.equal((await cli(["opencode"], state)).code, 42);
    assert.deepEqual(inline(), glm);
  });

  test("a fresh jouzu is wired in Jouzu's dir and opens on the ai& model it wired", async () => {
    const state = freshState();
    const { code, stderr } = await cli(["jouzu", "fix the build"], state, {
      JOUZU_HOME: join(state.home, "jz"),
    });
    assert.equal(code, 42);
    assert.match(stderr, /Jouzu is now using ai&\./);
    const settings = JSON.parse(
      readFileSync(join(state.home, "jz", "agent", "settings.json"), "utf8"),
    );
    assert.equal(settings.defaultProvider, "aiand");
    assert.deepEqual(capturedArgs(state), [
      "--provider",
      "aiand",
      "--model",
      settings.defaultModel,
      "fix the build",
    ]);
  });

  test("aiand jz is Jouzu, and a model in the args is left to Jouzu", async () => {
    const state = freshState();
    const env = { JOUZU_HOME: join(state.home, "jz") };
    assert.equal((await cli(["jz", "--model", "shisa/x"], state, env)).code, 42);
    assert.deepEqual(capturedArgs(state), ["--model", "shisa/x"]);
    assert.equal((await cli(["jz", "doctor"], state, env)).code, 42);
    assert.deepEqual(capturedArgs(state), ["doctor"]);
  });

  test("`--` passes a verb through to the agent", async () => {
    const state = freshState();
    const { code } = await cli(["opencode", "--", "status"], state);
    assert.equal(code, 42);
    assert.deepEqual(capturedArgs(state), ["status"]);
  });

  test("codex opens on its ai& profile", async () => {
    const state = freshState();
    const { code, stderr } = await cli(["codex", "exec", "hi"], state);
    assert.equal(code, 42);
    assert.match(stderr, /Codex is now using ai&\./);
    assert.ok(existsSync(join(state.home, ".codex", "aiand.config.toml")));
    assert.deepEqual(capturedArgs(state), ["--profile", "aiand", "exec", "hi"]);
  });

  test("codex args that pick a profile get no second --profile", async () => {
    const state = freshState();
    assert.equal((await cli(["codex", "--profile", "aiand", "exec", "hi"], state)).code, 42);
    assert.deepEqual(capturedArgs(state), ["--profile", "aiand", "exec", "hi"]);
    assert.equal((await cli(["codex", "-pwork"], state)).code, 42);
    assert.deepEqual(capturedArgs(state), ["-pwork"]);
  });

  test("codex management commands run without the ai& profile, which they refuse", async () => {
    const state = freshState();
    const { code } = await cli(["codex", "login", "status"], state);
    assert.equal(code, 42);
    assert.deepEqual(capturedArgs(state), ["login", "status"]);
  });

  test("on --model native keeps OpenCode's own default when it opens", async () => {
    const state = freshState();
    assert.equal((await cli(["opencode", "on", "--model", "native"], state)).code, 0);
    assert.equal((await cli(["opencode"], state)).code, 42);
    assert.doesNotMatch(capturedEnv(state), /^OPENCODE_CONFIG_CONTENT=/m);
  });

  test("an OPENCODE_CONFIG_CONTENT of the user's own is left alone", async () => {
    const state = freshState();
    mkdirSync(dirname(opencodeJson(state)), { recursive: true });
    writeFileSync(opencodeJson(state), '{ "model": "anthropic/claude-sonnet-4-5" }\n');
    await cli(["opencode"], state, { OPENCODE_CONFIG_CONTENT: '{"theme":"mine"}' });
    assert.match(capturedEnv(state), /^OPENCODE_CONFIG_CONTENT=\{"theme":"mine"\}$/m);
  });

  test("claude opens one session on ai& and leaves settings.json alone", async () => {
    const state = freshState();
    const { code, stderr } = await cli(["claude", "-p", "hi"], state);
    assert.equal(code, 42);
    assert.doesNotMatch(stderr, /now using ai&/);
    assert.equal(existsSync(join(state.home, ".claude", "settings.json")), false);
    const [flag, overlay, ...rest] = capturedArgs(state);
    assert.equal(flag, "--settings");
    assert.deepEqual(rest, ["-p", "hi"]);
    assert.equal(existsSync(overlay), false, "overlay removed after the session");
  });

  test("claude off says it is off, then what happens to open windows on its own line", async () => {
    const state = freshState();
    assert.equal((await cli(["claude", "on"], state)).code, 0);
    const { code, stdout, stderr } = await cli(["claude", "off"], state);
    assert.equal(code, 0);
    assert.equal(stdout.trim(), "Claude Code is off.");
    assert.match(stderr, /^If you have Claude Code open in other windows, they switch back too\./m);
  });

  describe("a default model picked inside the claude session", () => {
    const SAVE = `[ -n "$AIAND_SAVE" ] && printf '%s' "$AIAND_SAVE" > "$CLAUDE_CONFIG_DIR/settings.json"`;
    const WIRED = { env: { AIAND_MANAGED: "1", ANTHROPIC_BASE_URL: "https://api.aiand.com" } };
    const settingsWith = (model, extra = {}) => JSON.stringify({ model, theme: "dark", ...extra });
    const open = (state, { before, save = "", after = "", noDir = false }) => {
      const dir = join(state.home, "claude-config");
      const bin = join(state.home, "bin");
      if (!noDir) mkdirSync(dir, { recursive: true });
      plantStub(bin, "claude", `mkdir -p "$CLAUDE_CONFIG_DIR"\n${SAVE}\n${after}\nexit 0`);
      if (before !== undefined) writeFileSync(join(dir, "settings.json"), before);
      return cli(["claude"], state, {
        CLAUDE_CONFIG_DIR: dir,
        AIAND_SAVE: save,
        PATH: hermeticPath(bin, "/usr/bin", "/bin"),
      }).then((result) => ({
        ...result,
        settings: JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")),
      }));
    };

    test("an ai& pick is replaced by the user's own default while the session runs", async () => {
      const state = freshState();
      const { settings, stderr } = await open(state, {
        before: '{"model":"opus"}',
        save: settingsWith("zai-org/glm-5.3"),
        after: `i=0
while grep -q zai-org "$CLAUDE_CONFIG_DIR/settings.json" && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
cp "$CLAUDE_CONFIG_DIR/settings.json" "$AIAND_CAPTURE.during"`,
      });
      assert.equal(JSON.parse(readFileSync(`${state.capture}.during`, "utf8")).model, "opus");
      assert.deepEqual(settings, { model: "opus", theme: "dark" });
      assert.match(stderr, /Your default Claude Code model is opus again\./);
    });

    test("the put-back note stays one plain line when the model it names carries escape bytes", async () => {
      const { stderr, settings } = await open(freshState(), {
        before: JSON.stringify({ model: "opus\u001b]0;pwned\u0007\u001b[2J" }),
        save: settingsWith("zai-org/glm-5.3"),
      });
      assert.equal(settings.model, "opus\u001b]0;pwned\u0007\u001b[2J", "the file keeps its bytes");
      assert.match(stderr, /Your default Claude Code model is opus.* again\./);
      assert.doesNotMatch(stderr, /[\u0000-\u0008\u000b-\u001f\u007f]/);
    });

    test("a settings directory Claude Code creates on start is watched too", async () => {
      const state = freshState();
      const { settings } = await open(state, {
        noDir: true,
        save: settingsWith("zai-org/glm-5.3"),
        after: `i=0
while grep -q zai-org "$CLAUDE_CONFIG_DIR/settings.json" && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
cp "$CLAUDE_CONFIG_DIR/settings.json" "$AIAND_CAPTURE.during"`,
      });
      assert.deepEqual(JSON.parse(readFileSync(`${state.capture}.during`, "utf8")), {
        theme: "dark",
      });
      assert.deepEqual(settings, { theme: "dark" });
    });

    test("an ai& pick over no default is removed", async () => {
      const { settings } = await open(freshState(), { save: settingsWith("zai-org/glm-5.3") });
      assert.deepEqual(settings, { theme: "dark" });
    });

    test("an ai& default left by an earlier session is removed, so a plain claude starts again", async () => {
      const { settings, stderr } = await open(freshState(), {
        before: settingsWith("zai-org/glm-5.3"),
      });
      assert.deepEqual(settings, { theme: "dark" });
      assert.match(stderr, /Cleared zai-org\/glm-5\.3 as your default Claude Code model/);
    });

    test("a pick ai& does not serve is the user's own and stays", async () => {
      const { settings, stderr } = await open(freshState(), {
        before: '{"model":"opus"}',
        save: settingsWith("sonnet"),
      });
      assert.equal(settings.model, "sonnet");
      assert.doesNotMatch(stderr, /default Claude Code model/);
    });

    test("a file wired by on keeps an ai& pick, which is meant for every session", async () => {
      const { settings } = await open(freshState(), {
        before: settingsWith("opus", WIRED),
        save: settingsWith("zai-org/glm-5.3", WIRED),
      });
      assert.equal(settings.model, "zai-org/glm-5.3");
    });

    test("once on wires the file mid-session, off's kept model is left alone too", async () => {
      const { settings } = await open(freshState(), {
        before: '{"model":"opus"}',
        save: settingsWith("zai-org/glm-5.3", WIRED),
        after: `sleep 1\nprintf '%s' '${settingsWith("zai-org/glm-5.3")}' > "$CLAUDE_CONFIG_DIR/settings.json"\nsleep 0.5`,
      });
      assert.equal(settings.model, "zai-org/glm-5.3");
    });
  });

  test("a leading --profile wires again, so the agent runs on that profile", async () => {
    const state = freshState();
    assert.equal((await cli(["opencode"], state)).code, 42);
    const { code, stderr } = await cli(["--profile", "work", "opencode"], state);
    assert.equal(code, 42);
    assert.match(stderr, /OpenCode is now using ai&\./);
  });

  test("a leading --base-url wires again, so the agent reaches that gateway", async () => {
    const state = freshState();
    assert.equal((await cli(["opencode"], state)).code, 42);
    const other = "http://127.0.0.1:10";
    seedCatalogCache(state.cfg, { baseUrl: other });
    const { code, stderr } = await cli(["--base-url", other, "opencode"], state);
    assert.equal(code, 42);
    assert.match(stderr, /OpenCode is now using ai&\./);
    const config = JSON.parse(readFileSync(opencodeJson(state), "utf8"));
    assert.equal(config.provider.aiand.options.baseURL, `${other}/v1`);
  });

  test("a missing agent with no terminal exits 127 with the install hint, never npm", async () => {
    const state = freshState();
    const empty = mkdtempSync(join(box.dir, "nobin-"));
    const marker = join(state.home, "npm-ran");
    plantStub(empty, "npm", `touch "${marker}"`);
    // node's own bin dir is not hermetic on CI: `npm install -g opencode-ai`
    // drops the real agent next to node, so including it here would launch a
    // real opencode/TUI instead of exercising the missing-agent path.
    const { code, stderr } = await cli(["opencode"], state, {
      PATH: hermeticPath(empty),
    });
    assert.equal(code, 127);
    assert.match(stderr, /OpenCode is not installed/);
    assert.match(stderr, /Install it with: npm install -g opencode-ai@/);
    assert.equal(existsSync(marker), false);
  });

  test("signed out with no terminal exits 2 and never runs the agent", async () => {
    const state = freshState();
    const { code, stderr } = await cli(["opencode"], state, { AIAND_API_KEY: "" });
    assert.equal(code, 2);
    assert.match(stderr, /Not logged in/i);
    assert.equal(existsSync(`${state.capture}.args`), false);
  });
  test("hermes open drops env that would outrank the wired config", async () => {
    const state = freshState();
    const { code, stderr } = await cli(["hermes"], state, {
      HERMES_HOME: join(state.home, ".hermes"),
      ANTHROPIC_API_KEY: "sk-anthropic",
      OPENAI_API_KEY: "sk-openai",
    });
    assert.equal(code, 42);
    assert.match(stderr, /Hermes Agent is now using ai&\./);
    const env = capturedEnv(state);
    assert.doesNotMatch(env, /^ANTHROPIC_API_KEY=/m);
    assert.doesNotMatch(env, /^OPENAI_API_KEY=/m);
    assert.doesNotMatch(env, /^AIAND_API_KEY=/m);
  });

  test("open scrubs AIAND_API_KEY from the spawned agent env", async () => {
    const state = freshState();
    const { code } = await cli(["opencode"], state, { AIAND_API_KEY: FAKE_API_KEY });
    assert.equal(code, 42);
    assert.doesNotMatch(capturedEnv(state), /^AIAND_API_KEY=/m);
  });

  test("codex open keeps AIAND_API_KEY for env-key sessions", async () => {
    const state = freshState();
    const { code } = await cli(["codex", "exec", "hi"], state, { AIAND_API_KEY: FAKE_API_KEY });
    assert.equal(code, 42);
    assert.match(capturedEnv(state), new RegExp(`^AIAND_API_KEY=${FAKE_API_KEY}$`, "m"));
  });

  test("open drops the store master key from every agent but Codex", async () => {
    const MASTER = "cd".repeat(32);
    const state = freshState();
    await cli(["opencode"], state, { AIAND_SECRET_STORE_MASTER_KEY: MASTER });
    assert.doesNotMatch(capturedEnv(state), /AIAND_SECRET_STORE_MASTER_KEY/);
    const codex = freshState();
    await cli(["codex", "exec", "hi"], codex, { AIAND_SECRET_STORE_MASTER_KEY: MASTER });
    assert.match(capturedEnv(codex), new RegExp(`^AIAND_SECRET_STORE_MASTER_KEY=${MASTER}$`, "m"));
  });

  test("on Windows a lowercase aiand_api_key is scrubbed from every agent, the master key kept for Codex", () => {
    const env = {
      aiand_api_key: "sk-x",
      aiand_secret_store_master_key: "ab".repeat(32),
      Path: "C:\\bin",
    };
    const opencode = agentBaseEnv({ id: "opencode" }, env, "win32");
    assert.deepEqual(opencode, { Path: "C:\\bin" });
    const codex = agentBaseEnv({ id: "codex" }, env, "win32");
    assert.deepEqual(codex, { aiand_secret_store_master_key: "ab".repeat(32), Path: "C:\\bin" });
  });

  test("copilot-app open wires and never spawns", async () => {
    const state = freshState();
    const copilotHome = join(state.home, "copilot-home");
    mkdirSync(copilotHome, { recursive: true });
    createAppDb(join(copilotHome, "data.db"));
    const { code, stdout } = await cli(["copilot-app"], state, { COPILOT_HOME: copilotHome });
    assert.equal(code, 0);
    assert.match(stdout, /pick the ai& model/);
    assert.equal(existsSync(`${state.capture}.args`), false);
    const { code: statusCode, stdout: statusOut } = await cli(["copilot-app", "status"], state, {
      COPILOT_HOME: copilotHome,
    });
    assert.equal(statusCode, 0);
    assert.match(statusOut, /on/i);
  });

  test("copilot-app open with passthrough args errors and never spawns", async () => {
    const state = freshState();
    const copilotHome = join(state.home, "copilot-home");
    mkdirSync(copilotHome, { recursive: true });
    createAppDb(join(copilotHome, "data.db"));
    const { code, stderr } = await cli(["copilot-app", "-p", "hi"], state, {
      COPILOT_HOME: copilotHome,
    });
    assert.equal(code, 1);
    assert.match(stderr, /desktop app/);
    assert.equal(existsSync(`${state.capture}.args`), false);
  });
});
/** Create the app's BYOK tables exactly as the live app (v1.1.x) has them. */
function createAppDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS "accounts" (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE IF NOT EXISTS "model_providers" (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      type TEXT NOT NULL DEFAULT 'openai',
      settings_json TEXT NOT NULL DEFAULT '{}',
      account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS "provider_models" (
      id TEXT PRIMARY KEY NOT NULL,
      provider_id TEXT NOT NULL REFERENCES "model_providers"(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL,
      wire_model TEXT,
      display_name TEXT NOT NULL,
      max_prompt_tokens INTEGER,
      max_output_tokens INTEGER,
      wire_api_override TEXT CHECK (wire_api_override IS NULL OR wire_api_override IN ('completions','responses')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      supported_reasoning_efforts TEXT,
      UNIQUE (provider_id, model_id)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_models_provider ON provider_models(provider_id);
  `);
  db.close();
  return path;
}

async function onTty(answer, fn) {
  const saved = [process.stdin, process.stdout].map((s) => [
    s,
    Object.getOwnPropertyDescriptor(s, "isTTY"),
  ]);
  for (const [stream] of saved) {
    Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
  }
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try {
    if (answer !== undefined) process.stdin.push(`${answer}\n`);
    return await fn();
  } finally {
    process.stderr.write = write;
    for (const [stream, desc] of saved) {
      if (desc) Object.defineProperty(stream, "isTTY", desc);
      else delete stream.isTTY;
    }
  }
}

function installable(command = "npm install -g fixture-agent@1.2.3") {
  const dir = mkdtempSync(join(box.dir, "install-"));
  const agent = join(dir, "agent");
  return {
    dir,
    agent,
    adapter: {
      id: "fixture-agent",
      label: "Fixture Agent",
      bin: "fixture-agent",
      install: { command, url: "https://example.com/fixture" },
      detect: () =>
        existsSync(agent) ? { installed: true, path: agent } : { installed: false, path: null },
    },
  };
}

function withNpm(dir, script, fn) {
  plantStub(dir, "npm", script);
  return withEnv({ PATH: hermeticPath(dir, "/usr/bin", "/bin") }, fn);
}

describe("installIfMissing", () => {
  test("an installed agent is left alone", async () => {
    const { adapter, agent } = installable();
    writeFileSync(agent, "");
    await installIfMissing(adapter);
  });

  test("an install command that is not npm is never run, and never asked about", async () => {
    const { adapter } = installable("brew install fixture-agent");
    await onTty(undefined, () =>
      assert.rejects(installIfMissing(adapter), (error) => {
        assert.equal(error.exitCode, 127);
        assert.match(error.hint, /Install it with: brew install fixture-agent/);
        return true;
      }),
    );
  });

  test("yes (the default) runs npm install -g with the pinned package", async () => {
    const { adapter, agent, dir } = installable();
    const args = join(dir, "npm-args");
    await withNpm(dir, `printf '%s\\n' "$@" > "${args}"\ntouch "${agent}"`, () =>
      onTty("", () => installIfMissing(adapter)),
    );
    assert.deepEqual(readFileSync(args, "utf8").split("\n").slice(0, -1), [
      "install",
      "-g",
      "fixture-agent@1.2.3",
    ]);
  });

  // Auto-install ran whatever npm's latest was, scripts and all.
  test("Claude Code and Codex install a pinned release; Codex skips install scripts", async () => {
    const { claudeAdapter, CLAUDE_CODE_VERSION } = await import("../dist/agents/claude/adapter.js");
    const { codexAdapter, CODEX_VERSION } = await import("../dist/agents/codex/adapter.js");
    assert.match(CLAUDE_CODE_VERSION, /^\d+\.\d+\.\d+$/);
    assert.match(CODEX_VERSION, /^\d+\.\d+\.\d+$/);
    assert.equal(
      claudeAdapter.install.command,
      `npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`,
    );
    assert.equal(
      codexAdapter.install.command,
      `npm install -g --ignore-scripts @openai/codex@${CODEX_VERSION}`,
    );
  });

  test("the install question names the exact command, version included", async () => {
    const { adapter, dir } = installable();
    let asked = "";
    await withNpm(dir, "exit 0", () =>
      onTty("n", async () => {
        const quiet = process.stderr.write;
        process.stderr.write = (chunk) => {
          asked += String(chunk);
          return true;
        };
        try {
          await installIfMissing(adapter).catch(() => {});
        } finally {
          process.stderr.write = quiet;
        }
      }),
    );
    assert.match(asked, /Install it with npm install -g fixture-agent@1\.2\.3\?/);
  });

  test("no leaves it uninstalled: 127 + Install hint, npm never runs", async () => {
    const { adapter, dir } = installable();
    const marker = join(dir, "npm-ran");
    await withNpm(dir, `touch "${marker}"`, () =>
      onTty("n", () =>
        assert.rejects(installIfMissing(adapter), (error) => {
          assert.equal(error.exitCode, 127);
          assert.match(error.hint, /Install it with: npm install -g fixture-agent@1\.2\.3/);
          return true;
        }),
      ),
    );
    assert.equal(existsSync(marker), false);
  });

  test("a failing npm says so and keeps the hint", async () => {
    const { adapter, dir } = installable();
    await withNpm(dir, "exit 3", () =>
      onTty("y", () =>
        assert.rejects(installIfMissing(adapter), (error) => {
          assert.equal(error.exitCode, 127);
          assert.match(error.message, /Installing Fixture Agent failed: npm exited with 3\./);
          assert.match(
            error.hint,
            /Install it yourself with: npm install -g fixture-agent@1\.2\.3/,
          );
          return true;
        }),
      ),
    );
  });

  test("npm not on PATH says so", async () => {
    const { adapter } = installable();
    const empty = mkdtempSync(join(box.dir, "nonpm-"));
    await withEnv({ PATH: hermeticPath(empty) }, () =>
      onTty("y", () =>
        assert.rejects(installIfMissing(adapter), /Installing Fixture Agent failed: .*ENOENT/),
      ),
    );
  });

  test("an install npm puts off PATH says where to look", async () => {
    const { adapter, dir } = installable();
    await withNpm(dir, "exit 0", () =>
      onTty("y", () =>
        assert.rejects(installIfMissing(adapter), (error) => {
          assert.match(error.message, /installed, but fixture-agent is not on your PATH/);
          assert.match(error.hint, /npm prefix -g/);
          return true;
        }),
      ),
    );
  });
  test("npm install never sees AIAND_API_KEY", async () => {
    const { adapter, agent, dir } = installable();
    const captured = join(dir, "npm-env");
    await withEnv({ AIAND_API_KEY: "sk-test-123" }, () =>
      withNpm(dir, `env > "${captured}"\ntouch "${agent}"`, () =>
        onTty("", () => installIfMissing(adapter)),
      ),
    );
    assert.doesNotMatch(readFileSync(captured, "utf8"), /^AIAND_API_KEY=/m);
  });

  test("npm install never sees the store master key either", async () => {
    const { adapter, agent, dir } = installable();
    const captured = join(dir, "npm-env");
    await withEnv({ AIAND_SECRET_STORE_MASTER_KEY: "ef".repeat(32) }, () =>
      withNpm(dir, `env > "${captured}"\ntouch "${agent}"`, () =>
        onTty("", () => installIfMissing(adapter)),
      ),
    );
    assert.doesNotMatch(readFileSync(captured, "utf8"), /AIAND_SECRET_STORE_MASTER_KEY/);
  });
});

describe("runAgentBinary", () => {
  test("stops reading stdin before the agent takes the terminal", async () => {
    const dir = mkdtempSync(join(box.dir, "run-"));
    plantStub(dir, "fixture-agent", "exit 0");
    process.stdin.resume();
    try {
      await withEnv({ PATH: hermeticPath(dir, "/usr/bin", "/bin") }, () =>
        runAgentBinary(installable().adapter, [], process.env),
      );
      assert.equal(process.stdin.isPaused(), true);
    } finally {
      process.stdin.pause();
    }
  });

  test("an agent reachable only through `.` on PATH in the cwd is not run", {
    skip: process.platform === "win32",
  }, async () => {
    const dir = mkdtempSync(join(box.dir, "repo-"));
    const ran = join(dir, "ran");
    plantStub(dir, "fixture-agent", `touch "${ran}"`);
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      await withEnv({ PATH: hermeticPath(".", "/usr/bin", "/bin") }, () =>
        assert.rejects(runAgentBinary(installable().adapter, [], process.env), (error) => {
          assert.equal(error.exitCode, 127);
          return true;
        }),
      );
    } finally {
      process.chdir(cwd);
      process.stdin.pause();
    }
    assert.equal(existsSync(ran), false);
  });

  test("a SIGTERM that lands during cleanup still decides the exit code", {
    skip:
      process.platform === "win32" &&
      "Windows has no SIGTERM to send itself: kill() ends the test process outright",
  }, async () => {
    const dir = mkdtempSync(join(box.dir, "run-"));
    plantStub(dir, "fixture-agent", "exit 0");
    const before = process.exitCode;
    try {
      await withEnv({ PATH: hermeticPath(dir, "/usr/bin", "/bin") }, () =>
        runAgentBinary(installable().adapter, [], process.env, async () => {
          process.kill(process.pid, "SIGTERM");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }),
      );
      assert.equal(process.exitCode, 143);
    } finally {
      process.exitCode = before;
    }
  });
});
