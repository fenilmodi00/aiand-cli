import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import test, { beforeEach, describe } from "node:test";
import {
  enableInput as baseEnableInput,
  catalogModel,
  plantStub,
  withTestEnv,
} from "./helpers.mjs";

withTestEnv("aiand-codex-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_API_KEY = "sk-test-123";
  mkdirSync(process.env.AIAND_HOME, { recursive: true });
  mkdirSync(process.env.AIAND_CONFIG_DIR, { recursive: true });
  // probe() resolves the auth command through PATH, so a hermetic `aiand`
  // launcher stands in for a real install: without it, a machine that has
  // no ai& on PATH (a bare CI box) reads every probe as inactive.
  plantStub(join(dir, "launcher"), "aiand");
  process.env.PATH = [join(dir, "launcher"), process.env.PATH].filter(Boolean).join(delimiter);
});

const { codexAdapter } = await import("../dist/agents/codex/adapter.js");
const { pickWindowsExecutable } = await import("../dist/cli/win-spawn.js");
const { CliError } = await import("../dist/cli/errors.js");
const { hasSnapshot, snapshotFiles } = await import("../dist/agents/snapshot.js");

const KIMI = "moonshotai/kimi-k3";
const GLM = "zai-org/glm-5.3";
const PLAIN = "google/gemma-4-31b-it";
const MINIMAL = "qwen/qwen3.8-27b";
const CATALOG = [
  catalogModel(GLM, { reasoning_efforts: ["none", "high", "xhigh"] }),
  catalogModel(KIMI, {
    reasoning_efforts: ["low", "high", "max"],
    reasoning_effort_default: "max",
  }),
  catalogModel(PLAIN),
  catalogModel(MINIMAL, {
    reasoning_efforts: ["low", "medium"],
    reasoning_effort_default: "medium",
  }),
];

const profilePath = () => join(process.env.AIAND_HOME, ".codex", "aiand.config.toml");
const readProfile = () => readFileSync(profilePath(), "utf8");
const seed = (text) => {
  mkdirSync(dirname(profilePath()), { recursive: true });
  writeFileSync(profilePath(), text);
};
const enableInput = (overrides = {}) =>
  baseEnableInput({
    model: GLM,
    catalog: CATALOG,
    baseUrl: "https://api.aiand.com",
    profileName: "default",
    ...overrides,
  });
const TRUST = '[projects."/work/app"]\ntrust_level = "trusted"\n';
const HAND_WRITTEN = `model = "${GLM}"
model_provider = "aiand"

[model_providers.aiand]
name = "ai&"
base_url = "https://api.aiand.com/v1"
wire_api = "responses"

[model_providers.aiand.auth]
command = "sh"
args = ["-c", "echo $AIAND_API_KEY"]
`;

beforeEach(() => {
  delete process.env.CODEX_HOME;
  rmSync(join(process.env.AIAND_HOME, ".codex"), { recursive: true, force: true });
  rmSync(join(process.env.AIAND_CONFIG_DIR, "snapshots", "codex"), {
    recursive: true,
    force: true,
  });
});

