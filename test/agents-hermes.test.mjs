import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";
import {
  CLOSED_URL,
  catalogModel,
  cliEnv,
  enableInput,
  FAKE_API_KEY,
  plantStub,
  runCli,
  seedCatalogCache,
  withTestEnv,
} from "./helpers.mjs";

withTestEnv("aiand-hermes-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  delete process.env.HERMES_HOME;
  mkdirSync(process.env.AIAND_HOME, { recursive: true });
  mkdirSync(process.env.AIAND_CONFIG_DIR, { recursive: true });
});

const { hermesAdapter } = await import("../dist/agents/hermes/adapter.js");
const { findAgent } = await import("../dist/agents/registry.js");
const { CliError } = await import("../dist/cli/errors.js");
const { snapshotFiles, restoreSnapshot, hasSnapshot } = await import("../dist/agents/snapshot.js");

const home = () => process.env.AIAND_HOME;
const hermesDir = () => join(home(), ".hermes");
const configPath = () => join(hermesDir(), "config.yaml");
const envPath = () => join(hermesDir(), ".env");
const addedPath = () => join(process.env.AIAND_CONFIG_DIR, "snapshots", "hermes", "added.json");
const latestPath = () => join(process.env.AIAND_CONFIG_DIR, "snapshots", "hermes", "latest.json");

const MODEL = "zai-org/glm-5.3";
const input = (overrides = {}) =>
  enableInput({
    apiKey: FAKE_API_KEY,
    model: MODEL,
    catalog: [catalogModel(MODEL)],
    baseUrl: CLOSED_URL,
    ...overrides,
  });

beforeEach(() => {
  rmSync(hermesDir(), { recursive: true, force: true });
  rmSync(join(process.env.AIAND_CONFIG_DIR, "snapshots", "hermes"), {
    recursive: true,
    force: true,
  });
  delete process.env.HERMES_HOME;
});

describe("hermes adapter wiring", () => {
  test("registered with launcher hooks and a session launcher", () => {
    assert.equal(findAgent("hermes"), hermesAdapter);
    assert.equal(findAgent("hermes-agent"), hermesAdapter);
    assert.deepEqual(hermesAdapter.managedFiles(), [configPath(), envPath()]);
    // The literal list itself, not membership: a regression adding a
    // sibling adapter's ANTHROPIC_* row must fail here (P17-8).
    assert.deepEqual(hermesAdapter.shadowEnv, [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "HERMES_MODEL",
      "HERMES_INFERENCE_MODEL",
      "HERMES_INFERENCE_PROVIDER",
    ]);
    assert.equal(hermesAdapter.allowUnpinnedModel, true);
  });

  test("probe is inactive on an empty home", async () => {
    assert.deepEqual(await hermesAdapter.probe(), { active: false, model: null });
  });

  test("hermes-agent resolves to the hermes adapter, on the CLI too", async () => {
    // #17 P17-6: the full product name (install domain, docs) is an alias,
    // the way claude-code resolves to claude. The hermes binary was
    // unavailable to re-verify, so the surface stays and is covered here.
    assert.equal(findAgent("hermes-agent"), hermesAdapter);
    const stubBin = join(home(), "bin");
    plantStub(stubBin, "hermes");
    const { code, stdout } = await runCli(["hermes-agent", "status", "--json"], {
      env: cliEnv({
        AIAND_HOME: home(),
        AIAND_CONFIG_DIR: process.env.AIAND_CONFIG_DIR,
        PATH: `${stubBin}${delimiter}${process.env.PATH}`,
      }),
    });
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).agent, "hermes");
  });
});

