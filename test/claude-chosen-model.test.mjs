// A user who picks a model gets only that model. Claude Code sends
// session titles to its fast (haiku) slot and auto-mode safety checks to its
// Sonnet slot (or CLAUDE_CODE_AUTO_MODE_MODEL), so a slot left on a default
// sends the user's data to a model they did not choose. These tests run the
// config aiand writes through a stand-in for Claude Code that routes each
// kind of request the way Claude Code does, against a logging mock gateway,
// and read back which models were asked for.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import {
  catalogModel,
  harnessEnv,
  plantStub,
  runCli,
  seedCatalogCache,
  startMockGateway,
  withTestEnv,
} from "./helpers.mjs";

const CHOSEN = "meta/muse-spark-open";
const MAIN_DEFAULT = "moonshotai/kimi-k3";
const FAST_DEFAULT = "deepseek-ai/deepseek-v4.1-flash-1017";
// Human status output trims the provider prefix; config and JSON keep the full id.
const FAST_LABEL = "deepseek-v4.1-flash-1017";
// The catalog holds Claude's preferred defaults, so a slot that falls back to
// one shows up in the log.
const MODELS = [CHOSEN, MAIN_DEFAULT, FAST_DEFAULT, "zai-org/glm-5.3"].map((id) =>
  catalogModel(id, { context_window: 262144 }),
);

/**
 * Claude Code's model routing, from its docs (model-config, permission-modes,
 * env-vars) and the `query_source` lines it logs for unknown models: settings `env`
 * applies over the process env, `--settings` over the user's settings.json,
 * and each kind of request reads its own slot. An unset slot falls back to a
 * Claude model, which no ai& catalog serves.
 */
const FAKE_CLAUDE = `
import { readFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const read = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; }
};
const user = read(join(process.env.CLAUDE_CONFIG_DIR, "settings.json"));
const at = args.indexOf("--settings");
const overlay = at === -1 ? {} : read(args[at + 1]);
const env = { ...process.env, ...(user.env ?? {}), ...(overlay.env ?? {}) };
const flag = args.indexOf("--model");
const BUILT_IN = { opus: "claude-opus", sonnet: "claude-sonnet", haiku: "claude-haiku", fable: "claude-fable" };
const slot = (name) => env["ANTHROPIC_DEFAULT_" + name.toUpperCase() + "_MODEL"] || BUILT_IN[name];
const resolve = (model) => {
  const alias = (model ?? "default").toLowerCase();
  if (["default", "sonnet", "opusplan"].includes(alias)) return slot("sonnet");
  if (["opus", "best"].includes(alias)) return slot("opus");
  if (alias in BUILT_IN) return slot(alias);
  return model;
};
const main = resolve(flag === -1 ? env.ANTHROPIC_MODEL || overlay.model || user.model : args[flag + 1]);
const requests = {
  sdk: main,
  generate_session_title: slot("haiku"),
  auto_mode: env.CLAUDE_CODE_AUTO_MODE_MODEL || slot("sonnet"),
  subagent: env.CLAUDE_CODE_SUBAGENT_MODEL || main,
  plan_mode: slot("opus"),
  fable: slot("fable"),
};
for (const [source, model] of Object.entries(requests)) {
  await fetch(env.ANTHROPIC_BASE_URL + "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + env.ANTHROPIC_AUTH_TOKEN },
    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: source }] }),
  });
}
`;

let home, cfg, bin, claudeDir, log, gateway;

withTestEnv("aiand-chosen-model-", (dir) => {
  home = join(dir, "home");
  cfg = join(dir, "cfg");
  bin = join(dir, "bin");
  claudeDir = join(dir, "claude");
  log = join(dir, "gateway.log");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(dir, "fake-claude.mjs"), FAKE_CLAUDE);
  plantStub(bin, "claude", `exec "${process.execPath}" "${join(dir, "fake-claude.mjs")}" "$@"`);
});

before(async () => {
  gateway = await startMockGateway({ args: ["--log", log] });
});
after(async () => {
  await gateway?.stop();
});
beforeEach(() => {
  rmSync(claudeDir, { recursive: true, force: true });
  rmSync(cfg, { recursive: true, force: true });
  rmSync(log, { force: true });
  seedCatalogCache(cfg, { baseUrl: gateway.url, models: MODELS });
});

const cliEnvFor = () => ({
  ...harnessEnv(),
  AIAND_HOME: home,
  AIAND_CONFIG_DIR: cfg,
  AIAND_API_KEY: "sk-test-chosen-model",
  AIAND_BASE_URL: gateway.url,
  CLAUDE_CONFIG_DIR: claudeDir,
  AIAND_CLAUDE_RELOAD_MS: "0",
  PATH: `${bin}${delimiter}${process.env.PATH}`,
});

async function aiand(...args) {
  const result = await runCli(args, { env: cliEnvFor() });
  assert.equal(result.code, 0, `aiand ${args.join(" ")}: ${result.stderr}`);
  return result;
}

/** Each request Claude Code sent, as `query source → model`. */
function requested() {
  if (!existsSync(log)) return {};
  const lines = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return Object.fromEntries(
    lines
      .filter((line) => line.path.endsWith("/v1/messages"))
      .map((line) => [line.prompt, line.model]),
  );
}

const only = (model) => ({
  sdk: model,
  generate_session_title: model,
  auto_mode: model,
  subagent: model,
  plan_mode: model,
  fable: model,
});