describe("codex on", () => {
  test("writes a profile that asks aiand for the key and turns hosted tools off", async () => {
    const result = await codexAdapter.enable(enableInput());
    const text = readProfile();
    assert.match(text, /^model = "zai-org\/glm-5\.3"$/m);
    assert.match(text, /^model_provider = "aiand"$/m);
    assert.match(text, /^web_search = "disabled"$/m);
    assert.match(text, /^base_url = "https:\/\/api\.aiand\.com\/v1"$/m);
    assert.match(text, /^wire_api = "responses"$/m);
    assert.match(text, /^http_headers = \{x-aiand-agent = "codex"\}$/m);
    // win32 records the resolved .cmd path, because Codex spawns the command
    // without a PATHEXT lookup (same assertion as scripts/e2e.mjs:415).
    assert.match(
      text,
      /^\[model_providers\.aiand\.auth\]\ncommand = "(?:aiand|.*\\aiand\.cmd)"\nargs = \["key", "export"\]$/m,
    );
    assert.match(text, /^in_app_browser = false\nview_image = false$/m);
    assert.doesNotMatch(text, /\[tools\]/);
    assert.match(text, /^image_generation = false$/m);
    assert.doesNotMatch(text, /sk-/, "no key in the file");
    assert.equal(result.model, GLM);
    assert.equal(result.catalogModel, GLM);
    assert.ok(result.warnings.some((w) => w.includes("codex --profile aiand")));
    assert.equal((await codexAdapter.probe()).active, true);
  });

  test("pins a published effort: high, else the model's default, else none at all", async () => {
    await codexAdapter.enable(enableInput({ model: KIMI, pinModel: true }));
    assert.match(readProfile(), /^model_reasoning_effort = "high"$/m, "high beats a max default");
    assert.match(readProfile(), /^plan_mode_reasoning_effort = "high"$/m);
    await codexAdapter.enable(enableInput({ model: MINIMAL, pinModel: true }));
    assert.match(readProfile(), /^model_reasoning_effort = "medium"$/m);
    await codexAdapter.enable(enableInput({ model: PLAIN, pinModel: true }));
    assert.doesNotMatch(readProfile(), /reasoning_effort/);
  });

  test("a re-on keeps the model and effort Codex's /model picked, and the trust tables", async () => {
    await codexAdapter.enable(enableInput());
    seed(
      `${readProfile()
        .replace(`model = "${GLM}"`, `model = "${KIMI}"`)
        .replace(/model_reasoning_effort = "high"/, 'model_reasoning_effort = "low"')
        .replace(
          /plan_mode_reasoning_effort = "high"/,
          'plan_mode_reasoning_effort = "max"',
        )}\n${TRUST}`,
    );
    const result = await codexAdapter.enable(enableInput());
    const text = readProfile();
    assert.equal(result.model, KIMI);
    assert.match(text, /^model_reasoning_effort = "low"$/m);
    assert.match(text, /^plan_mode_reasoning_effort = "max"$/m);
    assert.ok(text.includes(TRUST.trim()));
    assert.ok(!result.warnings.some((w) => w.includes("replaced")), "a pick is not an edit");
  });

  test("--model replaces the picked model", async () => {
    await codexAdapter.enable(enableInput());
    const result = await codexAdapter.enable(enableInput({ model: KIMI, pinModel: true }));
    assert.equal(result.model, KIMI);
    assert.match(readProfile(), /^model = "moonshotai\/kimi-k3"$/m);
  });

  test("native has no meaning for a profile and is refused", async () => {
    await assert.rejects(codexAdapter.enable(enableInput({ model: "native" })), CliError);
    assert.equal(existsSync(profilePath()), false);
  });

  test("a profile ai& did not write is refused unless --force", async () => {
    seed(HAND_WRITTEN);
    await assert.rejects(codexAdapter.enableGuard({ force: false }), /does not manage/);
    await codexAdapter.enableGuard({ force: true });
    await snapshotFiles("codex", [profilePath()]);
    await codexAdapter.enable(enableInput());
    assert.match(readProfile(), /command = "(?:aiand|.*\\aiand\.cmd)"/);
    const off = await codexAdapter.disable();
    assert.ok(off.notes.some((n) => n.includes("aiand restore codex --force")));
  });

  test("a taken-over profile's snapshot survives off, a later on and another off", async () => {
    seed(HAND_WRITTEN);
    await snapshotFiles("codex", [profilePath()]);
    await codexAdapter.enable(enableInput());
    await codexAdapter.disable();
    await codexAdapter.enable(enableInput());
    const off = await codexAdapter.disable();
    assert.equal(await hasSnapshot("codex"), true);
    assert.ok(off.notes.some((n) => n.includes("aiand restore codex --force")));
  });

  test("a snapshot of no file is discarded once off removes the profile", async () => {
    await snapshotFiles("codex", [profilePath()]);
    await codexAdapter.enable(enableInput());
    await codexAdapter.disable();
    assert.equal(await hasSnapshot("codex"), false);
  });

  test("a re-on rewrites only ai&'s keys; the user's own keys in the same tables stay", async () => {
    await codexAdapter.enable(enableInput());
    seed(
      readProfile()
        .replace(
          'web_search = "disabled"\n',
          'web_search = "disabled"\napproval_policy = "never"\n',
        )
        .replace("in_app_browser = false\n", "in_app_browser = false\nmy_flag = true\n"),
    );
    const result = await codexAdapter.enable(enableInput({ model: KIMI, pinModel: true }));
    const text = readProfile();
    assert.match(text, /^approval_policy = "never"$/m);
    assert.match(text, /^my_flag = true$/m);
    assert.match(text, /^model = "moonshotai\/kimi-k3"$/m);
    assert.ok(!result.warnings.some((w) => w.includes("replaced")), "their keys are not ours");
  });

  test("CODEX_HOME moves the profile", async () => {
    process.env.CODEX_HOME = join(process.env.AIAND_HOME, "elsewhere");
    await codexAdapter.enable(enableInput());
    assert.equal(existsSync(join(process.env.CODEX_HOME, "aiand.config.toml")), true);
    assert.deepEqual(codexAdapter.managedFiles(), [
      join(process.env.CODEX_HOME, "aiand.config.toml"),
    ]);
  });

  test("warns when an edit to ai&'s settings is rewritten", async () => {
    await codexAdapter.enable(enableInput());
    seed(readProfile().replace('wire_api = "responses"', 'wire_api = "chat"'));
    const result = await codexAdapter.enable(enableInput());
    assert.ok(result.warnings.some((w) => w.includes("replaced")));
    assert.match(readProfile(), /wire_api = "responses"/);
  });
});