describe("hermes enable/disable", () => {
  test("fresh on pins provider and model, locks .env, keeps secrets out of added.json", async () => {
    const result = await hermesAdapter.enable(input());
    assert.equal(result.model, MODEL);
    assert.equal(result.catalogModel, MODEL);
    const config = readFileSync(configPath(), "utf8");
    assert.match(config, /managed_by: "aiand"/);
    assert.match(config, new RegExp(`default: "${MODEL}"`));
    const env = readFileSync(envPath(), "utf8");
    assert.match(env, new RegExp(`AIAND_HERMES_API_KEY=${FAKE_API_KEY}`));
    if (process.platform !== "win32") assert.equal(statSync(envPath()).mode & 0o777, 0o600);
    const added = readFileSync(addedPath(), "utf8");
    assert.ok(!added.includes(FAKE_API_KEY));
    assert.deepEqual(await hermesAdapter.probe(), { active: true, model: MODEL });
  });

  test("re-on is byte-identical", async () => {
    await hermesAdapter.enable(input());
    const beforeConfig = readFileSync(configPath(), "utf8");
    const beforeEnv = readFileSync(envPath(), "utf8");
    await hermesAdapter.enable(input());
    assert.equal(readFileSync(configPath(), "utf8"), beforeConfig);
    assert.equal(readFileSync(envPath(), "utf8"), beforeEnv);
  });

  test("unservable default is set aside and restored by off", async () => {
    mkdirSync(hermesDir(), { recursive: true });
    writeFileSync(configPath(), 'model:\n  provider: "openai"\n  default: "gpt-zzz"\n');
    const on = await hermesAdapter.enable(input());
    assert.ok(on.warnings.some((warning) => warning.includes("gpt-zzz")));
    assert.deepEqual(await hermesAdapter.probe(), { active: true, model: MODEL });
    const off = await hermesAdapter.disable();
    assert.equal(off.stripped, true);
    const config = readFileSync(configPath(), "utf8");
    assert.ok(!config.includes("providers:"));
    assert.match(config, /default: "gpt-zzz"/);
    // .env was created by on and left empty by off, so it is unlinked.
    assert.equal(existsSync(envPath()), false);
    assert.ok(!existsSync(addedPath()));
  });

  test("native leaves the default unpinned", async () => {
    // #16 — native round-trip: --model native must leave the default unpinned,
    // never pin the gateway model or fail validation.
    const on = await hermesAdapter.enable(input({ model: "native" }));
    assert.equal(on.model, "native");
    assert.equal(on.catalogModel, undefined);
    assert.deepEqual(await hermesAdapter.probe(), { active: true, model: null });
  });

  test("off restores a flipped provider instead of leaving it with a note", async () => {
    mkdirSync(hermesDir(), { recursive: true });
    writeFileSync(configPath(), 'model:\n  provider: "other"\n  default: "zai-org/glm-5.3"\n');
    // The servable default is kept; only the provider flips to aiand.
    await hermesAdapter.enable(input());
    assert.match(readFileSync(configPath(), "utf8"), /provider: "aiand"/);
    const off = await hermesAdapter.disable();
    assert.equal(off.stripped, true);
    assert.ok(!(off.notes ?? []).some((note) => note.includes("model.provider")));
    const config = readFileSync(configPath(), "utf8");
    assert.match(config, /provider: "other"/);
    assert.match(config, /default: "zai-org\/glm-5.3"/);
    assert.equal(config.includes("providers:"), false);
  });

  test("off drops the provider line (and emptied section) when on found none", async () => {
    await hermesAdapter.enable(input());
    assert.match(readFileSync(configPath(), "utf8"), /provider: "aiand"/);
    const off = await hermesAdapter.disable();
    assert.equal(off.stripped, true);
    assert.ok(!(off.notes ?? []).some((note) => note.includes("model.provider")));
    // Fresh `on` created both files and `off` emptied them, so both unlink.
    assert.equal(existsSync(configPath()), false);
    assert.equal(existsSync(envPath()), false);
  });

  test("off leaves a hand-edited provider with a note", async () => {
    await hermesAdapter.enable(input());
    writeFileSync(
      configPath(),
      readFileSync(configPath(), "utf8").replace('provider: "aiand"', 'provider: "other"'),
    );
    const off = await hermesAdapter.disable();
    assert.equal(off.stripped, true);
    assert.ok((off.notes ?? []).some((note) => note.includes("left model because you edited it")));
    assert.match(readFileSync(configPath(), "utf8"), /provider: "other"/);
  });

  test("off: a stamp-dropped block with our key_env still strips on the record", async () => {
    // #17 P17-5: the record backstops a Hermes rewrite that dropped the
    // unknown stamp key, while the dedicated key_env still proves the block
    // is ours — the record alone never strips, the pair does.
    mkdirSync(hermesDir(), { recursive: true });
    writeFileSync(configPath(), "theme: dark\n");
    await hermesAdapter.enable(input());
    writeFileSync(
      configPath(),
      readFileSync(configPath(), "utf8")
        .split("\n")
        .filter((line) => !line.includes("managed_by"))
        .join("\n"),
    );
    const result = await hermesAdapter.disable();
    assert.equal(result.stripped, true);
    assert.ok(
      !(result.notes ?? []).some((note) => /left providers\.aiand/.test(note)),
      "no left-behind note",
    );
    const config = readFileSync(configPath(), "utf8");
    assert.match(config, /theme: dark/);
    assert.ok(!config.includes("aiand"), "our block stripped");
  });

  test("off: a repointed block is the user's, kept with a note", async () => {
    // #17 P17-5: stamp dropped and key_env renamed — the record alone never
    // strips, so the block stays with a left-behind note.
    mkdirSync(hermesDir(), { recursive: true });
    writeFileSync(configPath(), "theme: dark\n");
    await hermesAdapter.enable(input());
    writeFileSync(
      configPath(),
      readFileSync(configPath(), "utf8")
        .split("\n")
        .filter((line) => !line.includes("managed_by"))
        .join("\n")
        .replace('key_env: "AIAND_HERMES_API_KEY"', 'key_env: "USER_ANTHROPIC_KEY"'),
    );
    const result = await hermesAdapter.disable();
    assert.ok(
      (result.notes ?? []).some((note) => /left providers\.aiand because you edited it/.test(note)),
      "kept with a note",
    );
    assert.match(readFileSync(configPath(), "utf8"), /USER_ANTHROPIC_KEY/);
  });
});

