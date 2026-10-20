// dsh adapter: the on/off/status wiring the ai& gateway needs for a
// DeepSeek Harness session. The adapter owns two files under
// $DSH_HOME: the home patch layer (cordis.patch.yml) and the
// credential store (.credentials.yaml).
import assert from "node:assert/strict";
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
import { dirname, join } from "node:path";
import test, { beforeEach, describe } from "node:test";
import {
  enableInput as baseEnableInput,
  CLOSED_URL,
  catalogModel,
  cliEnv,
  FAKE_API_KEY,
  hermeticPath,
  plantStub,
  runCli,
  seedCatalogCache,
  withTestEnv,
} from "./helpers.mjs";

withTestEnv("aiand-dsh-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_API_KEY = "sk-test-123";
  mkdirSync(process.env.AIAND_HOME, { recursive: true });
  mkdirSync(process.env.AIAND_CONFIG_DIR, { recursive: true });
});

const { dshAdapter } = await import("../dist/agents/dsh/adapter.js");
const { CliError } = await import("../dist/cli/errors.js");
const { snapshotFiles } = await import("../dist/agents/snapshot.js");
const { flowRowEntries, findRowById, rowValue } = await import("../dist/agents/dsh/patch.js");
const { DSH_BANNER, DSH_MARKER, buildDshLlmRow } = await import("../dist/agents/dsh/rows.js");

const GLM = "zai-org/glm-5.3";
const KIMI = "moonshotai/kimi-k3";
const CATALOG = [catalogModel(GLM, { capabilities: ["tools", "vision"] }), catalogModel(KIMI)];

const BANNER = "# Managed by aiand: `aiand dsh off` removes this row.";
const MARKER = "x-aiand: true";
const KEY_REF = "AIAND_DSH_API_KEY";

/** A dsh stub that dumps the child env and argv, then exits 42. */
const CAPTURE_STUB = `env > "$AIAND_CAPTURE.env"
printf '%s\\n' "$@" > "$AIAND_CAPTURE.args"
exit 42`;

/** The llm-pi-ai row `on` writes: every catalog model through the gateway. */
const LLM_ROW = `${BANNER}
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      aiand:
        ${MARKER}
        displayName: aiand
        api: openai-completions
        baseURL: https://api.aiand.com/v1
        apiKeyEnv: ${KEY_REF}
        models:
          - id: ${GLM}
            name: ${GLM}
            contextWindow: 128000
            maxTokens: 128000
            input: [text, image]
          - id: ${KIMI}
            name: ${KIMI}
            contextWindow: 128000
            maxTokens: 128000
            input: [text]`;

/** The agent-default-model row `on` writes. */
const DEFAULT_ROW = `${BANNER}
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    ${MARKER}
    provider: aiand
    model: ${GLM}`;

const credentials = (key) => `version: 1\nrefs:\n  ${KEY_REF}: ${key}\n`;

/** A user's patch layer: their own row and comment, which must survive byte for byte. */
const USER_PATCH = [
  "# user comment",
  "- id: session-persistence-jsonl",
  "  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
  "  config:",
  "    root: ~/.dsh/sessions",
  "",
].join("\n");

const USER_CREDENTIALS = "version: 1\nrefs:\n  OTHER_PROVIDER_KEY: user-secret\n";

/** A user's default-model row: what `on` sets aside and `off` hands back. */
const USER_DEFAULT_ROW = `- id: agent-default-model
  name: 'mine'
  config:
    provider: myroute
    model: my-model
`;

/** The same row with comments the user wrote inside it. */
const USER_DEFAULT_ROW_COMMENTED = `- id: agent-default-model
  name: 'mine' # the good name
  config:
    provider: myroute
    # keep this
    model: my-model
`;

const dshHomeDir = () => process.env.DSH_HOME || join(process.env.AIAND_HOME, ".dsh");
const patchPath = () => join(dshHomeDir(), "cordis.patch.yml");
const credsPath = () => join(dshHomeDir(), ".credentials.yaml");
const readPatch = () => readFileSync(patchPath(), "utf8");
const readCreds = () => readFileSync(credsPath(), "utf8");
const mode = (path) => statSync(path).mode & 0o777;
const addedRecord = () => join(process.env.AIAND_CONFIG_DIR, "snapshots", "dsh", "added.json");
const readRecord = () => JSON.parse(readFileSync(addedRecord(), "utf8"));

const seedPatch = (text) => {
  mkdirSync(dshHomeDir(), { recursive: true });
  writeFileSync(patchPath(), text);
};
const seedCreds = (text) => {
  mkdirSync(dshHomeDir(), { recursive: true });
  writeFileSync(credsPath(), text);
};

const enableInput = (overrides = {}) =>
  baseEnableInput({
    apiKey: "sk-enable-1",
    model: GLM,
    catalog: CATALOG,
    baseUrl: "https://api.aiand.com",
    profileName: "default",
    ...overrides,
  });

/** Run fn with process.stdin.isTTY forced, restoring whatever was there. */
const withStdinTty = async (tty, fn) => {
  const saved = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true });
  try {
    return await fn();
  } finally {
    if (saved) Object.defineProperty(process.stdin, "isTTY", saved);
    else delete process.stdin.isTTY;
  }
};

beforeEach(() => {
  delete process.env.DSH_HOME;
  rmSync(join(process.env.AIAND_HOME, ".dsh"), { recursive: true, force: true });
  rmSync(join(process.env.AIAND_CONFIG_DIR, "snapshots", "dsh"), {
    recursive: true,
    force: true,
  });
});

describe("dsh adapter", () => {
  test("id/label/bin/install/managedFiles", () => {
    assert.equal(dshAdapter.id, "dsh");
    assert.equal(dshAdapter.label, "DeepSeek Harness");
    assert.equal(dshAdapter.bin, "dsh");
    assert.match(dshAdapter.install.command, /@deepseek-ai\/dsh@/);
    assert.equal(dshAdapter.install.url, "https://deepseek.com/en/harness/");
    assert.deepEqual(dshAdapter.managedFiles(), [patchPath(), credsPath()]);
  });
});