describe("only the chosen model is requested", () => {
  test("aiand claude on --model X, then claude", async () => {
    await aiand("claude", "on", "--model", CHOSEN);
    await runFakeClaude();
    assert.deepEqual(requested(), only(CHOSEN));
    const status = await aiand("claude", "status");
    assert.doesNotMatch(status.stderr, /sends requests there too/);
  });

  test("aiand claude --model X (one session)", async () => {
    await aiand("claude", "--model", CHOSEN, "-p", "hi");
    assert.deepEqual(requested(), only(CHOSEN));
  });

  test("aiand claude --model=X before the agent's own args", async () => {
    await aiand("claude", `--model=${CHOSEN}`, "-p", "hi");
    assert.deepEqual(requested(), only(CHOSEN));
  });

  test("the profile's model (aiand config set model)", async () => {
    await aiand("config", "set", "model", CHOSEN);
    await aiand("claude", "-p", "hi");
    assert.deepEqual(requested(), only(CHOSEN));
  });

  test("--fast-model is the only other model: background calls and safety checks", async () => {
    await aiand("claude", "on", "--model", CHOSEN, "--fast-model", "zai-org/glm-5.3");
    await runFakeClaude();
    assert.deepEqual(requested(), {
      ...only(CHOSEN),
      generate_session_title: "zai-org/glm-5.3",
      auto_mode: "zai-org/glm-5.3",
    });
  });

  test("a one-session launch after on --model X stays on X", async () => {
    await aiand("claude", "on", "--model", CHOSEN);
    await aiand("claude", "-p", "hi");
    assert.deepEqual(requested(), only(CHOSEN));
  });

  test("a new profile model is followed by the next on", async () => {
    await aiand("config", "set", "model", "zai-org/glm-5.3");
    await aiand("claude", "on");
    await aiand("config", "set", "model", CHOSEN);
    await aiand("claude", "on");
    await runFakeClaude();
    assert.deepEqual(requested(), only(CHOSEN));
  });

  test("a 0.8.0 record does not outrank a new profile model", async () => {
    await aiand("claude", "on", "--model", "zai-org/glm-5.3");
    // 0.8.0 recorded no choice: the slots alone said what --model had been.
    assert.equal(dropRecordedChoice(cfg), true, "found the record's choice");
    await aiand("config", "set", "model", CHOSEN);
    await aiand("claude", "on");
    await runFakeClaude();
    assert.deepEqual(requested(), only(CHOSEN));
  });

  test("status warns when safety checks run on the main model but a fast model was chosen", async () => {
    const { slotReport } = await import("../dist/agents/claude/settings.js");
    const env = Object.fromEntries(
      ["OPUS", "SONNET", "FABLE"].map((s) => [`ANTHROPIC_DEFAULT_${s}_MODEL`, CHOSEN]),
    );
    env.CLAUDE_CODE_SUBAGENT_MODEL = CHOSEN;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = "zai-org/glm-5.3";
    const report = slotReport({ model: CHOSEN, env }, { chosen: CHOSEN, fast: "zai-org/glm-5.3" });
    assert.equal(report.warnings.filter((w) => w.includes("auto-mode checks")).length, 1);
  });

  test("an empty --model= is refused, not dropped", async () => {
    const result = await runCli(["run-agent", "claude", "--", "--model="], { env: cliEnvFor() });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--model needs a value/);
  });

  test("a safety-check model exported in the shell cannot win", async () => {
    await aiand("claude", "on", "--model", CHOSEN);
    await runFakeClaude([], { CLAUDE_CODE_AUTO_MODE_MODEL: MAIN_DEFAULT });
    assert.deepEqual(requested(), only(CHOSEN));
  });

  test("a Claude alias in the agent's args still resolves to the chosen model", async () => {
    await aiand("claude", "on", "--model", CHOSEN);
    await runFakeClaude(["--model", "opus"]);
    assert.deepEqual(requested(), only(CHOSEN));
  });

  test("with no model chosen, status names every model Claude Code sends to", async () => {
    await aiand("claude", "on");
    await runFakeClaude();
    assert.deepEqual(new Set(Object.values(requested())), new Set([MAIN_DEFAULT, FAST_DEFAULT]));
    const status = await aiand("claude", "status");
    // Human status prints the bare labels; the full ids stay in config and JSON.
    assert.match(status.stdout, new RegExp(`fast \\(haiku\\)\\s+${FAST_LABEL}`));
    assert.match(status.stdout, new RegExp(`auto-mode checks\\s+${FAST_LABEL}`));
    assert.match(status.stderr, /fast \(haiku\) model .* sends requests there too/);
  });
});

/** Run the stand-in Claude Code the way a user's plain `claude` would, outside aiand. */
async function runFakeClaude(args = [], extraEnv = {}) {
  const { spawn } = await import("node:child_process");
  const env = { ...cliEnvFor(), ...extraEnv };
  // Windows gets only the .cmd wrapper, which spawn runs through cmd.exe alone.
  const child =
    process.platform === "win32"
      ? spawn(
          process.env.ComSpec || "cmd.exe",
          (await import("../dist/cli/win-spawn.js")).cmdShimArgv(join(bin, "claude.cmd"), args),
          { env, stdio: "ignore", windowsVerbatimArguments: true },
        )
      : spawn(join(bin, "claude"), args, { env, stdio: "ignore" });
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, "fake claude");
}

/** Remove the recorded choice from Claude's record, as a 0.8.0 `on` would have left it. */
function dropRecordedChoice(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (dropRecordedChoice(path)) return true;
      continue;
    }
    if (!name.endsWith(".json")) continue;
    const text = readFileSync(path, "utf8");
    if (!text.includes('"choice"')) continue;
    const strip = (value) => {
      if (value && typeof value === "object") {
        if ("choice" in value && "env" in value) {
          delete value.choice;
          return true;
        }
        return Object.values(value).some(strip);
      }
      return false;
    };
    const data = JSON.parse(text);
    if (strip(data)) {
      writeFileSync(path, JSON.stringify(data, null, 2));
      return true;
    }
  }
  return false;
}