describe("hermes refreshKey", () => {
  test("swap, same-key, and previousKey mismatch", async () => {
    await hermesAdapter.enable(input());
    assert.equal(
      await hermesAdapter.refreshKey({ apiKey: "sk-new", previousKey: FAKE_API_KEY }),
      true,
    );
    assert.match(readFileSync(envPath(), "utf8"), /AIAND_HERMES_API_KEY=sk-new/);
    if (process.platform !== "win32") assert.equal(statSync(envPath()).mode & 0o777, 0o600);
    assert.equal(await hermesAdapter.refreshKey({ apiKey: "sk-new" }), true);
    assert.equal(
      await hermesAdapter.refreshKey({ apiKey: "sk-other", previousKey: "sk-stale" }),
      false,
    );
  });

  test("refreshKey: malformed config reads false, never throws", async () => {
    await hermesAdapter.enable(input());
    writeFileSync(configPath(), "not yaml {{{\n");
    const envBefore = readFileSync(envPath(), "utf8");
    // A broken config.yaml must not wedge rebake: quiet false, key untouched.
    assert.equal(await hermesAdapter.refreshKey({ apiKey: "sk-new" }), false);
    assert.equal(readFileSync(envPath(), "utf8"), envBefore);
  });

  test("refreshKey: a same-key no-op re-tightens a loosened .env to 0600", async () => {
    await hermesAdapter.enable(input());
    chmodSync(envPath(), 0o644);
    assert.equal(await hermesAdapter.refreshKey({ apiKey: FAKE_API_KEY }), true);
    if (process.platform !== "win32") assert.equal(statSync(envPath()).mode & 0o777, 0o600);
  });

  test("false when never wired", async () => {
    assert.equal(await hermesAdapter.refreshKey({ apiKey: "sk-x" }), false);
  });

  test("refreshKey: a repointed block is the user's, returns false untouched", async () => {
    // #17 P17-4: the swap needs the dedicated key_env as well as the stamp
    // or record — a block the user repointed at their own var keeps routing
    // there, so our orphaned literal must not move.
    await hermesAdapter.enable(input());
    const before = readFileSync(envPath(), "utf8");

    // Stamp kept, key_env repointed: still the user's.
    writeFileSync(
      configPath(),
      readFileSync(configPath(), "utf8").replace(
        'key_env: "AIAND_HERMES_API_KEY"',
        'key_env: "USER_ANTHROPIC_KEY"',
      ),
    );
    assert.equal(await hermesAdapter.refreshKey({ apiKey: "sk-new" }), false);

    // Stamp dropped too (record-only): still the user's.
    writeFileSync(
      configPath(),
      readFileSync(configPath(), "utf8")
        .split("\n")
        .filter((line) => !line.includes("managed_by"))
        .join("\n"),
    );
    assert.equal(await hermesAdapter.refreshKey({ apiKey: "sk-new" }), false);
    assert.equal(readFileSync(envPath(), "utf8"), before, "the baked key is untouched");
    await hermesAdapter.disable();
  });
});

describe("hermes sessionLaunch", () => {
  const launchInput = (overrides = {}) => ({
    apiKey: "sk-launch-1",
    model: MODEL,
    catalog: [catalogModel(MODEL)],
    baseUrl: CLOSED_URL,
    ...overrides,
  });

  test("overlay is routing-only: real home untouched, cleanup removes it", async () => {
    const launch = await hermesAdapter.sessionLaunch(launchInput());
    try {
      const overlay = launch.env.HERMES_HOME;
      assert.match(overlay, /aiand-hermes-/);
      assert.equal(existsSync(overlay), true);
      const config = readFileSync(join(overlay, "config.yaml"), "utf8");
      assert.match(config, /managed_by: "aiand"/);
      assert.match(config, new RegExp(`base_url: "${CLOSED_URL}/v1"`));
      assert.match(config, new RegExp(`default: "${MODEL}"`));
      assert.match(config, /provider: "aiand"/);
      const env = readFileSync(join(overlay, ".env"), "utf8");
      // The overlay .env carries the key alone: nothing reads any other var.
      assert.equal(env, "AIAND_HERMES_API_KEY=sk-launch-1\n");
      if (process.platform !== "win32") {
        assert.equal(statSync(join(overlay, "config.yaml")).mode & 0o777, 0o644);
        assert.equal(statSync(join(overlay, ".env")).mode & 0o777, 0o600);
      }
      assert.deepEqual(launch.args, ["--provider", "aiand", "--model", MODEL]);
      assert.deepEqual(launch.stripPassthroughFlags, ["--provider", "--model", "-m"]);
      // Routing-only: nothing lands in the real home.
      assert.equal(existsSync(hermesDir()), false);
    } finally {
      await launch.cleanup();
    }
    assert.equal(existsSync(launch.env.HERMES_HOME), false);
  });

  test("undefined model resolves through the catalog", async () => {
    const launch = await hermesAdapter.sessionLaunch(launchInput({ model: undefined }));
    try {
      assert.deepEqual(launch.args, ["--provider", "aiand", "--model", MODEL]);
    } finally {
      await launch.cleanup();
    }
  });

  test("native leaves the model unpinned and passes no --model", async () => {
    // #16 — native round-trip: the overlay carries provider-only routing with
    // no default, so the agent's own default wins.
    const launch = await hermesAdapter.sessionLaunch(launchInput({ model: "native" }));
    try {
      assert.deepEqual(launch.args, ["--provider", "aiand"]);
      const config = readFileSync(join(launch.env.HERMES_HOME, "config.yaml"), "utf8");
      assert.match(config, /provider: "aiand"/);
      assert.equal(config.includes("default:"), false);
      assert.equal(config.includes("default_model"), false);
    } finally {
      await launch.cleanup();
    }
  });

  test("missing baseUrl falls back to the production gateway", async () => {
    const launch = await hermesAdapter.sessionLaunch(launchInput({ baseUrl: undefined }));
    try {
      const config = readFileSync(join(launch.env.HERMES_HOME, "config.yaml"), "utf8");
      assert.match(config, /base_url: "https:\/\/api\.aiand\.com\/v1"/);
    } finally {
      await launch.cleanup();
    }
  });
});

