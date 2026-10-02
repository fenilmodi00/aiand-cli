// OMP (Oh My Pi) adapter: the on/off/status wiring the ai& gateway needs for
// an omp session, plus the surgical YAML editors that edit omp's two config
// files. Launcher tests live in test/run-agent.test.mjs.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import test, { beforeEach, describe } from "node:test";
import { CliError } from "../dist/cli/errors.js";
import { enableInput as baseEnableInput, catalogModel, withTestEnv } from "./helpers.mjs";

withTestEnv("aiand-omp-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_API_KEY = "sk-test-123";
  // test/setup.mjs clears PI_CONFIG_DIR and XDG_DATA_HOME globally; the
  // deletes below are belt-and-braces so this file stays hermetic even when
  // run without the preload.
  delete process.env.PI_CONFIG_DIR;
  // Same reason: a developer's own XDG-migrated omp would redirect the
  // session dir out from under the default-location assertions.
  delete process.env.XDG_DATA_HOME;
  mkdirSync(join(process.env.AIAND_HOME, ".omp", "agent"), { recursive: true });
  mkdirSync(process.env.AIAND_CONFIG_DIR, { recursive: true });
});

const { ompAdapter } = await import("../dist/agents/omp/adapter.js");
const { buildOmpProviderBlock } = await import("../dist/agents/omp/provider.js");
const { parseYaml, parseScalar, readYamlMapping, renderScalar, yamlDelete, yamlRender, yamlSet } =
  await import("../dist/agents/omp/yaml.js");
const { restoreSnapshot, snapshotFiles } = await import("../dist/agents/snapshot.js");

beforeEach(() => {
  rmSync(join(process.env.AIAND_HOME, ".omp"), { recursive: true, force: true });
  rmSync(join(process.env.AIAND_CONFIG_DIR, "snapshots", "omp"), {
    recursive: true,
    force: true,
  });
  mkdirSync(join(process.env.AIAND_HOME, ".omp", "agent"), { recursive: true });
});

const agentDir = () => join(process.env.AIAND_HOME, ".omp", "agent");
const modelsPath = () => join(agentDir(), "models.yml");
const configPath = () => join(agentDir(), "config.yml");
const addedRecord = () => join(process.env.AIAND_CONFIG_DIR, "snapshots", "omp", "added.json");

const CATALOG = [
  catalogModel("zai-org/glm-5.3", { capabilities: ["tools", "vision"] }),
  catalogModel("qwen/qwen3.8-27b"),
];

const enableInput = (overrides = {}) =>
  baseEnableInput({
    apiKey: "sk-enable-1",
    model: "zai-org/glm-5.3",
    catalog: CATALOG,
    baseUrl: "https://api.aiand.com",
    ...overrides,
  });

const readText = (path) => readFileSync(path, "utf8");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const configDefault = () => readYamlMapping(readText(configPath())).modelRoles.default;

// A user's own models.yml: a comment, another provider, their key.
const MODELS_SEED = [
  "# my omp providers",
  "providers:",
  "  openai:",
  "    baseUrl: https://api.openai.com/v1",
  "    apiKey: sk-user-openai",
  "",
].join("\n");

const CONFIG_SEED = (defaultModel) =>
  ["symbolPreset: unicode", "modelRoles:", `  default: ${defaultModel}`, ""].join("\n");

/** Seed the two files the way a user's omp would have them. */
function seedUserFiles(defaultModel = "anthropic/claude-haiku-4-5") {
  writeFileSync(modelsPath(), MODELS_SEED);
  writeFileSync(configPath(), CONFIG_SEED(defaultModel));
  return { models: readFileSync(modelsPath()), config: readFileSync(configPath()) };
}

/** Our stamped provider block with a routable URL, nothing else in the file. */
const MARKED_MODELS = [
  "providers:",
  "  aiand:",
  "    baseUrl: https://api.aiand.com/v1",
  "    apiKey: sk-x",
  "    managedBy: aiand",
  "",
].join("\n");

/** The same provider a user named `aiand` themselves: no stamp, never ours. */
const FOREIGN_MODELS = [
  "providers:",
  "  aiand:",
  "    baseUrl: https://api.aiand.com/v1",
  "    apiKey: sk-foreign",
  "",
].join("\n");

/** Every seed line still present in `text`, in order (comment, bytes, order). */
function assertLinesKept(text, seed) {
  let pos = -1;
  for (const line of seed.split("\n")) {
    if (line.trim() === "") continue;
    pos = text.indexOf(line, pos + 1);
    assert.ok(pos >= 0, `lost line: ${JSON.stringify(line)}`);
  }
}

