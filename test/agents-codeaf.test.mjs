import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test, { beforeEach, describe } from "node:test";
import { enableInput as baseEnableInput, catalogModel, withTestEnv } from "./helpers.mjs";

withTestEnv("aiand-codeaf-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_API_KEY = "sk-test-123";
  mkdirSync(process.env.AIAND_HOME, { recursive: true });
  mkdirSync(process.env.AIAND_CONFIG_DIR, { recursive: true });
});

const { codeafAdapter, CODEAF_VERSION } = await import("../dist/agents/codeaf/adapter.js");
const {
  CODEAF_MARKER_KEY,
  CODEAF_SOURCE_ID,
  CODEAF_WRITTEN,
  aiandSourcesRow,
  findOurs,
  foreignAiand,
  isOurs,
  readRows,
  routableRow,
} = await import("../dist/agents/codeaf/sources.js");
const { CliError } = await import("../dist/cli/errors.js");
const { restoreSnapshot, snapshotFiles } = await import("../dist/agents/snapshot.js");
const { parseJsonc } = await import("../dist/agents/managed-file.js");

const GLM = "zai-org/glm-5.3";
const KIMI = "moonshotai/kimi-k3";
const USER_MODEL = "anthropic/claude-sonnet-4-5";
const CATALOG = [
  catalogModel(GLM, { name: "GLM 5.3" }),
  catalogModel(KIMI, { name: "Kimi K3" }),
  catalogModel("qwen/qwen3.8-27b", { name: "Qwen3.8-27B" }),
];

/** CodeAF's own resolution order: CODEAF_PROFILE_DIR, CODEAF_HOME, ~/.codeaf. */
const profileDir = () =>
  process.env.CODEAF_PROFILE_DIR ||
  process.env.CODEAF_HOME ||
  join(process.env.AIAND_HOME, ".codeaf");
const configPath = () => join(profileDir(), "config.json");
const addedJsonPath = () => join(process.env.AIAND_CONFIG_DIR, "snapshots", "codeaf", "added.json");

/** Seed <profileDir>/config.json the way a user (or CodeAF) would write it. */
const seed = (text) => {
  mkdirSync(profileDir(), { recursive: true });
  writeFileSync(configPath(), text);
};
const readConfig = () => parseJsonc(readFileSync(configPath(), "utf8"));
const readRowsIn = () => readRows(readFileSync(configPath(), "utf8"));

const enableInput = (overrides = {}) =>
  baseEnableInput({
    apiKey: "sk-enable-1",
    baseUrl: "https://api.aiand.com",
    model: GLM,
    catalog: CATALOG,
    profileName: "default",
    ...overrides,
  });

/** A row a user hand-made (or CodeAF's own editor left): no marker, no record. */
const HAND_MADE_ROW = {
  id: "custom-aiand",
  written: "aiand",
  address: "https://my-gateway.example.com/v1",
  key: "sk-user-1",
  order: 1,
};
/** An unrelated service row that must survive every rewrite untouched. */
const FOREIGN_ROW = {
  id: "openrouter",
  written: "openrouter",
  address: "https://openrouter.ai/api/v1",
  key_env: "OPENROUTER_API_KEY",
  order: 0,
};

beforeEach(() => {
  delete process.env.CODEAF_HOME;
  delete process.env.CODEAF_PROFILE_DIR;
  rmSync(join(process.env.AIAND_HOME, ".codeaf"), {
    recursive: true,
    force: true,
  });
  rmSync(join(process.env.AIAND_CONFIG_DIR, "snapshots", "codeaf"), {
    recursive: true,
    force: true,
  });
});