describe("dsh on", () => {
  test("writes both rows and the credential ref, with the exact bytes", async () => {
    const result = await dshAdapter.enable(enableInput());
    assert.equal(readPatch(), `${LLM_ROW}\n${DEFAULT_ROW}\n`);
    assert.equal(readCreds(), credentials("sk-enable-1"));
    assert.equal(mode(patchPath()), 0o644, "a patch file on creates takes the ordinary mode");
    assert.equal(mode(credsPath()), 0o600, "the credential file is owner-only");
    assert.deepEqual(result, {
      model: GLM,
      catalogModel: GLM,
      filesWritten: [patchPath(), credsPath()],
      warnings: [],
    });
    assert.deepEqual(await dshAdapter.probe(), { active: true, model: GLM });
    assert.ok(!readPatch().includes("sk-"), "the key never rides in the patch layer");
  });

  test("GLM-5.3 publishes low, high, and max and a model with no levels stays plain", async () => {
    const catalog = [
      catalogModel(GLM, { reasoning_efforts: ["low", "high", "max"] }),
      catalogModel(KIMI),
    ];
    await dshAdapter.enable(enableInput({ catalog }));
    const patch = readPatch();
    assert.match(patch, /supportsReasoningEffort: true/);
    assert.equal(patch.includes("supportsReasoningEffort: false"), false);
    const glm = patch.slice(patch.indexOf(`id: ${GLM}`), patch.indexOf(`id: ${KIMI}`));
    assert.match(glm, /reasoningEfforts:\n\s+low: low\n\s+high: high\n\s+max: max/);
    const kimi = patch.slice(patch.indexOf(`id: ${KIMI}`));
    assert.equal(kimi.includes("reasoningEfforts"), false);
  });

  test("keeps a user patch file's mode and a user credential file's other refs", async () => {
    seedPatch(USER_PATCH);
    chmodSync(patchPath(), 0o600);
    seedCreds(USER_CREDENTIALS);
    chmodSync(credsPath(), 0o600);
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    assert.equal(mode(patchPath()), 0o600, "a pre-existing patch mode survives on");
    assert.equal(mode(credsPath()), 0o600);
    assert.equal(
      readCreds(),
      "version: 1\nrefs:\n  OTHER_PROVIDER_KEY: user-secret\n  AIAND_DSH_API_KEY: sk-enable-1\n",
    );
  });

  test("normalizes the base URL and falls back to the default origin", async () => {
    await dshAdapter.enable(enableInput({ baseUrl: "https://api.aiand.com/" }));
    assert.ok(
      readPatch().includes("baseURL: https://api.aiand.com/v1"),
      "a trailing slash is trimmed",
    );
    rmSync(dshHomeDir(), { recursive: true, force: true });
    await dshAdapter.enable(enableInput({ baseUrl: undefined }));
    assert.ok(
      readPatch().includes("baseURL: https://api.aiand.com/v1"),
      "the default origin is used",
    );
  });

  test("a re-on keeps the first capture and a model picked inside our routing", async () => {
    seedPatch(USER_DEFAULT_ROW);
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    const first = await dshAdapter.enable(enableInput());
    assert.ok(
      first.warnings.some((w) => w.includes("Set aside your dsh default (myroute/my-model)")),
    );
    // A --model re-on repins the default model; the undo target stays the first capture's.
    const repin = await dshAdapter.enable(enableInput({ model: KIMI, pinModel: true }));
    assert.equal(repin.model, KIMI);
    assert.ok(readPatch().includes(`model: ${KIMI}`));
    assert.equal(readRecord().previousProvider, "myroute");
    assert.equal(readRecord().previousModel, "my-model");
    // A plain re-on keeps the pick and the first record, and rotates the key.
    await dshAdapter.enable(enableInput({ apiKey: "sk-enable-2" }));
    assert.equal(readCreds(), credentials("sk-enable-2"));
    assert.equal(readRecord().previousProvider, "myroute");
    assert.equal(readRecord().previousModel, "my-model");
    assert.deepEqual(await dshAdapter.probe(), { active: true, model: KIMI });
    // A re-on never stacks ownership banners: the row it replaces loses
    // the comment lines directly above it, exactly like a prune does.
    assert.equal(
      readPatch()
        .split("\n")
        .filter((line) => line.trim() === BANNER).length,
      2,
      "one banner per owned row",
    );
    // Off still hands the set-aside default back, unmarked, with the user's
    // own row text preserved.
    await dshAdapter.disable();
    const restored = readPatch();
    assert.ok(restored.includes(USER_DEFAULT_ROW), "the set-aside default is handed back");
    assert.ok(!restored.includes(MARKER), "the hand-back row is unmarked");
    assert.equal(existsSync(credsPath()), false);
  });

  test("--model native is refused and nothing is written", async () => {
    await assert.rejects(
      dshAdapter.enable(enableInput({ model: "native" })),
      (error) => error instanceof CliError && /not on ai&/.test(error.message),
    );
    assert.equal(existsSync(patchPath()), false);
    assert.equal(existsSync(credsPath()), false);
  });

  test("refuses a hand-written llm-pi-ai row that declares providers", async () => {
    const foreign = [
      "- id: llm-pi-ai",
      "  name: 'mine'",
      "  config:",
      "    providers:",
      "      openai:",
      "        baseURL: https://api.openai.com/v1",
      "",
    ].join("\n");
    seedPatch(foreign);
    await assert.rejects(
      dshAdapter.enable(enableInput()),
      (error) => error instanceof CliError && /does not manage/.test(error.message),
    );
    assert.equal(readPatch(), foreign, "the user's row is untouched");
    assert.equal(existsSync(credsPath()), false);
  });

  test("refuses a foreign llm-pi-ai row with inline config, byte-identical", async () => {
    const foreign = "- id: llm-pi-ai\n  config: {timeoutMs: 1}\n";
    seedPatch(foreign);
    await assert.rejects(
      dshAdapter.enable(enableInput()),
      (error) => error instanceof CliError && /does not manage/.test(error.message),
    );
    assert.equal(readPatch(), foreign, "the user's row is untouched");
    assert.equal(existsSync(credsPath()), false);
  });
  test("refuses a foreign llm-pi-ai row with non-providers config, byte-identical", async () => {
    const foreign =
      "- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n  config:\n    timeoutMs: 120000\n";
    seedPatch(foreign);
    await assert.rejects(
      dshAdapter.enable(enableInput()),
      (error) => error instanceof CliError && /does not manage/.test(error.message),
    );
    assert.equal(readPatch(), foreign, "the user's row is untouched");
    assert.equal(existsSync(credsPath()), false);
  });

  for (const dormant of [
    "- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n",
    "- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n  config:\n",
  ]) {
    test(`a dormant llm-pi-ai row still enables (${JSON.stringify(dormant.slice(-24))})`, async () => {
      seedPatch(dormant);
      const result = await dshAdapter.enable(enableInput());
      assert.equal(result.model, GLM);
      assert.ok(readPatch().includes("x-aiand: true"));
    });
  }
  for (const opener of ["-\n  id: llm-pi-ai", "- name: 'mine'\n  id: llm-pi-ai"]) {
    test(`refuses a providers row that opens with ${JSON.stringify(opener.split("\n")[0])}`, async () => {
      const foreign = `${opener}\n  config:\n    providers:\n      openai:\n        baseURL: https://api.openai.com/v1\n`;
      assert.ok(findRowById(foreign, "llm-pi-ai"));
      seedPatch(foreign);
      await assert.rejects(
        dshAdapter.enable(enableInput()),
        (error) => error instanceof CliError && /does not manage/.test(error.message),
      );
      assert.equal(readPatch(), foreign);
    });
  }

  for (const dormant of [
    "- {id: llm-pi-ai}\n",
    "- {id: llm-pi-ai, name: 'mine'}\n",
    "- {name: 'mine', id: llm-pi-ai}\n",
    "- {'id': llm-pi-ai}\n",
  ]) {
    test(`replaces a dormant flow-map llm-pi-ai row (${JSON.stringify(dormant.trim().slice(0, 34))})`, async () => {
      seedPatch(dormant);
      const result = await dshAdapter.enable(enableInput());
      assert.equal(result.model, GLM);
      const after = readPatch();
      // Exactly one llm-pi-ai row, and it is the one on wrote (its opener
      // is the block form, so it can no longer read as a flow-map row).
      assert.equal(after.split("\n").filter((l) => l === "- id: llm-pi-ai").length, 1);
      assert.equal(after.split("- id: llm-pi-ai").length - 1, 1, "no second llm-pi-ai row");
      assert.ok(after.includes(`x-aiand: true`), "the replacement carries the marker");
      assert.ok(!after.includes("{"), "the dormant flow row is gone, not stacked");
      assert.match(after, /- id: llm-pi-ai\n {2}name: '@deepseek-ai\/dsh-llm-pi-ai'/);
    });
  }

  for (const foreign of [
    "- {id: llm-pi-ai, config: {providers: {openai: {baseURL: https://api.openai.com/v1}}}}\n",
    "- {id: llm-pi-ai, config: {timeoutMs: 120000}}\n",
    "- {id: llm-pi-ai, providers: {openai: {baseURL: https://api.openai.com/v1}}}\n",
    "- {id: llm-pi-ai, config: {providers: {a: {b: 1}}}, name: 'mine'}\n",
  ]) {
    test(`refuses a foreign flow-map llm-pi-ai row (${JSON.stringify(foreign.trim().slice(4, 44))})`, async () => {
      assert.ok(findRowById(foreign, "llm-pi-ai"), "the row is visible to the reader");
      seedPatch(foreign);
      await assert.rejects(
        dshAdapter.enable(enableInput()),
        (error) => error instanceof CliError && /does not manage/.test(error.message),
      );
      assert.equal(readPatch(), foreign, "the user's row is untouched");
      assert.equal(existsSync(credsPath()), false);
    });
  }

  test("a flow-map row whose braces never close is a CliError naming the file", async () => {
    const broken = "- {id: llm-pi-ai, config: {timeoutMs: 1\n";
    seedPatch(broken);
    await assert.rejects(
      dshAdapter.enable(enableInput()),
      (error) =>
        error instanceof CliError &&
        /is not a patch file aiand can read/.test(error.message) &&
        /never closes its braces/.test(error.message),
    );
    assert.equal(readPatch(), broken, "the user's file is untouched");
    assert.equal(existsSync(credsPath()), false);
  });

  test("a flow-map row repeating a key is a CliError naming the file", async () => {
    const broken = "- {id: llm-pi-ai, id: other}\n";
    seedPatch(broken);
    await assert.rejects(
      dshAdapter.enable(enableInput()),
      (error) =>
        error instanceof CliError &&
        /is not a patch file aiand can read/.test(error.message) &&
        /duplicate id/.test(error.message),
    );
    assert.equal(readPatch(), broken, "the user's file is untouched");
  });

  test("findRowById reads any first-level id, never a nested one", () => {
    assert.ok(findRowById("- id: x\n  name: mine\n", "x"));
    assert.ok(findRowById("-\n  id: x\n  name: mine\n", "x"));
    assert.ok(findRowById("- name: mine\n  id: x\n", "x"));
    assert.equal(findRowById("- id: other\n  config:\n    id: x\n", "x"), undefined);
  });

  test("findRowById reads a flow-map row's top-level id, never a nested one", () => {
    assert.ok(findRowById("- {id: llm-pi-ai}\n", "llm-pi-ai"));
    assert.ok(findRowById("- {id: llm-pi-ai, config: {timeoutMs: 1}}\n", "llm-pi-ai"));
    assert.ok(findRowById("- {name: 'mine', id: llm-pi-ai}\n", "llm-pi-ai"));
    assert.ok(findRowById("- {id: 'llm-pi-ai'}\n", "llm-pi-ai"));
    // A nested map's own `id` is its content, not the row's.
    assert.equal(findRowById("- {config: {id: other}}\n", "other"), undefined);
    assert.equal(findRowById("- {id: {nested: x}}\n", "nested"), undefined);
    assert.equal(findRowById("- {name: mine}\n", "llm-pi-ai"), undefined);
    // A block row that merely mentions a flow map still reads its own id.
    assert.ok(findRowById("- id: x\n  config: {y: 1}\n", "x"));
  });

  test("refuses a flow-style providers row instead of clobbering it", async () => {
    const foreign = [
      "- id: llm-pi-ai",
      "  name: 'mine'",
      "  config:",
      "    providers: {openai: {baseURL: https://api.openai.com/v1}}",
      "",
    ].join("\n");
    seedPatch(foreign);
    await assert.rejects(
      dshAdapter.enable(enableInput()),
      (error) => error instanceof CliError && /does not manage/.test(error.message),
    );
    assert.equal(readPatch(), foreign, "the user's row is untouched");
  });

  test("a row the parser cannot read becomes a CliError naming the file", async () => {
    const broken = [
      "- id: llm-pi-ai",
      "  name: '@deepseek-ai/dsh-llm-pi-ai'",
      "  config:",
      "    baseURL: https://api.aiand.com/v1",
      "    baseURL: https://api.aiand.com/v1",
      "    apiKeyEnv: AIAND_DSH_API_KEY",
      "",
    ].join("\n");
    seedPatch(broken);
    await assert.rejects(
      dshAdapter.enable(enableInput()),
      (error) =>
        error instanceof CliError &&
        /is not a patch file aiand can read/.test(error.message) &&
        /duplicate baseURL/.test(error.message),
    );
    assert.equal(readPatch(), broken, "the user's file is untouched");
  });

  // dsh itself writes `refs: {}` once it deletes its last ref, and a user
  // may hand-write a flow map. dsh parses the store with uniqueKeys, so a
  // second `refs:` key anywhere is a file that refuses to boot.
  test("sets a ref into an empty flow map without a second refs key", async () => {
    seedCreds("version: 1\nrefs: {}\n");
    await dshAdapter.enable(enableInput());
    assert.equal(readCreds(), `version: 1\nrefs: {${KEY_REF}: sk-enable-1}\n`);
    assert.equal(readCreds().match(/refs:/g)?.length, 1, "exactly one refs key");
  });

  test("sets a ref into a user flow map, keeping their ref byte-identical", async () => {
    seedCreds("version: 1\nrefs: {OTHER_PROVIDER_KEY: user-secret}\n");
    await dshAdapter.enable(enableInput());
    const creds = readCreds();
    assert.equal(creds.match(/refs:/g)?.length, 1, "exactly one refs key");
    assert.ok(creds.includes("OTHER_PROVIDER_KEY: user-secret"), "their ref survives");
    assert.ok(creds.includes(`${KEY_REF}: sk-enable-1`), "ours is added");
  });

  test("off restores an emptied flow map's line, byte for byte", async () => {
    // `refs: {}` is the shape dsh itself writes once it deletes its last
    // ref: the line belongs to the user's document, so off leaves it there
    // rather than rearranging a file aiand did not create.
    seedCreds("version: 1\nrefs: {}\n");
    await dshAdapter.enable(enableInput());
    await dshAdapter.disable();
    assert.equal(readCreds(), "version: 1\nrefs: {}\n");
  });

  test("off keeps a user flow map's own spacing, byte for byte", async () => {
    seedCreds(`version: 1\nrefs: { A: 'a', B: "b" }\n`);
    await dshAdapter.enable(enableInput());
    await dshAdapter.disable();
    const creds = readCreds();
    assert.equal(creds, `version: 1\nrefs: { A: 'a', B: "b" }\n`);
    assert.ok(creds.includes("A: 'a'") && creds.includes('B: "b"'), "both user refs survive");
  });

  test("an empty credentials store is unlinked, not left as a version: 1 shell", async () => {
    // dsh leaves its store empty once the last ref is gone. Our ref is the
    // document's whole content there, so off unlinks the file rather than
    // leaving a `version: 1` shell behind.
    seedCreds("");
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    assert.equal(readCreds(), credentials("sk-enable-1"));
    const off = await dshAdapter.disable();
    assert.equal(off.stripped, true);
    assert.equal(existsSync(credsPath()), false, "the file we created is gone, shell and all");
  });

  test("on -> on -> off with an empty credentials store unlinks it, not a version: 1 shell", async () => {
    // previousCredsEmpty is recorded on the first on; a re-on rebuilds the
    // record and must carry it over, or off leaves dsh's own rewritten
    // empty store behind.
    seedCreds("");
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    await dshAdapter.enable(enableInput());
    await dshAdapter.disable();
    assert.equal(existsSync(credsPath()), false, "the shell dsh rewrote is ours to drop");
  });

  test("a whitespace-only credentials store is unlinked, like an empty one", async () => {
    // A file holding only a newline comes back from dsh as `version: 1\n`
    // too: it never held a user ref, so off removes the shell.
    seedCreds("\n");
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    await dshAdapter.disable();
    assert.equal(existsSync(credsPath()), false);
  });

  test("on -> on -> off keeps a ref the user added between the two ons", async () => {
    // The carried flag must not reach past the emptiness proof: once the
    // store holds the user's own ref, off keeps the document.
    seedCreds("");
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    seedCreds(`${credentials("sk-enable-1")}  USER_KEY: user-secret\n`);
    await dshAdapter.enable(enableInput({ apiKey: "sk-enable-2" }));
    await dshAdapter.disable();
    assert.equal(readCreds(), "version: 1\nrefs:\n  USER_KEY: user-secret\n");
  });

  // The unlink above is only ours when we made the document: a store the user
  // wrote — a comment above our ref, or a value they hand-set under our ref
  // name — keeps its own bytes. Otherwise off would delete a file it did not
  // create.
  test("off keeps a user's own comment when our ref is the only key", async () => {
    const mine = `# my credentials\nversion: 1\nrefs:\n  ${KEY_REF}: sk-old\n`;
    seedCreds(mine);
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    await dshAdapter.disable();
    assert.equal(readCreds(), "# my credentials\nversion: 1\n", "the comment survives");
  });

  test("off keeps a user's own refs beside one written under our ref name", async () => {
    // A value under our ref name is ours to swap — that is the documented
    // design, the same ref dsh resolves for the session — so `on` rewrites it.
    // What must survive is everything the user put beside it.
    const mine = `version: 1\nrefs:\n  ${KEY_REF}: sk-handset\n  OTHER: keepme\n`;
    seedCreds(mine);
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    await dshAdapter.disable();
    assert.equal(
      readCreds(),
      `version: 1\nrefs:\n  OTHER: keepme\n`,
      "the user's own ref survives; only our name goes",
    );
  });

  test("a foreign credentials document is a CliError, nothing written", async () => {
    seedCreds("records:\n  x: y\n");
    await assert.rejects(
      dshAdapter.enable(enableInput()),
      (error) =>
        error instanceof CliError && /is not a credentials file aiand can read/.test(error.message),
    );
    assert.equal(readCreds(), "records:\n  x: y\n", "the user's file is untouched");
    assert.equal(existsSync(patchPath()), false, "no half-wired home");
  });

  test("the credentials error never echoes the file's first line", async () => {
    // A file whose first line is a bare secret must not leak it through the
    // error message (which lands in logs and --json output).
    seedCreds("sk-test-a-value-that-looks-like-a-key\n");
    await assert.rejects(
      dshAdapter.enable(enableInput()),
      (error) => !error.message.includes("sk-test-a-value-that-looks-like-a-key"),
    );
  });

  test("on warns when a profile layer also configures llm-pi-ai", async () => {
    const profilePatch = join(dshHomeDir(), "profiles", "web", "cordis.patch.yml");
    mkdirSync(dirname(profilePatch), { recursive: true });
    writeFileSync(
      profilePatch,
      "- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n  config:\n    providers:\n      openai:\n        baseURL: https://api.openai.com/v1\n",
    );
    const result = await dshAdapter.enable(enableInput());
    assert.ok(
      result.warnings?.some((w) => /profile/i.test(w)),
      JSON.stringify(result.warnings),
    );
  });

  test("on stays quiet when no profile layer configures llm-pi-ai", async () => {
    const profilePatch = join(dshHomeDir(), "profiles", "web", "cordis.patch.yml");
    mkdirSync(dirname(profilePatch), { recursive: true });
    writeFileSync(
      profilePatch,
      "- id: session-persistence-jsonl\n  name: '@deepseek-ai/dsh-session-persistence-jsonl'\n  config:\n    root: ~/.dsh/sessions\n",
    );
    const result = await dshAdapter.enable(enableInput());
    assert.ok(!result.warnings?.some((w) => /profile/i.test(w)), JSON.stringify(result.warnings));
  });
});