describe("hermes probe matrix", () => {
  const markedConfig = (baseUrl) =>
    [
      "providers:",
      "  aiand:",
      '    name: "aiand"',
      `    base_url: "${baseUrl}"`,
      "    key_env: AIAND_HERMES_API_KEY",
      '    managed_by: "aiand"',
      "model:",
      '  provider: "aiand"',
      `  default: "${MODEL}"`,
      "",
    ].join("\n");

  test("garbage text is inactive, no throw", async () => {
    mkdirSync(hermesDir(), { recursive: true });
    writeFileSync(configPath(), "not yaml {{{");
    assert.deepEqual(await hermesAdapter.probe(), { active: false, model: null });
  });

  test("foreign dict block without the stamp reads inactive", async () => {
    mkdirSync(hermesDir(), { recursive: true });
    writeFileSync(
      configPath(),
      'providers:\n  aiand:\n    base_url: "https://foreign.example.com"\n' +
        '    key_env: "SOME_OTHER_KEY"\n',
    );
    writeFileSync(envPath(), `AIAND_HERMES_API_KEY=${FAKE_API_KEY}\n`);
    assert.deepEqual(await hermesAdapter.probe(), { active: false, model: null });
  });

  test("foreign legacy list entry reads inactive", async () => {
    mkdirSync(hermesDir(), { recursive: true });
    writeFileSync(
      configPath(),
      "custom_providers:\n  - name: aiand\n    base_url: https://foreign.example.com\n",
    );
    writeFileSync(envPath(), `AIAND_HERMES_API_KEY=${FAKE_API_KEY}\n`);
    assert.deepEqual(await hermesAdapter.probe(), { active: false, model: null });
  });

  test("marked config with a garbage base_url reads inactive, no throw", async () => {
    mkdirSync(hermesDir(), { recursive: true });
    writeFileSync(configPath(), markedConfig(":::not-a-url"));
    writeFileSync(envPath(), `AIAND_HERMES_API_KEY=${FAKE_API_KEY}\n`);
    assert.deepEqual(await hermesAdapter.probe(), { active: false, model: null });
  });

  test("marked config with a non-loopback http base_url reads inactive", async () => {
    mkdirSync(hermesDir(), { recursive: true });
    writeFileSync(configPath(), markedConfig("http://evil.example"));
    writeFileSync(envPath(), `AIAND_HERMES_API_KEY=${FAKE_API_KEY}\n`);
    assert.deepEqual(await hermesAdapter.probe(), { active: false, model: null });
  });

  test("marked config without the key reads inactive", async () => {
    mkdirSync(hermesDir(), { recursive: true });
    writeFileSync(configPath(), markedConfig(CLOSED_URL));
    assert.deepEqual(await hermesAdapter.probe(), { active: false, model: null });
  });

  test("marked config with a staging https base_url is active", async () => {
    mkdirSync(hermesDir(), { recursive: true });
    writeFileSync(configPath(), markedConfig("https://staging.example.com"));
    writeFileSync(envPath(), `AIAND_HERMES_API_KEY=${FAKE_API_KEY}\n`);
    assert.deepEqual(await hermesAdapter.probe(), { active: true, model: MODEL });
  });

  test("record alone needs the dedicated key_env to read active", async () => {
    // #17 P17-5: without the stamp it takes the dedicated key_env to prove
    // the block is still ours — a repointed block reads inactive.
    await hermesAdapter.enable(input());
    const dropStamp = () =>
      writeFileSync(
        configPath(),
        readFileSync(configPath(), "utf8")
          .split("\n")
          .filter((line) => !line.includes("managed_by"))
          .join("\n"),
      );
    dropStamp();
    assert.deepEqual(await hermesAdapter.probe(), { active: true, model: MODEL });
    writeFileSync(
      configPath(),
      readFileSync(configPath(), "utf8").replace(
        'key_env: "AIAND_HERMES_API_KEY"',
        'key_env: "USER_ANTHROPIC_KEY"',
      ),
    );
    assert.deepEqual(await hermesAdapter.probe(), { active: false, model: null });
    await hermesAdapter.disable();
  });
});

