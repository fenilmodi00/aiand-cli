#!/usr/bin/env node
/**
 * Full-matrix sandbox E2E for the ai& CLI against the live gateway.
 *
 * Purpose
 *   Exercises every CLI surface (plumbing, auth, run, models, logs, usage,
 *   orgs, config, login, opencode wiring, init, launcher) against
 *   https://api.aiand.com with a real key. Node >= 22, node: builtins only.
 *   Safe on a workstation (temp state, stubbed keychain) or in a throwaway
 *   box: copy dist + package.json + CHANGELOG.md + scripts/sbx-test.mjs in and
 *   run `node scripts/sbx-test.mjs <cli.js>` with AIAND_API_KEY set.
 *
 * Usage
 *   node scripts/sbx-test.mjs <cli.js>   full live matrix (spends credit)
 *   node scripts/sbx-test.mjs --plan     print every check id, exit 0
 *   node scripts/sbx-test.mjs --smoke    offline subset, no key, no network
 *
 * Env contract
 *   AIAND_API_KEY  required for the full matrix; the real session key.
 *   All CLI state stays under a fresh $TMPDIR/aiand-sbx-XXXXXX (AIAND_HOME / AIAND_CONFIG_DIR
 *   point there); the real home is never touched.
 *
 * WARNING: the full matrix makes a handful of tiny real inference calls and
 * one live key validation — it spends production credit. Run it deliberately.
 *
 * Deliberate gaps (test manually):
 *   - interactive `chat` (needs a TTY; the non-TTY refusal IS covered)
 *   - device/browser login (mints a real machine key) — pasted-key sign-in
 *     is covered instead; the mint path creates server-side credentials a
 *     shared test run must not leave behind.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

/* -------------------------------------------------------------------------- */
/* Scenario layout                                                            */
/* -------------------------------------------------------------------------- */

const S = mkdtempSync(join(tmpdir(), "aiand-sbx-"));
const BIN = join(S, "bin");
const LAUNCHED = join(S, "launched");
const STUB_JS = join(S, "stub.js");
const MAIN_HOME = join(S, "home");
const MAIN_CFG = join(S, "cfg");
const AUTH_HOME = join(S, "auth-home");
const AUTH_CFG = join(S, "auth-cfg");
const CLEAN_HOME = join(S, "clean-home");
const CLEAN_CFG = join(S, "clean-cfg");
const NOCFG = join(S, "nocfg");
// Failing `security` / `secret-tool` first on every scenario PATH: the matrix
// expects the file tier, and on a macOS host the bare PATH would otherwise
// reach /usr/bin/security and sign in (then log out) the real login keychain.
const NOKEYCHAIN = join(S, "nokeychain");
mkdirSync(NOKEYCHAIN, { recursive: true });
for (const tool of ["security", "secret-tool"]) {
  writeFileSync(join(NOKEYCHAIN, tool), "#!/bin/sh\nexit 1\n");
  chmodSync(join(NOKEYCHAIN, tool), 0o755);
}
// A minimal bin dir for the "clean" scenarios. The CLI detects agents by
// spawning `which <bin>`, so a failing `which` shim here is enough to report
// zero agents; /bin then supplies the POSIX essentials. This must precede the
// system dirs on PATH: a VM base image installs real agent binaries into
// /usr/local/bin (and merged-/usr hosts expose /usr/bin/which through /bin),
// which would otherwise leak into the clean scenario.
const CLEAN_BIN = join(S, "clean-bin");
mkdirSync(CLEAN_BIN, { recursive: true });
writeFileSync(join(CLEAN_BIN, "which"), "#!/bin/sh\nexit 1\n");
chmodSync(join(CLEAN_BIN, "which"), 0o755);

const argv = process.argv.slice(2);
const MODE = argv.includes("--plan") ? "plan" : argv.includes("--smoke") ? "smoke" : "full";
const positional = argv.find((a) => !a.startsWith("--"));
const CLI = positional ?? join(process.cwd(), "dist", "index.js");
const KEY = process.env.AIAND_API_KEY ?? "";
// A placeholder session for offline paths that demand one; never sent anywhere.
const SMOKE_KEY = "sk-smoke-local-offline";
const KEY_EFFECTIVE = MODE === "smoke" ? SMOKE_KEY : KEY;

// The clean scenario's PATH: the failing `which` shim first (agent-free even
// when the base image installs real agents into /usr/local/bin), then /bin for
// POSIX essentials. Path discovery is subprocess-free in Node 22
// (fs.accessSync, process.getuid, env-only keychain), so /bin is enough.
const PATH_BARE = `${CLEAN_BIN}:/bin`;
const PATH_REAL = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
const NODE = process.execPath;

// Per-command wall-clock caps. Offline and local commands finish in well under
// a second; the rest wait on the live gateway (catalog, key checks, inference).
const CLI_TIMEOUT_MS = 30_000;
const GATEWAY_TIMEOUT_MS = 60_000;
const WIRING_TIMEOUT_MS = 120_000; // agent on/off + catalog resolution
const INFERENCE_TIMEOUT_MS = 180_000; // a real model call
const INIT_ALL_TIMEOUT_MS = 300_000; // init --all walks every adapter
const RETRY_DELAY_MS = 5_000;
const FOLLOW_ANNOUNCE_TIMEOUT_MS = 15_000;
const FOLLOW_EXIT_TIMEOUT_MS = 10_000;

// Env vars scrubbed from every scenario so parent-machine state can never
// leak into the CLI's resolution or the recorded stub environments.
const SCRUB = [
  "XDG_CONFIG_HOME",
  "AIAND_PROFILE",
  "AIAND_BASE_URL",
  "AIAND_AUTH_URL",
  "AIAND_CONFIG_DIR",
  "AIAND_HOME",
  "AIAND_KEY_STORAGE",
  "AIAND_IDE_SECRET_PLAINTEXT",
  "OPENCODE_CONFIG_CONTENT",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "DSH_HOME",
  "AIAND_DSH_API_KEY",
  "PI_CODING_AGENT_DIR",
  "PI_CONFIG_DIR",
  "XDG_DATA_HOME",
  "PI_CODING_AGENT_SESSION_DIR",
  "COPILOT_HOME",
  "COPILOT_PROVIDERS_CONFIG",
  "COPILOT_MODEL",
  "COPILOT_OFFLINE",
  "FORCE_COLOR",
  "STUB_EXIT",
];

function baseEnv(home, cfg, { stubs = true, key = KEY_EFFECTIVE, extra = {} } = {}) {
  const env = { ...process.env, NO_COLOR: "1", CI: "1" };
  for (const name of SCRUB) delete env[name];
  env.AIAND_HOME = home;
  env.AIAND_CONFIG_DIR = cfg;
  if (key === null) delete env.AIAND_API_KEY;
  else env.AIAND_API_KEY = key;
  env.PATH = `${NOKEYCHAIN}:${stubs ? `${BIN}:${PATH_REAL}` : PATH_BARE}`;
  Object.assign(env, extra);
  return env;
}
const mainEnv = (extra = {}) => baseEnv(MAIN_HOME, MAIN_CFG, { extra });
const authEnv = (extra = {}) => baseEnv(AUTH_HOME, AUTH_CFG, { stubs: false, key: null, extra });
const cleanEnv = (extra = {}) => baseEnv(CLEAN_HOME, CLEAN_CFG, { stubs: false, extra });
const noKeyEnv = () => baseEnv(NOCFG, NOCFG, { stubs: false, key: null });

/* -------------------------------------------------------------------------- */
/* CLI helper + small utilities                                               */
/* -------------------------------------------------------------------------- */