describe("dsh off", () => {
  test("a record with no row text to hand back rebuilds the default with no proofs left", async () => {
    // A record written before `on` captured the row's exact text has only
    // provider and model to rebuild from. Rebuilding must still drop the
    // ownership proofs: a banner promising `aiand dsh off` removes this row
    // never survives an off, whatever the record carried.
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    const record = readRecord();
    delete record.previousDefaultRow;
    record.previousProvider = "myroute";
    record.previousModel = "my-model";
    writeFileSync(addedRecord(), JSON.stringify(record));

    await dshAdapter.disable();
    const after = readPatch();
    assert.ok(!after.includes(BANNER), "no banner survives the rebuild");
    assert.ok(!after.includes(MARKER), "no marker survives the rebuild");
    assert.ok(after.includes("provider: myroute"), "their provider comes back");
    assert.ok(after.includes("model: my-model"), "their model comes back");
  });

  test("removes exactly what on added; user content survives byte for byte", async () => {
    seedPatch(USER_PATCH);
    seedCreds(USER_CREDENTIALS);
    chmodSync(patchPath(), 0o600);
    chmodSync(credsPath(), 0o600);
    // The command layer snapshots before the first write; seed that
    // here so the manifest records which files the user had.
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    assert.equal(readPatch(), `${USER_PATCH}${LLM_ROW}\n${DEFAULT_ROW}\n`);
    const off = await dshAdapter.disable();
    assert.equal(off.stripped, true);
    assert.equal(readPatch(), USER_PATCH);
    assert.equal(readCreds(), USER_CREDENTIALS);
    assert.equal(mode(patchPath()), 0o600, "off restores the pre-on patch mode");
    assert.equal(mode(credsPath()), 0o600, "off restores the pre-on credential mode");
    assert.deepEqual(await dshAdapter.probe(), { active: false, model: null });
    assert.equal((await dshAdapter.disable()).stripped, false, "a second off is a no-op");
  });

  test("unlinks the files on created once off empties them", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    const off = await dshAdapter.disable();
    assert.equal(off.stripped, true);
    assert.equal(existsSync(patchPath()), false, "cordis.patch.yml held only our rows");
    assert.equal(existsSync(credsPath()), false, ".credentials.yaml held only our key");
    assert.deepEqual(await dshAdapter.probe(), { active: false, model: null });
  });

  test("leaves a route the user repointed, with a note", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    seedPatch(
      readPatch().replace(
        "baseURL: https://api.aiand.com/v1",
        "baseURL: https://api.example.com/v1",
      ),
    );
    const off = await dshAdapter.disable();
    assert.equal(off.stripped, true);
    assert.ok(off.notes?.includes("left the aiand route because you edited it"));
    const after = readPatch();
    assert.ok(after.includes("baseURL: https://api.example.com/v1"), "the user's routing stays");
    assert.ok(after.includes(`apiKeyEnv: ${KEY_REF}`), "the ref name stays with the routing");
    assert.ok(!after.includes(MARKER), "the ownership marker is stripped");
    assert.deepEqual(await dshAdapter.probe(), { active: false, model: null });
    assert.equal(existsSync(credsPath()), false, "the baked key never outlives the strip");
    assert.equal((await dshAdapter.disable()).stripped, false);
  });

  test("hands back a default it set aside, unmarked", async () => {
    seedPatch(USER_DEFAULT_ROW);
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    const on = await dshAdapter.enable(enableInput());
    assert.ok(on.warnings.some((w) => w.includes("Set aside your dsh default (myroute/my-model)")));
    await dshAdapter.disable();
    assert.equal(readPatch(), USER_DEFAULT_ROW, "the user's own row text, byte for byte");
    assert.ok(!readPatch().includes(BANNER), "no aiand banner comes back");
    assert.equal(existsSync(credsPath()), false);
  });

  test("a set-aside default with comments inside it round-trips byte for byte", async () => {
    seedPatch(USER_DEFAULT_ROW_COMMENTED);
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    const on = await dshAdapter.enable(enableInput());
    assert.ok(on.warnings.some((w) => w.includes("Set aside your dsh default (myroute/my-model)")));
    await dshAdapter.disable();
    assert.equal(readPatch(), USER_DEFAULT_ROW_COMMENTED, "the comment comes back exactly once");
    assert.equal(existsSync(credsPath()), false);
  });

  // A default row that names no provider at all is the user's own row, and
  // `on`'s whole-row replace would lose it without `off` ever restoring it:
  // the row text is the only thing `off` can hand back, whatever keys the row
  // carries. Each shape is driven through the real verbs.
  const NO_PROVIDER_DEFAULTS = [
    ["a default with no config block at all", "- id: agent-default-model\n"],
    [
      "a default carrying only reasoningEffort",
      "- id: agent-default-model\n  name: 'mine'\n  config:\n    reasoningEffort: high\n",
    ],
    [
      "a default carrying only a model",
      "- id: agent-default-model\n  name: 'mine'\n  config:\n    model: keep-me\n",
    ],
    [
      "a default whose provider is unmarked but whose model dsh cannot serve",
      "- id: agent-default-model\n  config:\n    provider: nowhere\n    model: ghost\n",
    ],
  ];

  for (const [shape, rowText] of NO_PROVIDER_DEFAULTS) {
    test(`on then off keeps ${shape}`, async () => {
      seedPatch(`${USER_PATCH}${rowText}`);
      await snapshotFiles("dsh", dshAdapter.managedFiles());
      const on = await dshAdapter.enable(enableInput());
      assert.ok(readPatch().includes(`model: ${GLM}`), "on stamped the pin over it");
      assert.ok(
        on.warnings.some((w) => w.includes("Set aside your dsh default")),
        `no warning for ${shape}: ${JSON.stringify(on.warnings)}`,
      );
      const off = await dshAdapter.disable();
      assert.equal(off.stripped, true);
      assert.equal(readPatch(), `${USER_PATCH}${rowText}`, "the user's row text, byte for byte");
      assert.ok(!readPatch().includes(BANNER), "no aiand banner comes back");
      assert.equal(existsSync(credsPath()), false, "the baked key never outlives the strip");
      assert.deepEqual(await dshAdapter.probe(), { active: false, model: null });
    });
  }

  test("a set-aside default whose trailing comment sits at EOF round-trips byte for byte", async () => {
    const row = `${USER_DEFAULT_ROW}# eof\n`;
    seedPatch(row);
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    await dshAdapter.disable();
    assert.equal(readPatch(), row, "the comment at EOF comes back exactly once");
    assert.equal(existsSync(credsPath()), false);
  });

  test("a provider+model default whose trailing comment sits at EOF round-trips byte for byte", async () => {
    const row = `- id: agent-default-model
  name: 'mine'
  config:
    provider: myroute
    model: my-model
# eof\n`;
    seedPatch(row);
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    await dshAdapter.disable();
    assert.equal(readPatch(), row, "the comment at EOF comes back exactly once");
    assert.equal(existsSync(credsPath()), false);
  });

  test("drops the ownership proofs of a default row whose model the user edited", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    seedPatch(readPatch().replace(`model: ${GLM}`, `model: ${KIMI}`));
    const off = await dshAdapter.disable();
    assert.equal(off.stripped, true);
    assert.ok(off.notes?.includes("left the aiand default model because you edited it"));
    const after = readPatch();
    assert.ok(!after.includes(DSH_BANNER), "no banner survives an off");
    assert.ok(!after.includes(DSH_MARKER), "the ownership marker is stripped");
    assert.equal(existsSync(credsPath()), false, "the baked key never outlives the strip");
  });

  test("keeps a servable model the user picked inside our routing", async () => {
    await dshAdapter.enable(enableInput());
    seedPatch(readPatch().replace(`model: ${GLM}`, `model: ${KIMI}`));
    const result = await dshAdapter.enable(enableInput());
    assert.equal(result.model, KIMI);
    assert.ok(!result.warnings.some((w) => w.includes("Set aside")));
    assert.deepEqual(await dshAdapter.probe(), { active: true, model: KIMI });
  });

  test("hands back a dormant flow-map llm-pi-ai row it replaced", async () => {
    // on -> off is a round trip: the dormant `- {id: llm-pi-ai}` the flow
    // reader saw comes back exactly as it was, unmarked.
    const dormant = "- {id: llm-pi-ai}\n";
    seedPatch(dormant);
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    assert.ok(readPatch().includes(`x-aiand: true`), "the row was replaced");
    const off = await dshAdapter.disable();
    assert.equal(off.stripped, true);
    assert.equal(readPatch(), dormant, "the user's dormant row is handed back");
    assert.equal(existsSync(credsPath()), false, "the baked key never outlives the strip");
    assert.deepEqual(await dshAdapter.probe(), { active: false, model: null });
  });

  test("hands the dormant flow row back with the user's own rows untouched", async () => {
    // The dormant flow row is no longer an invisible row stacked under ours:
    // on replaces it in place and off puts it back, with the user's other
    // rows surviving byte for byte.
    const dormant = "- {id: llm-pi-ai}\n";
    const userRow = "- id: session-persistence-jsonl\n  name: 'mine'\n";
    seedPatch(`${dormant}${userRow}`);
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    assert.equal(
      readPatch()
        .split("\n")
        .filter((line) => line === "- id: llm-pi-ai").length,
      1,
      "no duplicate row is appended",
    );
    const off = await dshAdapter.disable();
    assert.equal(off.stripped, true);
    assert.equal(readPatch(), `${dormant}${userRow}`, "the file is handed back byte for byte");
    assert.equal(existsSync(credsPath()), false);
  });

  for (const [shape, dormant] of [
    ["no config", "# keep: my route\n- id: llm-pi-ai\n  name: 'mine'\n"],
    ["an empty config", "# keep: my route\n- id: llm-pi-ai\n  name: 'mine'\n  config:\n"],
  ]) {
    // The dormant shape (no config, or an empty one) is the only thing `on`
    // may replace, so the comment the user wrote above it is theirs: only
    // the aiand banner goes, and off hands the comment and row back as they
    // were written.
    test(`off keeps a comment above a dormant row it replaced, ${shape}`, async () => {
      seedPatch(dormant);
      await snapshotFiles("dsh", dshAdapter.managedFiles());
      await dshAdapter.enable(enableInput());
      assert.ok(readPatch().startsWith("# keep: my route\n"), "on keeps their comment");
      const off = await dshAdapter.disable();
      assert.equal(off.stripped, true);
      assert.equal(readPatch(), dormant, "the comment and the row survive byte for byte");
      assert.equal(existsSync(credsPath()), false);
    });
  }
});

