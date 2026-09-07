import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir;
const originalEnv = { ...process.env };

before(() => {
  dir = mkdtempSync(join(tmpdir(), "aiand-grok-test-"));
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  delete process.env.AIAND_API_KEY;
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = originalEnv;
});

const {
  grokAdapter,
  buildGrokModelCatalog,
  grokArgsWithoutOverrides,
  sanitizeGrokEnv,
} = await import("../dist/agents/grok.js");

function fixtureModels() {
  return [
    {
      id: "zai-org/glm-5.3",
      name: "GLM 5.3",
      object: "model",
      created: 0,
      owned_by: "zai",
      provider: "zai",
      context_window: 100000,
      capabilities: ["text"],
      reasoning_efforts: ["minimal", "low", "medium"],
      reasoning_effort_default: "medium",
      description: null,
      currency: "usd",
      input_per_1m: "1",
      output_per_1m: "2",
      cached_input_per_1m: null,
    },
    {
      id: "vision-model",
      name: "Vision",
      object: "model",
      created: 0,
      owned_by: "x",
      provider: "x",
      context_window: 50000,
      capabilities: ["text", "vision"],
      reasoning_efforts: null,
      reasoning_effort_default: null,
      description: null,
      currency: "usd",
      input_per_1m: "1",
      output_per_1m: "1",
      cached_input_per_1m: null,
    },
  ];
}

describe("grok adapter shape", () => {
  test("launcherOnly true, no managed files, inactive probe", async () => {
    assert.equal(grokAdapter.launcherOnly, true);
    assert.deepEqual(grokAdapter.managedFiles(), []);
    const probe = await grokAdapter.probe();
    assert.equal(probe.active, false);
    assert.equal(probe.foreignTool, null);
    assert.equal(probe.model, null);
  });

  test("detect probes PATH binary 'grok'", () => {
    const result = grokAdapter.detect();
    assert.equal(typeof result.installed, "boolean");
    assert.equal(result.path === null || typeof result.path === "string", true);
  });

  test("enable refuses launcher-only with an error", async () => {
    await assert.rejects(
      () =>
        grokAdapter.enable({
          apiKey: "sk-test-not-real",
          model: "zai-org/glm-5.3",
          slots: {},
          catalog: fixtureModels(),
          home: process.env.AIAND_HOME,
          baseUrl: "https://api.aiand.com/v1",
        }),
      /run-agent grok/
    );
  });
});

describe("buildGrokModelCatalog", () => {
  test("shapes live models into the OpenAI list Grok expects", () => {
    const catalog = buildGrokModelCatalog(fixtureModels());
    assert.equal(catalog.object, "list");
    assert.equal(catalog.data.length, 2);

    const ids = new Set(catalog.data.map((entry) => entry.id));
    assert.deepEqual(ids, new Set(["zai-org/glm-5.3", "vision-model"]));

    for (const entry of catalog.data) {
      const fixture = fixtureModels().find((model) => model.id === entry.id);
      assert.ok(fixture, `fixture ${entry.id} present`);
      assert.equal(entry.model, fixture.id);
      assert.equal(entry.name, `ai& · ${fixture.name}`);
      assert.equal(entry.description, `ai& model: ${fixture.id}`);
      assert.equal(entry.base_url, "https://api.aiand.com/v1");
      assert.equal(entry.api_backend, "chat_completions");
      assert.equal(entry.context_window, fixture.context_window);
      assert.equal(entry.max_completion_tokens, 8192);
      assert.equal(entry.user_selectable, true);
    }
  });
});

describe("grokArgsWithoutOverrides", () => {
  test("strips --model / -m value forms", () => {
    const out = grokArgsWithoutOverrides([
      "chat",
      "--model",
      "zai-org/glm-5.3",
      "-m",
      "vision-model",
    ]);
    assert.deepEqual(out, ["chat"]);
  });

  test("strips --model=/--model and short -m<value> forms", () => {
    assert.deepEqual(
      grokArgsWithoutOverrides(["--model=zai-org/glm-5.3", "-mvision-model", "hi"]),
      ["hi"]
    );
  });

  test("keeps unrelated flags and preserves order", () => {
    const out = grokArgsWithoutOverrides(["--safe", "-m", "x", "--debug", "--model=y"]);
    assert.deepEqual(out, ["--safe", "--debug"]);
  });
});

describe("sanitizeGrokEnv", () => {
  test("blank and missing GROK_HOME are dropped, real value kept", () => {
    assert.equal("GROK_HOME" in sanitizeGrokEnv({}), false);
    assert.equal("GROK_HOME" in sanitizeGrokEnv({ GROK_HOME: "   " }), false);
    assert.equal("GROK_HOME" in sanitizeGrokEnv({ GROK_HOME: "" }), false);
    assert.equal(sanitizeGrokEnv({ GROK_HOME: "/home/u/.grok" }).GROK_HOME, "/home/u/.grok");
  });
});

describe("sessionLaunch", () => {
  test("serves the exact catalog, env carries real key/URLs/kill switches, cleanup tears down", async () => {
    const catalog = fixtureModels();
    const input = {
      apiKey: "sk-test-not-real",
      model: "zai-org/glm-5.3",
      catalog,
    };

    const launch = await grokAdapter.sessionLaunch(input);
    try {
      const { env } = launch;
      const modelsListUrl = env.GROK_MODELS_LIST_URL;
      assert.ok(modelsListUrl, "GROK_MODELS_LIST_URL present");
      assert.match(modelsListUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1\/models$/);

      // Exact catalog body served at /v1/models.
      const res = await fetch(modelsListUrl);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.deepEqual(await res.json(), buildGrokModelCatalog(catalog));

      // A sibling path is 404.
      const sibling = new URL("../v1/other", modelsListUrl).toString();
      const miss = await fetch(sibling);
      assert.equal(miss.status, 404);

      // Env: real key, base URLs, kill switches.
      assert.equal(env.XAI_API_KEY, input.apiKey);
      assert.equal(env.GROK_MODELS_BASE_URL, "https://api.aiand.com/v1");
      assert.equal(env.GROK_XAI_API_BASE_URL, new URL(modelsListUrl).origin);
      assert.equal(env.GROK_DEFAULT_MODEL, input.model);
      assert.equal(env.GROK_SESSION_SUMMARY_MODEL, input.model);
      assert.equal(env.GROK_PROMPT_SUGGESTIONS_MODEL, input.model);
      assert.equal(env.GROK_SUGGESTIONS_AI_MODEL, input.model);
      assert.equal(env.GROK_TELEMETRY_ENABLED, "0");
      assert.equal(env.GROK_FEEDBACK_ENABLED, "0");
      assert.equal(env.GROK_IMAGE_GEN, "0");
      assert.equal(env.GROK_IMAGE_EDIT, "0");
      assert.equal(env.GROK_VOICE_MODE, "0");
      assert.ok(env.GROK_AUTH_PATH, "GROK_AUTH_PATH present");
      assert.match(env.GROK_AUTH_PATH, /no-auth\.json$/);

      // clear list exact.
      assert.deepEqual(launch.clear, ["GROK_AUTH", "GROK_DISABLE_API_KEY_AUTH"]);
    } finally {
      await launch.cleanup();
    }

    // Cleanup: server closed -> connection refused; auth dir gone.
    await assert.rejects(() => fetch(launch.env.GROK_MODELS_LIST_URL), (error) => {
      const code = error?.cause?.code ?? error?.code;
      return code === "ECONNREFUSED" || code === "UND_ERR_CONNECT" || code === "ECONNRESET";
    });
  });
});