describe("codex on, the profile's own shapes", () => {
  test("pins the aiand profile only when it is not the active one", async () => {
    await codexAdapter.enable(enableInput({ profileName: "work" }));
    assert.match(readProfile(), /^args = \["key", "export", "--profile", "work"\]$/m);
    await codexAdapter.enable(enableInput());
    assert.match(readProfile(), /^args = \["key", "export"\]$/m);
  });

  test("logging out another profile leaves a profile pinned to work alone", async () => {
    await codexAdapter.enable(enableInput({ profileName: "work" }));
    assert.equal((await codexAdapter.disable({ loggingOut: "default" })).stripped, false);
    assert.equal(existsSync(profilePath()), true);
    assert.equal((await codexAdapter.disable({ loggingOut: "work" })).stripped, true);
    assert.equal(existsSync(profilePath()), false);
  });

  test("a header with a trailing comment is not written twice", async () => {
    await codexAdapter.enable(enableInput());
    seed(readProfile().replace("[model_providers.aiand]\n", "[model_providers.aiand] # ai&\n"));
    await codexAdapter.enable(enableInput());
    assert.equal(readProfile().match(/^\[model_providers\.aiand\]/gm).length, 1);
  });

  test("a multi-line string keeps lines that look like keys or headers", async () => {
    const note = 'notes = """\nmodel = "mine"\n[custom]\n"""\n';
    seed(note);
    await codexAdapter.enable(enableInput());
    assert.ok(readProfile().includes(note));
    await codexAdapter.disable();
    assert.equal(readProfile(), note);
  });

  test("a root dotted key under an owned table moves into it, so the table is defined once", async () => {
    seed("features.my_flag = true\n");
    await codexAdapter.enable(enableInput());
    const text = readProfile();
    assert.doesNotMatch(text, /^features\./m);
    assert.match(text, /^\[features\]\n(?:.+\n)*my_flag = true$/m);
    assert.equal(text.match(/^\[features\]/gm).length, 1);
  });

  test("off keeps trust tables that were there before on, and drops Codex's", async () => {
    const mine = '[projects."/mine"]\ntrust_level = "untrusted"\n';
    seed(mine);
    await codexAdapter.enable(enableInput());
    seed(`${readProfile()}\n${TRUST}`);
    await codexAdapter.disable();
    assert.equal(readProfile(), mine);
  });

  test("on refuses to move while the profile is still on at another CODEX_HOME, and off finds it", async () => {
    await codexAdapter.enable(enableInput());
    const wired = profilePath();
    process.env.CODEX_HOME = join(process.env.AIAND_HOME, "elsewhere");
    await assert.rejects(codexAdapter.enableGuard({ force: true }), /Codex is on at/);
    assert.equal((await codexAdapter.disable()).stripped, true);
    assert.equal(existsSync(wired), false);
    await codexAdapter.enableGuard({ force: false });
  });

  test("warns for a model that publishes no reasoning levels", async () => {
    const result = await codexAdapter.enable(enableInput({ model: PLAIN, pinModel: true }));
    assert.ok(result.warnings.some((w) => w.includes("publishes no reasoning levels")));
  });
});