describe("dsh status and keys", () => {
  test("probe reads the patch file itself", async () => {
    assert.deepEqual(await dshAdapter.probe(), { active: false, model: null }, "no patch file");
    seedPatch(USER_PATCH);
    assert.deepEqual(await dshAdapter.probe(), { active: false, model: null }, "no aiand row");
    await dshAdapter.enable(enableInput());
    assert.deepEqual(await dshAdapter.probe(), { active: true, model: GLM });
    seedPatch(readPatch().replace(`model: ${GLM}`, `model: ${KIMI}`));
    assert.deepEqual(await dshAdapter.probe(), { active: true, model: KIMI });
  });

  test("probe reports routing live but unpinned when the default row is not ours", async () => {
    await dshAdapter.enable(enableInput());
    // Drop the default row's marker alone (column-4 indent; the llm
    // row's marker sits at column 8).
    seedPatch(readPatch().replace(/^ {4}x-aiand: true\n/m, ""));
    assert.deepEqual(await dshAdapter.probe(), { active: true, model: null });
  });

  test("refreshKey swaps only the key literal, gated on previousKey", async () => {
    assert.equal(await dshAdapter.refreshKey({ apiKey: "sk-new" }), false, "nothing wired");
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    // Same key: an idempotent no-op that still re-tightens a loosened mode.
    assert.equal(await dshAdapter.refreshKey({ apiKey: "sk-enable-1" }), true);
    chmodSync(credsPath(), 0o644);
    assert.equal(await dshAdapter.refreshKey({ apiKey: "sk-enable-1" }), true);
    assert.equal(mode(credsPath()), 0o600);
    // A rotation from a key that is not the baked one is a no-op.
    assert.equal(
      await dshAdapter.refreshKey({ apiKey: "sk-newer", previousKey: "sk-someone-else" }),
      false,
    );
    assert.equal(readCreds(), credentials("sk-enable-1"));
    // The baked key is the one being replaced: swap it.
    assert.equal(
      await dshAdapter.refreshKey({ apiKey: "sk-newer", previousKey: "sk-enable-1" }),
      true,
    );
    assert.equal(readCreds(), credentials("sk-newer"));
    assert.equal(mode(credsPath()), 0o600);
  });

  /** How many `refs:` keys the store declares; two is a file dsh refuses. */
  const refsKeys = () => (readCreds().match(/^refs:/gm) ?? []).length;

  test("refreshKey swaps a flow-form ref", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    // What dsh itself writes once its last ref is gone: the same credential
    // as one line, not an indented block.
    seedCreds(`version: 1\nrefs: {${KEY_REF}: sk-enable-1}\n`);
    assert.equal(await dshAdapter.refreshKey({ apiKey: "sk-flow-1" }), true);
    assert.equal(readCreds(), `version: 1\nrefs: {${KEY_REF}: sk-flow-1}\n`);
    assert.equal(refsKeys(), 1, "still exactly one refs key");
  });

  test("refreshKey keeps the user's own flow refs byte for byte", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    // Ours first: rewriting must not disturb the pair after it.
    seedCreds(`version: 1\nrefs: {${KEY_REF}: sk-enable-1, OTHER: sk-keep}\n`);
    assert.equal(await dshAdapter.refreshKey({ apiKey: "sk-flow-2" }), true);
    assert.equal(
      readCreds(),
      `version: 1\nrefs: {${KEY_REF}: sk-flow-2, OTHER: sk-keep}\n`,
      "ours swaps in place, their ref keeps its exact text",
    );
    assert.equal(refsKeys(), 1);
    // Ours last: the same swap, read from the other end.
    seedCreds(`version: 1\nrefs: {OTHER: sk-keep, ${KEY_REF}: sk-enable-1}\n`);
    assert.equal(await dshAdapter.refreshKey({ apiKey: "sk-flow-3" }), true);
    assert.equal(
      readCreds(),
      `version: 1\nrefs: {OTHER: sk-keep, ${KEY_REF}: sk-flow-3}\n`,
      "the leading pair is untouched, ours is swapped",
    );
    assert.equal(refsKeys(), 1, "still exactly one refs key");
  });

  test("refreshKey: a flow store holding no ref of ours is a plain false", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    const before = `version: 1\nrefs: {OTHER: sk-keep}\n`;
    seedCreds(before);
    assert.equal(await dshAdapter.refreshKey({ apiKey: "sk-flow-4" }), false);
    assert.equal(readCreds(), before, "the user's store is left alone");
  });

  test("refreshKey reads and swaps a quoted flow value", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    seedCreds(`version: 1\nrefs: {${KEY_REF}: "sk-enable-1"}\n`);
    assert.equal(
      await dshAdapter.refreshKey({ apiKey: "sk-flow-4", previousKey: "sk-enable-1" }),
      true,
      "the quotes are not part of the key",
    );
    assert.equal(readCreds(), `version: 1\nrefs: {${KEY_REF}: sk-flow-4}\n`);
  });

  test("refreshKey: the previousKey gate refuses a foreign flow key", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    seedCreds(`version: 1\nrefs: {${KEY_REF}: sk-enable-1, OTHER: sk-keep}\n`);
    assert.equal(
      await dshAdapter.refreshKey({ apiKey: "sk-flow-5", previousKey: "sk-someone-else" }),
      false,
    );
    assert.equal(readCreds(), `version: 1\nrefs: {${KEY_REF}: sk-enable-1, OTHER: sk-keep}\n`);
    // The same gate is not a blanket refusal: the key we baked is still ours
    // to swap, so the refusal above really was the gate and not a blind skip.
    assert.equal(
      await dshAdapter.refreshKey({ apiKey: "sk-flow-5", previousKey: "sk-enable-1" }),
      true,
      "the baked key is the one being replaced",
    );
    assert.equal(readCreds(), `version: 1\nrefs: {${KEY_REF}: sk-flow-5, OTHER: sk-keep}\n`);
  });

  test("on, refreshKey, then off hands a flow store back byte for byte", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    // The gap before the closing brace is the user's, and the rotation is the
    // only write that rebuilds a pair: without it that gap was eaten.
    const before = `version: 1\nrefs: { A: 'a', B: "b" }\n`;
    seedCreds(before);
    await dshAdapter.enable(enableInput());
    assert.equal(
      readCreds(),
      `version: 1\nrefs: { A: 'a', B: "b", ${KEY_REF}: sk-enable-1 }\n`,
      "on appends after the last pair and leaves the user's gap alone",
    );
    assert.equal(await dshAdapter.refreshKey({ apiKey: "sk-rotated" }), true);
    assert.equal(
      readCreds(),
      `version: 1\nrefs: { A: 'a', B: "b", ${KEY_REF}: sk-rotated }\n`,
      "the swap keeps the gap, not just the pair",
    );
    await dshAdapter.disable();
    assert.equal(readCreds(), before, "off drops exactly the pair it added");
    assert.equal(refsKeys(), 1, "still exactly one refs key");
  });

  test("a rotation on a store whose ref is alone keeps its own spacing", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    const before = `version: 1\nrefs: { ${KEY_REF}: sk-enable-1 }\n`;
    seedCreds(before);
    assert.equal(await dshAdapter.refreshKey({ apiKey: "sk-solo" }), true);
    assert.equal(readCreds(), `version: 1\nrefs: { ${KEY_REF}: sk-solo }\n`);
    await dshAdapter.disable();
    assert.equal(
      readCreds(),
      "version: 1\nrefs: {  }\n",
      "the emptied map keeps what the user left",
    );
  });

  // Our ref first is the one shape every other test seeds last: the pair being
  // removed owns the separator that opened the next one, so cutting at the
  // pair's own end leaves a stray `, ` and a file dsh refuses to parse.
  test("off drops a flow ref that sits first, leaving valid YAML", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    // Tight form: `on` never reflows the user's spacing, so none is added here.
    seedCreds(`version: 1\nrefs: {${KEY_REF}: sk-enable-1, A: 'a', B: "b"}\n`);
    await dshAdapter.disable();
    assert.equal(
      readCreds(),
      `version: 1\nrefs: {A: 'a', B: "b"}\n`,
      "only our pair goes; no stray comma",
    );
  });

  test("off drops a first flow ref, keeping the gap the user left after {", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    seedCreds(`version: 1\nrefs: { ${KEY_REF}: sk-enable-1, A: 'a', B: "b" }\n`);
    await dshAdapter.disable();
    assert.equal(
      readCreds(),
      `version: 1\nrefs: { A: 'a', B: "b" }\n`,
      "the leading gap the user left after { survives the removal",
    );
  });

  test("off drops a first flow ref when it is the only one", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    seedCreds(`version: 1\nrefs: { ${KEY_REF}: sk-enable-1 }\n`);
    await dshAdapter.disable();
    assert.equal(readCreds(), "version: 1\nrefs: {  }\n");
  });
});