describe("hermes foreign guards", () => {
  test("enable() throws on a foreign providers.aiand block and leaves the file unchanged", async () => {
    const before =
      'providers:\n  aiand:\n    base_url: "https://foreign.example.com"\n' +
      '    key_env: "SOME_OTHER_KEY"\n';
    mkdirSync(hermesDir(), { recursive: true });
    writeFileSync(configPath(), before);
    await assert.rejects(
      () => hermesAdapter.enable(input()),
      (error) => error instanceof CliError && /does not manage/.test(error.message),
    );
    assert.equal(readFileSync(configPath(), "utf8"), before);
    assert.deepEqual(await hermesAdapter.probe(), { active: false, model: null });
  });

  test("enable() throws on a foreign legacy list entry and leaves the file unchanged", async () => {
    const before =
      "custom_providers:\n  - name: aiand\n    base_url: https://foreign.example.com\n";
    mkdirSync(hermesDir(), { recursive: true });
    writeFileSync(configPath(), before);
    await assert.rejects(
      () => hermesAdapter.enable(input()),
      (error) => error instanceof CliError && /does not manage/.test(error.message),
    );
    assert.equal(readFileSync(configPath(), "utf8"), before);
    assert.deepEqual(await hermesAdapter.probe(), { active: false, model: null });
  });

  test("disable() leaves a foreign aiand-named provider untouched", async () => {
    const before =
      'providers:\n  aiand:\n    base_url: "https://foreign.example.com"\n' +
      '    key_env: "SOME_OTHER_KEY"\n';
    mkdirSync(hermesDir(), { recursive: true });
    writeFileSync(configPath(), before);
    writeFileSync(envPath(), `AIAND_HERMES_API_KEY=${FAKE_API_KEY}\n`);
    const off = await hermesAdapter.disable();
    assert.equal(off.stripped, false);
    assert.equal(readFileSync(configPath(), "utf8"), before);
  });

  test("refreshKey() leaves a foreign aiand-named provider untouched", async () => {
    const before =
      'providers:\n  aiand:\n    base_url: "https://foreign.example.com"\n' +
      '    key_env: "SOME_OTHER_KEY"\n';
    mkdirSync(hermesDir(), { recursive: true });
    writeFileSync(configPath(), before);
    writeFileSync(envPath(), "AIAND_HERMES_API_KEY=sk-foreign-1\n");
    assert.equal(await hermesAdapter.refreshKey({ apiKey: "sk-new-1" }), false);
    assert.equal(readFileSync(envPath(), "utf8"), "AIAND_HERMES_API_KEY=sk-foreign-1\n");
  });
});

describe("hermes disable surgery", () => {
  test("disable() strips only our writes, preserves the rest, idempotent, missing no-op", async () => {
    mkdirSync(hermesDir(), { recursive: true });
    writeFileSync(
      configPath(),
      [
        "theme: dark",
        "providers:",
        "  other:",
        "    base_url: https://other.example.com",
        "  aiand:",
        '    name: "aiand"',
        `    base_url: "${CLOSED_URL}"`,
        "    key_env: AIAND_HERMES_API_KEY",
        '    managed_by: "aiand"',
        "model:",
        '  provider: "aiand"',
        `  default: "${MODEL}"`,
        "",
      ].join("\n"),
    );
    writeFileSync(envPath(), `OTHER=1\nAIAND_HERMES_API_KEY=${FAKE_API_KEY}\n`);
    await hermesAdapter.disable();
    const config = readFileSync(configPath(), "utf8");
    assert.equal(config.includes("managed_by"), false);
    assert.match(config, /other:/);
    assert.match(config, /theme: dark/);
    assert.match(config, new RegExp(`default: "${MODEL}"`));
    const env = readFileSync(envPath(), "utf8");
    assert.match(env, /OTHER=1/);
    assert.equal(env.includes(FAKE_API_KEY), false);
    assert.deepEqual(await hermesAdapter.probe(), { active: false, model: null });
    // A second run changes nothing.
    const first = readFileSync(configPath(), "utf8");
    await hermesAdapter.disable();
    assert.equal(readFileSync(configPath(), "utf8"), first);
    // Missing files are a no-op, never a throw.
    rmSync(configPath(), { force: true });
    rmSync(envPath(), { force: true });
    await hermesAdapter.disable();
    assert.equal(existsSync(configPath()), false);
    // A garbage file is a no-op, never a throw, bytes untouched.
    writeFileSync(configPath(), "not yaml {{{");
    await hermesAdapter.disable();
    assert.equal(readFileSync(configPath(), "utf8"), "not yaml {{{");
  });

  test("disable() leaves providers.aiand when base_url was hand-edited", async () => {
    mkdirSync(hermesDir(), { recursive: true });
    writeFileSync(envPath(), "OTHER=1\n");
    await hermesAdapter.enable(input());
    const wired = readFileSync(configPath(), "utf8");
    writeFileSync(
      configPath(),
      wired.replace(`base_url: "${CLOSED_URL}/v1"`, 'base_url: "https://custom.example.com"'),
    );
    const result = await hermesAdapter.disable();
    assert.equal(result.stripped, true);
    assert.ok(
      result.notes.some((note) => /left providers\.aiand because you edited it/.test(note)),
    );
    assert.match(readFileSync(configPath(), "utf8"), /https:\/\/custom\.example\.com/);
    assert.equal(readFileSync(envPath(), "utf8").includes(FAKE_API_KEY), false);
  });

  test("refreshKey() then disable() strips provider (rebake is not a user edit)", async () => {
    await hermesAdapter.enable(input({ apiKey: FAKE_API_KEY }));
    await hermesAdapter.refreshKey({ apiKey: "sk-rebaked-2" });
    assert.match(readFileSync(envPath(), "utf8"), /AIAND_HERMES_API_KEY=sk-rebaked-2/);
    const off = await hermesAdapter.disable();
    assert.equal(off.stripped, true);
    assert.equal(
      (off.notes ?? []).some((note) => /left providers\.aiand because you edited it/.test(note)),
      false,
    );
    assert.equal(existsSync(configPath()), false);
    assert.equal(existsSync(envPath()), false);
  });
});

