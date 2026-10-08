import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import test, { beforeEach, describe } from "node:test";
import {
  CLOSED_URL,
  captureStdio,
  catalogModel,
  cliEnv,
  FAKE_API_KEY,
  hermeticPath,
  plantStub,
  runCli,
  seedCatalogCache,
  withEnv,
  withMockGateway,
  withTestEnv,
} from "./helpers.mjs";

// The Hermes adapter: persistent on/off/status through a dedicated `aiand`
// model-provider plugin, plus the throwaway HERMES_HOME overlay
// sessionLaunch builds for sessions without a prior `on`. Tests drive the
// built adapter from ../dist/agents/hermes/adapter.js against a temp home
// shaped like a real ~/.hermes.

let home, cfg, stubBin;
const env = withTestEnv("aiand-hermes-", (dir) => {
  home = join(dir, "home");
  cfg = join(dir, "cfg");
  stubBin = join(dir, "bin");
  mkdirSync(stubBin, { recursive: true });

  process.env.AIAND_HOME = home;
  process.env.AIAND_CONFIG_DIR = cfg;
  process.env.AIAND_API_KEY = "sk-test-not-real";
  seedCatalogCache(cfg);
});

const hermes = await import("../dist/agents/hermes/adapter.js");
const hermesRouting = await import("../dist/agents/hermes/routing.js");
const hermesOverlay = await import("../dist/agents/hermes/overlay.js");
const { snapshotFiles } = await import("../dist/agents/snapshot.js");

const realHome = () => join(home, ".hermes");
const envPath = () => join(realHome(), ".env");
const configPath = () => join(realHome(), "config.yaml");
const providerDir = () => join(realHome(), "plugins", "model-providers", "aiand");
const initPyPath = () => join(providerDir(), "__init__.py");
const pluginYamlPath = () => join(providerDir(), "plugin.yaml");

// Every test starts from no Hermes home, no snapshot, and no HERMES_HOME
// override: enable() wipes nothing, so a wired home would leak into the
// next test's probe.
beforeEach(() => {
  delete process.env.HERMES_HOME;
  rmSync(realHome(), { recursive: true, force: true });
  rmSync(join(cfg, "snapshots", "hermes"), { recursive: true, force: true });
});

/** A real-shaped ~/.hermes: state, credentials, plugins, config, env. */
function plantHermesHome() {
  const dir = realHome();
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "sessions"), { recursive: true });
  mkdirSync(join(dir, "skills"), { recursive: true });
  mkdirSync(join(dir, "plugins", "model-providers", "other"), { recursive: true });
  mkdirSync(join(dir, "plugins", "model-providers", "aiand"), { recursive: true });
  mkdirSync(join(dir, "plugins", "extra-tool"), { recursive: true });
  writeFileSync(join(dir, "sessions", "s1.json"), '{"s":1}\n');
  writeFileSync(join(dir, "skills", "keep.txt"), "skill\n");
  writeFileSync(join(dir, "plugins", "extra-tool", "keep.txt"), "tool\n");
  writeFileSync(join(dir, "plugins", "model-providers", "other", "p.py"), "plugin\n");
  writeFileSync(join(dir, "plugins", "model-providers", "aiand", "stale.py"), "stale\n");
  writeFileSync(join(dir, "tokens.json"), '{"token":"x"}\n');
  writeFileSync(join(dir, "auth-credentials.json"), '{"a":1}\n');
  writeFileSync(
    join(dir, "config.yaml"),
    'theme: dark\nmodel:\n  # user comment\n  provider: "auto"\n  default: "user-model"\n  base_url: "https://openrouter.ai/api/v1"\n\nother:\n  key: 1\n',
  );
  writeFileSync(
    join(dir, ".env"),
    'USER_KEY=keep\nANTHROPIC_API_KEY="user-key"\nexport ANTHROPIC_BASE_URL="https://proxy.example"\nANTHROPIC_TOKEN="tok"\nAIAND_HERMES_API_KEY="stale"\nAIAND_HERMES_BASE_URL="https://stale.example"\n',
  );
  return dir;
}

/** File bytes + dir listings, recursively: the whole real-home snapshot. */
function snapshotTree(dir) {
  const rows = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    rows.push(name, st.isDirectory() ? snapshotTree(path) : readFileSync(path).toString("base64"));
  }
  return rows.join("|");
}

const sessionInput = (overrides = {}) => ({
  apiKey: "sk-test-key-0000000000000000000000",
  model: "zai-org/glm-5.3",
  catalog: [catalogModel("zai-org/glm-5.3", { reasoning_efforts: ["low", "high", "max"] })],
  baseUrl: "https://api.aiand.com",
  profileName: "default",
  ...overrides,
});

describe("hermes adapter: membership", () => {
  test("detect reports the binary on PATH", async () => {
    plantStub(stubBin, "hermes");
    const detected = await withEnv({ PATH: hermeticPath(stubBin, "/usr/bin") }, () =>
      hermes.hermesAdapter.detect(),
    );
    assert.equal(detected.installed, true);
    assert.equal(detected.path, join(stubBin, "hermes"));
  });

  test("detect misses without the binary", async () => {
    rmSync(join(stubBin, "hermes"), { force: true });
    const detected = await withEnv({ PATH: hermeticPath(dirname(process.execPath)) }, () =>
      hermes.hermesAdapter.detect(),
    );
    assert.deepEqual(detected, { installed: false, path: null });
  });

  test("managedFiles are the four real-home paths, HERMES_HOME-aware", () => {
    // #16
    assert.deepEqual(hermes.hermesAdapter.managedFiles(), [
      envPath(),
      configPath(),
      initPyPath(),
      pluginYamlPath(),
    ]);
  });

  test("HERMES_HOME relocates the managed files", async () => {
    // #16
    const elsewhere = mkdtempSync(join(dirname(home), "hermes-elsewhere-"));
    try {
      await withEnv({ HERMES_HOME: elsewhere }, async () => {
        assert.deepEqual(hermes.hermesAdapter.managedFiles(), [
          join(elsewhere, ".env"),
          join(elsewhere, "config.yaml"),
          join(elsewhere, "plugins", "model-providers", "aiand", "__init__.py"),
          join(elsewhere, "plugins", "model-providers", "aiand", "plugin.yaml"),
        ]);
      });
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("hermes-agent resolves to the hermes adapter, on the CLI too", async () => {
    // The full product name (install domain, docs) is an alias,
    // the way claude-code resolves to claude.
    const { findAgent } = await import("../dist/agents/registry.js");
    assert.equal(findAgent("hermes-agent")?.id, "hermes");
    plantStub(stubBin, "hermes");
    const { code, stdout } = await runCli(["hermes-agent", "status", "--json"], {
      env: cliEnv({
        AIAND_HOME: home,
        AIAND_CONFIG_DIR: cfg,
        PATH: `${stubBin}${delimiter}${process.env.PATH}`,
      }),
    });
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).agent, "hermes");
  });

  test("status --json reports installed and off through the CLI", async () => {
    plantStub(stubBin, "hermes");
    const { code, stdout } = await runCli(["hermes", "status", "--json"], {
      env: cliEnv({
        AIAND_HOME: home,
        AIAND_CONFIG_DIR: cfg,
        PATH: `${stubBin}${delimiter}${process.env.PATH}`,
      }),
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.agent, "hermes");
    assert.equal(parsed.installed, true);
    assert.equal(parsed.state, "off");
    assert.equal(parsed.model, null);
  });

  test("help hermes prints the wired verbs and managed files", async () => {
    const { code, stdout } = await runCli(["help", "hermes"], {
      env: cliEnv({ AIAND_HOME: home, AIAND_CONFIG_DIR: cfg }),
    });
    assert.equal(code, 0);
    assert.match(stdout, /aiand hermes on\|off\|status/);
    assert.match(stdout, /wire Hermes Agent to ai&/);
    assert.match(stdout, /remove aiand routing/);
    assert.match(stdout, /\.hermes\/config\.yaml/);
  });

  test("status without the binary exits 0 and prints the install hint", async () => {
    rmSync(join(stubBin, "hermes"), { force: true });
    const { code, stdout, stderr } = await runCli(["hermes", "status"], {
      env: cliEnv({
        AIAND_HOME: home,
        AIAND_CONFIG_DIR: cfg,
        PATH: hermeticPath(dirname(process.execPath)),
      }),
    });
    assert.equal(code, 0, "missing binary is still a successful status report");
    assert.match(stdout, /installed\s+no/);
    assert.match(stderr, /Install it with: curl -fsSL https:\/\/hermes-agent\.nousresearch\.com/);
    assert.match(stderr, /hermes-agent\.nousresearch\.com\/docs/);
    // The hint pins exact bytes: check-dist keeps the commit in step, but the
    // user-facing string must carry it too.
    assert.match(stderr, /--commit [0-9a-f]{7,40}/);
  });

  test("aiand status lists hermes on the wiring surface", async () => {
    // #16
    plantStub(stubBin, "hermes");
    const { stdout } = await runCli(["status", "--json", "--local"], {
      env: cliEnv({
        AIAND_HOME: home,
        AIAND_CONFIG_DIR: cfg,
        PATH: `${stubBin}${delimiter}${process.env.PATH}`,
      }),
    });
    const ids = (JSON.parse(stdout).agents ?? []).map((row) => row.agent).sort();
    assert.ok(ids.includes("hermes"), `hermes on the wiring surface: ${ids.join(",")}`);
  });
});

const CATALOG = [
  catalogModel("zai-org/glm-5.3", { reasoning_efforts: ["low", "high", "max"] }),
  catalogModel("other/model", { reasoning_efforts: ["low", "high"] }),
];

const enableInput = (overrides = {}) => ({
  apiKey: "sk-test-hermes-enable",
  model: "zai-org/glm-5.3",
  catalog: CATALOG,
  baseUrl: "https://api.aiand.com",
  profileName: "default",
  ...overrides,
});

/** A user-shaped ~/.hermes for persistent tests: plain keys, no aiand wiring. */
function plantPersistentHome({
  env = "USER_KEY=keep\n# a comment\n\n",
  config = 'theme: dark\nmodel:\n  provider: "auto"\n  default: "user-model"\n\nother:\n  key: 1\n',
} = {}) {
  const dir = realHome();
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "plugins", "model-providers", "other"), { recursive: true });
  writeFileSync(join(dir, "plugins", "model-providers", "other", "p.py"), "plugin\n");
  writeFileSync(join(dir, ".env"), env);
  writeFileSync(join(dir, "config.yaml"), config);
  return dir;
}

