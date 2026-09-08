import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test, { describe } from "node:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { withTestEnv, catalogModel } from "./helpers.mjs";

let nativeHome;
const env = withTestEnv("aiand-hermes-test-", (dir) => {
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_HOME = join(dir, "home");
  nativeHome = join(dir, "home", ".hermes");
  delete process.env.AIAND_API_KEY;
  // Keep any outer HERMES_HOME out of the picture; tests set it explicitly.
  delete process.env.HERMES_HOME;
});
const home = () => process.env.AIAND_HOME;

const BASE_KEY = "sk-test-hermes-key-not-real";
const MODEL = "zai-org/glm-5.3";
const SECOND_MODEL = "zai-org/glm-flash";

/** Fixture Model[] in the live catalog shape. */
function catalogModels() {
  return [
    catalogModel(MODEL, {
      name: "GLM 5.3",
      context_window: 128000,
      capabilities: ["chat", "vision"],
      input: "0.60",
      output: "1.20",
      cached_input_per_1m: "0.30",
      owned_by: "zai-org",
      provider: "zai-org",
      created: 1,
    }),
    catalogModel(SECOND_MODEL, {
      name: "GLM Flash",
      context_window: 64000,
      capabilities: ["chat"],
      input: "0.20",
      output: "0.40",
      owned_by: "zai-org",
      provider: "zai-org",
      created: 1,
    }),
  ];
}
const { hermesAdapter } = await import("../dist/agents/hermes.js");


/** Plant a native Hermes home with the items the acceptance list expects. */
function plantNativeHome() {
  mkdirSync(join(nativeHome, "sessions"), { recursive: true });
  mkdirSync(join(nativeHome, "plugins", "model-providers", "other"), { recursive: true });
  writeFileSync(join(nativeHome, ".env"), "SOME_OTHER=1\n");
  writeFileSync(join(nativeHome, "active_profile"), "default\n");
  writeFileSync(join(nativeHome, "auth.json"), '{"token":"secret"}\n');
  writeFileSync(join(nativeHome, "sessions", "one.json"), '{"id":1}\n');
  writeFileSync(join(nativeHome, "plugins", "model-providers", "other", "plugin.yaml"), "k\n");
  writeFileSync(join(nativeHome, "config.yaml"), "base:\n  dir: /tmp\n");
}

const launchInput = (overrides = {}) => ({
  apiKey: BASE_KEY,
  model: MODEL,
  catalog: catalogModels(),
  ...overrides,
});

describe("hermes adapter shape", () => {
  test("launcherOnly is true and managedFiles is empty", () => {
    assert.equal(hermesAdapter.launcherOnly, true);
    assert.deepEqual(hermesAdapter.managedFiles(), []);
  });

  test("probe reads nothing and reports inactive", async () => {
    const probe = await hermesAdapter.probe();
    assert.deepEqual(probe, { active: false, model: null });
  });

  test("detect resolves the hermes binary via INSTALL_HINTS", () => {
    // INSTALL_HINTS.hermes carries the canonical install command/url.
    assert.equal(hermesAdapter.bin, "hermes");
    assert.match(hermesAdapter.install.url, /hermes/);
  });
});