describe("hermes secret hygiene", () => {
  test("enable() does not persist apiKey in added.json or latest.json", async () => {
    await snapshotFiles("hermes", hermesAdapter.managedFiles());
    await hermesAdapter.enable(input({ apiKey: FAKE_API_KEY }));
    const addedRaw = readFileSync(addedPath(), "utf8");
    const latestRaw = readFileSync(latestPath(), "utf8");
    assert.equal(addedRaw.includes(FAKE_API_KEY), false);
    assert.equal(latestRaw.includes(FAKE_API_KEY), false);
    const added = JSON.parse(addedRaw);
    assert.equal(added.wroteProvider.keyEnv, "AIAND_HERMES_API_KEY");
    assert.equal(JSON.parse(latestRaw).added.wroteProvider.keyEnv, "AIAND_HERMES_API_KEY");
  });

  test("refreshKey() does not write apiKey into added.json", async () => {
    await hermesAdapter.enable(input({ apiKey: FAKE_API_KEY }));
    await hermesAdapter.refreshKey({ apiKey: "sk-test-rebaked" });
    const addedRaw = readFileSync(addedPath(), "utf8");
    assert.equal(addedRaw.includes(FAKE_API_KEY), false);
    assert.equal(addedRaw.includes("sk-test-rebaked"), false);
    assert.equal(readFileSync(envPath(), "utf8").includes("sk-test-rebaked"), true);
  });
});

describe("hermes file modes", () => {
  test("enable() locks .env to 0600 while the key is baked; disable() restores the user's mode", async () => {
    if (process.platform === "win32") return;
    mkdirSync(hermesDir(), { recursive: true });
    writeFileSync(configPath(), "theme: dark\n");
    writeFileSync(envPath(), "OTHER=1\n");
    chmodSync(configPath(), 0o644);
    chmodSync(envPath(), 0o644);
    await hermesAdapter.enable(input());
    assert.equal(statSync(envPath()).mode & 0o777, 0o600);
    // The yaml holds no secret: the user's mode survives the write.
    assert.equal(statSync(configPath()).mode & 0o777, 0o644);
    // A re-on records the first on's modes, never 0600 as the user's own.
    await hermesAdapter.enable(input());
    assert.equal(statSync(envPath()).mode & 0o777, 0o600);
    await hermesAdapter.disable();
    assert.equal(statSync(configPath()).mode & 0o777, 0o644);
    assert.equal(statSync(envPath()).mode & 0o777, 0o644);
    assert.match(readFileSync(envPath(), "utf8"), /OTHER=1/);
  });

  test("after off, a chmod then on→off restores the post-off mode", async () => {
    if (process.platform === "win32") return;
    mkdirSync(hermesDir(), { recursive: true });
    writeFileSync(configPath(), "theme: dark\n");
    writeFileSync(envPath(), "OTHER=1\n");
    chmodSync(configPath(), 0o644);
    chmodSync(envPath(), 0o644);
    await hermesAdapter.enable(input());
    await hermesAdapter.disable();
    assert.equal(statSync(envPath()).mode & 0o777, 0o644);
    assert.equal(existsSync(addedPath()), false);
    chmodSync(configPath(), 0o755);
    chmodSync(envPath(), 0o755);
    await hermesAdapter.enable(input());
    assert.equal(statSync(envPath()).mode & 0o777, 0o600);
    await hermesAdapter.disable();
    assert.equal(statSync(configPath()).mode & 0o777, 0o755);
    assert.equal(statSync(envPath()).mode & 0o777, 0o755);
  });

  test("enable(): re-on with unchanged bytes re-tightens a loosened file to 0600", async () => {
    if (process.platform === "win32") return;
    await hermesAdapter.enable(input());
    assert.equal(statSync(envPath()).mode & 0o777, 0o600);
    const firstConfig = readFileSync(configPath(), "utf8");
    const firstEnv = readFileSync(envPath(), "utf8");
    // Loosen the key file behind our back; the re-on writes identical bytes
    // but must still re-tighten while the session key is baked.
    chmodSync(envPath(), 0o644);
    const result = await hermesAdapter.enable(input());
    assert.equal(result.model, MODEL);
    assert.equal(readFileSync(configPath(), "utf8"), firstConfig);
    assert.equal(readFileSync(envPath(), "utf8"), firstEnv);
    assert.equal(statSync(envPath()).mode & 0o777, 0o600);
    const added = JSON.parse(readFileSync(addedPath(), "utf8"));
    assert.equal(added.wroteDefault, MODEL);
  });
});