describe("codex off", () => {
  test("removes the profile, Codex's trust tables with it", async () => {
    await codexAdapter.enable(enableInput());
    seed(`${readProfile()}\n${TRUST}`);
    const off = await codexAdapter.disable();
    assert.equal(off.stripped, true);
    assert.equal(existsSync(profilePath()), false);
    assert.equal((await codexAdapter.probe()).active, false);
  });

  test("keeps tables the user added, dropping only ai&'s", async () => {
    await codexAdapter.enable(enableInput());
    seed(`${readProfile()}\n[mcp_servers.docs]\ncommand = "docs-mcp"\n`);
    const off = await codexAdapter.disable();
    assert.equal(readProfile(), '[mcp_servers.docs]\ncommand = "docs-mcp"\n');
    assert.ok(off.notes.some((n) => n.includes("kept your other settings")));
  });

  test("strips only ai&'s keys, and what is left is not refused by the next on", async () => {
    await codexAdapter.enable(enableInput());
    seed(
      readProfile().replace(
        'web_search = "disabled"\n',
        'web_search = "disabled"\napproval_policy = "never"\n',
      ),
    );
    await codexAdapter.disable();
    assert.equal(readProfile(), 'approval_policy = "never"\n');
    await codexAdapter.enableGuard({ force: false });
    await codexAdapter.enable(enableInput());
    assert.match(readProfile(), /^approval_policy = "never"$/m);
    assert.equal((await codexAdapter.probe()).active, true);
  });

  test("strips everything but the ai& keys you edited, so the profile no longer routes", async () => {
    await codexAdapter.enable(enableInput());
    seed(
      readProfile().replace(
        'base_url = "https://api.aiand.com/v1"',
        'base_url = "https://api.aiand.com/v1/"',
      ),
    );
    const off = await codexAdapter.disable();
    assert.equal(off.stripped, true);
    assert.ok(
      off.notes.some((n) => n.includes("left base_url") && n.includes("because you edited it")),
    );
    assert.equal(
      readProfile(),
      '[model_providers.aiand]\nbase_url = "https://api.aiand.com/v1/"\n',
    );
    assert.equal((await codexAdapter.probe()).active, false);
    assert.equal((await codexAdapter.disable()).stripped, false);
  });

  test("a model picked in Codex is not an edit", async () => {
    await codexAdapter.enable(enableInput());
    seed(readProfile().replace(`model = "${GLM}"`, `model = "${KIMI}"`));
    assert.equal((await codexAdapter.disable()).stripped, true);
  });

  test("leaves a profile ai& did not write alone", async () => {
    seed(HAND_WRITTEN);
    assert.equal((await codexAdapter.disable()).stripped, false);
    assert.equal(readProfile(), HAND_WRITTEN);
  });
});