describe("dsh ownership proof", () => {
  /** Drop the llm row's ownership marker (column-8 indent), as a rewrite might. */
  const dropMarker = () => {
    seedPatch(readPatch().replace(/^ {8}x-aiand: true\n/m, ""));
  };

  test("probe: a dropped marker still reads active while the record proof holds", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    dropMarker();
    assert.deepEqual(await dshAdapter.probe(), { active: true, model: GLM });
  });

  test("probe: a repointed route reads inactive even with a live record", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    dropMarker();
    seedPatch(readPatch().replace("https://api.aiand.com/v1", "https://foreign.example/v1"));
    assert.deepEqual(await dshAdapter.probe(), { active: false, model: null });
  });

  test("off: strips when the marker is gone but the record proof holds", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    dropMarker();
    const off = await dshAdapter.disable();
    assert.equal(off.stripped, true);
    assert.equal(existsSync(patchPath()), false);
    assert.equal(existsSync(credsPath()), false);
    assert.equal(existsSync(addedRecord()), false, "the record is cleared with the strip");
  });

  test("a re-on re-bakes a row whose marker a rewrite dropped", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    dropMarker();
    await dshAdapter.enable(enableInput({ apiKey: "sk-enable-2" }));
    assert.ok(readPatch().includes(MARKER));
    assert.equal(readCreds(), credentials("sk-enable-2"));
    assert.deepEqual(await dshAdapter.probe(), { active: true, model: GLM });
  });

  test("refreshKey: a dropped marker still swaps while the record proof holds", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    dropMarker();
    assert.equal(
      await dshAdapter.refreshKey({ apiKey: "sk-new-1", previousKey: "sk-enable-1" }),
      true,
    );
    assert.equal(readCreds(), credentials("sk-new-1"));
  });

  test("a re-on after the default marker is dropped keeps the first hand-back", async () => {
    seedPatch(USER_DEFAULT_ROW);
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    seedPatch(readPatch().replace(/^ {4}x-aiand: true\n/m, ""));
    await dshAdapter.enable(enableInput({ apiKey: "sk-enable-2" }));
    assert.equal(readRecord().previousProvider, "myroute");
    assert.equal(readRecord().previousModel, "my-model");
    await dshAdapter.disable();
    assert.ok(readPatch().includes(USER_DEFAULT_ROW), "the first hand-back survives the re-on");
  });

  test("refreshKey: a marked row repointed to another base URL is not ours", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    seedPatch(readPatch().replace("https://api.aiand.com/v1", "https://foreign.example/v1"));
    const before = readCreds();
    assert.equal(
      await dshAdapter.refreshKey({ apiKey: "sk-new-1", previousKey: "sk-enable-1" }),
      false,
    );
    assert.equal(readCreds(), before);
  });

  test("refreshKey: a repointed route returns false, byte-identical", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    dropMarker();
    seedPatch(readPatch().replace("https://api.aiand.com/v1", "https://foreign.example/v1"));
    const before = readCreds();
    assert.equal(await dshAdapter.refreshKey({ apiKey: "sk-new-1" }), false);
    assert.equal(readCreds(), before);
  });

  test("refreshKey: an unreadable patch returns false, never throws", async () => {
    seedPatch("{broken\n");
    assert.equal(await dshAdapter.refreshKey({ apiKey: "sk-new-1" }), false);
  });

  test("refreshKey: a write failure surfaces, never a silent false", async () => {
    if (process.platform === "win32") return;
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    const before = readCreds();
    const home = dshHomeDir();
    // A read-only home still reads (r-x) but cannot hold writeFileAtomic's
    // temp file, so the rotation's write fails where the read does not.
    chmodSync(home, 0o500);
    try {
      await assert.rejects(
        dshAdapter.refreshKey({ apiKey: "sk-new-write", previousKey: "sk-enable-1" }),
      );
    } finally {
      chmodSync(home, 0o700);
    }
    assert.equal(readCreds(), before, "the failed write left the baked key alone");
  });

  test("probe: a row the parser cannot read reads inactive, never throws", async () => {
    seedPatch(
      [
        "- id: llm-pi-ai",
        "  name: '@deepseek-ai/dsh-llm-pi-ai'",
        "  config:",
        "    baseURL: https://api.aiand.com/v1",
        "    baseURL: https://api.aiand.com/v1",
        "    apiKeyEnv: AIAND_DSH_API_KEY",
        "",
      ].join("\n"),
    );
    assert.deepEqual(await dshAdapter.probe(), { active: false, model: null });
  });

  test("off: a file broken after on drops the key, keeps the record, and recovers", async () => {
    // A raw throw between the two writes must never strand the baked key in
    // the credential file.
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    seedPatch(
      readPatch().replace(
        "baseURL: https://api.aiand.com/v1",
        "baseURL: https://api.aiand.com/v1\n        baseURL: https://api.aiand.com/v1",
      ),
    );
    await assert.rejects(
      dshAdapter.disable(),
      (error) =>
        error instanceof CliError && /is not a patch file aiand can read/.test(error.message),
    );
    assert.ok(!readCreds().includes("sk-enable-1"), "the baked key is gone");
    // Fix the file: the record survived, so a second off completes the strip.
    seedPatch(readPatch().replace("        baseURL: https://api.aiand.com/v1\n", ""));
    const off = await dshAdapter.disable();
    assert.equal(off.stripped, true);
    assert.equal(existsSync(patchPath()), false);
    assert.equal(existsSync(credsPath()), false);
  });

  test("off: a file broken at document level after on still drops the key", async () => {
    // A tab or a second document marker throws before ourLlmRow can prove
    // the row ours; the record plus the baked key are still ours to strip.
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    seedPatch(readPatch().replace("  config:", "\tconfig:"));
    await assert.rejects(
      dshAdapter.disable(),
      (error) =>
        error instanceof CliError && /is not a patch file aiand can read/.test(error.message),
    );
    assert.ok(!readCreds().includes("sk-enable-1"), "the baked key is gone");
    // Fix the file: the record survived, so a second off completes the strip.
    seedPatch(readPatch().replace("\tconfig:", "  config:"));
    const off = await dshAdapter.disable();
    assert.equal(off.stripped, true);
    assert.equal(existsSync(patchPath()), false);
    assert.equal(existsSync(credsPath()), false);
  });
});