describe("hermes snapshot round-trip", () => {
  test("snapshot → enable → restore is byte-identical", async () => {
    const originalConfig = 'model:\n  provider: "other"\n  default: "gpt-zzz"\n';
    const originalEnv = "OTHER=1\n";
    mkdirSync(hermesDir(), { recursive: true });
    writeFileSync(configPath(), originalConfig);
    writeFileSync(envPath(), originalEnv);

    const snapshot = await snapshotFiles("hermes", hermesAdapter.managedFiles());
    assert.ok(snapshot);

    const result = await hermesAdapter.enable(input());
    assert.deepEqual(result.filesWritten, [configPath(), envPath()]);
    assert.notEqual(readFileSync(configPath(), "utf8"), originalConfig);

    const restored = await restoreSnapshot("hermes", hermesAdapter.managedFiles());
    assert.equal(restored, true);
    assert.equal(readFileSync(configPath(), "utf8"), originalConfig);
    assert.equal(readFileSync(envPath(), "utf8"), originalEnv);
    assert.equal(await hasSnapshot("hermes"), false);
  });
});

describe("hermes review pins (PR#17)", () => {
  afterEach(() => {
    // HERMES_HOME is set per-test by the override pin; never leak it
    // into the default-home pins (the default is ~/.hermes).
    delete process.env.HERMES_HOME;
  });

  test("HERMES_HOME override relocates on, probe, off, and managedFiles", async () => {
    // #17 review: hermesHome() (adapter.ts) treats the override as
    // first-class upstream — HERMES_HOME wins over ~/.hermes, and
    // every read, write, and managedFiles() row must follow it.
    const override = join(home(), "hermes-override");
    process.env.HERMES_HOME = override;
    assert.deepEqual(hermesAdapter.managedFiles(), [
      join(override, "config.yaml"),
      join(override, ".env"),
    ]);
    await hermesAdapter.enable(input());
    // on wrote under the override; the default home stayed empty.
    assert.equal(existsSync(join(override, "config.yaml")), true);
    assert.equal(existsSync(join(override, ".env")), true);
    assert.equal(existsSync(configPath()), false);
    assert.deepEqual(await hermesAdapter.probe(), { active: true, model: MODEL });
    const off = await hermesAdapter.disable();
    assert.equal(off.stripped, true);
    // off stripped the override (on created both files, so they unlink).
    assert.equal(existsSync(join(override, "config.yaml")), false);
    assert.equal(existsSync(join(override, ".env")), false);
    assert.deepEqual(await hermesAdapter.probe(), { active: false, model: null });
  });

  test("off after a native on restores the previous default it set aside", async () => {
    // #17 review: enable({model:"native"}) records the default it
    // removed (removedDefault, adapter.ts ~:360-375); off must put
    // the user's original back byte-for-byte — the removedDefault
    // branch restores previousDefault, never re-pins the gateway model.
    mkdirSync(hermesDir(), { recursive: true });
    const seed = 'model:\n  provider: "openai"\n  default: "gpt-zzz"\n';
    writeFileSync(configPath(), seed);
    const on = await hermesAdapter.enable(input({ model: "native" }));
    assert.equal(on.model, "native");
    assert.equal(readFileSync(configPath(), "utf8").includes("gpt-zzz"), false);
    const off = await hermesAdapter.disable();
    assert.equal(off.stripped, true);
    // Byte result: the pre-on file, restored exactly.
    assert.equal(readFileSync(configPath(), "utf8"), seed);
    assert.equal(existsSync(envPath()), false);
  });

  test("off leaves a hand-edited model.default with a note", async () => {
    // #17 review: the currentDefault !== added.wroteDefault branch
    // (adapter.ts ~:362-367) — a default the user rewrote while our
    // stamp survived is theirs; off must not restore wroteDefault or
    // previousDefault over it, and says so in a note.
    await hermesAdapter.enable(input());
    writeFileSync(
      configPath(),
      readFileSync(configPath(), "utf8").replace(
        `default: "${MODEL}"`,
        'default: "user/hand-edited"',
      ),
    );
    const off = await hermesAdapter.disable();
    assert.equal(off.stripped, true);
    assert.ok(
      (off.notes ?? []).some((note) => /left model\.default because you edited it/.test(note)),
    );
    // The user's value survives; our pin and provider flip are gone.
    assert.equal(readFileSync(configPath(), "utf8"), 'model:\n  default: "user/hand-edited"\n');
  });

  test("enable() refuses a foreign block that names our dedicated key_env", async () => {
    // #17 review: the stamp is the write-side proof of ownership. A
    // providers.aiand block without managed_by is foreign even when
    // it names our key_env and a routable base_url: pinHermesProvider
    // throws, the bytes stay untouched, and --force cannot take it
    // over — force only escapes enableGuard (hermes defines none);
    // the refusal happens inside enable() itself.
    const before =
      "providers:\n  aiand:\n" +
      `    base_url: "${CLOSED_URL}/v1"\n` +
      '    key_env: "AIAND_HERMES_API_KEY"\n';
    mkdirSync(hermesDir(), { recursive: true });
    writeFileSync(configPath(), before);
    writeFileSync(envPath(), `AIAND_HERMES_API_KEY=${FAKE_API_KEY}\n`);
    await assert.rejects(
      () => hermesAdapter.enable(input()),
      (error) => error instanceof CliError && /does not manage/.test(error.message),
    );
    assert.equal(readFileSync(configPath(), "utf8"), before);
    // No stamp, no record: the foreign block reads inactive.
    assert.deepEqual(await hermesAdapter.probe(), { active: false, model: null });
    // --force does not take the block over: the CLI fails the same way.
    const stubBin = join(home(), "bin");
    plantStub(stubBin, "hermes");
    seedCatalogCache(process.env.AIAND_CONFIG_DIR);
    const { code, stderr } = await runCli(["hermes", "on", "--force"], {
      env: cliEnv({
        AIAND_HOME: home(),
        AIAND_CONFIG_DIR: process.env.AIAND_CONFIG_DIR,
        AIAND_API_KEY: FAKE_API_KEY,
        AIAND_BASE_URL: CLOSED_URL,
        PATH: `${stubBin}${delimiter}${process.env.PATH}`,
      }),
    });
    assert.notEqual(code, 0);
    assert.match(stderr, /does not manage/);
    assert.equal(readFileSync(configPath(), "utf8"), before);
  });

  test("created-flag carry-forward: a re-on still unlinks both files on off", async () => {
    // #17 review: enable() carries created only while the stamp
    // survives (prior?.created?.config === true && marked, adapter.ts
    // ~:274-277), so a re-on still counts the first on's files as
    // ours — off unlinks both instead of leaving emptied files.
    await hermesAdapter.enable(input());
    await hermesAdapter.enable(input());
    const added = JSON.parse(readFileSync(addedPath(), "utf8"));
    assert.deepEqual(added.created, { config: true, env: true });
    const off = await hermesAdapter.disable();
    assert.equal(off.stripped, true);
    assert.equal(existsSync(configPath()), false);
    assert.equal(existsSync(envPath()), false);
  });

  test("probe with a record-only repointed base_url still reads active", async () => {
    // #17 P17-5 settled the dedicated key_env as the durable
    // ownership proof for READS. probe() (adapter.ts :101-129) never
    // compares base_url against the record's wroteProvider.baseUrl:
    // with the stamp gone it takes record + dedicated key_env + a
    // routable base_url + the baked key to read active. A repoint to
    // another routable https URL is a routing-value edit, not an
    // ownership change, so probe reads active — the deliberate
    // asymmetry with disable(), whose marked branch compares the whole
    // wroteProvider (base_url included, adapter.ts ~:327-337) and
    // leaves a drifted block with a note. Reads prove ownership by
    // the var we control; writes prove it by exact bytes. Without the
    // stamp, disable() too strips on the key_env pair alone, so the
    // repointed block still comes off.
    await hermesAdapter.enable(input());
    writeFileSync(
      configPath(),
      readFileSync(configPath(), "utf8")
        .split("\n")
        .filter((line) => !line.includes("managed_by"))
        .join("\n")
        .replace(`base_url: "${CLOSED_URL}/v1"`, 'base_url: "https://repointed.example.com"'),
    );
    assert.deepEqual(await hermesAdapter.probe(), { active: true, model: MODEL });
    const off = await hermesAdapter.disable();
    assert.equal(off.stripped, true);
    assert.ok(!(off.notes ?? []).some((note) => /left providers\.aiand/.test(note)));
  });
});