describe("omp adapter", () => {
  test("id/label/bin/aliases/install/managedFiles", () => {
    assert.equal(ompAdapter.id, "omp");
    assert.equal(ompAdapter.label, "Oh My Pi");
    assert.equal(ompAdapter.bin, "omp");
    assert.deepEqual(ompAdapter.aliases, ["oh-my-pi"]);
    // The hint downloads the pinned release asset, verifies the digest,
    // and leaves the binary at omp's own default location.
    assert.match(ompAdapter.install.command, /oh-my-pi\/releases\/download\/v\d+\.\d+\.\d+\/omp-/);
    assert.doesNotMatch(ompAdapter.install.command, /\|\s*sh\b/);
    assert.doesNotMatch(ompAdapter.install.command, /omp\.sh\/install/);
    assert.match(ompAdapter.install.command, /\/\.local\/bin\/omp/);
    assert.match(ompAdapter.install.command, /sha256sum -c -|shasum -a 256 -c -/);
    assert.equal(ompAdapter.install.url, "https://omp.sh");
    assert.deepEqual(ompAdapter.managedFiles(), [modelsPath(), configPath()]);
  });

  test("ompAgentDir honors PI_CODING_AGENT_DIR and PI_CONFIG_DIR", () => {
    const elsewhere = join(process.env.AIAND_HOME, "elsewhere", "agent");
    process.env.PI_CODING_AGENT_DIR = elsewhere;
    try {
      assert.deepEqual(ompAdapter.managedFiles(), [
        join(elsewhere, "models.yml"),
        join(elsewhere, "config.yml"),
      ]);
    } finally {
      delete process.env.PI_CODING_AGENT_DIR;
    }
    process.env.PI_CONFIG_DIR = "custom-omp";
    try {
      assert.deepEqual(ompAdapter.managedFiles(), [
        join(process.env.AIAND_HOME, "custom-omp", "agent", "models.yml"),
        join(process.env.AIAND_HOME, "custom-omp", "agent", "config.yml"),
      ]);
    } finally {
      delete process.env.PI_CONFIG_DIR;
    }
  });

  // PR #18 review: restore --force after an agent-dir move —
  // managedFiles() must cover the recorded paths, not just the
  // current env's, or restoreSnapshot refuses them.
  test("managedFiles(): includes the recorded paths after the agent dir moved", async () => {
    const elsewhere = join(process.env.AIAND_HOME, "elsewhere", "agent");
    process.env.PI_CODING_AGENT_DIR = elsewhere;
    try {
      mkdirSync(elsewhere, { recursive: true });
      seedUserFiles();
      await snapshotFiles("omp", ompAdapter.managedFiles());
      await ompAdapter.enable(enableInput());
    } finally {
      delete process.env.PI_CODING_AGENT_DIR;
    }

    // Back in a shell without the relocation env: the widened
    // list still names both dirs' files, with no duplicates.
    assert.deepEqual(ompAdapter.managedFiles(), [
      modelsPath(),
      configPath(),
      join(elsewhere, "models.yml"),
      join(elsewhere, "config.yml"),
    ]);

    // The manifest names the moved dir's files; restore must
    // accept them instead of throwing "not a managed file".
    assert.equal(await restoreSnapshot("omp", ompAdapter.managedFiles()), true);
  });

  test("probe(): absent config is inactive with no model", async () => {
    assert.deepEqual(await ompAdapter.probe(), { active: false, model: null });
  });

  test("probe(): foreign aiand block without the marker is never active", async () => {
    writeFileSync(modelsPath(), FOREIGN_MODELS);
    assert.equal((await ompAdapter.probe()).active, false);
  });

  test("probe(): marked provider with a non-routable baseUrl is inactive", async () => {
    writeFileSync(
      modelsPath(),
      "providers:\n  aiand:\n    baseUrl: ftp://example.com\n    managedBy: aiand\n",
    );
    assert.equal((await ompAdapter.probe()).active, false);
  });

  test("probe(): marked provider and an aiand-prefixed default report the catalog id", async () => {
    writeFileSync(modelsPath(), MARKED_MODELS);
    writeFileSync(configPath(), "modelRoles:\n  default: aiand/zai-org/glm-5.3\n");
    assert.deepEqual(await ompAdapter.probe(), { active: true, model: "zai-org/glm-5.3" });
  });

  test("probe(): marked provider with no pinned model is active with no model", async () => {
    writeFileSync(modelsPath(), MARKED_MODELS);
    assert.deepEqual(await ompAdapter.probe(), { active: true, model: null });
  });

  // PR #18 review: routability plus the stamp is not ownership
  // either — with a live record, a block the user repointed at
  // their own routable origin is theirs: status reads inactive,
  // the same answer off gives.
  test("probe(): a repointed baseUrl reads inactive while the stamp survives", async () => {
    seedUserFiles();
    await ompAdapter.enable(enableInput());
    writeFileSync(
      modelsPath(),
      readText(modelsPath()).replace(
        "baseUrl: https://api.aiand.com/v1",
        "baseUrl: https://api.their-own-origin.com/v1",
      ),
    );
    assert.equal((await ompAdapter.probe()).active, false);
  });

  // PR #18 review: the record alone backstops a stamp a rewrite
  // dropped — the block still routes to the baseUrl `on` wrote,
  // so status reads it active, like off would strip it.
  test("probe(): a stamp-dropped block the record still proves reads active", async () => {
    seedUserFiles();
    await ompAdapter.enable(enableInput());
    // A rewrite that drops unknown keys takes our managedBy
    // stamp but leaves the block (and its baseUrl) in place.
    writeFileSync(modelsPath(), readText(modelsPath()).replace("    managedBy: aiand\n", ""));
    assert.deepEqual(await ompAdapter.probe(), { active: true, model: "zai-org/glm-5.3" });
  });

  test("buildOmpProviderBlock: override-only block with /v1 and the fallback", () => {
    assert.deepEqual(buildOmpProviderBlock({ baseUrl: "https://gw.example/", apiKey: "sk-1" }), {
      baseUrl: "https://gw.example/v1",
      apiKey: "sk-1",
      managedBy: "aiand",
    });
    assert.equal(buildOmpProviderBlock({ apiKey: "sk-1" }).baseUrl, "https://api.aiand.com/v1");
  });

  test("enable(): wires the provider block, keeps the user's files", async () => {
    const seed = seedUserFiles();
    const result = await ompAdapter.enable(enableInput());
    assert.deepEqual(result.filesWritten, [modelsPath(), configPath()]);
    assert.equal(result.model, "zai-org/glm-5.3");
    assert.equal(result.catalogModel, "zai-org/glm-5.3");

    const modelsText = readText(modelsPath());
    const models = readYamlMapping(modelsText);
    assert.deepEqual(models.providers.aiand, {
      baseUrl: "https://api.aiand.com/v1",
      apiKey: "sk-enable-1",
      managedBy: "aiand",
    });
    assert.deepEqual(models.providers.openai, {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-user-openai",
    });
    assertLinesKept(modelsText, String(seed.models));

    const config = readYamlMapping(readText(configPath()));
    assert.equal(config.symbolPreset, "unicode");
    assert.equal(config.modelRoles.default, "aiand/zai-org/glm-5.3");

    // The key lives in the file, never in the added-state record.
    const record = readJson(addedRecord());
    assert.ok(!JSON.stringify(record).includes("sk-enable-1"));
    assert.equal(record.previousDefaultModel, "anthropic/claude-haiku-4-5");
    assert.equal(record.wroteDefaultModel, "aiand/zai-org/glm-5.3");

    // models.yml holds the session key: private for as long as it lives there.
    if (process.platform !== "win32") {
      assert.equal(statSync(modelsPath()).mode & 0o777, 0o600);
    }

    // probe reads the real files back.
    assert.deepEqual(await ompAdapter.probe(), { active: true, model: "zai-org/glm-5.3" });
  });

  test("enable(): keeps a catalog-servable modelRoles.default unless --model pins", async () => {
    const seed = seedUserFiles("qwen/qwen3.8-27b");
    const result = await ompAdapter.enable(enableInput());
    assert.equal(readText(configPath()), String(seed.config));
    assert.equal(result.model, "qwen/qwen3.8-27b");
    assert.equal(result.catalogModel, "qwen/qwen3.8-27b");
    // The provider is still wired, and there is no write for off to undo.
    assert.equal(readYamlMapping(readText(modelsPath())).providers.aiand.managedBy, "aiand");
    assert.equal(readJson(addedRecord()).wroteDefaultModel, undefined);
    await ompAdapter.disable();
    assert.equal(configDefault(), "qwen/qwen3.8-27b");
  });

  test("--model pin overwrites the user's default and off restores it", async () => {
    seedUserFiles("qwen/qwen3.8-27b");
    const result = await ompAdapter.enable(enableInput({ pinModel: true }));
    assert.equal(result.model, "zai-org/glm-5.3");
    assert.equal(configDefault(), "aiand/zai-org/glm-5.3");
    await ompAdapter.disable();
    assert.equal(configDefault(), "qwen/qwen3.8-27b");
  });

  test("--model native leaves modelRoles.default untouched with a warning", async () => {
    const seed = seedUserFiles();
    const result = await ompAdapter.enable(enableInput({ model: "native" }));
    assert.equal(readText(configPath()), String(seed.config));
    assert.ok(result.warnings.some((w) => /pass --model to pick one/.test(w)));
    // Routing is still wired; only the model pin is skipped.
    assert.equal(readYamlMapping(readText(modelsPath())).providers.aiand.managedBy, "aiand");
  });

  test("enable(): a sequence-valued providers parent refuses loudly, file untouched", async () => {
    const broken = "providers:\n  - openai\n";
    writeFileSync(modelsPath(), broken);
    await assert.rejects(
      ompAdapter.enable(enableInput()),
      (error) =>
        error instanceof CliError &&
        error.message.includes(modelsPath()) &&
        error.hint === "Fix it by hand, or delete it and run aiand omp on again.",
    );
    assert.equal(readText(modelsPath()), broken);
    // Nothing was wired: no config write, no record.
    assert.equal(existsSync(configPath()), false);
    assert.equal(existsSync(addedRecord()), false);
  });

  test("enable(): the record names the baseUrl on wrote (never the key)", async () => {
    seedUserFiles();
    await ompAdapter.enable(enableInput());
    assert.equal(readJson(addedRecord()).wroteBaseUrl, "https://api.aiand.com/v1");
  });

  // PR #18 review: a stamp a rewrite dropped is a rebake, not a
  // foreign block — the record proves the routing ours, so `on`
  // re-wires it instead of refusing (off would strip it).
  test("enable(): a stamp-dropped block the record proves is re-wired, not refused", async () => {
    seedUserFiles();
    await ompAdapter.enable(enableInput());
    writeFileSync(modelsPath(), readText(modelsPath()).replace("    managedBy: aiand\n", ""));
    const result = await ompAdapter.enable(enableInput());
    assert.equal(result.model, "zai-org/glm-5.3");
    assert.equal(readYamlMapping(readText(modelsPath())).providers.aiand.managedBy, "aiand");
  });

  test("off: a stamp-dropped block the record still owns is stripped", async () => {
    const seed = seedUserFiles();
    await ompAdapter.enable(enableInput());
    // A rewrite that drops unknown keys takes our managedBy
    // stamp but leaves the block (and its baseUrl) in place.
    writeFileSync(modelsPath(), readText(modelsPath()).replace("    managedBy: aiand\n", ""));
    const result = await ompAdapter.disable();
    assert.equal(result.stripped, true);
    assert.equal(readFileSync(modelsPath()).equals(seed.models), true);
    assert.equal(readFileSync(configPath()).equals(seed.config), true);
    assert.equal((await ompAdapter.probe()).active, false);
  });

  test("off: a repointed baseUrl inside our marked block is left with a note", async () => {
    seedUserFiles();
    await ompAdapter.enable(enableInput());
    // The user repointed our block at their own origin: the
    // edit is theirs, so off must not silently strip it.
    writeFileSync(
      modelsPath(),
      readText(modelsPath()).replace(
        "baseUrl: https://api.aiand.com/v1",
        "baseUrl: https://api.their-own-origin.com/v1",
      ),
    );
    const result = await ompAdapter.disable();
    assert.ok(result.notes.some((n) => /left providers\.aiand because you edited it/.test(n)));
    // The block stays exactly as the user left it…
    assert.equal(
      readYamlMapping(readText(modelsPath())).providers.aiand.baseUrl,
      "https://api.their-own-origin.com/v1",
    );
    assert.equal(readYamlMapping(readText(modelsPath())).providers.aiand.managedBy, "aiand");
    // …while the config.yml hand-back still runs.
    assert.equal(configDefault(), "anthropic/claude-haiku-4-5");
  });

  test("off: a stamp-dropped, repointed block is left with a note", async () => {
    seedUserFiles();
    await ompAdapter.enable(enableInput());
    writeFileSync(
      modelsPath(),
      "providers:\n  aiand:\n    baseUrl: https://api.elsewhere.example/v1\n    apiKey: sk-user\n",
    );
    const result = await ompAdapter.disable();
    assert.ok(result.notes.some((n) => /left providers\.aiand because you edited it/.test(n)));
    assert.equal(
      readYamlMapping(readText(modelsPath())).providers.aiand.baseUrl,
      "https://api.elsewhere.example/v1",
    );
    assert.equal(configDefault(), "anthropic/claude-haiku-4-5");
  });

  test("off: a foreign block with no record stays silent", async () => {
    writeFileSync(modelsPath(), FOREIGN_MODELS);
    const result = await ompAdapter.disable();
    assert.equal(result.stripped, false);
    assert.deepEqual(result.notes, []);
    assert.equal(readText(modelsPath()), FOREIGN_MODELS);
  });

  test("unservable default is set aside with a warning and restored by off", async () => {
    seedUserFiles("gpt-4o");
    const result = await ompAdapter.enable(enableInput());
    assert.ok(result.warnings.some((w) => /Set aside your modelRoles\.default \(gpt-4o\)/.test(w)));
    assert.equal(configDefault(), "aiand/zai-org/glm-5.3");
    await ompAdapter.disable();
    assert.equal(configDefault(), "gpt-4o");
  });

  test("off: restores the previous default, strips our block, files byte-identical", async () => {
    const seed = seedUserFiles();
    await ompAdapter.enable(enableInput());
    const result = await ompAdapter.disable();
    assert.equal(result.stripped, true);
    assert.equal(readFileSync(modelsPath()).equals(seed.models), true);
    assert.equal(readFileSync(configPath()).equals(seed.config), true);
    assert.equal((await ompAdapter.probe()).active, false);
    // Idempotent: a second off is a no-op.
    assert.equal((await ompAdapter.disable()).stripped, false);
  });

  test("off: an empty modelRoles flow map in config.yml still strips models.yml", async () => {
    const seed = seedUserFiles();
    await ompAdapter.enable(enableInput());
    // `omp config reset modelRoles` leaves what omp's own writer
    // (Bun.YAML.stringify) emits for an empty map: a flow map on
    // its own indented line, no trailing newline.
    writeFileSync(configPath(), "modelRoles:\n  {}");
    const result = await ompAdapter.disable();
    assert.equal(result.stripped, true);
    assert.equal(readFileSync(modelsPath()).equals(seed.models), true);
    // The reset is the user's: off found no default of ours to
    // hand back, so config.yml stays exactly as omp left it.
    assert.equal(readText(configPath()), "modelRoles:\n  {}");
    assert.deepEqual(await ompAdapter.probe(), { active: false, model: null });
  });

  test("enable(): opens a commented empty-map placeholder without breaking the doc", async () => {
    seedUserFiles();
    // omp's writer can leave `{}` after a comment/blank inside the block.
    writeFileSync(configPath(), "modelRoles:\n  # pinned roles\n  {}\n");
    await ompAdapter.enable(enableInput());
    const text = readText(configPath());
    assert.equal(text.includes("{}"), false);
    assert.equal(text.includes("# pinned roles"), true);
    assert.equal(configDefault(), "aiand/zai-org/glm-5.3");
    assert.deepEqual(await ompAdapter.probe(), { active: true, model: "zai-org/glm-5.3" });
  });

  test("off: unlinks the files it created when nothing is left", async () => {
    // Only the command layer snapshots before the first write; seed that here
    // so the manifest records that neither file existed.
    await snapshotFiles("omp", ompAdapter.managedFiles());
    await ompAdapter.enable(enableInput());
    await ompAdapter.disable();
    assert.equal(existsSync(modelsPath()), false);
    assert.equal(existsSync(configPath()), false);
  });

  test("off: keeps a user-edited default with a note, still strips our block", async () => {
    seedUserFiles();
    await ompAdapter.enable(enableInput());
    writeFileSync(configPath(), CONFIG_SEED("aiand/qwen/qwen3.8-27b"));
    const result = await ompAdapter.disable();
    assert.equal(result.stripped, true);
    assert.ok(result.notes.some((n) => /left modelRoles\.default because you edited it/.test(n)));
    assert.equal(configDefault(), "aiand/qwen/qwen3.8-27b");
    assert.equal(readYamlMapping(readText(modelsPath())).providers.aiand, undefined);
  });

  test("off: broken config.yml writes nothing, keeps marker and record, retry restores", async () => {
    seedUserFiles();
    await ompAdapter.enable(enableInput());
    const modelsAfterEnable = readFileSync(modelsPath());
    writeFileSync(configPath(), "modelRoles: {broken}\n");

    const result = await ompAdapter.disable();
    assert.equal(result.stripped, false);
    assert.ok(result.notes.some((n) => n.includes("not valid YAML")));
    // Nothing was written: the marker survives and the record still holds
    // the previous default for the retry.
    assert.equal(readFileSync(modelsPath()).equals(modelsAfterEnable), true);
    assert.equal(readJson(addedRecord()).previousDefaultModel, "anthropic/claude-haiku-4-5");

    // The user fixes config.yml; the retry strips and restores the default.
    writeFileSync(configPath(), CONFIG_SEED("aiand/zai-org/glm-5.3"));
    const retry = await ompAdapter.disable();
    assert.equal(retry.stripped, true);
    assert.equal(configDefault(), "anthropic/claude-haiku-4-5");
    assert.equal(existsSync(addedRecord()), false);
  });

  test("off: strips the block from the recorded dir when the config dir moved", async () => {
    const seed = seedUserFiles();
    await ompAdapter.enable(enableInput());
    // The user relocated omp's agent dir between `on` and `off`; the moved
    // dir need not exist — off must still honor the recorded paths.
    process.env.PI_CODING_AGENT_DIR = join(process.env.AIAND_HOME, "moved", "agent");
    try {
      const result = await ompAdapter.disable();
      assert.equal(result.stripped, true);
      assert.equal(readFileSync(modelsPath()).equals(seed.models), true);
      assert.equal(readFileSync(configPath()).equals(seed.config), true);
      assert.equal(existsSync(addedRecord()), false);
      assert.ok(result.notes.some((n) => n.includes("config dir moved")));
    } finally {
      delete process.env.PI_CODING_AGENT_DIR;
    }
  });

  test("off: unparseable relocated config keeps the record for retry", async () => {
    const seed = seedUserFiles();
    await ompAdapter.enable(enableInput());
    process.env.PI_CODING_AGENT_DIR = join(process.env.AIAND_HOME, "moved", "agent");
    try {
      writeFileSync(configPath(), "modelRoles: {broken}\n");
      const result = await ompAdapter.disable();
      // The OLD models.yml was stripped anyway; the record survives for retry.
      assert.equal(result.stripped, true);
      assert.equal(readFileSync(modelsPath()).equals(seed.models), true);
      assert.ok(
        result.notes.some((n) => n.includes("is not valid YAML") && n.includes(configPath())),
      );
      assert.equal(existsSync(addedRecord()), true);

      // The user fixes the old config.yml; the retry restores and clears it.
      writeFileSync(configPath(), CONFIG_SEED("aiand/zai-org/glm-5.3"));
      const retry = await ompAdapter.disable();
      assert.equal(retry.stripped, true);
      assert.equal(readFileSync(configPath()).equals(seed.config), true);
      assert.equal(existsSync(addedRecord()), false);
    } finally {
      delete process.env.PI_CODING_AGENT_DIR;
    }
  });

  test("off: unparseable relocated models.yml with nothing stripped reports false", async () => {
    seedUserFiles();
    await ompAdapter.enable(enableInput());
    process.env.PI_CODING_AGENT_DIR = join(process.env.AIAND_HOME, "moved", "agent");
    try {
      // models.yml is the first stale file off reads: unreadable there means
      // nothing was stripped yet, so stripped stays false for the retry.
      writeFileSync(modelsPath(), "providers: {broken}\n");
      const result = await ompAdapter.disable();
      assert.equal(result.stripped, false);
      assert.ok(
        result.notes.some((n) => n.includes("is not valid YAML") && n.includes(modelsPath())),
      );
      assert.equal(existsSync(addedRecord()), true);
    } finally {
      delete process.env.PI_CODING_AGENT_DIR;
    }
  });

  test("refreshKey: idempotent same key, previousKey gates, one-literal swap", async () => {
    seedUserFiles();
    await ompAdapter.enable(enableInput());
    const before = readText(modelsPath());

    assert.equal(await ompAdapter.refreshKey({ apiKey: "sk-enable-1" }), true);
    assert.equal(readText(modelsPath()), before);

    assert.equal(await ompAdapter.refreshKey({ apiKey: "sk-new", previousKey: "sk-other" }), false);
    assert.equal(readText(modelsPath()), before);

    const rotated = await ompAdapter.refreshKey({
      apiKey: "sk-new",
      previousKey: "sk-enable-1",
    });
    assert.equal(rotated, true);
    const after = readText(modelsPath());
    assert.equal(after, before.replace("apiKey: sk-enable-1", "apiKey: sk-new"));
    const models = readYamlMapping(after);
    assert.equal(models.providers.aiand.apiKey, "sk-new");
    assert.equal(models.providers.aiand.baseUrl, "https://api.aiand.com/v1");
    assert.equal(models.providers.openai.apiKey, "sk-user-openai");
    assertLinesKept(after, MODELS_SEED);
  });

  test("refreshKey: foreign aiand block returns false untouched", async () => {
    writeFileSync(modelsPath(), FOREIGN_MODELS);
    assert.equal(await ompAdapter.refreshKey({ apiKey: "sk-new" }), false);
    assert.ok(!readText(modelsPath()).includes("sk-new"));
  });

  test("refreshKey: malformed models.yml returns false, no throw", async () => {
    writeFileSync(modelsPath(), "providers: {broken}\n");
    assert.equal(await ompAdapter.refreshKey({ apiKey: "sk-new" }), false);
    // The broken file is left exactly as it was.
    assert.equal(readText(modelsPath()), "providers: {broken}\n");
  });

  const sessionInput = (overrides = {}) => ({
    apiKey: "sk-session-1",
    model: "zai-org/glm-5.3",
    catalog: CATALOG,
    baseUrl: "https://api.aiand.com",
    ...overrides,
  });

  test("sessionLaunch: overlay files, child env, args, cleanup", async () => {
    const launch = await ompAdapter.sessionLaunch(sessionInput());
    const overlay = launch.env.PI_CODING_AGENT_DIR;
    try {
      assert.match(basename(overlay), /^aiand-omp-/);
      assert.equal(launch.env.PI_CODING_AGENT_SESSION_DIR, join(agentDir(), "sessions"));

      assert.deepEqual(readYamlMapping(readText(join(overlay, "models.yml"))), {
        providers: {
          aiand: {
            baseUrl: "https://api.aiand.com/v1",
            apiKey: "sk-session-1",
            managedBy: "aiand",
          },
        },
      });
      assert.deepEqual(readYamlMapping(readText(join(overlay, "config.yml"))), {
        modelRoles: { default: "aiand/zai-org/glm-5.3" },
      });
      if (process.platform !== "win32") {
        assert.equal(statSync(join(overlay, "models.yml")).mode & 0o777, 0o600);
        assert.equal(statSync(join(overlay, "config.yml")).mode & 0o777, 0o600);
      }

      // Non-TTY stdin under the test runner: an explicit one-shot launch.
      assert.deepEqual(launch.args.slice(0, 2), ["--model", "aiand/zai-org/glm-5.3"]);
      assert.ok(launch.args.includes("--print"));
      // The overlay file carries the key, never the child env.
      assert.ok(!JSON.stringify(launch.env).includes("sk-"));
    } finally {
      await launch.cleanup();
    }
    assert.equal(existsSync(overlay), false);
  });

  test("sessionLaunch: session dir honors the inherited env", async () => {
    process.env.PI_CODING_AGENT_SESSION_DIR = "/elsewhere/history";
    try {
      const launch = await ompAdapter.sessionLaunch(sessionInput());
      assert.equal(launch.env.PI_CODING_AGENT_SESSION_DIR, "/elsewhere/history");
      await launch.cleanup();
    } finally {
      delete process.env.PI_CODING_AGENT_SESSION_DIR;
    }
  });

  test("sessionLaunch: native omits --model and the modelRoles pin", async () => {
    const launch = await ompAdapter.sessionLaunch(sessionInput({ model: "native" }));
    const overlay = launch.env.PI_CODING_AGENT_DIR;
    try {
      // The provider pin rides the overlay models.yml only…
      assert.deepEqual(readYamlMapping(readText(join(overlay, "models.yml"))), {
        providers: {
          aiand: {
            baseUrl: "https://api.aiand.com/v1",
            apiKey: "sk-session-1",
            managedBy: "aiand",
          },
        },
      });
      // …no config.yml is baked, so omp's own default
      // resolution picks the model.
      assert.equal(existsSync(join(overlay, "config.yml")), false);
      assert.ok(!launch.args.includes("--model"));
      assert.ok(!launch.args.some((a) => a.startsWith("aiand/")));
      assert.ok(launch.args.includes("--print"));
    } finally {
      await launch.cleanup();
    }
    assert.equal(existsSync(overlay), false);
  });

  test("adapter surface: allowUnpinnedModel and the proven shadowEnv", () => {
    assert.equal(ompAdapter.allowUnpinnedModel, true);
    // Literal list, each name proven against the omp binary
    // (see the comment on ompAdapter.shadowEnv).
    assert.deepEqual(ompAdapter.shadowEnv, [
      "OMP_PROFILE",
      "AIAND_BASE_URL",
      "PI_SMOL_MODEL",
      "PI_SLOW_MODEL",
      "PI_PLAN_MODEL",
    ]);
  });

  // The XDG redirect mirrors omp's DirResolver: linux/darwin only.
  const xdgPlatform = process.platform === "linux" || process.platform === "darwin";

  test("sessionLaunch: XDG-migrated omp keeps history in its XDG sessions dir", {
    skip: !xdgPlatform,
  }, async () => {
    const xdg = join(process.env.AIAND_HOME, "xdg");
    mkdirSync(join(xdg, "omp"), { recursive: true });
    delete process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.XDG_DATA_HOME = xdg;
      const launch = await ompAdapter.sessionLaunch(sessionInput());
      try {
        assert.equal(launch.env.PI_CODING_AGENT_SESSION_DIR, join(xdg, "omp", "sessions"));
      } finally {
        await launch.cleanup();
      }
    } finally {
      delete process.env.XDG_DATA_HOME;
    }
  });

  test("sessionLaunch: XDG_DATA_HOME without an omp data dir falls back to the agent dir", {
    skip: !xdgPlatform,
  }, async () => {
    const xdg = join(process.env.AIAND_HOME, "xdg-empty"); // never created
    delete process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.XDG_DATA_HOME = xdg;
      const launch = await ompAdapter.sessionLaunch(sessionInput());
      try {
        assert.equal(launch.env.PI_CODING_AGENT_SESSION_DIR, join(agentDir(), "sessions"));
      } finally {
        await launch.cleanup();
      }
    } finally {
      delete process.env.XDG_DATA_HOME;
    }
  });

  test("sessionLaunch: PI_CODING_AGENT_DIR beats an XDG-migrated omp", {
    skip: !xdgPlatform,
  }, async () => {
    const xdg = join(process.env.AIAND_HOME, "xdg");
    mkdirSync(join(xdg, "omp"), { recursive: true });
    const elsewhere = join(process.env.AIAND_HOME, "elsewhere", "agent");
    try {
      process.env.XDG_DATA_HOME = xdg;
      process.env.PI_CODING_AGENT_DIR = elsewhere;
      const launch = await ompAdapter.sessionLaunch(sessionInput());
      try {
        assert.equal(launch.env.PI_CODING_AGENT_SESSION_DIR, join(elsewhere, "sessions"));
      } finally {
        await launch.cleanup();
      }
    } finally {
      delete process.env.XDG_DATA_HOME;
      delete process.env.PI_CODING_AGENT_DIR;
    }
  });
});