describe("dsh CRLF homes", () => {
  test("on splices a CRLF patch file and off restores it byte for byte", async () => {
    const crlf = USER_PATCH.replace(/\n/g, "\r\n");
    seedPatch(crlf);
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    const rows = readPatch()
      .split("\n")
      .filter((line) => line.startsWith("- id:"));
    assert.equal(rows.length, 3, "our two rows splice in; no duplicate of the user's");
    await dshAdapter.disable();
    assert.equal(readPatch(), crlf);
  });

  test("a row id with a trailing comment still reads as the row it names", async () => {
    const foreign = [
      "- id: llm-pi-ai # mine",
      "  name: 'mine'",
      "  config:",
      "    providers:",
      "      openai:",
      "        baseURL: https://api.openai.com/v1",
      "",
    ].join("\n");
    seedPatch(foreign);
    await assert.rejects(
      dshAdapter.enable(enableInput()),
      (error) => error instanceof CliError && /does not manage/.test(error.message),
    );
    assert.equal(readPatch(), foreign);
  });
});

describe("dsh shapes the reader refuses or hides", () => {
  test("a marker inside a block scalar body is text, not our ownership proof", async () => {
    const foreign = [
      "- id: llm-pi-ai",
      "  name: 'mine'",
      "  config:",
      "    providers:",
      "      openai:",
      "        baseURL: https://api.openai.com/v1",
      "    script: |",
      "      x-aiand: true",
      "",
    ].join("\n");
    seedPatch(foreign);
    assert.deepEqual(await dshAdapter.probe(), { active: false, model: null });
    await assert.rejects(
      dshAdapter.enable(enableInput()),
      (error) => error instanceof CliError && /does not manage/.test(error.message),
    );
    assert.equal(readPatch(), foreign);
  });

  test("a second document or a tab reads as a CliError, never a crash", async () => {
    // A duplicate key inside a row we read is covered by "a row the parser
    // cannot read becomes a CliError naming the file"; these two shapes
    // break the whole document, wherever they sit.
    const broken = [
      { name: "second document", text: "- id: a\n  name: b\n---\n- id: c\n  name: d\n" },
      { name: "tab indent", text: "- id: a\n\tname: b\n" },
    ];
    for (const { name, text } of broken) {
      seedPatch(text);
      assert.deepEqual(await dshAdapter.probe(), { active: false, model: null }, name);
      await assert.rejects(
        dshAdapter.enable(enableInput()),
        (error) =>
          error instanceof CliError && /is not a patch file aiand can read/.test(error.message),
        name,
      );
      assert.equal(readPatch(), text, `${name}: the user's file is untouched`);
    }
  });

  test("a leading document marker is legal and the rows below still read", async () => {
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    seedPatch(`---\n${USER_PATCH}`);
    await dshAdapter.enable(enableInput());
    assert.deepEqual(await dshAdapter.probe(), { active: true, model: GLM });
    await dshAdapter.disable();
    assert.equal(readPatch(), `---\n${USER_PATCH}`);
  });

  test("a leading BOM does not hide the first row from the reader", async () => {
    const foreign = `\uFEFF- id: llm-pi-ai\n  name: 'mine'\n  config:\n    providers:\n      openai:\n        baseURL: https://api.openai.com/v1\n`;
    seedPatch(foreign);
    await assert.rejects(
      dshAdapter.enable(enableInput()),
      (error) => error instanceof CliError && /does not manage/.test(error.message),
    );
    assert.equal(readPatch(), foreign, "the user's row is untouched");
  });

  test("a double-quoted scalar decodes YAML-only escapes, never the raw text", async () => {
    // JSON.parse rejects `\_` and `\x41`, so the old reader returned the raw
    // quoted text with the backslashes intact. The YAML table decodes them:
    // `\_` is U+00A0 (YAML 1.2 §5.7) and `\x41` is "A".
    seedPatch(`${LLM_ROW}\n${DEFAULT_ROW.replace(`model: ${GLM}`, 'model: "x\\_y\\x41"')}\n`);
    assert.deepEqual(await dshAdapter.probe(), { active: true, model: "x\u00a0yA" });
  });

  test("a bad escape in a double-quoted scalar reads inactive or a CliError", async () => {
    const text = `${LLM_ROW}\n${DEFAULT_ROW.replace(`model: ${GLM}`, 'model: "x\\qy"')}\n`;
    seedPatch(text);
    assert.deepEqual(await dshAdapter.probe(), { active: false, model: null });
    await assert.rejects(
      dshAdapter.enable(enableInput()),
      (error) =>
        error instanceof CliError && /is not a patch file aiand can read/.test(error.message),
    );
    assert.equal(readPatch(), text, "the user's file is untouched");
  });
});

describe("dsh flow-map row reader", () => {
  /** A flow row dsh itself would write for a default: `- {` opens on the
   * opener line, so every key the row has rides there. */
  const FLOW_DEFAULT =
    "- {id: agent-default-model, config: {provider: deepseek, model: deepseek-v4}}\n";

  test("finds a flow-map default row and reads its provider and model", () => {
    const row = findRowById(FLOW_DEFAULT, "agent-default-model");
    assert.ok(row, "the flow row is visible to the reader");
    assert.equal(rowValue(row, "provider"), "deepseek");
    assert.equal(rowValue(row, "model"), "deepseek-v4");
  });

  test("a trailing comment before the close brace is not part of the id", () => {
    // H1: the comment sits outside the braces, so `id` reads clean and the
    // nested values stay readable.
    assert.ok(
      findRowById(
        "- {id: agent-default-model, config: {provider: p, model: m}} # mine\n",
        "agent-default-model",
      ),
    );
    assert.ok(findRowById("- {id: x} # c\n", "x"));
    assert.deepEqual(flowRowEntries(findRowById("- {id: x} # c\n", "x")), { id: "x" });
    // A comment inside the braces is cut too; a quoted hash stays put.
    assert.deepEqual(flowRowEntries(findRowById("- {id: x # inside}\n", "x")), { id: "x" });
    assert.deepEqual(flowRowEntries(findRowById("- {name: 'a#b', id: q}\n", "q")), {
      name: "'a#b'",
      id: "q",
    });
  });

  test("a nested map's own keys are never read as the row's", () => {
    const row = findRowById(FLOW_DEFAULT, "agent-default-model");
    assert.equal(rowValue(row, "id"), "agent-default-model");
    // `config:` holds a map here, not a scalar: reading it as one is absent.
    assert.equal(rowValue(row, "config"), undefined);
  });

  test("a block row that merely mentions a flow map still reads its own shape", () => {
    const row = findRowById(
      "- id: agent-default-model\n  config: {provider: a, model: b}\n",
      "agent-default-model",
    );
    assert.ok(row);
    assert.equal(
      rowValue(row, "provider"),
      undefined,
      "a block row's flow map is not read as block values",
    );
  });

  // `on` and `off` both go through spliceRow, so the only way to prove the
  // adapter-level path holds the user's file together is to drive the real
  // verbs and assert the seeded bytes come back untouched.
  const USER_DEFAULT = [
    "- id: agent-default-model",
    "  name: 'mine'",
    "  config:",
    "    provider: myroute",
    "    model: my-model",
  ];

  /** Every shape the seeded file can carry, with the comment in a place
   * `on` must notice: between two rows, after the last one at EOF, or
   * directly above the row `on` replaces. Only the aiand banner goes: a
   * comment the user wrote above their own row is theirs. Each entry
   * carries the shape's name, the comment text to count, and the file. */
  const SHAPES = [
    [
      "a comment directly above the replaced llm row",
      "# keep: my route",
      [
        ...USER_DEFAULT,
        "# keep: my route",
        "- id: llm-pi-ai",
        "  name: 'mine'",
        "",
        "- id: other",
        "  name: 'other'",
        "",
      ].join("\n"),
    ],
    [
      "a comment between two rows, file ends with a newline",
      "# note between rows",
      [
        ...USER_DEFAULT,
        "- id: llm-pi-ai",
        "  name: 'mine'",
        "# note between rows",
        "",
        "- id: other",
        "  name: 'other'",
        "",
      ].join("\n"),
    ],
    [
      "a comment at EOF, file ends with a newline",
      "# note at eof",
      [
        ...USER_DEFAULT,
        "- id: llm-pi-ai",
        "  name: 'mine'",
        "",
        "- id: other",
        "  name: 'other'",
        "",
        "# note at eof",
        "",
      ].join("\n"),
    ],
    [
      "a comment at EOF, file ends without a newline",
      "# note at eof",
      [
        ...USER_DEFAULT,
        "- id: llm-pi-ai",
        "  name: 'mine'",
        "",
        "- id: other",
        "  name: 'other'",
        "",
        "# note at eof",
      ].join("\n"),
    ],
    [
      "a CRLF file with a comment between two rows",
      "# note between rows",
      [
        ...USER_DEFAULT,
        "- id: llm-pi-ai",
        "  name: 'mine'",
        "# note between rows",
        "",
        "- id: other",
        "  name: 'other'",
        "",
      ].join("\r\n"),
    ],
  ];

  for (const [shape, comment, original] of SHAPES) {
    test(`on -> off -> on -> off restores ${shape} byte for byte`, async () => {
      seedPatch(original);
      // The command layer snapshots before the first write, so off can tell
      // a file the user already had from one `on` created.
      await snapshotFiles("dsh", dshAdapter.managedFiles());
      // `on` replaces the llm row (comment above the next row) and stamps
      // the default row the record hands back.
      await dshAdapter.enable(enableInput());
      assert.equal(
        readPatch().split(comment).length - 1,
        1,
        "on keeps the user's own comment once",
      );
      await dshAdapter.disable();
      assert.equal(readPatch(), original, "one on/off cycle restores the seeded bytes exactly");

      await dshAdapter.enable(enableInput());
      await dshAdapter.disable();
      assert.equal(
        readPatch(),
        original,
        "a second cycle adds no copy of the comment and drops no blank",
      );
      assert.ok(!readPatch().includes(BANNER), "off leaves no banner behind");
      assert.ok(!readPatch().includes(MARKER), "off leaves no marker behind");
    });
  }
});