describe("hermes sessionLaunch", () => {
  test("builds an overlay with symlinked state, no credential symlinks, patched config and plugin", async () => {
    plantNativeHome();
    const launch = await hermesAdapter.sessionLaunch(launchInput());
    const overlay = launch.env.HERMES_HOME;
    assert.ok(existsSync(overlay), "overlay dir exists");
    assert.ok(!overlay.startsWith(nativeHome), "overlay is a fresh temp dir, not the native home");
    assert.notEqual(overlay, nativeHome);

    try {
      // env per spec
      assert.equal(launch.env.HERMES_HOME, overlay);
      assert.equal(launch.env.AIAND_HERMES_API_KEY, BASE_KEY);
      assert.equal(launch.env.AIAND_HERMES_BASE_URL, "https://api.aiand.com/v1");
      assert.equal(launch.env.HERMES_MODEL, MODEL);
      assert.equal(launch.env.HERMES_INFERENCE_MODEL, MODEL);
      assert.equal(launch.env.HERMES_INFERENCE_PROVIDER, "aiand");
      assert.equal(launch.env.HERMES_TUI_PROVIDER, "aiand");
      assert.equal(launch.env.AIAND_API_KEY, BASE_KEY);
      assert.deepEqual(launch.clear, []);

      // args: provider/model baked, no overrides
      assert.deepEqual(launch.args, ["--provider", "aiand", "--model", MODEL]);

      // sessions dir is symlinked back (real state stays native/resumable)
      const sessionsLink = join(overlay, "sessions");
      assert.ok(existsSync(sessionsLink), "sessions linked into overlay");
      assert.ok(lstatSync(sessionsLink).isSymbolicLink(), "sessions is a symlink");
      assert.equal(readlinkSync(sessionsLink), join(nativeHome, "sessions"));

      // credential-shaped native entries are NOT symlinked; .env is our fresh
      // write (asserted below), active_profile/auth.json are excluded entirely
      const overlayEntries = new Set(readdirSync(overlay));
      assert.ok(!lstatSync(join(overlay, ".env")).isSymbolicLink(), ".env is our fresh file");
      assert.ok(!overlayEntries.has("active_profile"), "active_profile not linked");
      assert.ok(!overlayEntries.has("auth.json"), "auth.json not linked");

      // overlay .env is a fresh file with our two vars, mode 0600
      const envText = readFileSync(join(overlay, ".env"), "utf8");
      assert.match(envText, new RegExp(`AIAND_HERMES_API_KEY=${JSON.stringify(BASE_KEY)}`));
      assert.match(
        envText,
        new RegExp(`AIAND_HERMES_BASE_URL=${JSON.stringify("https://api.aiand.com/v1")}`)
      );
      assert.doesNotMatch(envText, /SOME_OTHER/, "native env content is not copied in");
      assert.equal(statSync(join(overlay, ".env")).mode & 0o777, 0o600);

      // config.yaml carries the aiand provider block
      const configText = readFileSync(join(overlay, "config.yaml"), "utf8");
      assert.match(configText, /providers:/);
      assert.match(configText, /aiand:/);
      assert.match(configText, /base_url: https:\/\/api\.aiand\.com\/v1/);
      assert.match(configText, /key_env: AIAND_HERMES_API_KEY/);
      assert.match(configText, /default_model: zai-org\/glm-5\.3/);
      assert.match(configText, /- zai-org\/glm-flash/);

      // other plugin dir linked, aiand plugin dir is our fresh one
      const mp = join(overlay, "plugins", "model-providers");
      assert.ok(lstatSync(join(mp, "other")).isSymbolicLink(), "other provider linked");
      assert.ok(
        !lstatSync(join(mp, "aiand")).isSymbolicLink(),
        "aiand provider is our own dir, not a link"
      );

      // plugin __init__.py is valid Python and registers an aiand profile
      const pluginPy = join(mp, "aiand", "__init__.py");
      assert.ok(existsSync(pluginPy), "plugin __init__.py written");
      assert.ok(existsSync(join(mp, "aiand", "plugin.yaml")), "plugin.yaml written");
      const py = readFileSync(pluginPy, "utf8");
      assert.match(py, /register_provider\(aiand\)/);
      assert.match(py, /api_mode="chat_completions"/);
      assert.match(py, /env_vars=\("AIAND_HERMES_API_KEY", "AIAND_HERMES_BASE_URL"\)/);
      assert.match(py, /supports_vision=True/);
      const pyCheck = spawnSync("python3", ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], {
        input: py,
      });
      assert.equal(pyCheck.status, 0, `python3 failed to parse plugin: ${pyCheck.stderr}`);
    } finally {
      await launch.cleanup();
    }

    assert.ok(!existsSync(overlay), "cleanup removes the overlay");
  });

  test("resolves model from the catalog when input.model is undefined", async () => {
    const launch = await hermesAdapter.sessionLaunch(
      launchInput({ model: undefined })
    );
    try {
      assert.ok(launch.env.HERMES_MODEL, "a model is baked");
      assert.equal(launch.env.HERMES_MODEL, launch.args[launch.args.length - 1]);
      assert.equal(launch.env.HERMES_MODEL, MODEL, "default resolves from catalog");
    } finally {
      await launch.cleanup();
    }
  });

  test("handles a native home with no entries at all", async () => {
    const launch = await hermesAdapter.sessionLaunch(launchInput());
    const overlay = launch.env.HERMES_HOME;
    try {
      assert.ok(existsSync(join(overlay, ".env")));
      assert.ok(existsSync(join(overlay, "config.yaml")));
      assert.ok(existsSync(join(overlay, "plugins", "model-providers", "aiand", "__init__.py")));
    } finally {
      await launch.cleanup();
    }
    assert.ok(!existsSync(overlay), "cleanup removes the empty-home overlay");
  });

  test("replaces an existing aiand block in config.yaml instead of duplicating", async () => {
    writeFileSync(
      join(nativeHome, "config.yaml"),
      "providers:\n  anthropic:\n    name: acme\n  aiand:\n    name: old\n    default_model: old-model\nbase:\n  dir: /x\n"
    );
    const launch = await hermesAdapter.sessionLaunch(launchInput());
    const overlay = launch.env.HERMES_HOME;
    try {
      const configText = readFileSync(join(overlay, "config.yaml"), "utf8");
      const aiandCount = (configText.match(/aiand:/g) || []).length;
      assert.equal(aiandCount, 1, "exactly one aiand provider block");
      assert.match(configText, /default_model: zai-org\/glm-5\.3/);
      assert.doesNotMatch(configText, /name: old/);
      // sibling anthropic provider preserved
      assert.match(configText, /anthropic:/);
      assert.match(configText, /name: acme/);
    } finally {
      await launch.cleanup();
    }
  });

  test("cleanup never throws and is idempotent", async () => {
    const launch = await hermesAdapter.sessionLaunch(launchInput());
    await launch.cleanup();
    await launch.cleanup(); // second call is a no-op, must not reject
  });
});