describe("codex status and keys", () => {
  test("probe needs the marker and an https base URL", async () => {
    seed(HAND_WRITTEN);
    assert.deepEqual(await codexAdapter.probe(), { active: false, model: null });
    await codexAdapter.enable(enableInput({ model: KIMI, pinModel: true }));
    assert.deepEqual(await codexAdapter.probe(), { active: true, model: KIMI });
    seed(readProfile().replace("https://api.aiand.com/v1", "http://api.aiand.com/v1"));
    assert.equal((await codexAdapter.probe()).active, false);
  });

  test("a Windows absolute path to aiand.cmd still marks the profile as ours", async () => {
    await codexAdapter.enable(enableInput());
    seed(
      readProfile().replace(
        'command = "aiand"',
        'command = "C:\\\\Users\\\\me\\\\.local\\\\bin\\\\aiand.cmd"',
      ),
    );
    assert.equal((await codexAdapter.probe()).active, true);
  });

  test("on Windows, the shim Codex can spawn wins over the extensionless launcher", () => {
    const where = "C:\\Users\\me\\.local\\bin\\aiand\r\nC:\\Users\\me\\.local\\bin\\aiand.cmd\r\n";
    const env = { PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    assert.equal(pickWindowsExecutable(where, env), "C:\\Users\\me\\.local\\bin\\aiand.cmd");
    assert.equal(pickWindowsExecutable("", env), null);
  });

  test("a trailing comment on a key line keeps the profile ours", async () => {
    await codexAdapter.enable(enableInput());
    seed(readProfile().replace('command = "aiand"', 'command = "aiand"  # mine'));
    assert.equal((await codexAdapter.probe()).active, true);
  });

  test("other auth args than the ones on writes read as someone else's profile", async () => {
    await codexAdapter.enable(enableInput());
    seed(readProfile().replace(/^args = .*$/m, 'args = ["key", "export", "--all"]'));
    assert.equal((await codexAdapter.probe()).active, false);
    await assert.rejects(codexAdapter.enableGuard({ force: false }), /does not manage/);
  });

  test("there is no key to refresh", async () => {
    await codexAdapter.enable(enableInput());
    assert.equal(await codexAdapter.refreshKey({ apiKey: "sk-test-new" }), false);
  });
});

describe("codex sessionLaunch", () => {
  test("carries the settings as -c overrides and writes nothing", async () => {
    const launch = await codexAdapter.sessionLaunch({
      apiKey: "sk-test-launch",
      model: KIMI,
      catalog: CATALOG,
      baseUrl: "https://api.aiand.com",
      profileName: "work",
    });
    assert.deepEqual(launch.env, { AIAND_API_KEY: "sk-test-launch" });
    const overrides = launch.args.filter((_, i) => i % 2 === 1);
    assert.ok(launch.args.filter((_, i) => i % 2 === 0).every((flag) => flag === "-c"));
    assert.ok(overrides.includes(`model="${KIMI}"`));
    assert.ok(overrides.includes('model_reasoning_effort="high"'));
    assert.ok(overrides.includes('plan_mode_reasoning_effort="high"'));
    assert.ok(overrides.includes('model_provider="aiand"'));
    assert.ok(
      overrides.includes(
        `model_providers.aiand={name = "ai&", base_url = "https://api.aiand.com/v1", wire_api = "responses", http_headers = {x-aiand-agent = "codex"}, auth = {command = ${JSON.stringify(process.execPath)}, args = ${JSON.stringify([process.argv[1], "key", "export", "--profile", "work"]).replaceAll(",", ", ")}}}`,
      ),
    );
    assert.ok(overrides.includes("features.image_generation=false"));
    assert.ok(!launch.args.join(" ").includes("sk-"), "the key never rides in argv");
    assert.equal(existsSync(profilePath()), false);
  });

  test("hands no key over when the session came from a stored login", async () => {
    const saved = process.env.AIAND_API_KEY;
    delete process.env.AIAND_API_KEY;
    try {
      const launch = await codexAdapter.sessionLaunch({
        apiKey: "sk-test-stored",
        model: KIMI,
        catalog: CATALOG,
        profileName: "default",
      });
      assert.deepEqual(launch.env, {});
    } finally {
      process.env.AIAND_API_KEY = saved;
    }
  });
});