function readAddedState() {
  return JSON.parse(readFileSync(join(cfg, "snapshots", "hermes", "added.json"), "utf8"));
}

describe("hermes adapter: persistent on/off", () => {
  test("probe(): absent config is inactive with no model", async () => {
    // #16
    assert.deepEqual(await hermes.hermesAdapter.probe(), { active: false, model: null });
  });

  test("probe(): wired home is active with the top-level default", async () => {
    // #16
    plantPersistentHome();
    await hermes.hermesAdapter.enable(enableInput());
    assert.deepEqual(await hermes.hermesAdapter.probe(), {
      active: true,
      model: "zai-org/glm-5.3",
    });
  });

  test("probe(): each missing leg reads inactive, never throws", async () => {
    // #16
    plantPersistentHome();
    await hermes.hermesAdapter.enable(enableInput());
    const config = readFileSync(configPath(), "utf8");
    const env = readFileSync(envPath(), "utf8");

    // No providers.aiand block.
    writeFileSync(configPath(), "theme: dark\n");
    assert.deepEqual(await hermes.hermesAdapter.probe(), { active: false, model: null });

    // Unroutable base_url.
    writeFileSync(configPath(), config.replace("https://api.aiand.com", "ftp://example.com"));
    assert.deepEqual(await hermes.hermesAdapter.probe(), { active: false, model: null });

    // Dedicated key var gone.
    writeFileSync(configPath(), config);
    writeFileSync(envPath(), "USER_KEY=keep\n");
    assert.deepEqual(await hermes.hermesAdapter.probe(), { active: false, model: null });
    assert.equal(env.includes("USER_KEY=keep"), true);

    // A file mid-edit is inactive, not a throw.
    writeFileSync(configPath(), "providers:\n  aiand:\n    base_url: [unclosed\n");
    writeFileSync(envPath(), "\0\0binary\0\n");
    assert.deepEqual(await hermes.hermesAdapter.probe(), { active: false, model: null });

    // An unreadable file is inactive, not a throw: a directory where the
    // .env should be fails the read with EISDIR, never ENOENT.
    rmSync(envPath(), { force: true });
    mkdirSync(envPath(), { recursive: true });
    assert.deepEqual(await hermes.hermesAdapter.probe(), { active: false, model: null });
    rmSync(envPath(), { recursive: true, force: true });

    // An empty key var is no credential.
    writeFileSync(configPath(), config);
    writeFileSync(
      envPath(),
      'AIAND_HERMES_API_KEY=\nAIAND_HERMES_BASE_URL="https://api.aiand.com/v1"\n',
    );
    assert.deepEqual(await hermes.hermesAdapter.probe(), { active: false, model: null });
  });

  test("enable(): fresh on writes provider, credential, plugin, and pin", async () => {
    // #16
    const seedEnv = "USER_KEY=keep\n# a comment\n\n";
    const seedConfig =
      'theme: dark\nmodel:\n  provider: "auto"\n  default: "user-model"\n\nother:\n  key: 1\n';
    plantPersistentHome({ env: seedEnv, config: seedConfig });
    const result = await hermes.hermesAdapter.enable(enableInput());
    assert.deepEqual(result.filesWritten, [
      envPath(),
      configPath(),
      initPyPath(),
      pluginYamlPath(),
    ]);
    assert.equal(result.model, "zai-org/glm-5.3");
    assert.equal(result.catalogModel, "zai-org/glm-5.3");
    assert.ok(result.warnings.some((w) => /Set aside your default \(user-model\)/.test(w)));

    // The providers.aiand block: connection, pinned model, ownership stamp.
    const configText = readFileSync(configPath(), "utf8");
    assert.ok(configText.includes("  aiand:"), "block present");
    assert.ok(configText.includes('base_url: "https://api.aiand.com/v1"'));
    assert.ok(configText.includes("key_env: AIAND_HERMES_API_KEY"));
    assert.ok(configText.includes("transport: chat_completions"));
    assert.ok(configText.includes('default_model: "zai-org/glm-5.3"'));
    assert.ok(configText.includes('models: ["zai-org/glm-5.3"]'));
    assert.ok(configText.includes("discover_models: false"));
    assert.ok(configText.includes('managed_by: "aiand"'), "ownership stamp");
    assert.ok(configText.includes("other:\n  key: 1"), "siblings survive");
    assert.match(configText, /provider: aiand/);
    assert.match(configText, /default: "zai-org\/glm-5\.3"/);
    assert.ok(configText.includes("theme: dark"), "user keys survive");

    // The .env: 0600, user lines kept, dedicated pair appended.
    const envText = readFileSync(envPath(), "utf8");
    assert.equal(statSync(envPath()).mode & 0o777, 0o600);
    assert.ok(envText.startsWith("USER_KEY=keep\n# a comment\n\n"), "user lines kept");
    assert.ok(envText.includes('AIAND_HERMES_API_KEY="sk-test-hermes-enable"'));
    assert.ok(envText.includes('AIAND_HERMES_BASE_URL="https://api.aiand.com/v1"'));

    // The plugin: key-free files at the default mode, other providers kept.
    assert.equal(statSync(initPyPath()).mode & 0o777, 0o644);
    const initPy = readFileSync(initPyPath(), "utf8");
    assert.ok(initPy.includes("register_provider(aiand)"));
    assert.ok(initPy.includes('fallback_models=("zai-org/glm-5.3",)'));
    assert.ok(
      initPy.includes(
        'AIAND_REASONING_LEVELS = {"other/model":["low","high"],"zai-org/glm-5.3":["low","high","max"]}',
      ),
      "the plugin carries the catalog's reasoning levels, sorted keys",
    );
    assert.ok(initPy.includes("from agent.reasoning_effort import clamp_effort"), "clamp import");
    assert.ok(initPy.includes("return prepared"), "prepare_messages returns the list");
    for (const hook of [
      "def prepare_messages",
      "def supported_reasoning_efforts",
      "def default_reasoning_config",
      "def build_api_kwargs_extras",
    ]) {
      assert.ok(initPy.includes(hook), `${hook} present`);
    }
    assert.ok(readFileSync(pluginYamlPath(), "utf8").includes("kind: model-provider"));
    assert.equal(
      readFileSync(join(realHome(), "plugins", "model-providers", "other", "p.py"), "utf8"),
      "plugin\n",
      "other providers untouched",
    );

    // The record carries restore targets, never the baked key.
    const record = readAddedState();
    assert.ok(!JSON.stringify(record).includes("sk-test-hermes-enable"));
    assert.equal(record.wroteDefault, "zai-org/glm-5.3");
    assert.equal(record.previousDefaultLine, '  default: "user-model"');
    assert.equal(record.previousProviderLine, '  provider: "auto"');

    // Probe reads the real files back.
    assert.deepEqual(await hermes.hermesAdapter.probe(), {
      active: true,
      model: "zai-org/glm-5.3",
    });
    await hermes.hermesAdapter.disable();
  });

  test("enable(): the provider base_url carries /v1 for the chat-completions transport", async () => {
    // Hermes posts to `${base_url}/chat/completions`, so the stored base_url
    // must include /v1 to reach /v1/chat/completions (codex/opencode rule).
    plantPersistentHome();
    await hermes.hermesAdapter.enable(enableInput({ baseUrl: "https://api.aiand.com" }));
    const configText = readFileSync(configPath(), "utf8");
    assert.ok(
      configText.includes('base_url: "https://api.aiand.com/v1"'),
      "provider block carries /v1",
    );
    assert.ok(!configText.includes('base_url: "https://api.aiand.com"\n'), "no bare origin");
    const envText = readFileSync(envPath(), "utf8");
    assert.ok(envText.includes('AIAND_HERMES_BASE_URL="https://api.aiand.com/v1"'));
    const initPy = readFileSync(initPyPath(), "utf8");
    assert.ok(initPy.includes('base_url="https://api.aiand.com/v1"'));
    assert.equal(readAddedState().wroteBaseUrl, "https://api.aiand.com/v1");
    await hermes.hermesAdapter.disable();
  });

  test("off: byte-identical when untouched, and idempotent", async () => {
    // #16
    plantPersistentHome();
    const seedEnv = readFileSync(envPath());
    const seedConfig = readFileSync(configPath());
    await hermes.hermesAdapter.enable(enableInput());
    const result = await hermes.hermesAdapter.disable();
    assert.equal(result.stripped, true);
    assert.equal(readFileSync(envPath()).equals(seedEnv), true);
    assert.equal(readFileSync(configPath()).equals(seedConfig), true);
    assert.ok(!existsSync(providerDir()), "provider dir removed");
    const again = await hermes.hermesAdapter.disable();
    assert.equal(again.stripped, false);
  });

  test("re-on keeps the first capture: off lands byte-identical", async () => {
    // #16
    plantPersistentHome();
    const seedEnv = readFileSync(envPath());
    const seedConfig = readFileSync(configPath());
    await hermes.hermesAdapter.enable(enableInput());
    await hermes.hermesAdapter.enable(enableInput({ model: "other/model", pinModel: true }));
    assert.equal((await hermes.hermesAdapter.probe()).model, "other/model");
    await hermes.hermesAdapter.enable(enableInput());
    await hermes.hermesAdapter.disable();
    assert.equal(readFileSync(envPath()).equals(seedEnv), true);
    assert.equal(readFileSync(configPath()).equals(seedConfig), true);
  });

  test("re-on keeps the set-aside env lines: off hands them back", async () => {
    // Fuzz M2: the record's strippedEnvLines had no prior?. carry-forward,
    // so a second `on` (no shadowed lines left to drop) clobbered the first
    // run's set-aside list and off lost the user's ANTHROPIC_API_KEY line.
    const seedEnv = 'USER_KEY=keep\nANTHROPIC_API_KEY="user-key"\n';
    plantPersistentHome({ env: seedEnv });
    const seedConfig = readFileSync(configPath(), "utf8");
    await hermes.hermesAdapter.enable(enableInput());
    await hermes.hermesAdapter.enable(enableInput({ model: "other/model", pinModel: true }));
    assert.equal((await hermes.hermesAdapter.probe()).model, "other/model");
    await hermes.hermesAdapter.disable();
    assert.equal(readFileSync(envPath(), "utf8"), seedEnv);
    assert.equal(readFileSync(configPath(), "utf8"), seedConfig);
  });

  test("unservable default is set aside with a warning and handed back", async () => {
    // #16
    plantPersistentHome();
    const result = await hermes.hermesAdapter.enable(enableInput());
    assert.ok(result.warnings.some((w) => /Set aside your default \(user-model\)/.test(w)));
    assert.match(readFileSync(configPath(), "utf8"), /default: "zai-org\/glm-5\.3"/);
    await hermes.hermesAdapter.disable();
    assert.match(readFileSync(configPath(), "utf8"), /default: "user-model"/);
    assert.match(readFileSync(configPath(), "utf8"), /provider: "auto"/);
  });

  test("servable user default is kept unless --model passed", async () => {
    // #16
    plantPersistentHome({
      config: 'model:\n  provider: "auto"\n  default: "other/model"\n',
    });
    const result = await hermes.hermesAdapter.enable(enableInput());
    const configText = readFileSync(configPath(), "utf8");
    assert.ok(configText.includes('  default: "other/model"'), "the line stays byte-identical");
    assert.match(configText, /provider: aiand/);
    assert.equal(result.model, "other/model");
    // The kept pick is the user's, not ours: off leaves it.
    await hermes.hermesAdapter.enable(enableInput());
    await hermes.hermesAdapter.disable();
    const after = readFileSync(configPath(), "utf8");
    assert.ok(after.includes('  default: "other/model"'));
    assert.ok(!after.includes("provider: aiand"), "provider handed back");
  });

  test("--model pin overwrites a servable default and off restores it", async () => {
    // #16
    plantPersistentHome({
      config: 'model:\n  provider: "auto"\n  default: "other/model"\n',
    });
    await hermes.hermesAdapter.enable(enableInput({ pinModel: true }));
    assert.match(readFileSync(configPath(), "utf8"), /default: "zai-org\/glm-5\.3"/);
    await hermes.hermesAdapter.disable();
    const after = readFileSync(configPath(), "utf8");
    assert.ok(after.includes('  default: "other/model"'));
    assert.ok(after.includes('  provider: "auto"'));
  });

  test("--model native leaves an unservable model section byte-exact, still wires", async () => {
    // An empty model would make Hermes send no model at all, so native
    // never touches the section: the default and provider stay as found.
    plantPersistentHome();
    const seedConfig = readFileSync(configPath());
    const result = await hermes.hermesAdapter.enable(enableInput({ model: "native" }));
    assert.equal(result.model, "native");
    assert.ok(result.warnings.some((w) => /Pass --model/.test(w)));
    const configText = readFileSync(configPath(), "utf8");
    assert.ok(configText.includes('  default: "user-model"'), "the default stays");
    assert.ok(configText.includes('  provider: "auto"'), "the provider stays too");
    assert.ok(configText.includes("  aiand:"), "the provider block still wires");
    assert.ok(!configText.includes("default_model"), "the block names no unservable model");
    assert.ok(readFileSync(envPath(), "utf8").includes("AIAND_HERMES_API_KEY="));
    await hermes.hermesAdapter.disable();
    assert.equal(readFileSync(configPath()).equals(seedConfig), true);
  });

  test("--model native flips only the provider of a servable default", async () => {
    // The user's default already routes, so only the provider flips onto
    // aiand; the default line is untouched and off hands the provider back.
    plantPersistentHome({
      config: 'model:\n  provider: "auto"\n  default: "other/model"\n',
    });
    const result = await hermes.hermesAdapter.enable(enableInput({ model: "native" }));
    assert.equal(result.model, "native");
    const configText = readFileSync(configPath(), "utf8");
    assert.ok(configText.includes('  default: "other/model"'), "the default line is untouched");
    assert.match(configText, /provider: aiand/, "only the provider flips");
    assert.ok(configText.includes('default_model: "other/model"'), "the block serves the default");
    await hermes.hermesAdapter.disable();
    const after = readFileSync(configPath(), "utf8");
    assert.ok(after.includes('  default: "other/model"'));
    assert.ok(after.includes('  provider: "auto"'), "the provider is handed back");
  });

  test("enable(): foreign providers.aiand block refuses with a CliError", async () => {
    // #16
    plantPersistentHome({
      config: 'providers:\n  aiand:\n    base_url: "https://foreign.example"\n',
    });
    const before = readFileSync(configPath());
    await assert.rejects(hermes.hermesAdapter.enable(enableInput()), (error) => {
      assert.match(error.message, /does not manage/);
      assert.match(error.hint, /Remove or rename the foreign block/);
      return true;
    });
    assert.equal(readFileSync(configPath()).equals(before), true, "nothing written");
  });

  test("enable(): foreign same-named plugin files refuse", async () => {
    // #16
    plantPersistentHome();
    mkdirSync(providerDir(), { recursive: true });
    writeFileSync(initPyPath(), "# the user's own aiand provider\n");
    await assert.rejects(hermes.hermesAdapter.enable(enableInput()), /does not manage/);
    assert.equal(readFileSync(initPyPath(), "utf8"), "# the user's own aiand provider\n");
  });

  test("enable(): a legacy custom_providers entry refuses, never gains a dict block", async () => {
    // #17: upstream once read the legacy list; aiand only writes the dict,
    // so an entry naming aiand refuses with the entry-specific hint instead
    // of being spliced beside.
    plantPersistentHome({
      config: "theme: dark\ncustom_providers:\n  - name: aiand\n    base_url: https://x\n",
    });
    const before = readFileSync(configPath());
    await assert.rejects(hermes.hermesAdapter.enable(enableInput()), (error) => {
      assert.match(error.message, /custom_providers entry named aiand/);
      assert.match(error.hint, /Remove or rename the foreign entry/);
      return true;
    });
    assert.equal(readFileSync(configPath()).equals(before), true, "nothing written");
    assert.deepEqual(await hermes.hermesAdapter.probe(), { active: false, model: null });
  });

  test("off: keeps mid-wire user edits with notes, strips the rest", async () => {
    // #16
    plantPersistentHome();
    await hermes.hermesAdapter.enable(enableInput());
    writeFileSync(
      configPath(),
      readFileSync(configPath(), "utf8")
        .replace('default: "zai-org/glm-5.3"', 'default: "other/model"')
        .replace("provider: aiand", "provider: manual"),
    );
    const result = await hermes.hermesAdapter.disable();
    assert.equal(result.stripped, true);
    assert.ok(result.notes.some((n) => /left model\.default because you edited it/.test(n)));
    assert.ok(result.notes.some((n) => /left model\.provider because you edited it/.test(n)));
    const after = readFileSync(configPath(), "utf8");
    assert.ok(after.includes('  default: "other/model"'), "the edit stays");
    assert.ok(after.includes("  provider: manual"), "the edit stays");
    assert.ok(!after.includes("  aiand:"), "our block still stripped");
  });

  test("off: a repointed block without our stamp is left with a note", async () => {
    // #16 The stamp is gone and key_env no longer names our var, but the
    // record proves on wrote the block: off keeps the user's rewrite.
    plantPersistentHome();
    await hermes.hermesAdapter.enable(enableInput());
    writeFileSync(
      configPath(),
      readFileSync(configPath(), "utf8")
        .split("\n")
        .filter((line) => !line.includes("managed_by"))
        .join("\n")
        .replace("key_env: AIAND_HERMES_API_KEY", "key_env: USER_ANTHROPIC_KEY"),
    );
    const result = await hermes.hermesAdapter.disable();
    assert.equal(result.stripped, true);
    assert.ok(result.notes.some((n) => /left providers\.aiand because you edited it/.test(n)));
    const after = readFileSync(configPath(), "utf8");
    assert.ok(after.includes("  aiand:"), "the rewrite stays");
    assert.ok(after.includes("key_env: USER_ANTHROPIC_KEY"));
    assert.ok(!readFileSync(envPath(), "utf8").includes("AIAND_HERMES_API_KEY"));
  });

  test("off: a stamp-dropped block with our key_env still strips on the record", async () => {
    // The record backstops a Hermes rewrite that dropped the
    // unknown stamp key, while the dedicated key_env still proves the block
    // is ours — the record alone never strips, the pair does.
    plantPersistentHome();
    await hermes.hermesAdapter.enable(enableInput());
    writeFileSync(
      configPath(),
      readFileSync(configPath(), "utf8")
        .split("\n")
        .filter((line) => !line.includes("managed_by"))
        .join("\n"),
    );
    const result = await hermes.hermesAdapter.disable();
    assert.equal(result.stripped, true);
    assert.ok(
      !(result.notes ?? []).some((n) => /left providers\.aiand/.test(n)),
      "no left-behind note",
    );
    assert.ok(!readFileSync(configPath(), "utf8").includes("  aiand:"), "our block stripped");
  });

  test("off: a base_url-repointed block is left with a note, even with the stamp", async () => {
    // The marker is designed to survive Hermes rewrites, so a user who
    // repoints base_url at their own origin while the stamp survives must not
    // lose the block: refreshKey already treats it as the user's, and off
    // must agree instead of deleting it.
    plantPersistentHome();
    await hermes.hermesAdapter.enable(enableInput());
    writeFileSync(
      configPath(),
      readFileSync(configPath(), "utf8").replace(
        'base_url: "https://api.aiand.com/v1"',
        'base_url: "https://user-origin.example/v1"',
      ),
    );
    // Status agrees with off and refreshKey: a repointed block is not on,
    // even while the stamp and the dedicated key are still in place.
    assert.deepEqual(await hermes.hermesAdapter.probe(), { active: false, model: null });
    const result = await hermes.hermesAdapter.disable();
    assert.equal(result.stripped, true);
    assert.ok(result.notes.some((n) => /left providers\.aiand because you edited it/.test(n)));
    const after = readFileSync(configPath(), "utf8");
    assert.ok(after.includes("  aiand:"), "the repointed block stays");
    assert.ok(after.includes('base_url: "https://user-origin.example/v1"'));
    assert.ok(!readFileSync(envPath(), "utf8").includes("AIAND_HERMES_API_KEY"));
  });

  test("off: a key_env-repointed block is left with a note, even with the stamp", async () => {
    // A key_env repoint matches the base_url rule above — a block routing
    // to the user's var is theirs, so off leaves it with the same note.
    plantPersistentHome();
    await hermes.hermesAdapter.enable(enableInput());
    writeFileSync(
      configPath(),
      readFileSync(configPath(), "utf8").replace(
        "key_env: AIAND_HERMES_API_KEY",
        "key_env: USER_KEY_VAR",
      ),
    );
    assert.deepEqual(await hermes.hermesAdapter.probe(), { active: false, model: null });
    const result = await hermes.hermesAdapter.disable();
    assert.equal(result.stripped, true);
    assert.ok(result.notes.some((n) => /left providers\.aiand because you edited it/.test(n)));
    const after = readFileSync(configPath(), "utf8");
    assert.ok(after.includes("  aiand:"), "the repointed block stays");
    assert.ok(after.includes("key_env: USER_KEY_VAR"));
    assert.ok(!readFileSync(envPath(), "utf8").includes("AIAND_HERMES_API_KEY"));
  });

  test("commented providers: header: status on, off strips fully, comments kept", async () => {
    // Fuzz commented-header (Q19c): a `#` comment on the providers: header used to read
    // the section as a scalar, so status lied off and off stranded the block.
    const seed =
      'theme: dark\nproviders:  # keep providers\n  other:\n    k: v\nmodel:\n  provider: "auto"\n  default: "user-model"\n';
    plantPersistentHome({ config: seed });
    await hermes.hermesAdapter.enable(enableInput());
    assert.deepEqual(await hermes.hermesAdapter.probe(), {
      active: true,
      model: "zai-org/glm-5.3",
    });
    assert.ok(readFileSync(configPath(), "utf8").includes("providers:  # keep providers"));
    await hermes.hermesAdapter.disable();
    assert.equal(readFileSync(configPath(), "utf8"), seed);
    assert.equal(readFileSync(envPath(), "utf8"), "USER_KEY=keep\n# a comment\n\n");
  });

  test("commented model: header: status on with a model, off strips fully", async () => {
    // Fuzz commented-header (Q19d): a `#` comment on the model: header used to read a
    // null model and strand `provider: aiand` plus the pinned default.
    const seed = 'theme: dark\nmodel:  # keep model\n  provider: "auto"\n  default: "user-model"\n';
    plantPersistentHome({ config: seed });
    await hermes.hermesAdapter.enable(enableInput());
    assert.deepEqual(await hermes.hermesAdapter.probe(), {
      active: true,
      model: "zai-org/glm-5.3",
    });
    assert.ok(readFileSync(configPath(), "utf8").includes("model:  # keep model"));
    await hermes.hermesAdapter.disable();
    assert.equal(readFileSync(configPath(), "utf8"), seed);
  });

  test("both headers commented: status on, off strips fully (A19)", async () => {
    // The exact A19 shape: both headers commented used to report off while
    // the block was present, then clear the record without stripping.
    const seed =
      "theme: dark\nproviders:  # keep providers\n  other:\n    k: v\nmodel:  # keep model\n" +
      '  provider: "auto"\n  default: "user-model"\n';
    plantPersistentHome({ config: seed });
    await hermes.hermesAdapter.enable(enableInput());
    assert.deepEqual(await hermes.hermesAdapter.probe(), {
      active: true,
      model: "zai-org/glm-5.3",
    });
    const result = await hermes.hermesAdapter.disable();
    assert.equal(result.stripped, true);
    assert.equal(readFileSync(configPath(), "utf8"), seed);
    assert.ok(!readFileSync(configPath(), "utf8").includes("aiand:"), "no stranded block");
    assert.deepEqual(await hermes.hermesAdapter.probe(), { active: false, model: null });
  });

  test("re-on after a stamp-dropping rewrite rewrites the block, never refuses", async () => {
    // A Hermes rewrite may drop our unknown stamp while leaving every value
    // we wrote. disable() forgives that state on the record + dedicated
    // key_env; enable() must prove the same pair and keep editing its own
    // block — refusing it as foreign would dead-end `on` with only a
    // by-hand fix to unstick it.
    plantPersistentHome();
    await hermes.hermesAdapter.enable(enableInput());
    writeFileSync(
      configPath(),
      readFileSync(configPath(), "utf8")
        .split("\n")
        .filter((line) => !line.includes("managed_by"))
        .join("\n"),
    );
    const on = await hermes.hermesAdapter.enable(enableInput({ pinModel: true }));
    assert.equal(on.model, "zai-org/glm-5.3");
    assert.match(readFileSync(configPath(), "utf8"), /managed_by/);
  });

  test("re-on after a hand-deleted block keeps the first restore target", async () => {
    // The block is gone but model: still routes through aiand on our write:
    // the prior record must carry forward, or off hands back our own write
    // instead of the user's original default.
    plantPersistentHome();
    await hermes.hermesAdapter.enable(enableInput());
    writeFileSync(
      configPath(),
      hermesRouting.stripHermesProvider(readFileSync(configPath(), "utf8")),
    );
    assert.ok(!readFileSync(configPath(), "utf8").includes("  aiand:"), "block gone by hand");
    assert.match(readFileSync(configPath(), "utf8"), /provider: aiand/);
    await hermes.hermesAdapter.enable(enableInput({ pinModel: true }));
    const result = await hermes.hermesAdapter.disable();
    assert.equal(result.stripped, true);
    assert.ok(
      readFileSync(configPath(), "utf8").includes('  default: "user-model"'),
      "the original default comes back, not our write",
    );
  });

  test("off: a hand-edited plugin file is left with a note", async () => {
    // #16
    plantPersistentHome();
    await hermes.hermesAdapter.enable(enableInput());
    writeFileSync(initPyPath(), "# hand-tuned provider\n");
    const result = await hermes.hermesAdapter.disable();
    assert.equal(result.stripped, true);
    assert.ok(result.notes.some((n) => /__init__\.py because you edited it/.test(n)));
    assert.equal(readFileSync(initPyPath(), "utf8"), "# hand-tuned provider\n");
    assert.ok(!existsSync(pluginYamlPath()), "untouched files still removed");
  });

  test("off: foreign home is never stripped", async () => {
    // #16
    plantPersistentHome({
      env: "AIAND_HERMES_API_KEY=sk-foreign\n",
      config: 'providers:\n  aiand:\n    base_url: "https://foreign.example"\n',
    });
    const before = readFileSync(configPath());
    const result = await hermes.hermesAdapter.disable();
    assert.equal(result.stripped, false);
    assert.equal(readFileSync(configPath()).equals(before), true);
  });

  test("off: unlinks files it created, keeps ones the user had", async () => {
    // #16 Only config.yaml pre-exists; the command layer snapshots before
    // the first write, seeded here so the manifest records the absence.
    mkdirSync(realHome(), { recursive: true });
    writeFileSync(configPath(), "theme: dark\n");
    await snapshotFiles("hermes", hermes.hermesAdapter.managedFiles());
    await hermes.hermesAdapter.enable(enableInput({ model: "native" }));
    await hermes.hermesAdapter.disable();
    assert.ok(!existsSync(envPath()), ".env unlinked");
    assert.ok(!existsSync(initPyPath()), "plugin files unlinked");
    assert.ok(!existsSync(pluginYamlPath()), "plugin files unlinked");
    assert.ok(!existsSync(providerDir()), "provider dir removed");
    assert.equal(readFileSync(configPath(), "utf8"), "theme: dark\n");
  });

  test("off: a stale user file under our provider id survives", async () => {
    // #16
    plantPersistentHome();
    mkdirSync(providerDir(), { recursive: true });
    writeFileSync(join(providerDir(), "stale.py"), "stale\n");
    await hermes.hermesAdapter.enable(enableInput());
    await hermes.hermesAdapter.disable();
    assert.equal(readFileSync(join(providerDir(), "stale.py"), "utf8"), "stale\n");
    assert.ok(!existsSync(initPyPath()), "our files still removed");
    assert.ok(existsSync(providerDir()), "non-empty dir kept");
  });

  test("0600 stays on the .env both ways; the key-free config keeps its mode", async () => {
    // #16
    plantPersistentHome();
    chmodSync(envPath(), 0o640);
    chmodSync(configPath(), 0o640);
    await hermes.hermesAdapter.enable(enableInput());
    assert.equal(statSync(envPath()).mode & 0o777, 0o600, "the key locks the .env");
    assert.equal(statSync(configPath()).mode & 0o777, 0o640, "no secret, no lock");
    await hermes.hermesAdapter.disable();
    assert.equal(statSync(envPath()).mode & 0o777, 0o640, "pre-on mode handed back");
    assert.equal(statSync(configPath()).mode & 0o777, 0o640, "pre-on mode handed back");
  });

  test("off keeps a file on created private when the user added lines", async () => {
    // #16
    mkdirSync(realHome(), { recursive: true });
    writeFileSync(configPath(), "theme: dark\n");
    await snapshotFiles("hermes", hermes.hermesAdapter.managedFiles());
    await hermes.hermesAdapter.enable(enableInput());
    writeFileSync(envPath(), `${readFileSync(envPath(), "utf8")}USER_EXTRA=1\n`);
    await hermes.hermesAdapter.disable();
    assert.equal(statSync(envPath()).mode & 0o777, 0o600, "never widened");
    assert.equal(readFileSync(envPath(), "utf8"), "USER_EXTRA=1\n");
  });

  test("ANTHROPIC entries are set aside with a warning and handed back", async () => {
    // #16
    plantPersistentHome({ env: 'USER_KEY=keep\nANTHROPIC_API_KEY="user-key"\n' });
    const result = await hermes.hermesAdapter.enable(enableInput());
    assert.ok(result.warnings.some((w) => /ANTHROPIC/.test(w)));
    const wired = readFileSync(envPath(), "utf8");
    assert.ok(!wired.includes("user-key"), "shadowed while on");
    await hermes.hermesAdapter.disable();
    const after = readFileSync(envPath(), "utf8");
    assert.ok(after.includes("USER_KEY=keep"));
    assert.ok(after.includes('ANTHROPIC_API_KEY="user-key"'), "handed back");
    assert.ok(!after.includes("AIAND_HERMES_API_KEY"), "ours still stripped");
  });

  test("refreshKey: same-key no-op, gated rotation, literal-only swap", async () => {
    // #16
    plantPersistentHome();
    await hermes.hermesAdapter.enable(enableInput());
    const before = readFileSync(envPath(), "utf8");

    assert.equal(await hermes.hermesAdapter.refreshKey({ apiKey: "sk-test-hermes-enable" }), true);
    assert.equal(readFileSync(envPath(), "utf8") === before, true, "no-op writes nothing");

    assert.equal(
      await hermes.hermesAdapter.refreshKey({
        apiKey: "sk-new",
        previousKey: "sk-other-profile",
      }),
      false,
      "other profile untouched",
    );
    assert.equal(readFileSync(envPath(), "utf8") === before, true);

    // A key carrying substitution-significant bytes lands literally
    // (concatenated so no one string holds a template placeholder).
    const tricky = "sk-$& $" + "{HOME} #hash me";
    assert.equal(
      await hermes.hermesAdapter.refreshKey({
        apiKey: tricky,
        previousKey: "sk-test-hermes-enable",
      }),
      true,
    );
    const lines = readFileSync(envPath(), "utf8").split("\n");
    assert.ok(lines.includes(`AIAND_HERMES_API_KEY=${JSON.stringify(tricky)}`));
    assert.ok(lines.includes('AIAND_HERMES_BASE_URL="https://api.aiand.com/v1"'), "sibling kept");
    assert.ok(lines.includes("USER_KEY=keep"), "user lines kept");
    assert.equal(statSync(envPath()).mode & 0o777, 0o600, "mode stays private");
    assert.deepEqual(await hermes.hermesAdapter.probe(), {
      active: true,
      model: "zai-org/glm-5.3",
    });
    await hermes.hermesAdapter.disable();
  });

  test("refreshKey: a repointed block is the user's, returns false untouched", async () => {
    // The swap needs the dedicated key_env as well as the stamp
    // or record — a block the user repointed at their own var keeps routing
    // there, so our orphaned literal must not move.
    plantPersistentHome();
    await hermes.hermesAdapter.enable(enableInput());
    const before = readFileSync(envPath(), "utf8");

    // Stamp kept, key_env repointed: still the user's.
    writeFileSync(
      configPath(),
      readFileSync(configPath(), "utf8").replace(
        "key_env: AIAND_HERMES_API_KEY",
        "key_env: USER_ANTHROPIC_KEY",
      ),
    );
    assert.equal(await hermes.hermesAdapter.refreshKey({ apiKey: "sk-new" }), false);

    // Stamp dropped too (record-only): still the user's.
    writeFileSync(
      configPath(),
      readFileSync(configPath(), "utf8")
        .split("\n")
        .filter((line) => !line.includes("managed_by"))
        .join("\n"),
    );
    assert.equal(await hermes.hermesAdapter.refreshKey({ apiKey: "sk-new" }), false);
    assert.equal(readFileSync(envPath(), "utf8"), before, "the baked key is untouched");
    await hermes.hermesAdapter.disable();
  });

  test("refreshKey: a same-key no-op re-tightens a loosened key file", async () => {
    // #17: the baked session key stays 0600 for as long as it lives here —
    // even an idempotent rebake repairs the mode instead of passing through.
    if (process.platform === "win32") return;
    plantPersistentHome();
    await hermes.hermesAdapter.enable(enableInput());
    chmodSync(envPath(), 0o640);
    assert.equal(await hermes.hermesAdapter.refreshKey({ apiKey: "sk-test-hermes-enable" }), true);
    assert.equal(statSync(envPath()).mode & 0o777, 0o600, "mode re-tightened");
    await hermes.hermesAdapter.disable();
  });

  test("refreshKey: unmarked home and keyless .env return false untouched", async () => {
    // #16
    plantPersistentHome({
      env: "AIAND_HERMES_API_KEY=sk-foreign\n",
      config: 'providers:\n  aiand:\n    base_url: "https://foreign.example"\n',
    });
    const beforeEnv = readFileSync(envPath());
    const beforeConfig = readFileSync(configPath());
    assert.equal(await hermes.hermesAdapter.refreshKey({ apiKey: "sk-new" }), false);
    assert.equal(readFileSync(envPath()).equals(beforeEnv), true);
    assert.equal(readFileSync(configPath()).equals(beforeConfig), true);

    // Marked block but no baked key: nothing to swap.
    plantPersistentHome();
    await hermes.hermesAdapter.enable(enableInput());
    writeFileSync(envPath(), "USER_KEY=keep\n");
    assert.equal(await hermes.hermesAdapter.refreshKey({ apiKey: "sk-new" }), false);
    await hermes.hermesAdapter.disable();
  });

  test("refreshKey: an unreadable home of a never-wired user reads false, never throws", async () => {
    // Rebake calls refreshKey on every adapter, wired or not: a read error
    // before the ownership gate must not surface at every login.
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    plantPersistentHome({ config: "theme: dark\n" });
    chmodSync(envPath(), 0o000);
    try {
      assert.equal(await hermes.hermesAdapter.refreshKey({ apiKey: "sk-new" }), false);
    } finally {
      chmodSync(envPath(), 0o644);
    }
  });

  test("rebakeAgentKeys rotates the hermes key, config byte-identical", async () => {
    // Fuzz C2 gap: true rotation through the rebake path — the swap touches
    // only the baked literal, the config stays byte-identical, and a
    // previousKey that is not the baked one leaves everything alone.
    const { rebakeAgentKeys } = await import("../dist/agents/rebake.js");
    plantPersistentHome({ env: 'USER_KEY=keep\nANTHROPIC_API_KEY="user-key"\n' });
    await hermes.hermesAdapter.enable(enableInput({ apiKey: "sk-test-key-1" }));
    const configBefore = readFileSync(configPath(), "utf8");
    const envBefore = readFileSync(envPath(), "utf8");
    assert.ok(envBefore.includes('AIAND_HERMES_API_KEY="sk-test-key-1"'));

    const notes = await rebakeAgentKeys("sk-test-key-2", { previousKey: "sk-test-key-1" });
    assert.equal(notes.find((n) => n.agent === "hermes")?.state, "refreshed");
    const envAfter = readFileSync(envPath(), "utf8");
    assert.ok(envAfter.includes('AIAND_HERMES_API_KEY="sk-test-key-2"'), "key swapped");
    assert.ok(!envAfter.includes("sk-test-key-1"), "old key gone");
    assert.equal(envAfter.includes("USER_KEY=keep"), true, "user lines kept");
    assert.equal(readFileSync(configPath(), "utf8"), configBefore, "config byte-identical");

    // A rotation for another profile's key does not touch this config.
    const skipped = await rebakeAgentKeys("sk-test-key-3", { previousKey: "sk-test-other" });
    assert.equal(
      skipped.some((n) => n.agent === "hermes"),
      false,
    );
    assert.equal(readFileSync(envPath(), "utf8"), envAfter);
    assert.equal(readFileSync(configPath(), "utf8"), configBefore);
    await hermes.hermesAdapter.disable();
  });

  test("HERMES_HOME override is honoured as the real home for on/off", async () => {
    // #16
    plantPersistentHome();
    const seedConfig = readFileSync(configPath());
    const elsewhere = mkdtempSync(join(dirname(home), "hermes-home-"));
    const previous = process.env.HERMES_HOME;
    process.env.HERMES_HOME = elsewhere;
    try {
      const result = await hermes.hermesAdapter.enable(enableInput());
      assert.deepEqual(result.filesWritten, [
        join(elsewhere, ".env"),
        join(elsewhere, "config.yaml"),
        join(elsewhere, "plugins", "model-providers", "aiand", "__init__.py"),
        join(elsewhere, "plugins", "model-providers", "aiand", "plugin.yaml"),
      ]);
      assert.equal(readFileSync(configPath()).equals(seedConfig), true, "real home untouched");
      assert.deepEqual(await hermes.hermesAdapter.probe(), {
        active: true,
        model: "zai-org/glm-5.3",
      });
      await hermes.hermesAdapter.disable();
      assert.ok(!existsSync(join(elsewhere, ".env")), "override home stripped");
    } finally {
      if (previous === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = previous;
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("on and overlay cannot drift: same input, same bytes modulo paths", async () => {
    // #16 The shared buildHermesWrites core feeds both: the overlay this
    // launch builds and the persistent files on writes are byte-identical.
    plantPersistentHome();
    const seedEnv = readFileSync(envPath(), "utf8");
    const seedConfig = readFileSync(configPath(), "utf8");
    const routing = {
      apiKey: "sk-test-hermes-enable",
      baseUrl: "https://api.aiand.com/v1",
      model: "zai-org/glm-5.3",
      reasoningLevels: hermesRouting.hermesReasoningLevels(CATALOG),
    };
    // The overlay reads the same raw bytes enable() will.
    const overlay = await hermesOverlay.buildHermesOverlay(realHome(), routing);
    try {
      // The overlay is the shared builder plus the unconditional pin.
      const built = hermesRouting.buildHermesWrites({
        ...routing,
        envText: seedEnv,
        configText: seedConfig,
      });
      assert.equal(
        readFileSync(join(overlay, ".env"), "utf8"),
        built.env,
        "overlay .env is the builder",
      );
      assert.equal(
        readFileSync(join(overlay, "config.yaml"), "utf8"),
        hermesRouting.pinHermesModel(built.config, routing.model),
        "overlay config is builder plus pin",
      );

      await hermes.hermesAdapter.enable(enableInput({ apiKey: routing.apiKey }));
      const pairs = [
        [join(overlay, ".env"), envPath()],
        [join(overlay, "config.yaml"), configPath()],
        [join(overlay, "plugins", "model-providers", "aiand", "__init__.py"), initPyPath()],
        [join(overlay, "plugins", "model-providers", "aiand", "plugin.yaml"), pluginYamlPath()],
      ];
      for (const [over, real] of pairs) {
        assert.equal(readFileSync(real, "utf8"), readFileSync(over, "utf8"), `${real} matches`);
      }
    } finally {
      rmSync(overlay, { recursive: true, force: true });
      await hermes.hermesAdapter.disable();
    }
  });

  test("hermes on/off/status through the CLI", async () => {
    // #16 The closed loopback catalog keeps the CLI off the network: on
    // resolves its default from cache, like init.test.mjs.
    plantStub(stubBin, "hermes");
    const base = {
      AIAND_HOME: home,
      AIAND_CONFIG_DIR: cfg,
      AIAND_API_KEY: "sk-test-not-real",
      AIAND_BASE_URL: CLOSED_URL,
      PATH: `${stubBin}${delimiter}${process.env.PATH}`,
    };
    let run = await runCli(["hermes", "on"], { env: cliEnv(base) });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /now using ai&/);

    run = await runCli(["hermes", "status", "--json"], { env: cliEnv(base) });
    assert.equal(run.code, 0);
    assert.deepEqual(
      [JSON.parse(run.stdout).state, JSON.parse(run.stdout).model],
      ["on", "zai-org/glm-5.3"],
    );

    run = await runCli(["hermes", "off"], { env: cliEnv(base) });
    assert.equal(run.code, 0, run.stderr);
    run = await runCli(["hermes", "status", "--json"], { env: cliEnv(base) });
    assert.equal(JSON.parse(run.stdout).state, "off");
  });
});

describe("hermes adapter: on-path key and base-url guards", () => {
  // Fuzz E1-E5 + hostile-path A9/A10 through the built CLI: refusals exit 1 with a
  // hint (never a stack exit 70) and write nothing.
  const cliBase = (overrides = {}) =>
    cliEnv({
      AIAND_HOME: home,
      AIAND_CONFIG_DIR: cfg,
      AIAND_API_KEY: FAKE_API_KEY,
      PATH: `${stubBin}${delimiter}${process.env.PATH}`,
      ...overrides,
    });

  test("E1: an invalid key refuses before any write", async () => {
    await withMockGateway(async ({ url }) => {
      plantStub(stubBin, "hermes");
      const run = await runCli(["hermes", "on", "--json"], {
        env: cliBase({
          AIAND_API_KEY: "sk-test-invalid-key",
          AIAND_BASE_URL: `${url}/stub/401`,
        }),
      });
      assert.equal(run.code, 1, run.stderr);
      assert.match(run.stderr, /rejected/);
      assert.doesNotMatch(run.stderr, /Unexpected error/);
      assert.equal(existsSync(realHome()), false, "nothing written");
      assert.equal(existsSync(join(cfg, "snapshots", "hermes")), false, "no snapshot");
    });
  });

  test("E2: a whitespace-only key reads as signed out, writing nothing", async () => {
    // Shared rule (openSession trims): a blank env key behaves as unset and
    // falls through to the stored login, so a signed-out run exits 2 with
    // no snapshot and no Hermes home — never a baked blank key.
    await withMockGateway(async ({ url }) => {
      plantStub(stubBin, "hermes");
      const run = await runCli(["hermes", "on", "--json"], {
        env: cliBase({ AIAND_API_KEY: "   ", AIAND_BASE_URL: url }),
      });
      assert.equal(run.code, 2, run.stderr);
      assert.match(run.stderr, /Not logged in\./);
      assert.equal(existsSync(realHome()), false, "nothing written");
      assert.equal(existsSync(join(cfg, "snapshots", "hermes")), false, "no snapshot");
    });
  });

  test("E3: a padded key wires trimmed", async () => {
    await withMockGateway(async ({ url }) => {
      plantStub(stubBin, "hermes");
      const run = await runCli(["hermes", "on", "--json"], {
        env: cliBase({ AIAND_API_KEY: "  sk-test-padded-key  ", AIAND_BASE_URL: url }),
      });
      assert.equal(run.code, 0, run.stderr);
      const envText = readFileSync(envPath(), "utf8");
      assert.ok(envText.includes('AIAND_HERMES_API_KEY="sk-test-padded-key"'), "trimmed");
      assert.ok(!envText.includes("  sk-test-padded-key  "), "no padding baked");
      const off = await runCli(["hermes", "off"], {
        env: cliBase({ AIAND_API_KEY: FAKE_API_KEY, AIAND_BASE_URL: url }),
      });
      assert.equal(off.code, 0, off.stderr);
    });
  });

  test("E4: a /v1-suffixed --base-url refuses before any write", async () => {
    plantStub(stubBin, "hermes");
    for (const baseUrl of ["https://api.aiand.com/v1", "https://api.aiand.com/v1/"]) {
      const run = await runCli(["hermes", "on", "--json", "--base-url", baseUrl], {
        env: cliBase({ AIAND_BASE_URL: CLOSED_URL }),
      });
      assert.equal(run.code, 1, `${baseUrl}: ${run.stderr}`);
      assert.match(run.stderr, /origin without a path/);
    }
    assert.equal(existsSync(realHome()), false, "nothing written");
    assert.equal(existsSync(join(cfg, "snapshots", "hermes")), false, "no snapshot");
  });

  test("E5: a credential-embedded --base-url refuses without echoing the secret", async () => {
    plantStub(stubBin, "hermes");
    const fake = "fake-secret-xyz";
    const run = await runCli(
      ["hermes", "on", "--json", "--base-url", `https://user:${fake}@host.example/`],
      { env: cliBase({ AIAND_BASE_URL: CLOSED_URL }) },
    );
    assert.equal(run.code, 1, run.stderr);
    assert.match(run.stderr, /must not embed credentials/);
    assert.ok(!`${run.stdout}${run.stderr}`.includes(fake), "the secret is never echoed");
    assert.equal(existsSync(realHome()), false, "nothing written");
  });

  test("hostile-path A9: a file as HERMES_HOME refuses exit 1 with a hint", async () => {
    await withMockGateway(async ({ url }) => {
      plantStub(stubBin, "hermes");
      const blocker = join(home, "hermes-blocker");
      writeFileSync(blocker, "in the way\n");
      try {
        const run = await runCli(["hermes", "on", "--json"], {
          env: cliBase({ AIAND_BASE_URL: url, HERMES_HOME: blocker }),
        });
        assert.equal(run.code, 1, run.stderr);
        assert.match(run.stderr, /not a directory/);
        assert.match(run.stderr, /Remove or rename/);
        assert.doesNotMatch(run.stderr, /Unexpected error/);
        assert.doesNotMatch(run.stderr, /ENOTDIR/);
      } finally {
        rmSync(blocker, { force: true });
      }
    });
  });

  test("hostile-path A10: a directory on the .env path refuses exit 1 with a hint", async () => {
    await withMockGateway(async ({ url }) => {
      plantStub(stubBin, "hermes");
      const base = { AIAND_BASE_URL: url };
      const on = await runCli(["hermes", "on", "--json"], { env: cliBase(base) });
      assert.equal(on.code, 0, on.stderr);
      rmSync(envPath(), { force: true });
      mkdirSync(envPath(), { recursive: true });
      try {
        const run = await runCli(["hermes", "on", "--json"], { env: cliBase(base) });
        assert.equal(run.code, 1, run.stderr);
        assert.match(run.stderr, /it is a directory/);
        assert.match(run.stderr, /Remove or rename/);
        assert.doesNotMatch(run.stderr, /Unexpected error/);
        assert.doesNotMatch(run.stderr, /EISDIR/);
        assert.ok(readFileSync(configPath(), "utf8").includes("aiand:"), "config untouched");
      } finally {
        rmSync(envPath(), { recursive: true, force: true });
      }
    });
  });

  test("openSession trims a padded env key", async () => {
    const { openSession } = await import("../dist/api/client.js");
    const { resolveProfile } = await import("../dist/config.js");
    await withEnv({ AIAND_API_KEY: "  sk-test-trim-me  ", AIAND_BASE_URL: undefined }, async () => {
      const session = await openSession(resolveProfile("default"));
      assert.equal(session.token, "sk-test-trim-me");
    });
  });
});

describe("hermes adapter: sessionLaunch overlay", () => {
  test("builds the overlay, routes through the aiand provider, cleans up", async () => {
    plantHermesHome();
    const before = snapshotTree(realHome());
    const launch = await hermes.hermesAdapter.sessionLaunch(sessionInput());

    const overlay = launch.env.HERMES_HOME;
    assert.ok(overlay.includes("aiand-hermes-"), "overlay dir name");

    // The key never rides the child env: routing travels as provider args +
    // HERMES_* pointers, and the secret itself only in the overlay .env.
    assert.deepEqual(launch.env, {
      HERMES_HOME: overlay,
      HERMES_INFERENCE_PROVIDER: "aiand",
      HERMES_MODEL: "zai-org/glm-5.3",
      HERMES_INFERENCE_MODEL: "zai-org/glm-5.3",
    });
    assert.deepEqual(launch.args, ["--provider", "aiand", "--model", "zai-org/glm-5.3"]);
    // The launcher's generic strip owns the passthrough filtering; the
    // adapter only declares which routing flags it owns.
    assert.deepEqual(launch.stripPassthroughFlags, ["--provider", "--model", "-m"]);

    // State symlinks back; credentials never link.
    if (process.platform !== "win32") {
      assert.equal(readlinkSync(join(overlay, "sessions")), join(realHome(), "sessions"));
      assert.equal(readlinkSync(join(overlay, "skills")), join(realHome(), "skills"));
      // User plugins link back one by one, minus our own provider id.
      assert.equal(
        readlinkSync(join(overlay, "plugins", "extra-tool")),
        join(realHome(), "plugins", "extra-tool"),
      );
      assert.equal(
        readlinkSync(join(overlay, "plugins", "model-providers", "other")),
        join(realHome(), "plugins", "model-providers", "other"),
      );
    } else {
      assert.equal(readFileSync(join(overlay, "sessions", "s1.json"), "utf8"), '{"s":1}\n');
      assert.equal(
        readFileSync(join(overlay, "plugins", "extra-tool", "keep.txt"), "utf8"),
        "tool\n",
      );
    }
    assert.ok(!existsSync(join(overlay, "tokens.json")));
    assert.ok(!existsSync(join(overlay, "auth-credentials.json")));
    // Our provider id is overlay-only (a stale user file under it never
    // shadows this launch), written fresh as real files, never links.
    const providerDir = join(overlay, "plugins", "model-providers", "aiand");
    assert.equal(lstatSync(providerDir).isSymbolicLink(), false, "our provider is a real dir");
    assert.ok(!existsSync(join(providerDir, "stale.py")), "stale user file under our id stays out");
    const initPy = readFileSync(join(providerDir, "__init__.py"), "utf8");
    assert.ok(initPy.includes('api_mode="chat_completions"'), "chat completions mode");
    assert.ok(
      initPy.includes('env_vars=("AIAND_HERMES_API_KEY", "AIAND_HERMES_BASE_URL")'),
      "dedicated env names",
    );
    assert.ok(initPy.includes('fallback_models=("zai-org/glm-5.3",)'), "pinned fallback");
    assert.ok(
      initPy.includes('AIAND_REASONING_LEVELS = {"zai-org/glm-5.3":["low","high","max"]}'),
      "the overlay plugin carries the catalog's reasoning levels",
    );
    assert.ok(initPy.includes('item.pop("name", None)'), "tool-role name pop");
    assert.ok(initPy.includes("register_provider(aiand)"));
    const pluginYaml = readFileSync(join(providerDir, "plugin.yaml"), "utf8");
    assert.ok(pluginYaml.includes("kind: model-provider"));

    // The overlay .env: 0600, user lines carried, ours stripped then written.
    const envPath = join(overlay, ".env");
    const envText = readFileSync(envPath, "utf8");
    assert.equal(statSync(envPath).mode & 0o777, 0o600);
    assert.ok(envText.includes("USER_KEY=keep"));
    assert.ok(envText.includes('AIAND_HERMES_API_KEY="sk-test-key-0000000000000000000000"'));
    assert.ok(envText.includes('AIAND_HERMES_BASE_URL="https://api.aiand.com/v1"'));
    assert.ok(!envText.includes("user-key"), "user ANTHROPIC_API_KEY stripped");
    assert.ok(!envText.includes("proxy.example"), "user ANTHROPIC_BASE_URL stripped");
    assert.ok(!envText.includes("stale"), "stale AIAND_HERMES_* stripped");

    // The overlay config.yaml: providers.aiand block plus the model pin.
    const configText = readFileSync(join(overlay, "config.yaml"), "utf8");
    assert.ok(statSync(join(overlay, "config.yaml")).isFile());
    assert.match(configText, /provider: aiand/);
    assert.match(configText, /default: "zai-org\/glm-5\.3"/);
    assert.ok(configText.includes("key_env: AIAND_HERMES_API_KEY"));
    assert.ok(configText.includes("transport: chat_completions"));
    assert.ok(configText.includes('default_model: "zai-org/glm-5.3"'));
    assert.ok(configText.includes('models: ["zai-org/glm-5.3"]'));
    assert.ok(configText.includes("discover_models: false"));
    assert.ok(configText.includes("theme: dark"), "user keys survive");
    assert.ok(configText.includes("# user comment"), "comments survive");
    assert.ok(configText.includes("other:"), "later sections survive");
    assert.ok(!configText.includes('"user-model"'), "the user model is replaced");

    // The real home is untouched; cleanup removes the overlay.
    assert.equal(snapshotTree(realHome()), before);
    await launch.cleanup();
    assert.equal(existsSync(overlay), false);
  });

  test("a model with no published levels leaves the map without it", async () => {
    plantHermesHome();
    const launch = await hermes.hermesAdapter.sessionLaunch(
      sessionInput({
        catalog: [catalogModel("zai-org/glm-5.3", { reasoning_efforts: null })],
      }),
    );
    try {
      const initPy = readFileSync(
        join(launch.env.HERMES_HOME, "plugins", "model-providers", "aiand", "__init__.py"),
        "utf8",
      );
      assert.ok(initPy.includes("AIAND_REASONING_LEVELS = {}"), "empty levels literal");
      assert.ok(initPy.includes("def build_api_kwargs_extras"), "the hooks still ship");
    } finally {
      await launch.cleanup();
    }
  });

  test("--model native is a catalog error, every launch pins a model", async () => {
    // A bare --provider exits 2 ("--provider requires --model"), so the
    // literal never reaches the binary: the adapter refuses it with the
    // normal catalog hint, and a model-less launch pins the catalog default.
    plantHermesHome();
    await assert.rejects(
      hermes.hermesAdapter.sessionLaunch(sessionInput({ model: "native" })),
      (error) => {
        assert.match(error.hint ?? "", /--model/);
        return true;
      },
    );
    const launch = await hermes.hermesAdapter.sessionLaunch(
      sessionInput({ model: undefined, catalog: [catalogModel("zai-org/glm-5.3")] }),
    );
    try {
      assert.deepEqual(launch.args, ["--provider", "aiand", "--model", "zai-org/glm-5.3"]);
      const configText = readFileSync(join(launch.env.HERMES_HOME, "config.yaml"), "utf8");
      assert.match(configText, /provider: aiand/);
      assert.match(configText, /default: "zai-org\/glm-5\.3"/);
      assert.ok(configText.includes("key_env: AIAND_HERMES_API_KEY"), "the provider still routes");
    } finally {
      await launch.cleanup();
    }
  });

  test("pinHermesModel rewrites the scalar sentinel without a duplicate key", () => {
    // The pure seam: a fresh install's `model: ""` must become the mapping,
    // not keep its scalar value in front of it.
    const out = hermesRouting.pinHermesModel(
      '_config_version: 49\nmodel: ""\nother:\n  key: 1\n',
      "zai-org/glm-5.3",
    );
    assert.equal(
      out,
      '_config_version: 49\nmodel:\n  provider: aiand\n  default: "zai-org/glm-5.3"\nother:\n  key: 1\n',
    );
    assert.equal(
      hermesRouting.pinHermesModel('model: ""\n', undefined),
      "model:\n  provider: aiand\n",
    );
  });

  test("pinHermesProvider appends, merges, and replaces the aiand block", () => {
    const appended = hermesRouting.pinHermesProvider(
      "theme: dark\n",
      "https://api.aiand.com",
      "m/1",
    );
    assert.ok(appended.includes("providers:\n  aiand:"), "block appended");
    assert.ok(appended.includes('default_model: "m/1"'));
    assert.ok(appended.includes('models: ["m/1"]'));
    assert.ok(appended.includes("theme: dark"), "user keys survive");

    const merged = hermesRouting.pinHermesProvider(
      "providers:\n  other:\n    base_url: x\n",
      "https://api.aiand.com",
      "m/1",
    );
    assert.ok(merged.includes("other:\n    base_url: x"), "other providers survive");
    assert.ok(merged.includes("  aiand:"), "aiand added alongside");

    const replaced = hermesRouting.pinHermesProvider(
      'providers:\n  aiand:\n    base_url: "old"\n    models: ["old"]\n  other:\n    k: v\n',
      "https://api.aiand.com",
      "m/2",
    );
    assert.ok(!replaced.includes('"old"'), "the stale block is replaced");
    assert.ok(replaced.includes('default_model: "m/2"'));
    assert.ok(replaced.includes("other:\n    k: v"), "siblings survive");

    const native = hermesRouting.pinHermesProvider(
      "theme: dark\n",
      "https://api.aiand.com",
      undefined,
    );
    assert.ok(native.includes("key_env: AIAND_HERMES_API_KEY"), "connection stays");
    assert.ok(!native.includes("default_model"), "native names no model");
    assert.ok(!/^ {2}models:/m.test(native), "native lists no models");
  });

  test("the dedicated base-URL var travels .env to plugin end to end", () => {
    // AIAND_HERMES_BASE_URL is written into the routing .env with
    // the same baseUrl the provider block, plugin, and config pin carry, and
    // the plugin declares it in env_vars for Hermes to inject at runtime.
    // It stays module-private: no other module names it.
    assert.equal(
      Object.hasOwn(hermesRouting, "HERMES_PROVIDER_BASE_URL_ENV"),
      false,
      "module-private",
    );
    const writes = hermesRouting.buildHermesWrites({
      apiKey: "sk-test-hermes-enable",
      baseUrl: "https://api.aiand.com/v1",
      model: "zai-org/glm-5.3",
      reasoningLevels: new Map([["zai-org/glm-5.3", ["low", "high", "max"]]]),
      envText: "USER_KEY=keep\n",
      configText: "theme: dark\n",
    });
    assert.ok(
      writes.env.split("\n").includes('AIAND_HERMES_BASE_URL="https://api.aiand.com/v1"'),
      "the .env defines it",
    );
    assert.ok(writes.config.includes('base_url: "https://api.aiand.com/v1"'), "the block pins it");
    assert.ok(writes.initPy.includes('base_url="https://api.aiand.com/v1"'), "the plugin bakes it");
    assert.ok(
      writes.initPy.includes('env_vars=("AIAND_HERMES_API_KEY", "AIAND_HERMES_BASE_URL")'),
      "the plugin declares it",
    );
    assert.ok(writes.initPy.includes("AIAND_REASONING_LEVELS"), "the plugin carries the levels");
    assert.ok(
      writes.initPy.includes('AIAND_REASONING_LEVELS = {"zai-org/glm-5.3":["low","high","max"]}'),
      "the levels literal is the sorted JSON",
    );
  });

  test("column-0 comments inside sections survive pin and strip", async () => {
    // #16 A comment must never truncate a section scan: off would strand the
    // lines past it outside their section.
    const seed =
      'model:\n  provider: "auto"\n# divider\n  default: "user-model"\nproviders:\n  other:\n    k: v\n# trailing note\nnext:\n  key: 1\n';
    const pinned = hermesRouting.pinHermesProvider(seed, "https://api.aiand.com", "m/1");
    assert.ok(pinned.includes("# divider"), "model comment kept");
    assert.ok(pinned.includes("# trailing note"), "providers comment kept");
    assert.ok(pinned.includes("  other:\n    k: v"), "sibling kept in section");
    const top = hermesRouting.pinHermesModel(pinned, "m/1");
    assert.match(top, /provider: aiand/);
    assert.match(top, /default: "m\/1"/);
    // The full on/off cycle preserves every user line through the comments
    // (the default line moves beside the provider line, as the pin does).
    const dir = realHome();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), seed);
    writeFileSync(join(dir, ".env"), "USER_KEY=keep\n");
    await hermes.hermesAdapter.enable(enableInput({ model: "other/model", pinModel: true }));
    await hermes.hermesAdapter.disable();
    const after = readFileSync(join(dir, "config.yaml"), "utf8");
    assert.ok(after.includes("# divider"));
    assert.ok(after.includes("# trailing note"));
    assert.ok(after.includes("providers:\n  other:\n    k: v"), "sibling still in section");
    assert.ok(!after.includes("  aiand:"), "our block stripped");
    assert.ok(after.includes('  default: "user-model"'), "default handed back");
    assert.ok(after.includes('  provider: "auto"'), "provider handed back");
  });

  test("a symlinked real config.yaml is copied, never linked", async () => {
    // The copy is by NAME: Dirent.isFile() is false for a symlink, so an
    // isFile() gate would link it and the overlay edit would write through
    // to the real home.
    const dir = plantHermesHome();
    const target = join(dir, "config.target.yaml");
    writeFileSync(target, 'theme: dark\nmodel:\n  provider: "auto"\n  default: "user-model"\n');
    rmSync(join(dir, "config.yaml"));
    symlinkSync(target, join(dir, "config.yaml"));
    const before = readFileSync(target, "utf8");
    const overlay = await hermesOverlay.buildHermesOverlay(dir, {
      apiKey: "sk-test-key-0000000000000000000000",
      baseUrl: "https://api.aiand.com",
      model: "zai-org/glm-5.3",
      reasoningLevels: new Map(),
    });
    try {
      const overlayConfig = join(overlay, "config.yaml");
      assert.equal(lstatSync(overlayConfig).isSymbolicLink(), false, "overlay config is a copy");
      assert.match(readFileSync(overlayConfig, "utf8"), /provider: aiand/);
      assert.equal(readFileSync(target, "utf8"), before, "the link target is untouched");
    } finally {
      rmSync(overlay, { recursive: true, force: true });
    }
  });

  test("no --model resolves the catalog default", async () => {
    plantHermesHome();
    const launch = await hermes.hermesAdapter.sessionLaunch(
      sessionInput({ model: undefined, catalog: [catalogModel("zai-org/glm-5.3")] }),
    );
    const configText = readFileSync(join(launch.env.HERMES_HOME, "config.yaml"), "utf8");
    assert.match(configText, /default: "zai-org\/glm-5\.3"/);
    await launch.cleanup();
  });

  test("a config without a model: section gets one prepended", async () => {
    const dir = plantHermesHome();
    writeFileSync(join(dir, "config.yaml"), "theme: dark\n");
    const launch = await hermes.hermesAdapter.sessionLaunch(sessionInput());
    const configText = readFileSync(join(launch.env.HERMES_HOME, "config.yaml"), "utf8");
    assert.ok(configText.startsWith("model:"), "model block first");
    assert.match(configText, /provider: aiand/);
    assert.match(configText, /default: "zai-org\/glm-5\.3"/);
    assert.ok(configText.includes("theme: dark"));
    await launch.cleanup();
  });

  test("a missing real home still launches (fresh install)", async () => {
    rmSync(realHome(), { recursive: true, force: true });
    const launch = await hermes.hermesAdapter.sessionLaunch(sessionInput());
    const envText = readFileSync(join(launch.env.HERMES_HOME, ".env"), "utf8");
    assert.match(envText, /AIAND_HERMES_API_KEY=/);
    await launch.cleanup();
  });

  test("AIAND_DEBUG=1 logs the launch to stderr", async () => {
    plantHermesHome();
    const capture = captureStdio();
    let launch;
    try {
      launch = await withEnv({ AIAND_DEBUG: "1" }, () =>
        hermes.hermesAdapter.sessionLaunch(sessionInput()),
      );
    } finally {
      capture.restore();
    }
    try {
      const err = capture.log.err.join("");
      assert.match(err, /\[aiand hermes\] mode: pinned/);
      assert.match(err, /\[aiand hermes\] model: zai-org\/glm-5\.3/);
      assert.match(err, /\[aiand hermes\] base URL: https:\/\/api\.aiand\.com\/v1/);
      assert.match(err, /\[aiand hermes\] home overlay: .*aiand-hermes-/);
    } finally {
      await launch.cleanup();
    }
  });

  test("HERMES_HOME env override is honoured as the real home", async () => {
    plantHermesHome();
    const elsewhere = mkdtempSync(join(dirname(home), "hermes-elsewhere-"));
    const previous = process.env.HERMES_HOME;
    process.env.HERMES_HOME = elsewhere;
    try {
      const launch = await hermes.hermesAdapter.sessionLaunch(sessionInput());
      const overlay = launch.env.HERMES_HOME;
      // The empty override home contributes nothing: no state came across.
      assert.ok(!existsSync(join(overlay, "sessions")), "no state carried from the real home");
      assert.ok(existsSync(join(overlay, ".env")), "routing still written");
      await launch.cleanup();
    } finally {
      if (previous === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = previous;
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("cleanup restores the store shims and only removes overlay-pointing additions", async () => {
    // Hermes rewrites checkout/.hermes/bin/* to whatever HERMES_HOME the
    // session ran under; without the restore, cleanup deletes the path its
    // own `hermes` binary points at. The PATH entry here is a symlink to the
    // store shim — the shape that stranded a real install during verification.
    const shims = join(env.dir, "checkout", ".hermes", "bin");
    mkdirSync(shims, { recursive: true });
    const original = "#!/bin/sh\nexec /real/store/python3 -I -c 'script'\n";
    writeFileSync(join(shims, "hermes"), original, { mode: 0o755 });
    writeFileSync(join(shims, "hermes-acp"), "original-acp\n");
    const pathDir = join(env.dir, "shim-path");
    mkdirSync(pathDir, { recursive: true });
    symlinkSync(join(shims, "hermes"), join(pathDir, "hermes"));

    const previousPath = process.env.PATH;
    process.env.PATH = `${pathDir}${delimiter}${previousPath}`;
    try {
      const launch = await hermes.hermesAdapter.sessionLaunch(sessionInput());
      const overlay = launch.env.HERMES_HOME;
      // Simulate the session relocating the shims, plus additions: ones that
      // point at the overlay (cleanup's to remove) and a legit one (kept).
      writeFileSync(join(shims, "hermes"), `#!/bin/sh\nexec ${overlay}/tools/python3 -I -c 'x'\n`);
      writeFileSync(join(shims, "hermes-acp"), "relocated\n");
      symlinkSync(join(overlay, ".env"), join(shims, "added-link"));
      writeFileSync(join(shims, "added-file"), `#!/bin/sh\nexec ${overlay}/tools/python3\n`);
      writeFileSync(join(shims, "user-note.txt"), "the user's own addition\n");

      await launch.cleanup();
      assert.equal(readFileSync(join(shims, "hermes"), "utf8"), original, "store shim restored");
      assert.equal(readFileSync(join(shims, "hermes-acp"), "utf8"), "original-acp\n");
      assert.ok(!existsSync(join(shims, "added-link")), "an overlay-pointing link is removed");
      assert.ok(!existsSync(join(shims, "added-file")), "an overlay-pointing file is removed");
      assert.equal(
        readFileSync(join(shims, "user-note.txt"), "utf8"),
        "the user's own addition\n",
        "a legit addition survives",
      );
      assert.equal(existsSync(overlay), false, "overlay removed");
    } finally {
      process.env.PATH = previousPath;
    }
  });
});
