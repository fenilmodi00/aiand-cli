import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { withTestEnv, catalogModel } from "./helpers.mjs";

withTestEnv("aiand-grok-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  delete process.env.AIAND_API_KEY;
});

const {
  grokAdapter,
  buildGrokModelCatalog,
  sanitizeGrokEnv,
} = await import("../dist/agents/grok.js");


function fixtureModels() {
  return [
    catalogModel("zai-org/glm-5.3", {
      name: "GLM 5.3",
      context_window: 100000,
      capabilities: ["text"],
      reasoning_efforts: ["minimal", "low", "medium"],
      reasoning_effort_default: "medium",
      owned_by: "zai",
      provider: "zai",
    }),
    catalogModel("vision-model", {
      name: "Vision",
      context_window: 50000,
      capabilities: ["text", "vision"],
      owned_by: "x",
      provider: "x",
    }),
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

describe("sanitizeGrokEnv", () => {
  test("blank and missing GROK_HOME are dropped, real value kept", () => {
    assert.equal("GROK_HOME" in sanitizeGrokEnv({}), false);
    assert.equal("GROK_HOME" in sanitizeGrokEnv({ GROK_HOME: "   " }), false);
    assert.equal("GROK_HOME" in sanitizeGrokEnv({ GROK_HOME: "" }), false);
    assert.equal(sanitizeGrokEnv({ GROK_HOME: "~u/.grok" }).GROK_HOME, "~u/.grok");
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
    const { env } = launch;
    try {
      const modelsListUrl = env.GROK_MODELS_LIST_URL;
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


    // Cleanup: the auth dir is gone and the server no longer accepts
    // connections. Assert the observable teardown (dir removed, any fetch
    // attempt fails) rather than a specific undici error code — after
    // server.close() a keep-alive agent can surface several distinct errors
    // (ECONNREFUSED, UND_ERR_CONNECT, "other side closed" on a racing
    // keep-alive socket), all of which prove the listener is gone.
    assert.equal(existsSync(dirname(env.GROK_AUTH_PATH)), false, "auth dir removed");
    let fetchFailed = false;
    try {
      await fetch(launch.env.GROK_MODELS_LIST_URL);
    } catch {
      fetchFailed = true;
    }
    assert.equal(fetchFailed, true, "fetch after cleanup must fail");
  });
});