describe("dsh sessionLaunch", () => {
  const launchInput = (overrides = {}) => ({
    apiKey: "sk-session-1",
    model: GLM,
    catalog: CATALOG,
    baseUrl: "https://api.aiand.com",
    profileName: "default",
    ...overrides,
  });
  const overlayPatch = (launch) =>
    readFileSync(join(launch.env.DSH_HOME, "cordis.patch.yml"), "utf8");

  test("runs one session from a throwaway home, key out of the child env", async () => {
    const launch = await dshAdapter.sessionLaunch(launchInput());
    try {
      // The only env the child gets is the overlay home and a blank
      // override of the ref name: dsh resolves refs with the
      // inherited environment first, so a blank value lets the
      // overlay's credential file win.
      assert.deepEqual(launch.env, { DSH_HOME: launch.env.DSH_HOME, [KEY_REF]: "" });
      assert.notEqual(launch.env.DSH_HOME, dshHomeDir());
      assert.deepEqual(launch.args, ["--profile", "headless"]);
      assert.deepEqual(launch.stripPassthroughFlags, ["--patch"]);
      const overlay = launch.env.DSH_HOME;
      assert.equal(mode(join(overlay, "cordis.patch.yml")), 0o600);
      assert.equal(mode(join(overlay, ".credentials.yaml")), 0o600);
      assert.equal(
        readFileSync(join(overlay, "cordis.patch.yml"), "utf8"),
        `${LLM_ROW}\n${DEFAULT_ROW}\n`,
      );
      assert.equal(
        readFileSync(join(overlay, ".credentials.yaml"), "utf8"),
        credentials("sk-session-1"),
      );
      assert.equal(existsSync(patchPath()), false, "nothing is written under the real home");
      assert.equal(existsSync(credsPath()), false);
    } finally {
      await launch.cleanup();
    }
    assert.equal(existsSync(launch.env.DSH_HOME), false, "cleanup removes the overlay");
  });

  test("picks the web profile on a terminal, headless when piped", async () => {
    const web = await withStdinTty(true, () => dshAdapter.sessionLaunch(launchInput()));
    try {
      assert.deepEqual(web.args, ["--profile", "web"]);
    } finally {
      await web.cleanup();
    }
    const piped = await withStdinTty(false, () => dshAdapter.sessionLaunch(launchInput()));
    try {
      assert.deepEqual(piped.args, ["--profile", "headless"]);
    } finally {
      await piped.cleanup();
    }
  });

  test("resolves the startup model: --model, else the profile default, else the catalog's first entry", async () => {
    const pinned = await dshAdapter.sessionLaunch(launchInput({ model: KIMI }));
    try {
      assert.ok(overlayPatch(pinned).includes(`    model: ${KIMI}`));
    } finally {
      await pinned.cleanup();
    }
    const profiled = await dshAdapter.sessionLaunch(
      launchInput({ model: undefined, profileModel: KIMI }),
    );
    try {
      assert.ok(overlayPatch(profiled).includes(`    model: ${KIMI}`));
    } finally {
      await profiled.cleanup();
    }
    // A model outside the catalog falls back to the first entry.
    const foreign = await dshAdapter.sessionLaunch(launchInput({ model: "foreign/model" }));
    try {
      assert.ok(overlayPatch(foreign).includes(`    model: ${GLM}`));
    } finally {
      await foreign.cleanup();
    }
    const first = await dshAdapter.sessionLaunch(launchInput({ model: undefined }));
    try {
      assert.ok(overlayPatch(first).includes(`    model: ${GLM}`));
    } finally {
      await first.cleanup();
    }
    await assert.rejects(dshAdapter.sessionLaunch(launchInput({ catalog: [] })), CliError);
  });

  test("restates the real session root so history survives the throwaway", async () => {
    mkdirSync(join(dshHomeDir(), "sessions"), { recursive: true });
    const launch = await dshAdapter.sessionLaunch(launchInput());
    try {
      assert.ok(overlayPatch(launch).includes("- id: session-persistence-jsonl"));
      assert.ok(overlayPatch(launch).includes(`    root: ${join(dshHomeDir(), "sessions")}`));
    } finally {
      await launch.cleanup();
    }
  });
});

describe("dsh DSH_HOME", () => {
  test("relocates the config root", () => {
    const elsewhere = join(process.env.AIAND_HOME, "elsewhere");
    process.env.DSH_HOME = elsewhere;
    try {
      assert.deepEqual(dshAdapter.managedFiles(), [
        join(elsewhere, "cordis.patch.yml"),
        join(elsewhere, ".credentials.yaml"),
      ]);
    } finally {
      delete process.env.DSH_HOME;
    }
  });

  test("off strips the recorded home when $DSH_HOME moved", async () => {
    const first = join(process.env.AIAND_HOME, "first-home");
    process.env.DSH_HOME = first;
    await snapshotFiles("dsh", dshAdapter.managedFiles());
    await dshAdapter.enable(enableInput());
    const wired = [join(first, "cordis.patch.yml"), join(first, ".credentials.yaml")];
    assert.deepEqual(dshAdapter.managedFiles(), wired);
    // The home moved between on and off; the new home need not exist.
    const second = join(process.env.AIAND_HOME, "second-home");
    process.env.DSH_HOME = second;
    try {
      assert.deepEqual(
        dshAdapter.managedFiles(),
        [join(second, "cordis.patch.yml"), join(second, ".credentials.yaml"), ...wired],
        "managedFiles includes the recorded moved paths",
      );
      const off = await dshAdapter.disable();
      assert.equal(off.stripped, true);
      assert.ok(
        off.notes?.some(
          (n) =>
            n.includes("stripped the aiand config from") &&
            n.includes(first) &&
            n.includes("because the dsh home moved"),
        ),
      );
      assert.equal(existsSync(wired[0]), false);
      assert.equal(existsSync(wired[1]), false);
      assert.equal(existsSync(addedRecord()), false, "the record is cleared with the strip");
      assert.deepEqual(await dshAdapter.probe(), { active: false, model: null });
    } finally {
      delete process.env.DSH_HOME;
    }
  });
});