describe("codeaf adapter", () => {
  test("id/label/bin/install/managedFiles/version", () => {
    assert.equal(codeafAdapter.id, "codeaf");
    assert.equal(codeafAdapter.label, "CodeAF");
    assert.equal(codeafAdapter.bin, "codeaf");
    assert.deepEqual(codeafAdapter.install, {
      command: "curl -fsSL https://agentfield.ai/get/codeaf | bash",
      url: "https://agentfield.ai/docs/codeaf",
    });
    assert.deepEqual(codeafAdapter.managedFiles(), [configPath()]);
    assert.equal(CODEAF_VERSION, "v0.5.1");
  });

  test("on writes the aiand row and model.talk, locked to 0600", async () => {
    const result = await codeafAdapter.enable(enableInput());
    const config = readConfig();
    // Exactly the row aiandSourcesRow mints: key_env stays unset (CodeAF's
    // WriteSources blanks `key` whenever key_env is set).
    assert.deepEqual(
      config.model_sources[0],
      aiandSourcesRow("sk-enable-1", "https://api.aiand.com"),
    );
    assert.equal(config.model_sources.length, 1);
    assert.equal(config["model.talk"], `aiand/${GLM}`);
    assert.equal(result.model, `aiand/${GLM}`);
    assert.equal(result.catalogModel, GLM);
    assert.deepEqual(result.filesWritten, [configPath()]);
    if (process.platform !== "win32") {
      assert.equal(statSync(configPath()).mode & 0o777, 0o600);
    }
  });

  test("on never writes a root api_key (the leak guard)", async () => {
    await codeafAdapter.enable(enableInput());
    assert.equal("api_key" in readConfig(), false);

    // A user's own root api_key (the default service's) survives untouched.
    seed(`${JSON.stringify({ api_key: "sk-user-openrouter", daily_budget_usd: 5 }, null, 2)}\n`);
    await codeafAdapter.enable(enableInput());
    const config = readConfig();
    assert.equal(config.api_key, "sk-user-openrouter");
    assert.equal(config.daily_budget_usd, 5);
    assert.equal(
      readConfig().model_sources.find((row) => row.id === CODEAF_SOURCE_ID).key,
      "sk-enable-1",
    );
  });

  test("on preserves unrelated keys, foreign rows and formatting", async () => {
    const seeded = `{
  // my config
  "daily_budget_usd": 5,
  "setup_seen_at": 1730000000,
  "model_sources": [
    {
      "id": "openrouter",
      "written": "openrouter",
      "address": "https://openrouter.ai/api/v1",
      "key_env": "OPENROUTER_API_KEY",
      "order": 0
    }
  ],
  "unrelated": { "nested": [1, 2, 3] }
}
`;
    seed(seeded);
    await codeafAdapter.enable(enableInput());
    const config = readConfig();
    assert.equal(config.daily_budget_usd, 5);
    assert.equal(config.setup_seen_at, 1730000000);
    assert.deepEqual(config.model_sources[0], FOREIGN_ROW);
    assert.deepEqual(
      config.model_sources[1],
      aiandSourcesRow("sk-enable-1", "https://api.aiand.com"),
    );
    assert.deepEqual(config.unrelated, { nested: [1, 2, 3] });
    const raw = readFileSync(configPath(), "utf8");
    assert.match(raw, /\/\/ my config/, "comments outside the rewrite survive");
    assert.match(raw, /"daily_budget_usd": 5/, "untouched keys keep their bytes");
    assert.ok(raw.endsWith("\n"), "a seeded trailing newline survives");
  });

  test("a re-on replaces our row in place and re-bakes the key", async () => {
    seed(`${JSON.stringify({ model_sources: [FOREIGN_ROW] }, null, 2)}\n`);
    await codeafAdapter.enable(enableInput({ apiKey: "sk-enable-1" }));
    assert.equal(readConfig().model_sources.length, 2);

    const result = await codeafAdapter.enable(enableInput({ apiKey: "sk-enable-2" }));
    const config = readConfig();
    assert.equal(config.model_sources.length, 2, "no duplicate row");
    assert.equal(config.model_sources.filter((row) => row.id === CODEAF_SOURCE_ID).length, 1);
    assert.deepEqual(config.model_sources[0], FOREIGN_ROW);
    assert.equal(config.model_sources[1].key, "sk-enable-2");
    assert.equal(config.model_sources[1].order, 1, "position and order kept");
    assert.equal(config.model_sources[1][CODEAF_MARKER_KEY], true);
    assert.equal(config["model.talk"], `aiand/${GLM}`);
    assert.equal(result.model, `aiand/${GLM}`);
  });

  test("model handling: native keeps, existing keeps with a warning, --model pins", async () => {
    // --model native leaves model.talk untouched and records nothing
    seed(`{"model.talk": "${USER_MODEL}"}`);
    const native = await codeafAdapter.enable(enableInput({ model: "native" }));
    assert.equal(readConfig()["model.talk"], USER_MODEL);
    assert.equal(native.model, USER_MODEL);
    assert.equal(native.catalogModel, undefined);

    // a pre-existing model.talk is kept, warned about when not aiand/-prefixed
    seed(`{"model.talk": "${USER_MODEL}"}`);
    const kept = await codeafAdapter.enable(enableInput());
    assert.equal(readConfig()["model.talk"], USER_MODEL);
    assert.equal(kept.model, USER_MODEL);
    assert.ok(
      kept.warnings.some((w) =>
        w.includes(`Left your existing model (${USER_MODEL}). Pass --model to switch.`),
      ),
    );
    // off leaves the user's model alone: nothing was recorded for it
    await codeafAdapter.disable();
    assert.equal(readConfig()["model.talk"], USER_MODEL);

    // an aiand/-prefixed existing model is kept without a warning
    seed(`{"model.talk": "aiand/${GLM}"}`);
    const ours = await codeafAdapter.enable(enableInput());
    assert.equal(readConfig()["model.talk"], `aiand/${GLM}`);
    assert.ok(!ours.warnings.some((w) => w.includes("Left your existing model")));

    // --model pins over the user's choice; off restores the previous model
    seed(`{"model.talk": "${USER_MODEL}"}`);
    const pinned = await codeafAdapter.enable(enableInput({ model: KIMI, pinModel: true }));
    assert.equal(readConfig()["model.talk"], `aiand/${KIMI}`);
    assert.equal(pinned.model, `aiand/${KIMI}`);
    assert.equal(pinned.catalogModel, KIMI);
    await codeafAdapter.disable();
    assert.equal(readConfig()["model.talk"], USER_MODEL);

    // a re-on with a different --model restores the FIRST previousModel,
    // never chains onto the model the last on wrote
    seed(`{"model.talk": "${USER_MODEL}"}`);
    await codeafAdapter.enable(enableInput({ model: KIMI, pinModel: true }));
    await codeafAdapter.enable(enableInput({ model: GLM, pinModel: true }));
    assert.equal(readConfig()["model.talk"], `aiand/${GLM}`);
    await codeafAdapter.disable();
    assert.equal(readConfig()["model.talk"], USER_MODEL);
  });

  test("status: active only with our row (or the recorded shape)", async () => {
    // routableRow: https and loopback http only
    assert.equal(routableRow({ address: "https://api.aiand.com/v1" }), true);
    assert.equal(routableRow({ address: "http://127.0.0.1:8080/v1" }), true);
    assert.equal(routableRow({ address: "http://api.aiand.com/v1" }), false);
    assert.equal(routableRow({}), false);

    // missing, blank, garbage and non-object configs read inactive, never throwing
    assert.deepEqual(await codeafAdapter.probe(), { active: false, model: null });
    for (const garbage of ["", "not json {{{", "[]", '{"model_sources": "nope"}']) {
      seed(garbage);
      assert.deepEqual(
        await codeafAdapter.probe(),
        { active: false, model: null },
        JSON.stringify(garbage),
      );
    }

    // active with the marker on a routable address, reporting model.talk
    seed(
      JSON.stringify({
        model_sources: [aiandSourcesRow("sk-test-123", "https://api.aiand.com")],
        "model.talk": `aiand/${GLM}`,
      }),
    );
    assert.deepEqual(await codeafAdapter.probe(), {
      active: true,
      model: `aiand/${GLM}`,
    });

    // active on loopback http, and a null model when model.talk is absent
    seed(
      JSON.stringify({
        model_sources: [aiandSourcesRow("sk-test-123", "http://127.0.0.1:8080")],
      }),
    );
    assert.deepEqual(await codeafAdapter.probe(), { active: true, model: null });

    // a non-routable address reads inactive
    const repointed = aiandSourcesRow("sk-test-123", "https://api.aiand.com");
    repointed.address = "http://api.aiand.com/v1";
    seed(JSON.stringify({ model_sources: [repointed] }));
    assert.deepEqual(await codeafAdapter.probe(), { active: false, model: null });

    // durable proof: CodeAF's own connection editor drops unknown fields
    // (the marker), but the recorded row shape still proves ownership
    await codeafAdapter.enable(enableInput());
    const dropped = readConfig();
    delete dropped.model_sources[0][CODEAF_MARKER_KEY];
    writeFileSync(configPath(), `${JSON.stringify(dropped, null, 2)}\n`);
    assert.deepEqual(await codeafAdapter.probe(), {
      active: true,
      model: `aiand/${GLM}`,
    });

    // ...but a marker-less row repointed to another address is not ours
    const moved = readConfig();
    moved.model_sources[0].address = "https://my-own-gateway.example.com/v1";
    writeFileSync(configPath(), `${JSON.stringify(moved, null, 2)}\n`);
    assert.deepEqual(await codeafAdapter.probe(), { active: false, model: null });
  });

  test("a foreign custom-aiand row refuses on; --force takes over; restore returns the seed", async () => {
    const seeded = `${JSON.stringify({ model_sources: [HAND_MADE_ROW] }, null, 2)}\n`;
    seed(seeded);

    // the hand-made row is not ours: no marker, no record
    const rows = readRowsIn();
    assert.equal(rows.length, 1);
    assert.equal(isOurs(rows[0], null), false);
    assert.equal(findOurs(rows, null), undefined);
    assert.equal(foreignAiand(rows, null)?.id, CODEAF_SOURCE_ID);
    // the written-spelling trips the refusal too: a user's connection to
    // the gateway mints written "aiand" under any id
    const spelled = [
      {
        id: "my-aiand",
        written: CODEAF_WRITTEN.toUpperCase(),
        address: "https://x.example.com/v1",
        key: "k",
        order: 0,
      },
    ];
    assert.equal(foreignAiand(spelled, null)?.id, "my-aiand");
    // a marked row is ours regardless of the record
    const marked = [{ ...HAND_MADE_ROW, [CODEAF_MARKER_KEY]: true }];
    assert.equal(isOurs(marked[0], null), true);
    assert.equal(findOurs(marked, null)?.id, CODEAF_SOURCE_ID);

    await assert.rejects(
      () => codeafAdapter.enableGuard({ force: false }),
      (error) =>
        error instanceof CliError &&
        /already routes CodeAF somewhere ai& does not manage/.test(error.message) &&
        /Pass --force to take it over, or use aiand run-agent codeaf\./.test(error.hint ?? ""),
    );
    // the file is untouched by the refusal
    assert.equal(readFileSync(configPath(), "utf8"), seeded);
    await codeafAdapter.enableGuard({ force: true });

    await snapshotFiles("codeaf", [configPath()]);
    const result = await codeafAdapter.enable(enableInput());
    const config = readConfig();
    assert.equal(config.model_sources.length, 2, "the user's row survives");
    assert.deepEqual(config.model_sources[0], HAND_MADE_ROW);
    assert.deepEqual(config.model_sources[1], {
      ...aiandSourcesRow("sk-enable-1", "https://api.aiand.com"),
      order: 2, // appended after the user's row: max order + 1
    });
    assert.equal(config["model.talk"], `aiand/${GLM}`);
    assert.equal(result.model, `aiand/${GLM}`);

    const off = await codeafAdapter.disable();
    assert.equal(off.stripped, true);
    assert.deepEqual(readConfig().model_sources, [HAND_MADE_ROW]);
    // restore --force returns the exact seeded bytes
    assert.equal(await restoreSnapshot("codeaf", [configPath()]), true);
    assert.equal(readFileSync(configPath(), "utf8"), seeded);
  });

  test("off strips surgically: row, model, mode, created files", async () => {
    // strips our row and restores the previous model; unrelated keys survive
    seed(`{"daily_budget_usd": 5, "model.talk": "${USER_MODEL}"}`);
    await codeafAdapter.enable(enableInput({ model: KIMI, pinModel: true }));
    const off = await codeafAdapter.disable();
    assert.equal(off.stripped, true);
    const config = readConfig();
    assert.ok(!config.model_sources?.length, "our row is gone");
    assert.equal(config["model.talk"], USER_MODEL);
    assert.equal(config.daily_budget_usd, 5);
    assert.equal(existsSync(addedJsonPath()), false, "off clears added-state");
    assert.equal((await codeafAdapter.disable()).stripped, false, "a second off is a no-op");

    // a model.talk we chose from nothing is deleted by off
    seed('{"daily_budget_usd": 5}');
    await codeafAdapter.enable(enableInput());
    assert.equal(readConfig()["model.talk"], `aiand/${GLM}`);
    await codeafAdapter.disable();
    assert.equal(readConfig()["model.talk"], undefined);

    // an edited row keeps its non-key bytes, losing only key and marker
    seed(`{"model.talk": "${USER_MODEL}"}`);
    await codeafAdapter.enable(enableInput({ model: KIMI, pinModel: true }));
    const edited = readConfig();
    edited.model_sources[0].address = "https://my-gateway.example.com/v1";
    writeFileSync(configPath(), `${JSON.stringify(edited, null, 2)}\n`);
    const editedOff = await codeafAdapter.disable();
    assert.equal(editedOff.stripped, true);
    assert.ok(
      editedOff.notes.some((n) => n.includes("left the aiand connection because you edited it")),
    );
    assert.deepEqual(readConfig().model_sources[0], {
      id: CODEAF_SOURCE_ID,
      written: CODEAF_WRITTEN,
      address: "https://my-gateway.example.com/v1",
      order: 1,
    });
    assert.equal(readConfig()["model.talk"], USER_MODEL);

    // an edited model.talk is kept, with a note
    seed(`{"model.talk": "${USER_MODEL}"}`);
    await codeafAdapter.enable(enableInput({ model: KIMI, pinModel: true }));
    const switched = readConfig();
    switched["model.talk"] = "openai/gpt-4.1";
    writeFileSync(configPath(), `${JSON.stringify(switched, null, 2)}\n`);
    const modelOff = await codeafAdapter.disable();
    assert.equal(modelOff.stripped, true);
    assert.ok(modelOff.notes.some((n) => n.includes("left model because you edited it")));
    assert.ok(!modelOff.notes.some((n) => n.includes("aiand connection")));
    assert.equal(readConfig()["model.talk"], "openai/gpt-4.1");
    assert.ok(!readConfig().model_sources?.length);

    if (process.platform !== "win32") {
      // off restores the mode the file had before on
      seed('{"daily_budget_usd": 5}\n');
      chmodSync(configPath(), 0o644);
      await codeafAdapter.enable(enableInput());
      assert.equal(statSync(configPath()).mode & 0o777, 0o600);
      await codeafAdapter.disable();
      assert.equal(statSync(configPath()).mode & 0o777, 0o644);
    }

    // a file we created and emptied is unlinked; a user's file never is
    rmSync(configPath(), { force: true });
    await codeafAdapter.enable(enableInput());
    assert.equal(existsSync(configPath()), true);
    await codeafAdapter.disable();
    assert.equal(existsSync(configPath()), false, "a file we created and emptied is unlinked");

    seed('{"theme": "system"}\n');
    await codeafAdapter.enable(enableInput());
    await codeafAdapter.disable();
    assert.equal(existsSync(configPath()), true, "a user-created file is never unlinked");
    assert.equal(readConfig().theme, "system");

    // a missing file is a no-op, never a throw
    rmSync(configPath(), { force: true });
    assert.equal((await codeafAdapter.disable()).stripped, false);
  });

  test("refreshKey swaps only row.key behind the marker and previousKey gates", async () => {
    await codeafAdapter.enable(enableInput({ apiKey: "sk-enable-1" }));

    // idempotent: the same key is a no-op that still counts as touched
    assert.equal(await codeafAdapter.refreshKey({ apiKey: "sk-enable-1" }), true);
    assert.equal(findOurs(readRowsIn(), null)?.key, "sk-enable-1");

    // a rotation swaps only the key literal; mode, row shape and model stay
    assert.equal(await codeafAdapter.refreshKey({ apiKey: "sk-rebaked-2" }), true);
    const config = readConfig();
    assert.equal(config.model_sources[0].key, "sk-rebaked-2");
    assert.equal(config.model_sources[0].address, "https://api.aiand.com/v1");
    assert.equal(config.model_sources[0][CODEAF_MARKER_KEY], true);
    assert.equal(config["model.talk"], `aiand/${GLM}`);
    if (process.platform !== "win32") {
      assert.equal(statSync(configPath()).mode & 0o777, 0o600);
    }

    // previousKey must match the baked key, or the rotation is refused
    assert.equal(
      await codeafAdapter.refreshKey({ apiKey: "sk-other-3", previousKey: "sk-wrong" }),
      false,
    );
    assert.equal(readConfig().model_sources[0].key, "sk-rebaked-2");
    assert.equal(
      await codeafAdapter.refreshKey({ apiKey: "sk-other-3", previousKey: "sk-rebaked-2" }),
      true,
    );
    assert.equal(readConfig().model_sources[0].key, "sk-other-3");

    // the recorded state never holds a key
    const added = JSON.parse(readFileSync(addedJsonPath(), "utf8"));
    assert.equal(added.source.key, undefined);
    assert.equal(readFileSync(addedJsonPath(), "utf8").includes("sk-other-3"), false);

    // a rebake is not a user edit: off still strips the row cleanly
    const rebakedOff = await codeafAdapter.disable();
    assert.equal(rebakedOff.stripped, true);
    assert.ok(!rebakedOff.notes.some((n) => n.includes("edited")));

    // an unmarked foreign row keeps its key untouched
    seed(`${JSON.stringify({ model_sources: [HAND_MADE_ROW] }, null, 2)}\n`);
    const before = readFileSync(configPath(), "utf8");
    assert.equal(await codeafAdapter.refreshKey({ apiKey: "sk-new-4" }), false);
    assert.equal(readFileSync(configPath(), "utf8"), before);

    // after off there is no row left to refresh
    await codeafAdapter.enable(enableInput());
    await codeafAdapter.disable();
    assert.equal(await codeafAdapter.refreshKey({ apiKey: "sk-new-4" }), false);
  });

  test("CODEAF_HOME / CODEAF_PROFILE_DIR relocate the config; on refuses an orphaned old path", async () => {
    // CODEAF_HOME relocates the state root
    process.env.CODEAF_HOME = join(process.env.AIAND_HOME, "elsewhere");
    await codeafAdapter.enable(enableInput());
    assert.equal(existsSync(join(process.env.CODEAF_HOME, "config.json")), true);
    assert.deepEqual(codeafAdapter.managedFiles(), [join(process.env.CODEAF_HOME, "config.json")]);
    assert.equal(existsSync(join(process.env.AIAND_HOME, ".codeaf", "config.json")), false);
    await codeafAdapter.disable();

    // CODEAF_PROFILE_DIR wins over CODEAF_HOME
    process.env.CODEAF_PROFILE_DIR = join(process.env.AIAND_HOME, "profile");
    await codeafAdapter.enable(enableInput());
    assert.equal(existsSync(join(process.env.CODEAF_PROFILE_DIR, "config.json")), true);
    assert.deepEqual(codeafAdapter.managedFiles(), [
      join(process.env.CODEAF_PROFILE_DIR, "config.json"),
    ]);
    await codeafAdapter.disable();

    // on refuses to move while still on at the old path, and off finds it there
    delete process.env.CODEAF_PROFILE_DIR;
    delete process.env.CODEAF_HOME;
    await codeafAdapter.enable(enableInput());
    const wired = configPath();
    process.env.CODEAF_HOME = join(process.env.AIAND_HOME, "moved");
    await assert.rejects(
      () => codeafAdapter.enableGuard({ force: true }),
      (error) =>
        error instanceof CliError &&
        /CodeAF is on at/.test(error.message) &&
        /Run aiand codeaf off first/.test(`${error.message} ${error.hint ?? ""}`),
    );
    const off = await codeafAdapter.disable();
    assert.equal(off.stripped, true);
    assert.equal(existsSync(wired), false);
    await codeafAdapter.enableGuard({ force: false });
  });

  test("probe never throws on malformed config; enable refuses it instead", async () => {
    for (const garbage of [
      "not json {{{",
      "[]",
      '{"model_sources": "nope"}',
      '{"model_sources": null}',
      "",
    ]) {
      seed(garbage);
      assert.deepEqual(
        await codeafAdapter.probe(),
        { active: false, model: null },
        JSON.stringify(garbage),
      );
    }

    // readRows: a missing or empty model_sources reads as []
    assert.deepEqual(readRows("{}"), []);
    assert.deepEqual(readRows('{"model_sources": []}'), []);
    assert.deepEqual(readRows('{"model_sources": [{}]}'), [{}]);
    // a non-object root is not valid JSON
    assert.throws(
      () => readRows("[]"),
      (error) => error instanceof CliError && /is not valid JSON\./.test(error.message),
    );
    // a model_sources that is not an array is a CliError
    assert.throws(
      () => readRows('{"model_sources": "nope"}'),
      (error) => error instanceof CliError,
    );

    // enable() refuses a non-object root with the recovery hint
    seed("[]");
    await assert.rejects(
      () => codeafAdapter.enable(enableInput()),
      (error) =>
        error instanceof CliError &&
        /is not valid JSON\./.test(error.message) &&
        /delete it and run aiand codeaf on again/.test(error.hint ?? ""),
    );
    assert.equal(existsSync(configPath()), true, "the refusal writes nothing");
    assert.equal(readFileSync(configPath(), "utf8"), "[]");
  });
});

