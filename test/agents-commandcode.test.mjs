// Command Code adapter: the on/off/status wiring the ai&
// gateway needs for a Command Code session. The launcher
// tests live in test/run-agent.test.mjs.
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import test, { beforeEach, describe } from "node:test";
import { enableInput as baseEnableInput, catalogModel, withTestEnv } from "./helpers.mjs";

withTestEnv("aiand-commandcode-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_API_KEY = "sk-test-123";
  mkdirSync(join(process.env.AIAND_HOME, ".commandcode"), {
    recursive: true,
  });
  mkdirSync(process.env.AIAND_CONFIG_DIR, { recursive: true });
});

const { commandcodeAdapter } = await import("../dist/agents/commandcode/adapter.js");
const { buildCommandCodeProvider, aiandRow, commandCodeBaseUrl, isOurRow } = await import(
  "../dist/agents/commandcode/shared.js"
);
const { COMMANDCODE_VERSION } = await import("../dist/agents/commandcode/install.js");
const { snapshotFiles } = await import("../dist/agents/snapshot.js");

beforeEach(() => {
  rmSync(join(process.env.AIAND_HOME, ".commandcode"), { recursive: true, force: true });
  rmSync(join(process.env.AIAND_HOME, ".commandcode-moved"), {
    recursive: true,
    force: true,
  });
  rmSync(join(process.env.AIAND_CONFIG_DIR, "snapshots", "commandcode"), {
    recursive: true,
    force: true,
  });
  mkdirSync(join(process.env.AIAND_HOME, ".commandcode"), { recursive: true });
});

const commandcodeDir = () => join(process.env.AIAND_HOME, ".commandcode");
const providersPath = () => join(commandcodeDir(), "providers.json");
const authPath = () => join(commandcodeDir(), "auth.json");
const configPath = () => join(commandcodeDir(), "config.json");
const addedRecord = () =>
  join(process.env.AIAND_CONFIG_DIR, "snapshots", "commandcode", "added.json");

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

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Seed all three files the way a user's Command Code would have them. */
function seedUserFiles() {
  writeJson(providersPath(), {
    provider: {
      openai: {
        name: "OpenAI",
        api: "openai-completions",
        baseURL: "https://api.openai.com/v1",
      },
    },
  });
  writeJson(authPath(), {
    apiKey: "sk-user-cmd-login",
    userName: "user@example.com",
    openai: { type: "api", key: "sk-user-openai" },
  });
  writeJson(configPath(), { theme: "dark", model: "openai/gpt-5.2" });
  return {
    providers: readFileSync(providersPath()),
    auth: readFileSync(authPath()),
    config: readFileSync(configPath()),
  };
}