describe("omp yaml editors", () => {
  test("parseYaml: a realistic models.yml", () => {
    assert.deepEqual(parseYaml(MODELS_SEED), {
      providers: { openai: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-user-openai" } },
    });
  });

  test("yamlSet: unrelated lines and the comment survive byte-wise", () => {
    const after = yamlSet(MODELS_SEED, ["providers", "aiand"], {
      baseUrl: "https://api.aiand.com/v1",
      apiKey: "sk-enable-1",
      managedBy: "aiand",
    });
    assertLinesKept(after, MODELS_SEED);
    assert.deepEqual(readYamlMapping(after).providers.aiand, {
      baseUrl: "https://api.aiand.com/v1",
      apiKey: "sk-enable-1",
      managedBy: "aiand",
    });
  });

  test("yamlSet: rewrites only the addressed entry of an existing map", () => {
    const text = "modelRoles:\n  default: anthropic/claude-haiku-4-5\n  fallback: openai/gpt-5\n";
    const after = yamlSet(text, ["modelRoles", "default"], "aiand/zai-org/glm-5.3");
    assert.deepEqual(readYamlMapping(after), {
      modelRoles: { default: "aiand/zai-org/glm-5.3", fallback: "openai/gpt-5" },
    });
  });

  test("yamlDelete: leaves no empty husk and keeps siblings", () => {
    const text = "symbolPreset: unicode\nmodelRoles:\n  default: aiand/zai-org/glm-5.3\n";
    const after = yamlDelete(text, ["modelRoles", "default"]);
    assert.ok(!after.includes("modelRoles"));
    assert.deepEqual(readYamlMapping(after), { symbolPreset: "unicode" });
    // The last entry under the only key takes its husk with it.
    const empty = yamlDelete("modelRoles:\n  default: x\n", ["modelRoles", "default"]);
    assert.deepEqual(readYamlMapping(empty), {});
  });
  test("yamlSet/yamlDelete: blank separators around an entry survive byte-wise", () => {
    // A blank line between siblings is not part of any entry's block:
    // set must not eat it, and delete must not take it with the entry.
    const seed = "modelRoles:\n  default: anthropic/x\n\nsymbolPreset: unicode\n";
    const set = yamlSet(seed, ["modelRoles", "default"], "aiand/zai-org/glm-5.3");
    assert.equal(set, "modelRoles:\n  default: aiand/zai-org/glm-5.3\n\nsymbolPreset: unicode\n");
    const removed = yamlDelete(set, ["modelRoles", "default"]);
    assert.equal(removed, "\nsymbolPreset: unicode\n");
    // A trailing blank inside the last block stays with the file.
    const tail = "providers:\n  openai:\n    baseUrl: https://x\n\n";
    const setTail = yamlSet(tail, ["providers", "aiand"], {
      baseUrl: "http://y/v1",
      apiKey: "sk-1",
      managedBy: "aiand",
    });
    assert.equal(
      yamlDelete(setTail, ["providers", "aiand"]),
      "providers:\n  openai:\n    baseUrl: https://x\n\n",
    );
  });
  test("parseYaml: unquoted selectors, quoted '#' and ':', numbers, booleans, null", () => {
    const text = [
      "selector: aiand/zai-org/glm-5.3",
      'note: "release #2: pinned"',
      "url: https://x.example/v1 # endpoint",
      "count: 3",
      "ratio: -2.5",
      "enabled: true",
      "empty:",
      "nothing: null",
      "tilde: ~",
    ].join("\n");
    assert.deepEqual(readYamlMapping(text), {
      selector: "aiand/zai-org/glm-5.3",
      note: "release #2: pinned",
      url: "https://x.example/v1",
      count: 3,
      ratio: -2.5,
      enabled: true,
      empty: null,
      nothing: null,
      tilde: null,
    });
  });

  test("parseYaml: a quoted sequence item containing ': ' stays one item", () => {
    assert.deepEqual(parseYaml('stream:\n  redactPatterns:\n    - "token: [a-z]+"\n'), {
      stream: { redactPatterns: ["token: [a-z]+"] },
    });
  });

  test("parseScalar: YAML-only double-quote escapes decode, unknown ones throw", () => {
    assert.equal(parseScalar('"x\\_y\\Lz\\x41"'), "x\u00a0y\u2028zA");
    assert.equal(parseScalar('"tab\\there"'), "tab\there");
    assert.equal(parseScalar('"q\\"q"'), 'q"q');
    assert.throws(() => parseScalar('"x\\qy"'), SyntaxError);
    assert.throws(() => parseScalar('"x\\"'), SyntaxError);
  });

  test("parseYaml: a quoted key keeps its identity", () => {
    assert.deepEqual(readYamlMapping('"a:b": 1\n'), { "a:b": 1 });
  });

  test("parseYaml: block sequences", () => {
    assert.deepEqual(parseYaml("modes:\n  - fast\n  - 1\n  - 2.5\n"), { modes: ["fast", 1, 2.5] });
  });

  test("parseYaml: flow sequences keep quoted commas intact", () => {
    assert.deepEqual(parseYaml('modes: ["a,b", c]\n'), { modes: ["a,b", "c"] });
    assert.deepEqual(parseYaml("modes: ['d,e', f]\n"), { modes: ["d,e", "f"] });
  });

  test("parseYaml: sequence of mappings keeps sibling, last, and nested entries", () => {
    const text = "items:\n  - id: a\n  - id: b\n  - compat:\n      x: 1\n";
    assert.deepEqual(parseYaml(text), {
      items: [{ id: "a" }, { id: "b" }, { compat: { x: 1 } }],
    });
  });

  test("parseYaml: flow mappings and tab indentation are SyntaxError", () => {
    assert.throws(() => parseYaml("providers: {aiand: x}\n"), SyntaxError);
    assert.throws(() => parseYaml("modelRoles:\n\tdefault: x\n"), SyntaxError);
  });

  test("yamlRender round-trips through parseYaml", () => {
    const doc = {
      providers: {
        aiand: { baseUrl: "https://api.aiand.com/v1", apiKey: "sk-x", managedBy: "aiand" },
      },
      modelRoles: { default: "aiand/zai-org/glm-5.3" },
      modes: ["fast", "slow"],
      count: 3,
      flag: true,
      nothing: null,
    };
    assert.deepEqual(parseYaml(yamlRender(doc)), doc);
  });

  test("renderScalar/parseScalar round-trip every scalar shape", () => {
    for (const value of ["aiand/zai-org/glm-5.3", "true", "3", "a # b: c", "", "null"]) {
      assert.equal(parseScalar(renderScalar(value)), value);
    }
    assert.equal(parseScalar(renderScalar(null)), null);
    assert.equal(parseScalar(renderScalar(-2.5)), -2.5);
    assert.equal(parseScalar(renderScalar(true)), true);
  });

  test("yamlSet: a replaced scalar line keeps its trailing comment", () => {
    const after = yamlSet(
      "modelRoles:\n  default: anthropic/x # my pick\n",
      ["modelRoles", "default"],
      "aiand/zai-org/glm-5.3",
    );
    assert.equal(after, "modelRoles:\n  default: aiand/zai-org/glm-5.3 # my pick\n");
    assert.deepEqual(readYamlMapping(after), {
      modelRoles: { default: "aiand/zai-org/glm-5.3" },
    });
  });

  test("yamlSet: a scalar replaced by a block keeps its comment on the opener", () => {
    const after = yamlSet("modelRoles:\n  default: old # pick\n", ["modelRoles", "default"], {
      a: 1,
    });
    assert.equal(after, "modelRoles:\n  default: # pick\n    a: 1\n");
    assert.deepEqual(readYamlMapping(after), { modelRoles: { default: { a: 1 } } });
  });

  test("yamlSet: the original key quoting survives a rewrite", () => {
    const after = yamlSet('"a:b": old\n', ["a:b"], "new");
    assert.equal(after, '"a:b": new\n');
    assert.deepEqual(readYamlMapping(after), { "a:b": "new" });
  });

  test("yamlSet/yamlRender: a key that cannot round-trip bare is quoted", () => {
    // A bare `a:b` or `#x` key would not parse back as the same
    // key, so generated lines quote it.
    for (const key of ["a:b", "#x", ""]) {
      const after = yamlSet("", [key], "v");
      assert.equal(after, `${JSON.stringify(key)}: v\n`);
      assert.deepEqual(readYamlMapping(after), { [key]: "v" });
    }
    assert.equal(yamlRender({ "a:b": "v" }), '"a:b": v\n');
  });

  test("yamlSet: a sequence-valued parent is a SyntaxError, not a splice", () => {
    const seed = "providers:\n  - openai\n";
    assert.throws(
      () => yamlSet(seed, ["providers", "aiand"], { baseUrl: "https://x/v1" }),
      SyntaxError,
    );
    // yamlDelete agrees: it never splices into a sequence either.
    assert.throws(() => yamlDelete(seed, ["providers", "openai"]), SyntaxError);
  });

  test("childMapping skips leading comments when deciding the block shape", () => {
    // A comment inside the block is not content: the mapping under
    // it is still editable.
    const seed = "providers:\n  # my providers\n  openai:\n    baseUrl: https://x\n";
    const after = yamlSet(seed, ["providers", "aiand"], {
      baseUrl: "https://y/v1",
      apiKey: "sk-1",
      managedBy: "aiand",
    });
    assert.ok(after.includes("# my providers"));
    assert.deepEqual(readYamlMapping(after).providers.aiand.baseUrl, "https://y/v1");
  });

  test("childMapping ignores an empty-map placeholder wherever it sits", () => {
    // omp's writer can leave the `{}` after a comment or a blank line; the
    // new entry must replace it, not land above it.
    const seed = "modelRoles:\n  # pinned roles go here\n  {}\n";
    const after = yamlSet(seed, ["modelRoles", "default"], "aiand/x");
    assert.equal(after, "modelRoles:\n  default: aiand/x\n  # pinned roles go here\n");
    assert.deepEqual(readYamlMapping(after), { modelRoles: { default: "aiand/x" } });
    const blank = yamlSet("modelRoles:\n\n  {}", ["modelRoles", "default"], "aiand/x");
    assert.equal(blank.includes("{}"), false);
    assert.deepEqual(readYamlMapping(blank), { modelRoles: { default: "aiand/x" } });
  });

  test("childMapping: an empty sequence stays a sequence, refusals not a splice", () => {
    // `[]` is a real list, not a placeholder: writing a mapping into it
    // would silently replace the user's empty list, so it must throw.
    assert.throws(
      () => yamlSet("providers:\n  []\n", ["providers", "aiand"], { x: 1 }),
      SyntaxError,
    );
  });
});