describe("codeaf sessionLaunch", () => {
  test("overlay config.json carries the key and a bare model.talk; env is hermetic", async () => {
    // no --model: the resolved default rides bare (the default service is
    // repointed at us, so no aiand/ prefix)
    const launch = await codeafAdapter.sessionLaunch({
      apiKey: "sk-launch-1",
      model: undefined,
      catalog: CATALOG,
      profileName: "default",
    });
    const dir = launch.env.CODEAF_HOME;
    assert.ok(/aiand-codeaf-/.test(dir), "a throwaway CODEAF_HOME");
    assert.deepEqual(launch.env, {
      CODEAF_HOME: dir,
      CODEAF_BASE_URL: "https://api.aiand.com/v1",
      OPENROUTER_API_KEY: "",
      OPENAI_API_KEY: "",
      CODEAF_MODEL: "",
      CODEAF_NO_UPDATE_CHECK: "1",
      CODEAF_TELEMETRY: "off",
    });
    assert.equal(launch.args, undefined, "passthrough stays verbatim");
    // the session key never rides the child env
    assert.ok(!Object.values(launch.env).includes("sk-launch-1"));
    // the overlay holds the key and the resolved default model, and nothing else
    const overlay = join(dir, "config.json");
    assert.deepEqual(readdirSync(dir), ["config.json"]);
    assert.deepEqual(JSON.parse(readFileSync(overlay, "utf8")), {
      api_key: "sk-launch-1",
      "model.talk": GLM,
    });
    if (process.platform !== "win32") {
      assert.equal(statSync(overlay).mode & 0o777, 0o600);
    }
    // nothing was written under the real config path
    assert.equal(existsSync(configPath()), false);
    await launch.cleanup();
    assert.equal(existsSync(dir), false, "cleanup removes the throwaway dir");

    // an explicit --model rides bare; a trailing-slash --base-url is trimmed
    const explicit = await codeafAdapter.sessionLaunch({
      apiKey: "sk-launch-1",
      model: KIMI,
      catalog: CATALOG,
      profileName: "default",
      baseUrl: "https://staging.example.com/",
    });
    assert.equal(explicit.env.CODEAF_BASE_URL, "https://staging.example.com/v1");
    assert.deepEqual(
      JSON.parse(readFileSync(join(explicit.env.CODEAF_HOME, "config.json"), "utf8")),
      {
        api_key: "sk-launch-1",
        "model.talk": KIMI,
      },
    );
    await explicit.cleanup();

    // a profile model resolves when --model was not passed
    const fromProfile = await codeafAdapter.sessionLaunch({
      apiKey: "sk-launch-1",
      model: undefined,
      profileModel: KIMI,
      catalog: CATALOG,
      profileName: "default",
    });
    assert.equal(
      JSON.parse(readFileSync(join(fromProfile.env.CODEAF_HOME, "config.json"), "utf8"))[
        "model.talk"
      ],
      KIMI,
    );
    await fromProfile.cleanup();
  });
});