// The bare-verb leg `run-agent` never exercises: `aiand dsh` (no verb) must
// wire a fresh home with `on`, then run dsh with the args verbatim. The
// throwaway-$DSH_HOME overlay and cleanup invariants are covered for
// `run-agent dsh` in test/run-agent.test.mjs and by the sessionLaunch tests
// above; this covers the wiring-on-open leg only.
describe("dsh open", () => {
  test("a bare `aiand dsh` wires a fresh home, then runs dsh with the args verbatim", async () => {
    const binDir = join(process.env.AIAND_HOME, "bin");
    plantStub(binDir, "dsh", CAPTURE_STUB);
    const capture = mkdtempSync(join(process.env.AIAND_HOME, "open-cap-"));
    seedCatalogCache(process.env.AIAND_CONFIG_DIR);
    try {
      const { code, stderr } = await runCli(["dsh", "--", "--version"], {
        env: cliEnv({
          AIAND_API_KEY: FAKE_API_KEY,
          AIAND_BASE_URL: CLOSED_URL,
          AIAND_CAPTURE: capture,
          DSH_HOME: dshHomeDir(),
          PATH: hermeticPath(binDir, "/usr/bin", "/bin"),
        }),
      });
      assert.equal(code, 42, "the child's exit code propagates");
      assert.match(stderr, /DeepSeek Harness is now using ai&\./);
      // `on` wrote the wiring into the throwaway home and the spawn targets
      // that same home, never the runner's real ~/.dsh.
      assert.ok(existsSync(patchPath()), "cordis.patch.yml was wired");
      assert.ok(existsSync(credsPath()), ".credentials.yaml was wired");
      const args = readFileSync(`${capture}.args`, "utf8").split("\n").slice(0, -1);
      assert.deepEqual(args, ["--profile", "headless", "--version"]);
      const envText = readFileSync(`${capture}.env`, "utf8");
      assert.doesNotMatch(envText, /^AIAND_API_KEY=/m, "the key never rides the child env");
      assert.equal(/^DSH_HOME=(.*)$/m.exec(envText)[1], dshHomeDir());
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  // The regression this exists for: the open path used to spawn dsh with no
  // profile at all, so the real binary exited `error: --profile <name> is
  // required`. dsh has no default profile — it boots a named one under
  // $DSH_HOME/profiles, and the piped (non-TTY) session is `headless`.
  test("the open path spawns dsh with a --profile argv whose value survives", async () => {
    const binDir = join(process.env.AIAND_HOME, "bin");
    plantStub(binDir, "dsh", CAPTURE_STUB);
    const capture = mkdtempSync(join(process.env.AIAND_HOME, "open-cap-"));
    seedCatalogCache(process.env.AIAND_CONFIG_DIR);
    try {
      const { code, stderr } = await runCli(["dsh"], {
        env: cliEnv({
          AIAND_API_KEY: FAKE_API_KEY,
          AIAND_BASE_URL: CLOSED_URL,
          AIAND_CAPTURE: capture,
          DSH_HOME: dshHomeDir(),
          PATH: hermeticPath(binDir, "/usr/bin", "/bin"),
        }),
      });
      assert.equal(code, 42, "the child's exit code propagates");
      assert.doesNotMatch(stderr, /--profile <name> is required/);
      const args = readFileSync(`${capture}.args`, "utf8").split("\n").slice(0, -1);
      // Not just the flag: dsh errors `--profile needs a name` on a bare
      // `--profile`, and `--profile <name> is required` when it is absent.
      assert.deepEqual(args.slice(0, 2), ["--profile", "headless"]);
      const at = args.indexOf("--profile");
      assert.ok(at !== -1, "the open path names the profile");
      const value = args[at + 1];
      assert.equal(value, "headless", "the profile value survives to the child");
      assert.ok(value !== "" && !value.startsWith("-"), "the value is a real name");
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("a profile the user picks themselves gets no second one", async () => {
    const binDir = join(process.env.AIAND_HOME, "bin");
    plantStub(binDir, "dsh", CAPTURE_STUB);
    const capture = mkdtempSync(join(process.env.AIAND_HOME, "open-cap-"));
    seedCatalogCache(process.env.AIAND_CONFIG_DIR);
    try {
      // dsh refuses a profile selected twice ("select a profile only once"),
      // so `aiand dsh web` must pass the user's pick through untouched.
      const { code } = await runCli(["dsh", "web"], {
        env: cliEnv({
          AIAND_API_KEY: FAKE_API_KEY,
          AIAND_BASE_URL: CLOSED_URL,
          AIAND_CAPTURE: capture,
          DSH_HOME: dshHomeDir(),
          PATH: hermeticPath(binDir, "/usr/bin", "/bin"),
        }),
      });
      assert.equal(code, 42);
      const args = readFileSync(`${capture}.args`, "utf8").split("\n").slice(0, -1);
      assert.deepEqual(args, ["web"], "the user's own profile is the only one");
      const { code: same } = await runCli(["dsh", "--", "--profile", "web"], {
        env: cliEnv({
          AIAND_API_KEY: FAKE_API_KEY,
          AIAND_BASE_URL: CLOSED_URL,
          AIAND_CAPTURE: capture,
          DSH_HOME: dshHomeDir(),
          PATH: hermeticPath(binDir, "/usr/bin", "/bin"),
        }),
      });
      assert.equal(same, 42);
      assert.deepEqual(readFileSync(`${capture}.args`, "utf8").split("\n").slice(0, -1), [
        "--profile",
        "web",
      ]);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  // A passthrough --patch overlay outranks the layer `on` just wrote, so the
  // open path must own the flag exactly like run-agent does.
  test("a user --patch is dropped so it cannot outrank the wiring", async () => {
    const binDir = join(process.env.AIAND_HOME, "bin");
    plantStub(binDir, "dsh", CAPTURE_STUB);
    const capture = mkdtempSync(join(process.env.AIAND_HOME, "open-cap-"));
    seedCatalogCache(process.env.AIAND_CONFIG_DIR);
    try {
      const { code } = await runCli(
        ["dsh", "--", "--patch", "/tmp/evil.yml", "--patch=/x.yml", "--port", "8080"],
        {
          env: cliEnv({
            AIAND_API_KEY: FAKE_API_KEY,
            AIAND_BASE_URL: CLOSED_URL,
            AIAND_CAPTURE: capture,
            DSH_HOME: dshHomeDir(),
            PATH: hermeticPath(binDir, "/usr/bin", "/bin"),
          }),
        },
      );
      assert.equal(code, 42);
      const args = readFileSync(`${capture}.args`, "utf8").split("\n").slice(0, -1);
      assert.ok(!args.includes("--patch"), "the --patch value form is dropped");
      assert.ok(!args.includes("/tmp/evil.yml"));
      assert.ok(!args.some((a) => a.startsWith("--patch=")), "the --patch= form is dropped too");
      assert.deepEqual(args.slice(0, 2), ["--profile", "headless"]);
      assert.deepEqual(args.slice(-2), ["--port", "8080"], "unrelated flags pass verbatim");
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  // The flag is owned on every invocation, not only when a profile is
  // injected: a passthrough overlay outranks the layer `on` just wrote
  // whichever profile the user named.
  test("a user --patch is dropped next to a profile the user named", async () => {
    const binDir = join(process.env.AIAND_HOME, "bin");
    plantStub(binDir, "dsh", CAPTURE_STUB);
    const capture = mkdtempSync(join(process.env.AIAND_HOME, "open-cap-"));
    seedCatalogCache(process.env.AIAND_CONFIG_DIR);
    const runCliStub = (passthrough) =>
      runCli(["dsh", "--", ...passthrough], {
        env: cliEnv({
          AIAND_API_KEY: FAKE_API_KEY,
          AIAND_BASE_URL: CLOSED_URL,
          AIAND_CAPTURE: capture,
          DSH_HOME: dshHomeDir(),
          PATH: hermeticPath(binDir, "/usr/bin", "/bin"),
        }),
      });
    // runCli resolves the child's exit, so each case is awaited before its
    // argv file is read.
    const dshArgs = async (passthrough) => {
      rmSync(`${capture}.args`, { force: true });
      const { code } = await runCliStub(passthrough);
      const args = readFileSync(`${capture}.args`, "utf8").split("\n").slice(0, -1);
      return { code, args };
    };
    try {
      // A profile named as a flag: theirs stands, ours is not added, and the
      // overlay still never reaches dsh.
      const flag = await dshArgs(["--profile", "web", "--patch", "/x.yml"]);
      assert.equal(flag.code, 42);
      assert.deepEqual(flag.args, ["--profile", "web"], "their profile, no second one");

      // A profile named positionally, with the overlay in its `=` form.
      const positional = await dshArgs(["web", "--patch=/x.yml"]);
      assert.equal(positional.code, 42);
      assert.deepEqual(positional.args, ["web"], "their positional profile stands alone");

      // The overlay's own value is not a profile: the positional after it is,
      // so ours must not be added and the overlay must still go.
      const after = await dshArgs(["--patch", "x.yml", "web"]);
      assert.equal(after.code, 42);
      assert.deepEqual(after.args, ["web"], "the value is skipped, the profile is theirs");

      // A value belonging to an unrelated flag is not a profile either.
      const unrelated = await dshArgs(["--patch", "x.yml", "--port", "8080"]);
      assert.equal(unrelated.code, 42);
      assert.deepEqual(
        unrelated.args.slice(0, 2),
        ["--profile", "headless"],
        "no profile was named, so ours is injected",
      );
      assert.deepEqual(unrelated.args.slice(-2), ["--port", "8080"]);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  // The key the `on` leg baked must stay in the file and never ride the
  // child env: a blank override of the ref name lets dsh read it as absent,
  // so the credential file wins.
  test("the session key never rides the child env", async () => {
    const binDir = join(process.env.AIAND_HOME, "bin");
    plantStub(binDir, "dsh", CAPTURE_STUB);
    const capture = mkdtempSync(join(process.env.AIAND_HOME, "open-cap-"));
    seedCatalogCache(process.env.AIAND_CONFIG_DIR);
    try {
      const { code } = await runCli(["dsh"], {
        env: cliEnv({
          AIAND_API_KEY: FAKE_API_KEY,
          AIAND_BASE_URL: CLOSED_URL,
          AIAND_CAPTURE: capture,
          DSH_HOME: dshHomeDir(),
          PATH: hermeticPath(binDir, "/usr/bin", "/bin"),
        }),
      });
      assert.equal(code, 42);
      const envText = readFileSync(`${capture}.env`, "utf8");
      assert.doesNotMatch(envText, new RegExp(`^${KEY_REF}=sk`, "m"), "the key is not exported");
      assert.match(envText, new RegExp(`^${KEY_REF}=$`, "m"), "the ref name is blanked");
      // The credential file `on` wrote is the one that carries the key.
      assert.match(readCreds(), new RegExp(`${KEY_REF}: sk`));
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });
});

/** The levels dsh's cordis schema names (dsh 0.2.0-rc.2), mirrored here to
 * prove what the row renders. */
const DSH_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The reasoningEfforts keys one model's rendered entry carries, in order. */
const effortsFor = (row, modelId) => {
  const lines = row.split("\n");
  const start = lines.findIndex((line) => line.includes(`- id: ${modelId}`));
  const block = [];
  for (const line of lines.slice(start)) {
    if (/^ {12}reasoningEfforts:$/.test(line)) continue;
    const key = /^ {14}(\S+): /.exec(line);
    if (key) block.push(key[1]);
    else if (block.length > 0) break;
  }
  return block;
};

describe("dsh reasoning levels", () => {
  const BASE = "https://api.aiand.com";
  const withLevels = (id, levels) => catalogModel(id, { reasoning_efforts: levels });

  test("a level dsh does not name is dropped, its legal siblings survive", () => {
    const model = withLevels("motif-technologies/motif-3", ["none", "high"]);
    const row = buildDshLlmRow(BASE, [model]);
    assert.deepEqual(effortsFor(row, model.id), ["high"]);
    assert.ok(row.includes(`- id: ${model.id}`), "the model still rides the row");
    assert.ok(row.includes("contextWindow: 128000"), "the rest of the entry is untouched");
    assert.ok(!row.includes("none:"), "the unmappable key is never written");
  });

  test("a model whose every level is unmappable renders no reasoningEfforts block", () => {
    const row = buildDshLlmRow(BASE, [withLevels("deepseek-ai/deepseek-v4-flash", ["none"])]);
    assert.ok(row.includes("- id: deepseek-ai/deepseek-v4-flash"), "the model is still routed");
    assert.ok(!row.includes("reasoningEfforts:"), "no block is declared at all");
    assert.ok(row.includes("input: [text]"), "the plain fields survive");
    assert.deepEqual(effortsFor(row, "deepseek-ai/deepseek-v4-flash"), []);
  });

  test("an invented level is dropped too: the rule is dsh's schema, not a blocklist", () => {
    const row = buildDshLlmRow(BASE, [
      withLevels("invented/model", ["none", "low", "o3", "medium", "xhigh"]),
    ]);
    assert.deepEqual(effortsFor(row, "invented/model"), ["low", "medium", "xhigh"]);
    for (const key of effortsFor(row, "invented/model")) {
      assert.ok(DSH_LEVELS.includes(key), `${key} is a dsh level`);
    }
  });

  test("no usable level anywhere drops the whole compat block", () => {
    const row = buildDshLlmRow(BASE, [withLevels("a/one", ["none"]), catalogModel("b/two")]);
    assert.ok(!row.includes("compat:"), "no capability is claimed");
    assert.ok(!row.includes("supportsReasoningEffort"), "no effort flag without a usable level");
  });

  test("a surviving level flips supportsReasoningEffort true", () => {
    const row = buildDshLlmRow(BASE, [withLevels("a/one", ["none", "max"])]);
    assert.ok(row.includes("supportsReasoningEffort: true"));
  });

  test("`on` renders the filtered levels into the row it writes", async () => {
    const model = withLevels(GLM, ["low", "high", "max"]);
    await dshAdapter.enable(enableInput({ catalog: [model] }));
    assert.deepEqual(effortsFor(readPatch(), GLM), ["low", "high", "max"]);
  });

  test("`on` drops the unmappable level from the row it writes", async () => {
    const model = withLevels(GLM, ["none", "low", "high", "max"]);
    await dshAdapter.enable(enableInput({ catalog: [model] }));
    const glm = readPatch().slice(readPatch().indexOf(`- id: ${GLM}`));
    assert.deepEqual(effortsFor(glm, GLM), ["low", "high", "max"]);
    assert.ok(!glm.includes("none:"), "dsh never sees the level its schema does not name");
  });
});