describe("commandcode adapter", () => {
  test("id/label/bin/install/managedFiles/version", () => {
    assert.equal(commandcodeAdapter.id, "commandcode");
    assert.equal(commandcodeAdapter.label, "Command Code");
    assert.equal(commandcodeAdapter.bin, process.platform === "win32" ? "cmdc" : "cmd");
    assert.match(commandcodeAdapter.install.command, /command-code@/);
    assert.equal(commandcodeAdapter.install.url, "https://commandcode.ai/docs");
    assert.deepEqual(commandcodeAdapter.managedFiles(), [
      providersPath(),
      authPath(),
      configPath(),
    ]);
    assert.equal(COMMANDCODE_VERSION, "1.74.0");
  });

  test("row helpers tolerate absent and malformed shapes", () => {
    assert.equal(isOurRow(undefined), false);
    assert.equal(aiandRow({}), undefined);
    // `provider` present but not an object: the optional chain
    // must not throw on a scalar.
    assert.equal(aiandRow({ provider: "oops" }), undefined);
    // The base URL falls back to the default when empty or unset.
    assert.equal(commandCodeBaseUrl(), "https://api.aiand.com/v1");
    assert.equal(commandCodeBaseUrl(""), "https://api.aiand.com/v1");
    assert.equal(commandCodeBaseUrl("https://gw.example/"), "https://gw.example/v1");
  });

  test("probe(): absent config is inactive with no model", async () => {
    const result = await commandcodeAdapter.probe();
    assert.equal(result.active, false);
    assert.equal(result.model, null);
  });

  test("probe(): foreign aiand row without the marker is never active", async () => {
    writeJson(providersPath(), {
      provider: { aiand: { baseURL: "https://api.aiand.com/v1", api: "openai-completions" } },
    });
    const result = await commandcodeAdapter.probe();
    assert.equal(result.active, false);
    assert.equal(result.model, null);
  });

  test("probe(): corrupt auth.json reports inactive, never on", async () => {
    writeJson(providersPath(), {
      provider: {
        aiand: {
          baseURL: "https://api.aiand.com/v1",
          managedBy: "aiand",
        },
      },
    });
    // A marked row, but the credential file is mid-edit garbage: the
    // real binary could not read its key, so status must not say on.
    writeFileSync(authPath(), "{ broken json");
    assert.deepEqual(await commandcodeAdapter.probe(), { active: false, model: null });
  });
  test("probe(): marked row with a non-routable baseURL is inactive", async () => {
    writeJson(providersPath(), {
      provider: { aiand: { baseURL: "ftp://example.com", managedBy: "aiand" } },
    });
    assert.equal((await commandcodeAdapter.probe()).active, false);
  });

  test("probe(): a row repointed by the user is off; off strips ours but leaves the row", async () => {
    seedUserFiles();
    await commandcodeAdapter.enable(enableInput());
    // The marker stays, but the baseURL is the user's own gateway
    // now: status must not call that routing ours (pi round-2).
    const providers = readJson(providersPath());
    providers.provider.aiand.baseURL = "https://users-own-gateway.example.com/v1";
    writeJson(providersPath(), providers);
    assert.deepEqual(await commandcodeAdapter.probe(), { active: false, model: null });
    const result = await commandcodeAdapter.disable();
    assert.match(result.notes.join("; "), /left the row as your own config/);
    // The repointed row is the user's config now: it stays.
    const after = readJson(providersPath());
    assert.equal(after.provider.aiand.baseURL, "https://users-own-gateway.example.com/v1");
    assert.equal(after.provider.openai.baseURL, "https://api.openai.com/v1");
    // But our credential and model pin did not survive the repoint.
    assert.equal(readJson(authPath()).aiand, undefined);
    assert.equal(readJson(authPath()).apiKey, "sk-user-cmd-login");
    assert.equal(readJson(configPath()).model, "openai/gpt-5.2");
  });

  test("managedFiles() widens with the recorded paths after a config-dir move", async () => {
    seedUserFiles();
    await commandcodeAdapter.enable(enableInput());
    // The user moved the config root; a `restore --force` from the
    // new shell must still be allowed the recorded paths (claude
    // precedent), or it refuses a path that is not "managed".
    const record = readJson(addedRecord());
    const moved = join(process.env.AIAND_HOME, ".commandcode-moved");
    for (const key of ["providersPath", "authPath", "configPath"]) {
      record[key] = record[key].replace(commandcodeDir(), moved);
    }
    writeJson(addedRecord(), record);
    assert.deepEqual(commandcodeAdapter.managedFiles(), [
      providersPath(),
      authPath(),
      configPath(),
      join(moved, "providers.json"),
      join(moved, "auth.json"),
      join(moved, "config.json"),
    ]);
  });

  test("probe(): an active row reports the model without the aiand/ prefix", async () => {
    seedUserFiles();
    await commandcodeAdapter.enable(enableInput());
    assert.deepEqual(await commandcodeAdapter.probe(), {
      active: true,
      model: "zai-org/glm-5.3",
    });
    // A model that does not route to our row reports no model.
    writeJson(configPath(), { model: "openai/gpt-5.2" });
    assert.deepEqual(await commandcodeAdapter.probe(), { active: true, model: null });
  });

  test("enable(): wires row, credential, and model pin; keeps unrelated keys", async () => {
    const seed = seedUserFiles();
    const result = await commandcodeAdapter.enable(enableInput());
    assert.deepEqual(result.filesWritten, [providersPath(), authPath(), configPath()]);

    const providers = readJson(providersPath());
    assert.equal(providers.provider.openai.baseURL, "https://api.openai.com/v1");
    assert.equal(providers.provider.aiand.name, "ai&");
    assert.equal(providers.provider.aiand.api, "openai-completions");
    assert.equal(providers.provider.aiand.baseURL, "https://api.aiand.com/v1");
    assert.equal(providers.provider.aiand.managedBy, "aiand");
    assert.deepEqual(
      Object.keys(providers.provider.aiand.models),
      CATALOG.map((model) => model.id),
    );
    assert.deepEqual(providers.provider.aiand.models["zai-org/glm-5.3"], {
      name: "zai-org/glm-5.3",
      contextWindow: 128000,
    });
    // No apiKey rides the row: the auth.json credential is the key site.
    assert.equal(providers.provider.aiand.apiKey, undefined);
    assert.equal(result.model, "aiand/zai-org/glm-5.3");
    assert.equal(result.catalogModel, "zai-org/glm-5.3");

    const auth = readJson(authPath());
    assert.equal(auth.apiKey, "sk-user-cmd-login");
    assert.equal(auth.userName, "user@example.com");
    assert.equal(auth.openai.key, "sk-user-openai");
    assert.deepEqual(auth.aiand, { type: "api", key: "sk-enable-1" });

    const config = readJson(configPath());
    assert.equal(config.theme, "dark");
    assert.equal(config.model, "aiand/zai-org/glm-5.3");
    // The seed's unservable model was set aside, with a warning.
    assert.ok(result.warnings.some((w) => /Set aside your model \(openai\/gpt-5\.2\)/.test(w)));

    // The added-state record must not carry the baked key.
    const record = readJson(addedRecord());
    assert.ok(!JSON.stringify(record).includes("sk-enable-1"));
    assert.equal(record.previousModel, "openai/gpt-5.2");
    assert.equal(record.wroteModel, "aiand/zai-org/glm-5.3");
    assert.equal(seed.providers.includes("aiand"), false);
  });

  test("auth.json is written 0600", async () => {
    seedUserFiles();
    await commandcodeAdapter.enable(enableInput());
    assert.equal(statSync(authPath()).mode & 0o777, 0o600);
  });

  test("buildCommandCodeProvider renders the catalog as an id-keyed map", () => {
    const provider = buildCommandCodeProvider({
      baseUrl: "https://gw.example/v1",
      catalog: CATALOG,
    });
    assert.equal(provider.name, "ai&");
    assert.equal(provider.api, "openai-completions");
    assert.equal(provider.baseURL, "https://gw.example/v1");
    assert.equal(provider.managedBy, "aiand");
    assert.deepEqual(Object.keys(provider.models), ["zai-org/glm-5.3", "qwen/qwen3.8-27b"]);
    assert.deepEqual(provider.models["qwen/qwen3.8-27b"], {
      name: "qwen/qwen3.8-27b",
      contextWindow: 128000,
    });
  });

  test("off: byte-identical when untouched, keeps user files", async () => {
    const seed = seedUserFiles();
    await commandcodeAdapter.enable(enableInput());
    const result = await commandcodeAdapter.disable();
    assert.equal(result.stripped, true);
    assert.equal(readFileSync(providersPath()).equals(seed.providers), true);
    assert.equal(readFileSync(authPath()).equals(seed.auth), true);
    assert.equal(readFileSync(configPath()).equals(seed.config), true);
    // Idempotent: a second off is a no-op.
    const again = await commandcodeAdapter.disable();
    assert.equal(again.stripped, false);
  });

  test("off: unlinks files it created, keeps ones the user had", async () => {
    // Only config.json pre-exists; on creates providers.json and
    // auth.json. The command layer snapshots before the first write;
    // seed that here so the manifest records which files did not
    // exist.
    writeJson(configPath(), { theme: "dark" });
    await snapshotFiles("commandcode", commandcodeAdapter.managedFiles());
    await commandcodeAdapter.enable(enableInput());
    await commandcodeAdapter.disable();
    assert.equal(existsSync(providersPath()), false);
    assert.equal(existsSync(authPath()), false);
    assert.deepEqual(readJson(configPath()), { theme: "dark" });
  });

  test("off: keeps user edits made while on, strips our keys", async () => {
    seedUserFiles();
    await commandcodeAdapter.enable(enableInput());
    const config = readJson(configPath());
    config.autoUpdater = true;
    config.model = "aiand/qwen/qwen3.8-27b";
    writeJson(configPath(), config);
    const providers = readJson(providersPath());
    providers.provider.openai.tag = "mine";
    writeJson(providersPath(), providers);

    const result = await commandcodeAdapter.disable();
    assert.equal(result.stripped, true);

    const afterProviders = readJson(providersPath());
    assert.equal(afterProviders.provider.aiand, undefined);
    assert.equal(afterProviders.provider.openai.tag, "mine");
    const afterConfig = readJson(configPath());
    assert.equal(afterConfig.autoUpdater, true);
    // The user's mid-wire model stays (they set it after our write).
    assert.equal(afterConfig.model, "aiand/qwen/qwen3.8-27b");
    assert.ok(result.notes.some((n) => /left model because you edited it/.test(n)));
  });

  test("off: foreign aiand row is never stripped", async () => {
    seedUserFiles();
    writeJson(providersPath(), {
      provider: {
        openai: { name: "OpenAI", baseURL: "https://api.openai.com/v1" },
        aiand: { baseURL: "https://foreign.example/v1" },
      },
    });
    const result = await commandcodeAdapter.disable();
    assert.equal(result.stripped, false);
    assert.equal(readJson(providersPath()).provider.aiand.baseURL, "https://foreign.example/v1");
  });

  test("enable(): foreign provider row named aiand refuses with a CliError", async () => {
    seedUserFiles();
    const providers = readJson(providersPath());
    providers.provider.aiand = { baseURL: "https://foreign.example" };
    writeJson(providersPath(), providers);
    await assert.rejects(commandcodeAdapter.enable(enableInput()), /does not manage/);
  });

  test("enable(): native throws — Command Code's own models are not on ai&", async () => {
    seedUserFiles();
    await assert.rejects(commandcodeAdapter.enable(enableInput({ model: "native" })), /not on ai&/);
    // Nothing was written.
    assert.equal(readJson(providersPath()).provider.aiand, undefined);
    assert.equal(readJson(configPath()).model, "openai/gpt-5.2");
  });

  test("user-set servable aiand/ model is kept unless --model passed", async () => {
    seedUserFiles();
    writeJson(configPath(), { theme: "dark", model: "aiand/qwen/qwen3.8-27b" });
    const result = await commandcodeAdapter.enable(enableInput());
    assert.equal(readJson(configPath()).model, "aiand/qwen/qwen3.8-27b");
    assert.equal(result.model, "aiand/qwen/qwen3.8-27b");
    assert.equal(result.catalogModel, "qwen/qwen3.8-27b");
    assert.deepEqual(result.warnings, []);
    // The kept model is the user's, not ours: off leaves it, so a
    // re-on cycle still holds their pick.
    await commandcodeAdapter.enable(enableInput());
    await commandcodeAdapter.disable();
    assert.equal(readJson(configPath()).model, "aiand/qwen/qwen3.8-27b");
  });

  test("unservable user model is set aside with a warning and restored by off", async () => {
    seedUserFiles();
    const result = await commandcodeAdapter.enable(enableInput());
    assert.ok(result.warnings.some((w) => /Set aside your model \(openai\/gpt-5\.2\)/.test(w)));
    assert.equal(readJson(configPath()).model, "aiand/zai-org/glm-5.3");
    await commandcodeAdapter.disable();
    const after = readJson(configPath());
    assert.equal(after.model, "openai/gpt-5.2");
    assert.equal(after.theme, "dark");
  });

  test("re-on keeps the first capture: off lands byte-identical", async () => {
    // on → re-on → off must still hand back the pre-aiand file
    // exactly, including when a re-`on` switches models.
    const seed = seedUserFiles();
    await commandcodeAdapter.enable(enableInput());
    await commandcodeAdapter.enable(enableInput({ model: "qwen/qwen3.8-27b", pinModel: true }));
    assert.equal(readJson(configPath()).model, "aiand/qwen/qwen3.8-27b");
    await commandcodeAdapter.enable(enableInput());
    await commandcodeAdapter.disable();
    assert.equal(readFileSync(configPath()).equals(seed.config), true);
  });

  test("a model written by on with nothing to restore is simply removed", async () => {
    writeJson(configPath(), { theme: "dark" });
    await commandcodeAdapter.enable(enableInput());
    await commandcodeAdapter.disable();
    assert.deepEqual(readJson(configPath()), { theme: "dark" });
  });

  test("--model pin overwrites the user's model and off restores it", async () => {
    seedUserFiles();
    writeJson(configPath(), { theme: "dark", model: "aiand/qwen/qwen3.8-27b" });
    await commandcodeAdapter.enable(enableInput({ pinModel: true }));
    assert.equal(readJson(configPath()).model, "aiand/zai-org/glm-5.3");
    await commandcodeAdapter.disable();
    // The user's servable pick was replaced by --model, so it is
    // on's to undo: off hands it back.
    assert.equal(readJson(configPath()).model, "aiand/qwen/qwen3.8-27b");
  });

  test("refreshKey: swaps the key literal only; previousKey gates", async () => {
    seedUserFiles();
    await commandcodeAdapter.enable(enableInput());
    const providersBefore = readFileSync(providersPath());
    const configBefore = readFileSync(configPath());

    const same = await commandcodeAdapter.refreshKey({ apiKey: "sk-enable-1" });
    assert.equal(same, true);

    const wrongPrevious = await commandcodeAdapter.refreshKey({
      apiKey: "sk-new",
      previousKey: "sk-other",
    });
    assert.equal(wrongPrevious, false);

    const rotated = await commandcodeAdapter.refreshKey({
      apiKey: "sk-new",
      previousKey: "sk-enable-1",
    });
    assert.equal(rotated, true);
    const auth = readJson(authPath());
    assert.equal(auth.aiand.key, "sk-new");
    assert.equal(auth.openai.key, "sk-user-openai");
    assert.equal(auth.apiKey, "sk-user-cmd-login");
    assert.equal(readFileSync(providersPath()).equals(providersBefore), true);
    assert.equal(readFileSync(configPath()).equals(configBefore), true);
  });

  test("refreshKey: foreign row returns false untouched", async () => {
    writeJson(providersPath(), {
      provider: { aiand: { baseURL: "https://foreign.example/v1" } },
    });
    writeJson(authPath(), { aiand: { type: "api", key: "sk-foreign" } });
    const touched = await commandcodeAdapter.refreshKey({ apiKey: "sk-new" });
    assert.equal(touched, false);
    assert.equal(readJson(authPath()).aiand.key, "sk-foreign");
  });

  test("refreshKey: a mid-edit config returns false, never throws", async () => {
    seedUserFiles();
    await commandcodeAdapter.enable(enableInput());
    // The user is mid-edit: auth.json is garbage. A rebake must not
    // crash past rebakeAgentKeys (pi and omp return false here).
    writeFileSync(authPath(), "{ broken mid-edit");
    assert.equal(await commandcodeAdapter.refreshKey({ apiKey: "sk-new" }), false);
    // The other parse site: providers.json mid-edit with a valid
    // auth.json must behave the same, key untouched.
    seedUserFiles();
    await commandcodeAdapter.enable(enableInput());
    writeFileSync(providersPath(), "{ broken mid-edit");
    assert.equal(await commandcodeAdapter.refreshKey({ apiKey: "sk-new" }), false);
    assert.equal(readJson(authPath()).aiand.key, "sk-enable-1");
  });

  test("refreshKey: a repointed row is never re-keyed", async () => {
    seedUserFiles();
    await commandcodeAdapter.enable(enableInput());
    // The user repointed the row at their own gateway: it reads our
    // credential now, so swapping the key would ship the session
    // key to their endpoint.
    const providers = readJson(providersPath());
    providers.provider.aiand.baseURL = "https://users-own-gateway.example.com/v1";
    writeJson(providersPath(), providers);
    assert.equal(await commandcodeAdapter.refreshKey({ apiKey: "sk-new" }), false);
    assert.equal(readJson(authPath()).aiand.key, "sk-enable-1");
  });

  test("off restores the file's pre-on mode; a file on created stays private", async () => {
    // A user's auth.json normally holds their own credentials at
    // 0600; off must not widen it back to the umask default when
    // dropping our key.
    const seed = seedUserFiles();
    chmodSync(authPath(), 0o600);
    await commandcodeAdapter.enable(enableInput());
    await commandcodeAdapter.disable();
    assert.equal(statSync(authPath()).mode & 0o777, 0o600);
    assert.equal(readFileSync(authPath()).equals(seed.auth), true);
  });

  test("off keeps a file on created private when the user added a credential", async () => {
    // on created auth.json (no prior mode to restore); the user adds
    // their own key mid-wire; off hands that file back at 0600,
    // never 0644.
    writeJson(configPath(), { theme: "dark" });
    await snapshotFiles("commandcode", commandcodeAdapter.managedFiles());
    await commandcodeAdapter.enable(enableInput());
    writeJson(authPath(), {
      aiand: { type: "api", key: "sk-enable-1" },
      openai: { type: "api", key: "sk-user-openai" },
    });
    await commandcodeAdapter.disable();
    assert.equal(statSync(authPath()).mode & 0o777, 0o600);
    assert.deepEqual(readJson(authPath()), {
      openai: { type: "api", key: "sk-user-openai" },
    });
  });

  // Relocated config dir orphaned the baked key
  test("off: strips the recorded files when the commandcode config dir moved", async () => {
    const seed = seedUserFiles();
    await commandcodeAdapter.enable(enableInput());
    // The user relocated Command Code's config dir between `on` and
    // `off`; the moved dir holds the files `on` wrote. Point the
    // record at them, the way a relocated install's record would
    // read.
    const movedDir = join(process.env.AIAND_HOME, ".commandcode-moved");
    renameSync(commandcodeDir(), movedDir);
    const record = readJson(addedRecord());
    for (const key of ["providersPath", "authPath", "configPath"]) {
      record[key] = record[key].replace(commandcodeDir(), movedDir);
    }
    writeJson(addedRecord(), record);
    const result = await commandcodeAdapter.disable();
    assert.equal(result.stripped, true);
    assert.equal(readFileSync(join(movedDir, "providers.json")).equals(seed.providers), true);
    assert.equal(readFileSync(join(movedDir, "auth.json")).equals(seed.auth), true);
    assert.equal(readFileSync(join(movedDir, "config.json")).equals(seed.config), true);
    assert.ok(result.notes.some((n) => n.includes("config dir moved")));
    assert.equal(existsSync(addedRecord()), false);
  });
  test("off: a moved dir whose aiand row is foreign leaves it in place", async () => {
    seedUserFiles();
    await commandcodeAdapter.enable(enableInput());
    const movedDir = join(process.env.AIAND_HOME, ".commandcode-moved");
    renameSync(commandcodeDir(), movedDir);
    const record = readJson(addedRecord());
    for (const key of ["providersPath", "authPath", "configPath"]) {
      record[key] = record[key].replace(commandcodeDir(), movedDir);
    }
    writeJson(addedRecord(), record);
    // The user replaced our row while the dir was moved: nothing there
    // is ours to strip anymore.
    const moved = JSON.parse(readFileSync(join(movedDir, "providers.json"), "utf8"));
    moved.provider.aiand = { name: "someone else", baseURL: "https://evil.example.com/v1" };
    writeJson(join(movedDir, "providers.json"), moved);
    const result = await commandcodeAdapter.disable();
    // The foreign row is not ours to strip, but the stale auth.json
    // still holds the credential our `on` baked — stripping it is
    // the point of the moved-dir loop.
    assert.equal(result.stripped, true);
    const after = JSON.parse(readFileSync(join(movedDir, "providers.json"), "utf8"));
    assert.equal(after.provider.aiand.name, "someone else");
    assert.equal(after.provider.openai.baseURL, "https://api.openai.com/v1");
    const staleAuth = JSON.parse(readFileSync(join(movedDir, "auth.json"), "utf8"));
    assert.equal(staleAuth.aiand, undefined);
    assert.equal(staleAuth.apiKey, "sk-user-cmd-login");
    assert.equal(staleAuth.openai.key, "sk-user-openai");
  });

  test("off: unparseable relocated providers.json keeps the record for retry", async () => {
    seedUserFiles();
    await commandcodeAdapter.enable(enableInput());
    // Capture our wired providers.json so the retry can restore a
    // readable file.
    const wiredProviders = readFileSync(providersPath());
    const movedDir = join(process.env.AIAND_HOME, ".commandcode-moved");
    renameSync(commandcodeDir(), movedDir);
    const record = readJson(addedRecord());
    for (const key of ["providersPath", "authPath", "configPath"]) {
      record[key] = record[key].replace(commandcodeDir(), movedDir);
    }
    writeJson(addedRecord(), record);
    // providers.json is the first stale file off reads, and it is
    // unreadable: nothing was stripped yet, so stripped stays false
    // and the record survives for the retry.
    writeFileSync(join(movedDir, "providers.json"), "{broken");
    const result = await commandcodeAdapter.disable();
    assert.equal(result.stripped, false);
    assert.ok(
      result.notes.some(
        (n) => n.includes("is not valid JSON") && n.includes(join(movedDir, "providers.json")),
      ),
    );
    assert.equal(existsSync(addedRecord()), true);

    // The user fixes the old providers.json; the retry strips and
    // clears it.
    writeFileSync(join(movedDir, "providers.json"), wiredProviders);
    const retry = await commandcodeAdapter.disable();
    assert.equal(retry.stripped, true);
    assert.equal(existsSync(addedRecord()), false);
  });

  const sessionInput = () => ({
    apiKey: "sk-session-1",
    model: "zai-org/glm-5.3",
    catalog: CATALOG,
    baseUrl: "https://api.aiand.com",
  });

  test("sessionLaunch: throwaway HOME, key env, headless args, strips", async () => {
    const launch = await commandcodeAdapter.sessionLaunch(sessionInput());
    try {
      // The overlay becomes a throwaway HOME named for the agent.
      assert.ok(basename(launch.env.HOME).startsWith("aiand-commandcode-"));
      assert.equal(launch.env.COMMAND_CODE_API_KEY, "sk-session-1");
      assert.equal(launch.env.DO_NOT_TRACK, "1");
      // The Codex-style exception carries COMMAND_CODE_API_KEY
      // only; AIAND_API_KEY itself stays out of the child env.
      assert.equal(launch.env.AIAND_API_KEY, undefined);
      // Non-TTY stdin (the test runner): one-shot mode.
      assert.deepEqual(launch.args, ["-p"]);
      assert.deepEqual(launch.stripPassthroughFlags, ["--model", "-m", "--config"]);

      const overlay = join(launch.env.HOME, ".commandcode");
      const providers = readJson(join(overlay, "providers.json"));
      assert.equal(providers.provider.aiand.baseURL, "https://api.aiand.com/v1");
      assert.equal(providers.provider.aiand.managedBy, "aiand");
      assert.deepEqual(
        Object.keys(providers.provider.aiand.models),
        CATALOG.map((model) => model.id),
      );
      // The overlay's auth.json holds only our credential, at 0600.
      assert.deepEqual(readJson(join(overlay, "auth.json")), {
        aiand: { type: "api", key: "sk-session-1" },
      });
      assert.equal(statSync(join(overlay, "auth.json")).mode & 0o777, 0o600);
      // The model pin routes to our row.
      assert.equal(readJson(join(overlay, "config.json")).model, "aiand/zai-org/glm-5.3");
    } finally {
      await launch.cleanup();
    }
  });

  test("sessionLaunch: cleanup removes the throwaway dir", async () => {
    const launch = await commandcodeAdapter.sessionLaunch(sessionInput());
    assert.equal(existsSync(launch.env.HOME), true);
    await launch.cleanup();
    assert.equal(existsSync(launch.env.HOME), false);
  });

  test("sessionLaunch: a failed overlay write removes the throwaway dir", async () => {
    const sandboxTmp = join(process.env.AIAND_HOME, "tmp");
    mkdirSync(sandboxTmp, { recursive: true });
    process.env.TMPDIR = sandboxTmp;
    try {
      const boom = [
        {
          get id() {
            throw new Error("catalog render failed");
          },
        },
      ];
      await assert.rejects(commandcodeAdapter.sessionLaunch({ ...sessionInput(), catalog: boom }));
      assert.deepEqual(
        readdirSync(sandboxTmp).filter((name) => name.startsWith("aiand-commandcode-")),
        [],
      );
    } finally {
      delete process.env.TMPDIR;
    }
  });
});
