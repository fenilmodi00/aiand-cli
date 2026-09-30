// OMP (Oh My Pi) adapter: the on/off/status wiring the ai& gateway needs for
// an omp session, plus the surgical YAML editors that edit omp's two config
// files. Launcher tests live in test/run-agent.test.mjs.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import test, { beforeEach, describe } from "node:test";
import { enableInput as baseEnableInput, catalogModel, withTestEnv } from "./helpers.mjs";

withTestEnv("aiand-omp-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_API_KEY = "sk-test-123";
  // Unlike its sibling vars, test/setup.mjs does not clear PI_CONFIG_DIR, so
  // a developer's own relocation would move ompAgentDir() out from under us.
  delete process.env.PI_CONFIG_DIR;
  // Same reason: a developer's own XDG-migrated omp would redirect the
  // session dir out from under the default-location assertions.
  delete process.env.XDG_DATA_HOME;
  mkdirSync(join(process.env.AIAND_HOME, ".omp", "agent"), { recursive: true });
  mkdirSync(process.env.AIAND_CONFIG_DIR, { recursive: true });
});

const { ompAdapter, buildOmpProviderBlock } = await import("../dist/agents/omp/adapter.js");
const { parseYaml, parseScalar, readYamlMapping, renderScalar, yamlDelete, yamlRender, yamlSet } =
  await import("../dist/agents/omp/yaml.js");
const { snapshotFiles } = await import("../dist/agents/snapshot.js");

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
    assert.match(ompAdapter.install.command, /omp\.sh\/install/);
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

  const sessionInput = () => ({
    apiKey: "sk-session-1",
    model: "zai-org/glm-5.3",
    catalog: CATALOG,
    baseUrl: "https://api.aiand.com",
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

  test("parseYaml: block sequences", () => {
    assert.deepEqual(parseYaml("modes:\n  - fast\n  - 1\n  - 2.5\n"), { modes: ["fast", 1, 2.5] });
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
});