function cli(args, { env, timeout = CLI_TIMEOUT_MS, input } = {}) {
  const r = spawnSync(NODE, [CLI, ...args], { env, encoding: "utf8", timeout, input: input ?? "" });
  return {
    status: r.error && r.status === null ? -1 : r.status,
    stdout: r.stdout ?? "",
    // Node prints runtime warnings (e.g. ExperimentalWarning plus
    // its "(Use `node --trace-warnings ...`)" continuation line) to stderr on
    // every invocation; strip them so assertions see CLI output.
    stderr: String(r.stderr ?? "")
      .split("\n")
      .filter((line) => !/^\((node:\d+|Use `node)/.test(line))
      .join("\n"),
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

// Inference responses stream reasoning before content on reasoning models, so
// the tiny prompts get a budget that survives a reasoning preamble (50 would
// read as an empty answer and mask real failures).
const MAX_TOKENS = "512";

const OPENCODE_CFG = join(MAIN_HOME, ".config", "opencode", "opencode.json");
const CLAUDE_CFG = join(MAIN_HOME, ".claude", "settings.json");
const CODEX_CFG = join(MAIN_HOME, ".codex", "aiand.config.toml");
const DSH_PATCH = join(MAIN_HOME, ".dsh", "cordis.patch.yml");
const DSH_CREDS = join(MAIN_HOME, ".dsh", ".credentials.yaml");
const PI_DIR = join(MAIN_HOME, ".pi", "agent");
const PI_MODELS = join(PI_DIR, "models.json");
const PI_AUTH = join(PI_DIR, "auth.json");
const PI_SETTINGS = join(PI_DIR, "settings.json");
// omp's config root honors PI_CONFIG_DIR like pi's honors
// PI_CODING_AGENT_DIR; the scenarios scrub both, so the default
// ~/.omp/agent is what the matrix wires.
const OMP_DIR = join(MAIN_HOME, ".omp", "agent");
const OMP_MODELS = join(OMP_DIR, "models.yml");
const OMP_CONFIG = join(OMP_DIR, "config.yml");
const COPILOT_DIR = join(MAIN_HOME, ".copilot");
const COPILOT_PROVIDERS = join(COPILOT_DIR, "providers.json");
const COPILOT_SETTINGS = join(COPILOT_DIR, "settings.json");
const COPILOT_DB = join(COPILOT_DIR, "data.db");

function seedFile(state, path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  state.seeds.set(path, readFileSync(path));
  return path;
}

function sameBytes(path, expected) {
  try {
    return readFileSync(path).equals(expected);
  } catch {
    return false;
  }
}

function readCopilotDb(...sqls) {
  const db = new DatabaseSync(COPILOT_DB, { readOnly: true });
  try {
    return sqls.map((sql) => db.prepare(sql).all());
  } finally {
    db.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Sandbox setup                                                              */
/* -------------------------------------------------------------------------- */

const STUB_NAMES = ["opencode", "claude", "codex", "pi", "omp", "copilot", "copilot-app", "dsh"];

function writeStubs() {
  mkdirSync(BIN, { recursive: true });
  mkdirSync(LAUNCHED, { recursive: true });
  writeFileSync(
    STUB_JS,
    `const fs = require("node:fs");
const name = process.argv[2];
const args = process.argv.slice(3);
const record = { name, args, env: { ...process.env } };
// The launcher deletes a --settings throwaway after exit: keep what it held.
const settingsAt = args.indexOf("--settings");
if (settingsAt !== -1) {
  const file = args[settingsAt + 1];
  record.settingsMode = fs.statSync(file).mode & 0o777;
  record.settings = JSON.parse(fs.readFileSync(file, "utf8"));
}
if (process.env.DSH_HOME) {
  // dsh's throwaway home: capture what it held before cleanup removes it.
  try {
    record.dshCredsMode = fs.statSync(process.env.DSH_HOME + "/.credentials.yaml").mode & 0o777;
    record.dshPatch = fs.readFileSync(process.env.DSH_HOME + "/cordis.patch.yml", "utf8");
  } catch {
    record.dshPatch = null;
  }
}
// Same for the PI_CODING_AGENT_DIR overlay the launcher deletes
// after exit: pi's overlay holds models.json + auth.json, omp's
// holds models.yml + config.yml (YAML text, not JSON).
if (process.env.PI_CODING_AGENT_DIR) {
  const dir = process.env.PI_CODING_AGENT_DIR;
  if (fs.existsSync(dir + "/auth.json")) {
    record.overlayMode = fs.statSync(dir + "/auth.json").mode & 0o777;
    record.overlayAuth = JSON.parse(fs.readFileSync(dir + "/auth.json", "utf8"));
    record.overlayModels = JSON.parse(fs.readFileSync(dir + "/models.json", "utf8"));
  } else {
    record.overlayMode = fs.statSync(dir + "/models.yml").mode & 0o777;
    record.overlayModels = fs.readFileSync(dir + "/models.yml", "utf8");
    record.overlayConfig = fs.readFileSync(dir + "/config.yml", "utf8");
  }
}
// ...and the COPILOT_HOME overlay (providers.json + settings.json).
if (process.env.COPILOT_HOME) {
  const dir = process.env.COPILOT_HOME;
  record.copilotMode = fs.statSync(dir + "/providers.json").mode & 0o777;
  record.copilotProviders = JSON.parse(fs.readFileSync(dir + "/providers.json", "utf8"));
  record.copilotSettings = JSON.parse(fs.readFileSync(dir + "/settings.json", "utf8"));
}
fs.writeFileSync(${JSON.stringify(LAUNCHED)} + "/" + name + ".json", JSON.stringify(record, null, 2));
process.exit(Number(process.env.STUB_EXIT ?? 0));
`,
  );
  chmodSync(STUB_JS, 0o755);
  for (const name of STUB_NAMES) {
    const path = join(BIN, name);
    writeFileSync(path, `#!/bin/sh\nexec "${NODE}" ${STUB_JS} ${name} "$@"\n`);
    chmodSync(path, 0o755);
  }
}

// Offline catalog so --smoke never needs the live gateway: the launcher
// bad-model check validates --model against the CLI's 6h catalog cache.
function seedSmokeCatalogCache() {
  const models = [
    ["zai-org/glm-5.3", "GLM 5.3", "zai-org", ["text", "tool_calling"], "0.60", "2.40"],
    ["google/gemma-4-31b-it", "Gemma 4 31B", "google", ["text", "vision"], "0.20", "0.50"],
  ].map(([id, name, provider, capabilities, input, output]) => ({
    id,
    name,
    object: "model",
    created: 1,
    owned_by: provider,
    provider,
    context_window: 200000,
    capabilities,
    reasoning_efforts: null,
    reasoning_effort_default: null,
    description: null,
    currency: "usd",
    input_per_1m: input,
    output_per_1m: output,
    cached_input_per_1m: "0.10",
  }));
  writeFileSync(
    join(MAIN_CFG, "model-catalog.json"),
    JSON.stringify({ fetchedAt: Date.now(), baseUrl: "https://api.aiand.com", models }, null, 2),
  );
}

function cleanupSandbox() {
  rmSync(S, { recursive: true, force: true });
}

function setup() {
  for (const dir of [MAIN_CFG, AUTH_CFG, CLEAN_CFG, NOCFG, BIN, LAUNCHED]) {
    mkdirSync(dir, { recursive: true });
  }
  writeStubs();
  if (MODE === "smoke") seedSmokeCatalogCache();
}

/* -------------------------------------------------------------------------- */
/* Shared state                                                               */
/* -------------------------------------------------------------------------- */

let catalog = null;

function loadCatalog() {
  if (catalog) return catalog;
  if (MODE === "smoke") return null;
  const r = cli(["models", "--json"], { env: mainEnv(), timeout: GATEWAY_TIMEOUT_MS });
  catalog = parseJson(r.stdout);
  return catalog;
}

function modelId() {
  const models = loadCatalog();
  if (Array.isArray(models) && models.length > 0) {
    for (const preferred of [
      "zai-org/glm-5.3",
      "moonshotai/kimi-k3",
      "qwen/qwen3.8-27b",
      "google/gemma-4-31b-it",
    ]) {
      if (models.some((m) => m.id === preferred)) return preferred;
    }
    return models[0].id;
  }
  return "zai-org/glm-5.3";
}

/* -------------------------------------------------------------------------- */
/* Check plumbing                                                             */
/* -------------------------------------------------------------------------- */

const results = [];

function makeT() {
  return {
    fails: [],
    verdict: null,
    detail: null,
    ok(cond, label, detail = "") {
      if (!cond) this.fails.push(detail ? `${label} (${detail})` : label);
    },
  };
}

function report(check, verdict, detail) {
  results.push({ id: check.id, section: check.section, verdict, detail });
  console.log(`${verdict} ${check.id} — ${detail}`);
}

async function execute(check) {
  const t = makeT();
  try {
    await check.run(t);
  } catch (error) {
    t.fails.push(`threw: ${error?.message ?? error}`);
  }
  const verdict = t.verdict ?? (t.fails.length > 0 ? "FAIL" : "PASS");
  const detail = t.detail ?? (t.fails.length > 0 ? t.fails.join("; ") : "ok");
  report(check, verdict, detail);
}

/* -------------------------------------------------------------------------- */
/* Adapter seeds                                                              */
/* -------------------------------------------------------------------------- */

const agentStates = {};
const agentState = (id) => (agentStates[id] ??= { seeds: new Map(), created: [] });

const AGENT_DEFS = {
  opencode: {
    bin: "opencode",
    seed(state) {
      state.created = [];
      state.cfg = seedFile(
        state,
        OPENCODE_CFG,
        // Trailing newline, like a real editor-written opencode.json.
        `${JSON.stringify({ theme: "dark", provider: { anthropic: { name: "Anthropic" } }, keep: true }, null, 2)}\n`,
      );
    },
    contents(t) {
      const cfg = parseJson(readFileSync(OPENCODE_CFG, "utf8")) ?? {};
      const aiand = cfg.provider?.aiand ?? {};
      t.ok(aiand.options?.apiKey === KEY, "provider.aiand.options.apiKey is the session key");
      t.ok(
        aiand.options?.baseURL === "https://api.aiand.com/v1",
        "provider.aiand baseURL is gateway /v1",
        String(aiand.options?.baseURL),
      );
      t.ok(
        cfg.model === `aiand/${modelId()}`,
        `root model ref is aiand/${modelId()}`,
        String(cfg.model),
      );
      t.ok(
        !Array.isArray(cfg.enabled_providers) && !Array.isArray(cfg.disabled_providers),
        "persistent config carries no provider lockdown",
      );
      t.ok(cfg.provider?.anthropic?.name === "Anthropic", "foreign provider survives");
    },
  },
  claude: {
    bin: "claude",
    seed(state) {
      state.created = [];
      state.cfg = seedFile(
        state,
        CLAUDE_CFG,
        `${JSON.stringify({ theme: "dark", env: { KEEP_ME: "1" }, permissions: { allow: ["Bash(ls:*)"] } }, null, 2)}\n`,
      );
    },
    contents(t) {
      const cfg = parseJson(readFileSync(CLAUDE_CFG, "utf8")) ?? {};
      const env = cfg.env ?? {};
      t.ok(env.ANTHROPIC_AUTH_TOKEN === KEY, "env.ANTHROPIC_AUTH_TOKEN is the session key");
      t.ok(env.ANTHROPIC_API_KEY === "", "env.ANTHROPIC_API_KEY is blanked");
      t.ok(
        env.ANTHROPIC_BASE_URL === "https://api.aiand.com",
        "env.ANTHROPIC_BASE_URL is the gateway origin",
        String(env.ANTHROPIC_BASE_URL),
      );
      const ids = (loadCatalog() ?? []).map((m) => m.id);
      t.ok(
        ids.length === 0 || ids.includes(env.ANTHROPIC_DEFAULT_SONNET_MODEL),
        "sonnet slot is a catalog id",
        String(env.ANTHROPIC_DEFAULT_SONNET_MODEL),
      );
      t.ok(cfg.permissions?.deny?.includes("WebSearch"), "WebSearch denied");
      const pickerIds = (cfg.modelPicker?.options ?? []).map((row) => row.model).sort();
      t.ok(
        ids.length === 0 || pickerIds.join() === [...ids].sort().join(),
        "the /model picker lists every catalog model",
        `${pickerIds.length} rows, ${ids.length} catalog models`,
      );
      t.ok(env.KEEP_ME === "1" && cfg.theme === "dark", "user settings survive");
    },
  },
  codex: {
    bin: "codex",
    seed(state) {
      state.created = [CODEX_CFG];
      state.cfg = CODEX_CFG;
    },
    contents(t) {
      const text = existsSync(CODEX_CFG) ? readFileSync(CODEX_CFG, "utf8") : "";
      t.ok(text.includes('command = "aiand"'), "the profile asks aiand for the key");
      t.ok(!text.includes(KEY), "the key is not in the profile");
      t.ok(
        text.includes('base_url = "https://api.aiand.com/v1"'),
        "provider base_url is gateway /v1",
      );
      t.ok(text.includes('wire_api = "responses"'), "Responses wire");
      t.ok(text.includes('web_search = "disabled"'), "hosted web search off");
      const model = /^model = "(.+)"$/m.exec(text)?.[1];
      const ids = (loadCatalog() ?? []).map((m) => m.id);
      t.ok(ids.length === 0 || ids.includes(model), "model is a catalog id", String(model));
    },
  },
  dsh: {
    bin: "dsh",
    seed(state) {
      state.created = [];
      // A foreign patch row and a foreign credential ref: the
      // user's own dsh composition, which on/off must leave
      // byte for byte alone (the seeds check in
      // verifyOffRestore).
      state.cfg = seedFile(
        state,
        DSH_PATCH,
        "# user comment\n- id: session-persistence-jsonl\n  name: '@deepseek-ai/dsh-session-persistence-jsonl'\n  config:\n    root: ~/.dsh/sessions\n",
      );
      seedFile(state, DSH_CREDS, "version: 1\nrefs:\n  USER_DSH_KEY: sk-user-dsh\n");
    },
    contents(t) {
      const text = readFileSync(DSH_PATCH, "utf8");
      t.ok(text.includes("- id: llm-pi-ai"), "the llm-pi-ai route row exists");
      t.ok(text.includes("x-aiand: true"), "ownership marker present");
      t.ok(
        text.includes("apiKeyEnv: AIAND_DSH_API_KEY"),
        "the key resolves through the credential ref",
      );
      t.ok(text.includes("baseURL: https://api.aiand.com/v1"), "provider baseURL is gateway /v1");
      t.ok(
        text.includes("- id: agent-default-model") && text.includes("provider: aiand"),
        "the default-model row routes aiand",
      );
      const model = /- id: agent-default-model[\s\S]*?\n\s+model: (.+)$/m.exec(text)?.[1];
      const ids = (loadCatalog() ?? []).map((m) => m.id);
      t.ok(
        ids.length === 0 || ids.includes(model?.replace(/^'|'$/g, "")),
        "default model is a catalog id",
        String(model),
      );
      t.ok(
        text.includes("- id: session-persistence-jsonl") && text.includes("# user comment"),
        "user patch row survives",
      );
      t.ok(!text.includes(KEY), "the key is not in the patch file");
      const creds = readFileSync(DSH_CREDS, "utf8");
      t.ok(
        creds.includes(`AIAND_DSH_API_KEY: ${KEY}`),
        "the credentials file carries the session key",
      );
      t.ok(creds.includes("USER_DSH_KEY: sk-user-dsh"), "user credential ref survives");
      t.ok(
        (statSync(DSH_CREDS).mode & 0o777) === 0o600,
        "credentials file is 0600",
        (statSync(DSH_CREDS).mode & 0o777).toString(8),
      );
    },
    // The seeded files survive off byte-identically (the
    // seeds check above); a $DSH_HOME with nothing seeded is
    // the other half of the contract: `on` creates both
    // files and `off` removes them again.
    verifyOffExtra(t) {
      const scratch = join(S, "dsh-created");
      const env = mainEnv({ DSH_HOME: scratch });
      const on = cli(["dsh", "on", "--json"], {
        env,
        timeout: WIRING_TIMEOUT_MS,
      });
      okStatus(t, on, "dsh on (created-files scenario)");
      const off = cli(["dsh", "off", "--json"], {
        env,
        timeout: GATEWAY_TIMEOUT_MS,
      });
      okStatus(t, off, "dsh off (created-files scenario)");
      t.ok(!existsSync(join(scratch, "cordis.patch.yml")), "aiand-created patch file removed");
      t.ok(
        !existsSync(join(scratch, ".credentials.yaml")),
        "aiand-created credentials file removed",
      );
    },
  },
  pi: {
    bin: "pi",
    seed(state) {
      state.created = [];
      seedFile(
        state,
        PI_MODELS,
        `${JSON.stringify(
          { providers: { openai: { name: "OpenAI", baseUrl: "https://api.openai.com/v1" } } },
          null,
          2,
        )}\n`,
      );
      seedFile(
        state,
        PI_AUTH,
        `${JSON.stringify({ openai: { type: "api_key", key: "sk-user-openai" } }, null, 2)}\n`,
      );
      seedFile(state, PI_SETTINGS, `${JSON.stringify({ theme: "dark" }, null, 2)}\n`);
    },
    contents(t) {
      const models = parseJson(readFileSync(PI_MODELS, "utf8")) ?? {};
      const aiand = models.providers?.aiand ?? {};
      t.ok(aiand.api === "openai-completions", "provider speaks openai-completions");
      t.ok(
        aiand.baseUrl === "https://api.aiand.com/v1",
        "provider baseUrl is gateway /v1",
        String(aiand.baseUrl),
      );
      // `aiand models --json` sorts by id while the provider array keeps
      // gateway order: compare the sets, not the sequences.
      const ids = (loadCatalog() ?? []).map((m) => m.id);
      const modelIds = (aiand.models ?? []).map((m) => m.id);
      t.ok(
        ids.length === 0 || [...modelIds].sort().join() === [...ids].sort().join(),
        "provider lists every catalog model",
        `${modelIds.length} rows, ${ids.length} catalog models`,
      );
      const auth = parseJson(readFileSync(PI_AUTH, "utf8")) ?? {};
      t.ok(
        auth.aiand?.key === KEY && auth.aiand?.managedBy === "aiand",
        "auth.json aiand credential carries the key and marker",
      );
      t.ok(auth.openai?.key === "sk-user-openai", "user credential survives");
      const settings = parseJson(readFileSync(PI_SETTINGS, "utf8")) ?? {};
      t.ok(
        settings.defaultProvider === "aiand" && settings.defaultModel === modelId(),
        "settings pin provider and model",
        `${settings.defaultProvider}/${settings.defaultModel}`,
      );
      t.ok(settings.theme === "dark", "user settings survive");
    },
  },
  omp: {
    bin: "omp",
    seed(state) {
      state.created = [];
      // The same seeds scripts/e2e.mjs uses: a user-owned
      // models.yml (comment + openai provider) and a config.yml
      // with an unrelated key and a foreign default model.
      seedFile(
        state,
        OMP_MODELS,
        "# user's own providers, kept by aiand\nproviders:\n  openai:\n    baseUrl: https://api.openai.com/v1\n    apiKey: sk-user-openai\n",
      );
      seedFile(
        state,
        OMP_CONFIG,
        "symbolPreset: unicode\nmodelRoles:\n  default: anthropic/claude-haiku-4-5\n",
      );
    },
    contents(t) {
      // Text assertions on the same shapes e2e checks: the adapter's
      // YAML editors are covered by the unit suite (agents-omp).
      const models = readFileSync(OMP_MODELS, "utf8");
      t.ok(models.includes("aiand:"), "providers.aiand block exists");
      t.ok(
        models.includes("baseUrl: https://api.aiand.com/v1"),
        "provider baseUrl is gateway /v1",
        models.split("\n").find((line) => line.includes("baseUrl")) ?? "missing",
      );
      t.ok(models.includes(`apiKey: ${KEY}`), "provider block carries the session key");
      t.ok(models.includes("managedBy: aiand"), "ownership marker present");
      t.ok(
        models.includes("# user's own providers") &&
          models.includes("https://api.openai.com/v1") &&
          models.includes("apiKey: sk-user-openai"),
        "user comment and openai provider survive",
      );
      const config = readFileSync(OMP_CONFIG, "utf8");
      t.ok(
        config.includes(`default: aiand/${modelId()}`),
        "modelRoles.default pinned at the catalog model",
        config.split("\n").find((line) => line.includes("default:")) ?? "missing",
      );
      t.ok(config.includes("symbolPreset: unicode"), "user config survives");
    },
  },
  copilot: {
    bin: "copilot",
    seed(state) {
      state.created = [];
      seedFile(
        state,
        COPILOT_PROVIDERS,
        `${JSON.stringify(
          {
            providers: [
              {
                name: "fireworks",
                type: "openai",
                baseUrl: "https://api.fireworks.ai/inference/v1",
              },
            ],
            models: [{ id: "kimi", provider: "fireworks" }],
          },
          null,
          2,
        )}\n`,
      );
      seedFile(
        state,
        COPILOT_SETTINGS,
        `${JSON.stringify({ theme: "dark", model: "gpt-5.1" }, null, 2)}\n`,
      );
    },
    contents(t) {
      const providers = parseJson(readFileSync(COPILOT_PROVIDERS, "utf8")) ?? {};
      const aiand = (providers.providers ?? []).find((row) => row?.name === "aiand");
      t.ok(aiand?.type === "openai", "provider speaks the openai dialect", String(aiand?.type));
      t.ok(
        aiand?.baseUrl === "https://api.aiand.com/v1",
        "provider baseUrl is gateway /v1",
        String(aiand?.baseUrl),
      );
      t.ok(aiand?.apiKey === KEY, "provider row carries the session key");
      t.ok(
        providers.providers?.some((row) => row?.name === "fireworks") &&
          providers.models?.some((row) => row?.id === "kimi"),
        "foreign provider and model rows survive",
      );
      const ids = (loadCatalog() ?? []).map((m) => m.id);
      const modelIds = (providers.models ?? [])
        .filter((row) => row?.provider === "aiand")
        .map((row) => row.id);
      t.ok(
        ids.length === 0 || [...modelIds].sort().join() === [...ids].sort().join(),
        "one model row per catalog model",
        `${modelIds.length} rows, ${ids.length} catalog models`,
      );
      const settings = parseJson(readFileSync(COPILOT_SETTINGS, "utf8")) ?? {};
      t.ok(
        settings.model === `aiand/${modelId()}`,
        `selection is aiand/${modelId()}`,
        String(settings.model),
      );
      t.ok(settings.theme === "dark", "user settings survive");
    },
  },
  "copilot-app": {
    bin: "copilot",
    seed(state) {
      state.created = [];
      rmSync(COPILOT_DB, { force: true });
      mkdirSync(COPILOT_DIR, { recursive: true });
      // `on` refuses a missing db (the app owns its creation), so the fixture
      // stands in for a first app launch. Schema per the adapter's sqlite.ts.
      const db = new DatabaseSync(COPILOT_DB);
      db.exec(`
CREATE TABLE model_providers (id TEXT PRIMARY KEY, name TEXT, created_at TEXT, updated_at TEXT, type TEXT, settings_json TEXT, account_id TEXT);
CREATE TABLE provider_models (id TEXT PRIMARY KEY, provider_id TEXT, model_id TEXT, wire_model TEXT, display_name TEXT, max_prompt_tokens INTEGER, max_output_tokens INTEGER, wire_api_override TEXT, created_at TEXT, updated_at TEXT, supported_reasoning_efforts TEXT, UNIQUE(provider_id, model_id));
INSERT INTO model_providers (id, name, type, settings_json) VALUES ('user-1', 'mine', 'openai', '{}');
`);
      db.close();
    },
    contents(t) {
      const [providers, models] = readCopilotDb(
        "SELECT id, name, settings_json FROM model_providers WHERE id LIKE 'aiand-%';",
        "SELECT model_id FROM provider_models WHERE provider_id LIKE 'aiand-%';",
      );
      t.ok(
        providers.length === 1 && providers[0].name === "ai&",
        "one owned provider row",
        JSON.stringify(providers),
      );
      const settings = parseJson(String(providers[0]?.settings_json ?? "{}")) ?? {};
      t.ok(
        settings.baseUrl === "https://api.aiand.com/v1",
        "provider baseUrl is gateway /v1",
        String(settings.baseUrl),
      );
      t.ok(
        String(settings.headersJson ?? "").includes(`Bearer ${KEY}`),
        "the key rides the Authorization header",
      );
      const ids = (loadCatalog() ?? []).map((m) => m.id);
      const modelIds = models.map((row) => row.model_id);
      t.ok(
        ids.length === 0 || [...modelIds].sort().join() === [...ids].sort().join(),
        "one model row per catalog model",
        `${modelIds.length} rows, ${ids.length} catalog models`,
      );
    },
    verifyOffExtra(t) {
      // The db is the app's own file: off must strip our rows, keep the
      // user's, and never delete the database itself.
      const [ours, foreign] = readCopilotDb(
        "SELECT id FROM model_providers WHERE id LIKE 'aiand-%';",
        "SELECT id FROM model_providers WHERE id = 'user-1';",
      );
      t.ok(ours.length === 0, "our provider row is gone after off");
      t.ok(foreign.length === 1, "the user's provider row survives off");
      t.ok(existsSync(COPILOT_DB), "the app's database file survives off");
    },
  },
};

const WIRING_ONE = ["opencode", "claude", "codex", "pi", "omp", "copilot", "copilot-app", "dsh"];

// Whole-registry assertion (`status` lists every shipped adapter) reads the
// shipped registry instead of a hand-kept list, which goes stale silently as
// adapters ship. WIRING_ONE stays the cast that has seed fixtures + stub
// binaries; `init --all` counts that cast, since it wires only DETECTED agents.
const { AGENTS: SHIPPED_AGENTS } = await import(
  pathToFileURL(join(dirname(CLI), "agents", "registry.js")).href
);
const SHIPPED_AGENT_IDS = SHIPPED_AGENTS.map((agent) => agent.id).sort();

function verifyOffRestore(t, id) {
  const state = agentStates[id];
  for (const [path, bytes] of state.seeds) {
    t.ok(sameBytes(path, bytes), `seed restored byte-for-byte: ${path}`);
  }
  for (const created of state.created) {
    t.ok(!existsSync(created), `aiand-created path removed: ${created}`);
  }
  const extra = AGENT_DEFS[id].verifyOffExtra;
  if (extra) extra(t, state);
}

function stubRecord(name) {
  return parseJson(readFileSync(join(LAUNCHED, `${name}.json`), "utf8"));
}

/* -------------------------------------------------------------------------- */
/* Checks                                                                     */
/* -------------------------------------------------------------------------- */

const checks = [];
const define = (section, id, run, { smoke = false } = {}) =>
  checks.push({ section, id, run, smoke });

function okStatus(t, r, label, expect = 0) {
  t.ok(
    r.status === expect,
    `${label} exits ${expect}`,
    `exit ${r.status}: ${(r.stderr || r.stdout).split("\n")[0]}`,
  );
}

/* == plumbing == */

define(
  "plumbing",
  "plumbing-version",
  (t) => {
    const pkg = parseJson(readFileSync(join(dirname(CLI), "..", "package.json"), "utf8"));
    t.ok(pkg?.version !== undefined, "package.json next to the dist tree reads");
    const r = cli(["--version"], { env: mainEnv() });
    okStatus(t, r, "--version");
    t.ok(
      r.stdout.trim() === pkg?.version,
      `--version equals package version ${pkg?.version}`,
      r.stdout.trim(),
    );
  },
  { smoke: true },
);

define(
  "plumbing",
  "plumbing-help",
  (t) => {
    const r = cli(["--help"], { env: mainEnv() });
    okStatus(t, r, "--help");
    for (const name of [
      "login",
      "logout",
      "whoami",
      "run",
      "chat",
      "models",
      "logs",
      "usage",
      "orgs",
      "config",
      "init",
      "status",
      "run-agent",
      "key",
    ]) {
      t.ok(r.stdout.includes(name), `help lists ${name}`);
    }
  },
  { smoke: true },
);

define(
  "plumbing",
  "plumbing-unknown",
  (t) => {
    const unknown = cli(["definitely-not-a-command"], { env: mainEnv() });
    t.ok(unknown.status === 127, "unknown command exits 127", `exit ${unknown.status}`);
    t.ok(
      unknown.stderr.includes("Unknown command"),
      "stderr names the unknown command",
      unknown.stderr.split("\n")[0],
    );
    // The suggestion machinery: a near-miss gets the "Did you mean" hint.
    const nearMiss = cli(["mdels"], { env: mainEnv() });
    t.ok(nearMiss.status === 127, "near-miss exits 127");
    t.ok(
      nearMiss.stderr.includes("Did you mean"),
      "near-miss suggests a command",
      nearMiss.stderr.split("\n").join(" "),
    );
  },
  { smoke: true },
);

define(
  "plumbing",
  "plumbing-chat-refusal",
  (t) => {
    const r = cli(["chat"], { env: mainEnv() });
    t.ok(r.status === 1, "chat with non-TTY stdin exits 1", `exit ${r.status}`);
    t.ok(
      r.stderr.includes("needs an interactive terminal"),
      "refusal names the interactive terminal requirement",
      r.stderr.split("\n")[0],
    );
  },
  { smoke: true },
);

/* == auth == */

define("auth", "auth-whoami", (t) => {
  const r = cli(["whoami", "--json"], { env: mainEnv(), timeout: GATEWAY_TIMEOUT_MS });
  okStatus(t, r, "whoami --json");
  const who = parseJson(r.stdout) ?? {};
  t.ok(
    typeof who.user?.email === "string" && who.user.email.length > 0,
    "user.email non-empty",
    JSON.stringify(who.user),
  );
  t.ok(who.source === "AIAND_API_KEY", "source is AIAND_API_KEY", String(who.source));
  t.ok(who.api_url === "https://api.aiand.com", "api_url is the gateway", String(who.api_url));
  t.ok(
    typeof who.key === "string" && who.key.startsWith("sk-") && who.key !== KEY,
    "key is masked, never raw",
    String(who.key),
  );
});

define("auth", "auth-key-export", (t) => {
  const r = cli(["key", "export"], { env: mainEnv() });
  okStatus(t, r, "key export");
  t.ok(r.stdout.trim() === KEY, "key export prints the env key", r.stdout.trim().slice(0, 6));
});

define("auth", "auth-whoami-local", (t) => {
  const r = cli(["whoami", "--local", "--json"], { env: mainEnv(), timeout: GATEWAY_TIMEOUT_MS });
  okStatus(t, r, "whoami --local --json");
  const who = parseJson(r.stdout) ?? {};
  t.ok(who.profile === "default", "profile is default", String(who.profile));
});

define("auth", "auth-missing-key", (t) => {
  const r = cli(["whoami"], { env: noKeyEnv() });
  t.ok(r.status === 2, "whoami without any key exits 2", `exit ${r.status}`);
  t.ok(
    (r.stderr + r.stdout).includes("Not logged in"),
    "refusal says Not logged in",
    r.stderr.split("\n")[0],
  );
});

define("auth", "auth-public-models", (t) => {
  const r = cli(["models", "--json"], { env: noKeyEnv(), timeout: GATEWAY_TIMEOUT_MS });
  okStatus(t, r, "models --json without a key");
  const models = parseJson(r.stdout) ?? [];
  t.ok(models.length > 0, "public catalog lists models", String(models.length));
  t.ok(
    models.every((m) => m.currency === "usd"),
    "public catalog priced in usd",
  );
});

define("auth", "auth-status-env", (t) => {
  const r = cli(["status"], { env: mainEnv(), timeout: GATEWAY_TIMEOUT_MS });
  okStatus(t, r, "status");
  const out = r.stdout + r.stderr;
  t.ok(
    out.includes("AIAND_API_KEY"),
    "status names the env key source",
    out.split("\n").slice(0, 4).join(" | "),
  );
  t.ok(out.includes("opencode"), "status lists the opencode agent");
});
define("run", "run-no-stream-json", (t) => {
  // Explicit -m: the "auto" alias is account-gated (covered by the run-stream
  // WARN path), so shape assertions pin a real catalog id.
  const r = cli(
    [
      "run",
      "-m",
      modelId(),
      "--no-stream",
      "--json",
      "--max-tokens",
      MAX_TOKENS,
      "Reply with the single word: ok",
    ],
    { env: mainEnv(), timeout: INFERENCE_TIMEOUT_MS },
  );
  okStatus(t, r, "run --no-stream --json");
  const body = parseJson(r.stdout) ?? {};
  const content = body.choices?.[0]?.message?.content;
  t.ok(
    typeof content === "string" && content.length > 0,
    "choices[0].message.content non-empty",
    r.stdout.slice(0, 200),
  );
  t.ok(body.usage !== null && typeof body.usage === "object", "usage object present");
});
define("run", "run-stdin", (t) => {
  const id = modelId();
  const r = cli(
    ["run", "-m", id, "--no-stream", "--max-tokens", MAX_TOKENS, "Reply with the single word: ok"],
    { env: mainEnv(), timeout: INFERENCE_TIMEOUT_MS, input: "context-line" },
  );
  okStatus(t, r, "run with piped stdin");
  t.ok(r.stdout.trim().length > 0, "non-empty answer", (r.stderr || r.stdout).split("\n")[0]);
});

define("run", "run-stream", (t) => {
  const id = modelId();
  const r = cli(["run", "-m", id, "--max-tokens", MAX_TOKENS, "Reply with the single word: ok"], {
    env: mainEnv(),
    timeout: INFERENCE_TIMEOUT_MS,
  });
  okStatus(t, r, `run -m ${id} (stream)`);
  t.ok(r.stdout.trim().length > 0, "streamed stdout non-empty");
  t.ok(r.stderr.includes("·"), "stderr footer present", r.stderr.split("\n").slice(-3).join(" | "));
});

define("run", "run-model", (t) => {
  const id = modelId();
  const r = cli(
    ["run", "-m", id, "--no-stream", "--max-tokens", MAX_TOKENS, "Reply with the single word: ok"],
    { env: mainEnv(), timeout: INFERENCE_TIMEOUT_MS },
  );
  okStatus(t, r, `run -m ${id}`);
  t.ok(r.stdout.trim().length > 0, "non-empty answer", (r.stderr || r.stdout).split("\n")[0]);
});

define("run", "run-system", (t) => {
  const id = modelId();
  const r = cli(
    [
      "run",
      "--system",
      "be terse",
      "-m",
      id,
      "--no-stream",
      "--max-tokens",
      MAX_TOKENS,
      "Reply with the single word: ok",
    ],
    { env: mainEnv(), timeout: INFERENCE_TIMEOUT_MS },
  );
  okStatus(t, r, "run --system");
  t.ok(r.stdout.trim().length > 0, "non-empty answer", (r.stderr || r.stdout).split("\n")[0]);
});

define("run", "run-quiet", (t) => {
  const id = modelId();
  const r = cli(
    [
      "run",
      "-q",
      "-m",
      id,
      "--no-stream",
      "--max-tokens",
      MAX_TOKENS,
      "Reply with the single word: ok",
    ],
    { env: mainEnv(), timeout: INFERENCE_TIMEOUT_MS },
  );
  okStatus(t, r, "run -q");
  t.ok(r.stderr === "", "stderr empty (no stats footer)", r.stderr.split("\n")[0]);
});

define("run", "run-bad-model", (t) => {
  const r = cli(["run", "-m", "definitely-bogus", "--no-stream", "hi"], {
    env: mainEnv(),
    timeout: INFERENCE_TIMEOUT_MS,
  });
  t.ok(r.status === 1, "unknown model exits 1", `exit ${r.status}`);
  t.ok(
    (r.stderr + r.stdout).trim().length > 0,
    "error surfaced",
    (r.stderr || r.stdout).split("\n")[0],
  );
});

define("run", "run-no-prompt", (t) => {
  const r = cli(["run"], { env: mainEnv(), timeout: GATEWAY_TIMEOUT_MS, input: "" });
  t.ok(r.status === 1, "run with no prompt exits 1", `exit ${r.status}`);
  t.ok(
    (r.stderr + r.stdout).includes("No prompt given"),
    "refusal names the missing prompt",
    r.stderr.split("\n")[0],
  );
});

/* == models == */

define("models", "models-json", (t) => {
  const r = cli(["models", "--json"], { env: mainEnv(), timeout: GATEWAY_TIMEOUT_MS });
  okStatus(t, r, "models --json");
  const models = parseJson(r.stdout) ?? [];
  t.ok(models.length > 0, "catalog non-empty", String(models.length));
  t.ok(
    models.every((m) => typeof m.id === "string" && Array.isArray(m.capabilities)),
    "every model has id + capabilities",
  );
});

define("models", "models-vision", (t) => {
  const r = cli(["models", "--capability", "vision", "--json"], {
    env: mainEnv(),
    timeout: GATEWAY_TIMEOUT_MS,
  });
  okStatus(t, r, "models --capability vision --json");
  const models = parseJson(r.stdout) ?? [];
  t.ok(models.length > 0, "vision-capable models exist", String(models.length));
  t.ok(
    models.every((m) => m.capabilities.includes("vision")),
    "every returned model has vision",
  );
});

define("models", "models-sort", (t) => {
  const r = cli(["models", "--sort", "input", "--json"], {
    env: mainEnv(),
    timeout: GATEWAY_TIMEOUT_MS,
  });
  okStatus(t, r, "models --sort input --json");
  const models = parseJson(r.stdout) ?? [];
  t.ok(models.length > 0, "catalog non-empty");
  const sorted = models.every(
    (m, i, arr) => i === 0 || Number(arr[i - 1].input_per_1m) <= Number(m.input_per_1m),
  );
  t.ok(sorted, "input_per_1m values non-decreasing");
});

define("models", "models-search", (t) => {
  const models = loadCatalog() ?? [];
  const first = models[0];
  t.ok(first !== undefined, "catalog loaded for search");
  if (!first) return;
  const query = first.provider.toLowerCase();
  const r = cli(["models", "--search", query, "--json"], {
    env: mainEnv(),
    timeout: GATEWAY_TIMEOUT_MS,
  });
  okStatus(t, r, `models --search ${query}`);
  const results2 = parseJson(r.stdout) ?? [];
  t.ok(results2.length > 0, "search matched", String(results2.length));
  t.ok(
    results2.every((m) =>
      [m.id, m.name, m.provider].some((field) => String(field).toLowerCase().includes(query)),
    ),
    `every result matches "${query}"`,
  );
});

/* == logs == */

function retry(times, fn) {
  let last = null;
  for (let attempt = 0; attempt < times; attempt++) {
    last = fn();
    if (last) return last;
    if (attempt < times - 1) sleepSync(RETRY_DELAY_MS);
  }
  return last;
}

function logsRouteMissing(r) {
  const text = `${r.stderr}\n${r.stdout}`;
  return r.status === 1 && /HTTP 404|not_found|Request logs are not available/i.test(text);
}

define("logs", "logs-recent", (t) => {
  const first = cli(["logs", "--range", "15m", "--json"], {
    env: mainEnv(),
    timeout: GATEWAY_TIMEOUT_MS,
  });
  if (logsRouteMissing(first)) {
    t.verdict = "WARN";
    t.detail = "GET /logs is documented but unpublished on this gateway; use `aiand usage`";
    return;
  }
  const attempt = () => {
    const r = cli(["logs", "--range", "15m", "--json"], {
      env: mainEnv(),
      timeout: GATEWAY_TIMEOUT_MS,
    });
    const entries = parseJson(r.stdout);
    if (r.status === 0 && Array.isArray(entries) && entries.length > 0) return { r, entries };
    return null;
  };
  const firstEntries = parseJson(first.stdout);
  const found =
    first.status === 0 && Array.isArray(firstEntries) && firstEntries.length > 0
      ? { r: first, entries: firstEntries }
      : retry(3, attempt);
  t.ok(
    found !== null,
    "logs --range 15m returns entries (3 attempts, 5s apart)",
    found ? "" : "no entries after retries",
  );
  if (!found) return;
  t.ok(
    found.entries.every(
      (e) =>
        typeof e.status_code === "number" &&
        typeof e.model === "string" &&
        typeof e.created_at === "string",
    ),
    "every entry has numeric status_code, string model and created_at",
  );
});

define("logs", "logs-errors", (t) => {
  const r = cli(["logs", "--errors", "--range", "15m", "--json"], {
    env: mainEnv(),
    timeout: GATEWAY_TIMEOUT_MS,
  });
  if (logsRouteMissing(r)) {
    t.verdict = "WARN";
    t.detail = "GET /logs is documented but unpublished on this gateway; use `aiand usage`";
    return;
  }
  okStatus(t, r, "logs --errors --json");
  const entries = parseJson(r.stdout) ?? [];
  t.ok(Array.isArray(entries), "errors output is an array", String(entries.length));
  t.ok(
    entries.every((e) => e.status_code >= 400),
    "every error entry has status_code >= 400",
  );
});

define("logs", "logs-follow", async (t) => {
  // NOTE: waits here must be promise-based. A sleepSync busy loop blocks the
  // event loop, so the child process's data/exit events would never fire
  // while waiting — every observation below would come back empty.
  const child = spawn(NODE, [CLI, "logs", "--follow", "--interval", "1"], {
    env: mainEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const announced = await new Promise((resolve) => {
    if (/Following/.test(stderr)) return resolve(true);
    const timer = setTimeout(() => resolve(false), FOLLOW_ANNOUNCE_TIMEOUT_MS);
    child.stderr.on("data", () => {
      if (/Following/.test(stderr)) {
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
  t.ok(
    announced,
    `follow announces itself on stderr within ${FOLLOW_ANNOUNCE_TIMEOUT_MS / 1000}s`,
    stderr.split("\n")[0],
  );
  try {
    child.kill("SIGINT");
  } catch {
    /* already gone */
  }
  const exited = await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), FOLLOW_EXIT_TIMEOUT_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  t.ok(exited, "follow terminates on SIGINT", `exit ${child.exitCode} signal ${child.signalCode}`);
  if (!exited) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

/* == usage == */

define("usage", "usage-summary", (t) => {
  const r = cli(["usage", "--json"], { env: mainEnv(), timeout: GATEWAY_TIMEOUT_MS });
  okStatus(t, r, "usage --json");
  const summary = parseJson(r.stdout) ?? {};
  const current = summary.current ?? {};
  t.ok(
    typeof current.requests === "number" &&
      typeof current.input_tokens === "number" &&
      typeof current.output_tokens === "number",
    "current totals numeric",
    JSON.stringify(summary.current),
  );
  t.ok(
    typeof summary.previous?.requests === "number" &&
      typeof summary.previous?.input_tokens === "number" &&
      typeof summary.previous?.output_tokens === "number",
    "previous totals numeric",
  );
  t.ok(Array.isArray(summary.timeseries), "timeseries array present");
  t.ok(
    current.requests >= 1,
    "current.requests reflects this run's calls",
    String(current.requests),
  );
});

define("usage", "usage-range", (t) => {
  const r = cli(["usage", "--range", "1h", "--json"], {
    env: mainEnv(),
    timeout: GATEWAY_TIMEOUT_MS,
  });
  okStatus(t, r, "usage --range 1h --json");
});

define("usage", "usage-metrics", (t) => {
  const r = cli(["usage", "--metrics", "--json"], { env: mainEnv(), timeout: GATEWAY_TIMEOUT_MS });
  okStatus(t, r, "usage --metrics --json");
  const metrics = parseJson(r.stdout) ?? [];
  t.ok(Array.isArray(metrics), "metrics output is an array", String(metrics.length));
  t.ok(
    metrics.every((m) => typeof m.metric_name === "string"),
    "every metric has metric_name",
  );
});

/* == orgs == */

define("orgs", "orgs-list", (t) => {
  const r = cli(["orgs", "--json"], { env: mainEnv(), timeout: GATEWAY_TIMEOUT_MS });
  okStatus(t, r, "orgs --json");
  const orgs = parseJson(r.stdout) ?? [];
  t.ok(Array.isArray(orgs) && orgs.length >= 1, "at least one org", String(orgs.length));
  t.ok(
    typeof orgs[0]?.id === "string" && typeof orgs[0]?.name === "string",
    "first org has id + name",
  );
});

/* == config (pristine main cfg — runs before any login test) == */

define(
  "config",
  "config-show",
  (t) => {
    const r = cli(["config", "--json"], { env: mainEnv() });
    okStatus(t, r, "config --json");
    const cfg = parseJson(r.stdout) ?? {};
    t.ok(cfg.name === "default", "profile default", String(cfg.name));
    t.ok(cfg.apiUrl === "https://api.aiand.com", "api_url is the gateway", String(cfg.apiUrl));
    t.ok(cfg.signed_in === false, "signed_in false (env key only)", String(cfg.signed_in));
  },
  { smoke: true },
);

define(
  "config",
  "config-path",
  (t) => {
    const r = cli(["config", "path", "--json"], { env: mainEnv() });
    okStatus(t, r, "config path --json");
    const paths = parseJson(r.stdout) ?? {};
    t.ok(
      typeof paths.config === "string" && paths.config.endsWith("config.json"),
      "config path reported",
      String(paths.config),
    );
    t.ok(
      typeof paths.credentials === "string" && paths.credentials.endsWith("credentials.json"),
      "credentials path reported",
      String(paths.credentials),
    );
    t.ok(
      paths.config.startsWith(MAIN_CFG),
      "paths live under the isolated config dir",
      String(paths.config),
    );
  },
  { smoke: true },
);

define("login", "login-with-token", (t) => {
  const r = cli(["login", "--with-token", "--json"], {
    env: authEnv(),
    timeout: GATEWAY_TIMEOUT_MS,
    input: KEY,
  });
  okStatus(t, r, "login --with-token --json");
  const out = parseJson(r.stdout) ?? {};
  t.ok(
    out.profile === "default" && out.source === "pasted-key" && out.storage === "file",
    "pasted key stored in the file tier",
    JSON.stringify(out),
  );
});

define(
  "config",
  "config-set-model",
  (t) => {
    const id = modelId();
    let r = cli(["config", "set", "model", id], { env: mainEnv() });
    okStatus(t, r, `config set model ${id}`);
    r = cli(["config", "--json"], { env: mainEnv() });
    const cfg = parseJson(r.stdout) ?? {};
    t.ok(cfg.model === id, `config shows model ${id}`, String(cfg.model));
    r = cli(["config", "set", "model", "auto"], { env: mainEnv() });
    okStatus(t, r, "config set model auto");
    r = cli(["config", "--json"], { env: mainEnv() });
    t.ok(parseJson(r.stdout)?.model === "auto", "model restored to auto");
  },
  { smoke: true },
);

define(
  "config",
  "config-set-bad",
  (t) => {
    const r = cli(["config", "set", "bogus", "x"], { env: mainEnv() });
    t.ok(r.status === 1, "unknown settable key exits 1", `exit ${r.status}`);
    t.ok(
      (r.stderr + r.stdout).includes("not a settable key"),
      "refusal names the bad key",
      r.stderr.split("\n")[0],
    );
  },
  { smoke: true },
);

define(
  "config",
  "config-profiles",
  (t) => {
    const r = cli(["config", "profiles", "--json"], { env: mainEnv() });
    okStatus(t, r, "config profiles --json");
    const rows = parseJson(r.stdout) ?? [];
    const def = rows.find((row) => row.name === "default");
    t.ok(
      def?.active === true && def?.signed_in === false,
      "default profile active, signed out",
      JSON.stringify(def),
    );
  },
  { smoke: true },
);

define(
  "config",
  "config-use",
  (t) => {
    let r = cli(["config", "use", "work"], { env: mainEnv() });
    okStatus(t, r, "config use work");
    r = cli(["config", "profiles", "--json"], { env: mainEnv() });
    const rows = parseJson(r.stdout) ?? [];
    t.ok(
      rows.some((row) => row.name === "work" && row.active === true),
      "work profile active",
    );
    r = cli(["key", "export"], { env: mainEnv() });
    okStatus(t, r, "key export under work profile");
    t.ok(r.stdout.trim() === KEY_EFFECTIVE, "env key still wins for key export");
    r = cli(["config", "use", "default"], { env: mainEnv() });
    okStatus(t, r, "config use default restores");
  },
  { smoke: true },
);

/* == login (pristine auth scenario, no env key) == */

define("login", "login-whoami", (t) => {
  const r = cli(["whoami", "--json"], { env: authEnv(), timeout: GATEWAY_TIMEOUT_MS });
  okStatus(t, r, "whoami --json (stored credential)");
  const who = parseJson(r.stdout) ?? {};
  t.ok(typeof who.user?.email === "string" && who.user.email.length > 0, "user.email non-empty");
  t.ok(who.source === "pasted-key", "source is pasted-key", String(who.source));
  t.ok(who.storage === "file", "storage is file", String(who.storage));
});

define("login", "login-status", (t) => {
  const r = cli(["status", "--json"], { env: authEnv(), timeout: WIRING_TIMEOUT_MS });
  okStatus(t, r, "status --json");
  const out = parseJson(r.stdout) ?? {};
  t.ok(out.auth?.signed_in === true, "auth.signed_in true");
  const ids = (out.agents ?? []).map((agent) => agent.agent).sort();
  t.ok(
    JSON.stringify(ids) === JSON.stringify(SHIPPED_AGENT_IDS),
    "status lists every registered agent",
    JSON.stringify(ids),
  );
});

define("login", "login-key-export", (t) => {
  const r = cli(["key", "export"], { env: authEnv() });
  okStatus(t, r, "key export (stored credential)");
  t.ok(r.stdout.trim() === KEY, "exported key equals the stored key");
});

define("login", "login-rejects-bad-key", (t) => {
  // --force skips the already-signed-in gate so the key itself gets validated.
  const r = cli(["login", "--force", "--with-token"], {
    env: authEnv(),
    timeout: GATEWAY_TIMEOUT_MS,
    input: "sk-this-key-is-definitely-invalid-000\n",
  });
  t.ok(r.status === 1, "invalid key exits 1", `exit ${r.status}`);
  t.ok(
    (r.stderr + r.stdout).includes("rejected"),
    "server rejection surfaced",
    r.stderr.split("\n")[0],
  );
});

define("login", "login-logout", (t) => {
  const r = cli(["logout", "--json"], { env: authEnv() });
  okStatus(t, r, "logout --json");
  const out = parseJson(r.stdout) ?? {};
  t.ok(
    out.profile === "default" && out.revoked === false && out.source === "pasted-key",
    "pasted key cleared locally, never revoked server-side",
    JSON.stringify(out),
  );
  const who = cli(["whoami", "--json"], { env: authEnv() });
  t.ok(who.status === 2, "whoami after logout exits 2", `exit ${who.status}`);
});

define(
  "login",
  "login-logout-when-out",
  (t) => {
    const r = cli(["logout"], { env: authEnv() });
    t.ok(r.status === 0, "logout while signed out exits 0", `exit ${r.status}`);
    t.ok(
      (r.stdout + r.stderr).includes("not signed in"),
      "friendly not-signed-in note",
      r.stdout.split("\n")[0],
    );
  },
  { smoke: true },
);

/* == agents (opencode wiring, stubs on PATH) == */

for (const id of WIRING_ONE) {
  const def = AGENT_DEFS[id];
  define("agents", `agents-${id}-on`, (t) => {
    def.seed(agentState(id));
    const r = cli([id, "on", "--json"], { env: mainEnv(), timeout: WIRING_TIMEOUT_MS });
    okStatus(t, r, `${id} on`);
    const out = parseJson(r.stdout) ?? {};
    t.ok(out.state === "on", "state on", JSON.stringify(out));
    const ids = (loadCatalog() ?? []).map((m) => m.id);
    const catalogId =
      typeof out.model === "string" && out.model.startsWith("aiand/")
        ? out.model.slice("aiand/".length)
        : out.model;
    t.ok(
      typeof catalogId === "string" && (ids.length === 0 || ids.includes(catalogId)),
      "model is a catalog id",
      String(out.model),
    );
    t.ok(
      Array.isArray(out.files) && out.files.length > 0,
      "files list non-empty",
      JSON.stringify(out.files),
    );
  });

  define("agents", `agents-${id}-contents`, (t) => {
    const run = { ok: (cond, label, detail) => t.ok(cond, label, detail) };
    // contents checks may be async
    return Promise.resolve(def.contents(run)).then(() => {});
  });

  define("agents", `agents-${id}-status`, (t) => {
    const r = cli([id, "status", "--json"], { env: mainEnv(), timeout: GATEWAY_TIMEOUT_MS });
    okStatus(t, r, `${id} status`);
    const out = parseJson(r.stdout) ?? {};
    t.ok(out.state === "on", "status reports on", JSON.stringify(out));
  });

  define("agents", `agents-${id}-off-restore`, (t) => {
    const r = cli([id, "off", "--json"], { env: mainEnv(), timeout: GATEWAY_TIMEOUT_MS });
    okStatus(t, r, `${id} off`);
    const out = parseJson(r.stdout) ?? {};
    t.ok(out.state === "off", "state off", JSON.stringify(out));
    verifyOffRestore(t, id);
  });

  define("agents", `agents-${id}-status-off`, (t) => {
    const r = cli([id, "status", "--json"], { env: mainEnv(), timeout: GATEWAY_TIMEOUT_MS });
    okStatus(t, r, `${id} status after off`);
    const out = parseJson(r.stdout) ?? {};
    t.ok(out.state === "off", "status reports off", JSON.stringify(out));
  });
}

/* == agent edge cases == */

for (const id of WIRING_ONE) {
  define("edge", `agents-reon-idempotent-${id}`, (t) => {
    const env = { env: mainEnv(), timeout: WIRING_TIMEOUT_MS };
    const on1 = cli([id, "on", "--json"], env);
    okStatus(t, on1, `${id} on (first)`);
    const on2 = cli([id, "on", "--json"], env);
    okStatus(t, on2, `${id} on (again)`);
    const off = cli([id, "off", "--json"], { env: mainEnv(), timeout: GATEWAY_TIMEOUT_MS });
    okStatus(t, off, `${id} off`);
    const status = cli([id, "status", "--json"], { env: mainEnv(), timeout: GATEWAY_TIMEOUT_MS });
    const out = parseJson(status.stdout) ?? {};
    t.ok(
      out.state === "off",
      "re-on kept the first snapshot (off lands back on the seed)",
      JSON.stringify(out),
    );
    verifyOffRestore(t, id);
  });
}

define(
  "edge",
  "agents-not-installed",
  (t) => {
    const opencode = cli(["opencode", "on"], { env: cleanEnv(), timeout: GATEWAY_TIMEOUT_MS });
    t.ok(
      opencode.status === 127,
      "opencode on without a binary exits 127",
      `exit ${opencode.status}`,
    );
    t.ok(
      (opencode.stderr + opencode.stdout).includes("npm install -g opencode-ai"),
      "install hint names the official command",
      opencode.stderr.split("\n")[0],
    );
    const init = cli(["init"], { env: cleanEnv(), timeout: GATEWAY_TIMEOUT_MS });
    t.ok(init.status === 1, "bare non-interactive init exits 1", `exit ${init.status}`);
    t.ok(
      (init.stderr + init.stdout).includes("Non-interactive init needs explicit agents"),
      "init refusal names the explicit-agents requirement",
      init.stderr.split("\n")[0],
    );
  },
  { smoke: true },
);

/* == init == */

define("init", "init-named", (t) => {
  AGENT_DEFS.opencode.seed(agentStates.opencode);
  const r = cli(["init", "opencode", "--json"], { env: mainEnv(), timeout: WIRING_TIMEOUT_MS });
  okStatus(t, r, "init opencode --json");
  const out = parseJson(r.stdout) ?? {};
  t.ok(
    out.agents?.[0]?.agent === "opencode" && out.agents?.[0]?.state === "on",
    "opencode wired on",
    JSON.stringify(out.agents?.[0]),
  );
  const off = cli(["init", "--off", "--json"], { env: mainEnv(), timeout: WIRING_TIMEOUT_MS });
  okStatus(t, off, "init --off --json");
  const offOut = parseJson(off.stdout) ?? {};
  t.ok(
    offOut.agents?.length === 1 && offOut.agents.every((a) => a.state === "off"),
    "agent unwired",
    JSON.stringify(offOut.agents),
  );
  t.ok(
    sameBytes(OPENCODE_CFG, agentStates.opencode.seeds.get(OPENCODE_CFG)),
    "opencode config byte-identical to the seed",
  );
});

define("init", "init-all", (t) => {
  const r = cli(["init", "--all", "--json"], { env: mainEnv(), timeout: INIT_ALL_TIMEOUT_MS });
  okStatus(t, r, "init --all --json");
  const out = parseJson(r.stdout) ?? {};
  const rows = out.agents ?? [];
  // WIRING_ONE (not the registry): `init --all` wires only DETECTED
  // agents, and the stub PATH guarantees exactly the seven above. A
  // real agent on the host that no stub covers would add a row.
  for (const id of WIRING_ONE) {
    const row = rows.find((a) => a.agent === id);
    t.ok(row?.state === "on", `${id} wired on by --all`, JSON.stringify(row));
  }
  const off = cli(["init", "--off", "--json"], { env: mainEnv(), timeout: INIT_ALL_TIMEOUT_MS });
  okStatus(t, off, "init --off --json after --all");
  const offOut = parseJson(off.stdout) ?? {};
  t.ok(
    // `>=`, not `===`: a workstation PATH can carry further REAL
    // agents (none is seeded here) and --all would wire them too.
    (offOut.agents ?? []).length >= WIRING_ONE.length &&
      (offOut.agents ?? []).every((a) => a.state === "off"),
    "every wired agent off again",
    JSON.stringify(offOut.agents),
  );
});

define(
  "init",
  "init-none",
  (t) => {
    const r = cli(["init", "--json"], { env: cleanEnv(), timeout: GATEWAY_TIMEOUT_MS });
    t.ok(r.status === 0, "init --json with nothing installed exits 0", `exit ${r.status}`);
    const out = parseJson(r.stdout) ?? {};
    t.ok(
      Array.isArray(out.agents) && out.agents.length === 0,
      "agents list empty",
      JSON.stringify(out.agents),
    );
    t.ok(
      typeof out.message === "string" && out.message.includes("No coding agents detected"),
      "message says no coding agents detected",
      String(out.message),
    );
  },
  { smoke: true },
);

/* == launcher (run-agent, stubs on PATH) == */

function launchCheck(name, args, { extra = {}, timeout = GATEWAY_TIMEOUT_MS } = {}) {
  rmSync(join(LAUNCHED, `${name}.json`), { force: true });
  return cli(["run-agent", ...args], { env: mainEnv(extra), timeout });
}

define("launcher", "launcher-opencode", (t) => {
  const r = launchCheck("opencode", ["opencode", "--", "--dump"]);
  okStatus(t, r, "run-agent opencode");
  const rec = stubRecord("opencode");
  t.ok(rec !== null, "stub recorded its launch");
  if (!rec) return;
  const cfg = parseJson(rec.env.OPENCODE_CONFIG_CONTENT ?? "");
  t.ok(cfg !== null, "OPENCODE_CONFIG_CONTENT parses as JSON");
  if (!cfg) return;
  t.ok(
    /^\{file:.+\}$/.test(cfg.provider?.aiand?.options?.apiKey ?? ""),
    "apiKey references a {file:} throwaway, not the env",
  );
  t.ok(
    cfg.provider?.aiand?.options?.baseURL === "https://api.aiand.com/v1",
    "inline baseURL is gateway /v1",
  );
  t.ok(
    cfg.model === `aiand/${modelId()}`,
    `inline model ref is aiand/${modelId()}`,
    String(cfg.model),
  );
});

define("launcher", "launcher-claude", (t) => {
  const r = launchCheck("claude", ["claude", "--", "--dump"]);
  okStatus(t, r, "run-agent claude");
  const rec = stubRecord("claude");
  t.ok(rec !== null, "stub recorded its launch");
  if (!rec) return;
  t.ok(
    rec.args[0] === "--settings" && rec.args.at(-1) === "--dump",
    "--settings, then passthrough",
  );
  t.ok(rec.settingsMode === 0o600, "throwaway settings file is 0600", String(rec.settingsMode));
  t.ok(rec.settings?.env?.ANTHROPIC_AUTH_TOKEN === KEY, "the key rides in the settings file");
  t.ok(!Object.values(rec.env).includes(KEY), "the key is not in the child env");
  t.ok(!existsSync(rec.args[1]), "throwaway settings file removed after exit");
});

define("launcher", "launcher-codex", (t) => {
  const r = launchCheck("codex", ["codex", "--", "--dump"]);
  okStatus(t, r, "run-agent codex");
  const rec = stubRecord("codex");
  t.ok(rec !== null, "stub recorded its launch");
  if (!rec) return;
  t.ok(rec.args[0] === "-c" && rec.args.at(-1) === "--dump", "-c overrides, then passthrough");
  t.ok(rec.args.includes('model_provider="aiand"'), "routes through the aiand provider");
  t.ok(!rec.args.join(" ").includes(KEY), "the key is not in argv");
  t.ok(
    rec.env.AIAND_API_KEY === KEY,
    "the env key is handed back for Codex's own aiand key export",
  );
  t.ok(!existsSync(CODEX_CFG), "no profile written");
});

define("launcher", "launcher-dsh", (t) => {
  const r = launchCheck("dsh", ["dsh", "--", "--patch", "/tmp/x.yml", "--dump"]);
  okStatus(t, r, "run-agent dsh");
  const rec = stubRecord("dsh");
  t.ok(rec !== null, "stub recorded its launch");
  if (!rec) return;
  // Piped stdin => the headless one-shot profile; a passthrough --patch
  // would outrank the injected rows in dsh's composition, so the launcher
  // owns the flag and --dump survives.
  t.ok(
    rec.args[0] === "--profile" && rec.args[1] === "headless",
    "headless profile",
    rec.args.join(" "),
  );
  t.ok(!rec.args.includes("--patch"), "--patch stripped from the passthrough");
  t.ok(rec.args.at(-1) === "--dump", "passthrough forwarded after the profile");
  const overlay = rec.env.DSH_HOME;
  t.ok(
    overlay && overlay !== join(MAIN_HOME, ".dsh"),
    "DSH_HOME points at the throwaway",
    String(overlay),
  );
  t.ok(rec.dshPatch?.includes("x-aiand: true"), "the overlay holds the aiand route rows");
  t.ok(
    rec.dshPatch === null || rec.dshPatch.includes("baseURL: https://api.aiand.com/v1"),
    "the route points at the gateway",
  );
  t.ok(rec.dshCredsMode === 0o600, "the overlay key file is 0600", String(rec.dshCredsMode));
  t.ok(
    !Object.values(rec.env).includes(KEY) && !Object.values(rec.env).includes(SMOKE_KEY),
    "the session key never rides the child env",
  );
  t.ok(overlay && !existsSync(overlay), "the throwaway home is removed after exit");
  // The launch must not have wired the real home: whatever the dsh
  // wiring cells left behind stays free of our marker and the key.
  const real = existsSync(DSH_PATCH) ? readFileSync(DSH_PATCH, "utf8") : "";
  t.ok(!real.includes("x-aiand: true"), "nothing of ours in the real patch layer");
});

define("launcher", "launcher-pi", (t) => {
  const r = launchCheck("pi", ["pi", "--", "--dump"]);
  okStatus(t, r, "run-agent pi");
  const rec = stubRecord("pi");
  t.ok(rec !== null, "stub recorded its launch");
  if (!rec) return;
  t.ok(
    rec.args[0] === "--provider" && rec.args[1] === "aiand" && rec.args.at(-1) === "--dump",
    "--provider aiand --model <id>, then passthrough",
  );
  t.ok(rec.env.PI_CODING_AGENT_DIR?.includes("aiand-pi-"), "overlay is the throwaway dir");
  t.ok(
    /\.pi[/\\]agent[/\\]sessions[/\\]--[^/\\]+--$/.test(rec.env.PI_CODING_AGENT_SESSION_DIR ?? ""),
    "session history stays in pi's own per-cwd session dir",
    String(rec.env.PI_CODING_AGENT_SESSION_DIR),
  );
  t.ok(rec.overlayMode === 0o600, "overlay auth.json is 0600", String(rec.overlayMode));
  t.ok(rec.overlayAuth?.aiand?.key === KEY, "the key rides in the overlay, not the env");
  t.ok(!Object.values(rec.env).includes(KEY), "the key is not in the child env");
  t.ok(
    rec.overlayModels?.providers?.aiand?.baseUrl === "https://api.aiand.com/v1",
    "overlay provider is gateway /v1",
  );
  t.ok(!existsSync(rec.env.PI_CODING_AGENT_DIR), "overlay removed after exit");
});

define("launcher", "launcher-omp", (t) => {
  // Mirrors launcher-pi: the launcher overlays a throwaway
  // PI_CODING_AGENT_DIR (omp's config root) holding models.yml +
  // config.yml, and never wires the user's real ~/.omp (that is
  // `omp on`'s job).
  const modelsBefore = readFileSync(OMP_MODELS, "utf8");
  const r = launchCheck("omp", ["omp", "--", "--dump"]);
  okStatus(t, r, "run-agent omp");
  const rec = stubRecord("omp");
  t.ok(rec !== null, "stub recorded its launch");
  if (!rec) return;
  t.ok(
    rec.args[0] === "--model" &&
      rec.args[1] === `aiand/${modelId()}` &&
      rec.args.at(-1) === "--dump",
    "--model aiand/<id>, then passthrough",
    rec.args.slice(0, 2).join(" "),
  );
  t.ok(rec.env.PI_CODING_AGENT_DIR?.includes("aiand-omp-"), "overlay is the throwaway dir");
  t.ok(
    /\.omp[/\\]agent[/\\]sessions$/.test(rec.env.PI_CODING_AGENT_SESSION_DIR ?? ""),
    "session history stays in the user's session dir",
    String(rec.env.PI_CODING_AGENT_SESSION_DIR),
  );
  t.ok(rec.overlayMode === 0o600, "overlay models.yml is 0600", String(rec.overlayMode));
  t.ok(
    rec.overlayModels?.includes(`apiKey: ${KEY}`),
    "the key rides in the overlay models.yml, not the env",
  );
  t.ok(
    rec.overlayModels?.includes("baseUrl: https://api.aiand.com/v1"),
    "overlay provider is gateway /v1",
  );
  t.ok(
    rec.overlayConfig?.includes(`default: aiand/${modelId()}`),
    "overlay config.yml pins the session model",
    String(rec.overlayConfig),
  );
  t.ok(!Object.values(rec.env).includes(KEY), "the key is not in the child env");
  t.ok(!rec.args.join(" ").includes(KEY), "the key is not in argv");
  t.ok(!existsSync(rec.env.PI_CODING_AGENT_DIR), "overlay removed after exit");
  t.ok(readFileSync(OMP_MODELS, "utf8") === modelsBefore, "the real models.yml is untouched");
});

define("launcher", "launcher-copilot", (t) => {
  // The launcher overlays a throwaway config dir; it must never wire the
  // user's real ~/.copilot (that is `copilot on`'s job).
  const settingsBefore = readFileSync(COPILOT_SETTINGS, "utf8");
  const r = launchCheck("copilot", ["copilot", "--", "--dump"]);
  okStatus(t, r, "run-agent copilot");
  const rec = stubRecord("copilot");
  t.ok(rec !== null, "stub recorded its launch");
  if (!rec) return;
  t.ok(
    rec.args[0] === "--no-auto-update" && rec.args.at(-1) === "--dump",
    "--no-auto-update, then passthrough",
  );
  t.ok(rec.env.COPILOT_HOME?.includes("aiand-copilot-"), "overlay is the throwaway dir");
  t.ok(
    /^aiand\//.test(rec.env.COPILOT_MODEL ?? ""),
    "COPILOT_MODEL is aiand-qualified",
    String(rec.env.COPILOT_MODEL),
  );
  t.ok(rec.env.COPILOT_OFFLINE === "true", "COPILOT_OFFLINE=true");
  t.ok(rec.copilotMode === 0o600, "overlay providers.json is 0600", String(rec.copilotMode));
  t.ok(
    rec.copilotProviders?.providers?.[0]?.apiKey === KEY,
    "the key rides in the overlay, not the env",
  );
  t.ok(
    rec.copilotSettings?.model === rec.env.COPILOT_MODEL,
    "overlay settings pin the session model",
    String(rec.copilotSettings?.model),
  );
  t.ok(!Object.values(rec.env).includes(KEY), "the key is not in the child env");
  t.ok(!rec.args.join(" ").includes(KEY), "the key is not in argv");
  t.ok(!existsSync(rec.env.COPILOT_HOME), "overlay removed after exit");
  t.ok(
    readFileSync(COPILOT_SETTINGS, "utf8") === settingsBefore,
    "the real settings file is untouched",
  );
});

define("launcher", "launcher-exit-code", (t) => {
  const r = launchCheck("opencode", ["opencode", "--", "x"], { extra: { STUB_EXIT: "42" } });
  t.ok(r.status === 42, "child exit code propagates", `exit ${r.status}`);
});

define(
  "launcher",
  "launcher-unknown",
  (t) => {
    const r = cli(["run-agent", "nope"], { env: mainEnv() });
    t.ok(r.status === 1, "unknown agent exits 1", `exit ${r.status}`);
    t.ok(
      (r.stderr + r.stdout).includes("Unknown agent"),
      "refusal names the unknown agent",
      r.stderr.split("\n")[0],
    );
  },
  { smoke: true },
);

define(
  "launcher",
  "launcher-bad-model",
  (t) => {
    const r = launchCheck("opencode", ["opencode", "--model", "definitely-bogus", "--", "x"]);
    t.ok(r.status === 1, "off-catalog --model exits 1", `exit ${r.status}`);
    t.ok(
      (r.stderr + r.stdout).includes("not in the catalog"),
      "refusal names the catalog membership rule",
      r.stderr.split("\n")[0],
    );
  },
  { smoke: true },
);

/* -------------------------------------------------------------------------- */
/* Runner                                                                     */
/* -------------------------------------------------------------------------- */

async function main() {
  if (MODE === "full" && !KEY) {
    console.error("AIAND_API_KEY is required");
    return 2;
  }
  if (MODE !== "plan") setup();

  let lastSection = null;
  for (const check of checks) {
    if (check.section !== lastSection) {
      console.log(`=== ${check.section} ===`);
      lastSection = check.section;
    }
    if (MODE === "plan") {
      console.log(check.id);
      continue;
    }
    if (MODE === "smoke" && !check.smoke) {
      report(check, "WARN", "skipped: needs the live gateway (offline smoke mode)");
      continue;
    }
    // Sequential by design: sections build on each other's scenario state.
    await execute(check);
  }

  if (MODE === "plan") {
    console.log(`SBX: ${checks.length} checks planned`);
    return 0;
  }

  const passed = results.filter((r) => r.verdict === "PASS").length;
  const failed = results.filter((r) => r.verdict === "FAIL").length;
  const warned = results.filter((r) => r.verdict === "WARN").length;
  console.log(`SBX: ${passed} passed, ${failed} failed, ${warned} warned`);
  return failed > 0 ? 1 : 0;
}

main().then(
  (code) => {
    cleanupSandbox();
    process.exit(code);
  },
  (error) => {
    cleanupSandbox();
    console.error(error?.stack ?? error);
    process.exit(70);
  },
);
