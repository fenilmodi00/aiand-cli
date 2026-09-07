import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { foreignMarkerFixtures } from "../dist/agents/foreign.js";

let dir;
const originalEnv = { ...process.env };

const BASE_KEY = "sk-test-key-for-prime-adapter-slice-20";
const PRIME_BASE_URL = "https://api.aiand.com/v1";

before(() => {
  dir = mkdtempSync(join(tmpdir(), "aiand-prime-test-"));
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_HOME = join(dir, "home");
  delete process.env.AIAND_API_KEY;
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = originalEnv;
});

const { primeAdapter } = await import("../dist/agents/prime.js");

/** A fixture Model with the full catalog shape (prices as per-1M USD strings). */
function model(overrides = {}) {
  return {
    id: "zai-org/glm-5.3",
    name: "GLM 5.3",
    object: "model",
    created: 1,
    owned_by: "zai",
    provider: "zai",
    context_window: 131072,
    capabilities: ["tool", "vision"],
    reasoning_efforts: ["low", "medium", "high"],
    reasoning_effort_default: "medium",
    description: null,
    currency: "usd",
    input_per_1m: "0.60",
    output_per_1m: "1.20",
    cached_input_per_1m: "0.15",
    ...overrides,
  };
}

function enableInput(overrides = {}) {
  return {
    apiKey: BASE_KEY,
    model: "zai-org/glm-5.3",
    slots: {},
    catalog: [model(), model({ id: "zai-org/other", name: "Other", reasoning_efforts: null })],
    home: process.env.AIAND_HOME,
    baseUrl: "https://api.aiand.com",
    ...overrides,
  };
}

const primeDir = () => join(process.env.AIAND_CONFIG_DIR, "agents", "prime");
const modelsPath = () => join(primeDir(), "models.json");

const isWin = () => process.platform === "win32";

describe("prime enable", () => {
  test("creates dir (0700) + models.json (0600) with a catalog-shaped provider entry", async () => {
    const result = await primeAdapter.enable(enableInput());
    assert.deepEqual(result.filesWritten, [modelsPath()]);
    assert.equal(result.model, "zai-org/glm-5.3");

    assert.equal(statSync(primeDir()).isDirectory(), true);
    if (!isWin()) assert.equal(statSync(primeDir()).mode & 0o777, 0o700);
    if (!isWin()) assert.equal(statSync(modelsPath()).mode & 0o777, 0o600);

    const written = JSON.parse(readFileSync(modelsPath(), "utf8"));
    const provider = written.providers.aiand;
    assert.equal(provider.baseUrl, PRIME_BASE_URL);
    assert.equal(provider.api, "openai-completions");
    assert.equal(provider.models.length, 2);

    const first = provider.models[0];
    assert.equal(first.id, "zai-org/glm-5.3");
    assert.equal(first.name, "GLM 5.3");
    assert.equal(first.reasoning, true);
    assert.deepEqual(first.input, ["text", "image"]);
    assert.equal(first.contextWindow, 131072);
    assert.equal(first.maxTokens, 16384);
    assert.deepEqual(first.cost, { input: 0.6, output: 1.2, cacheRead: 0.15, cacheWrite: 0 });

    const second = provider.models[1];
    assert.equal(second.reasoning, false);
    assert.deepEqual(second.input, ["text"]);
  });

  test("enable is idempotent and never touches the user agent config dir", async () => {
    await primeAdapter.enable(enableInput());
    await primeAdapter.enable(enableInput({ apiKey: `${BASE_KEY}-2` }));
    const written = JSON.parse(readFileSync(modelsPath(), "utf8"));
    // apiKey is not persisted into models.json (the session carries it), so a
    // re-`on` produces the same bytes.
    assert.equal(written.providers.aiand.models.length, 2);

    const userPrimeDir = join(process.env.AIAND_HOME, ".prime");
    assert.equal(existsSync(userPrimeDir), false);
  });
});

describe("prime probe", () => {
  test("inactive when nothing is wired, then active after enable", async () => {
    // The fixture HOME is shared across tests, so start this one clean.
    rmSync(primeDir(), { recursive: true, force: true });
    const inactive = await primeAdapter.probe();
    assert.equal(inactive.active, false);
    assert.equal(inactive.model, null);

    await primeAdapter.enable(enableInput());
    const active = await primeAdapter.probe();
    assert.equal(active.active, true);
    assert.equal(active.model, null);
    assert.equal(active.foreignTool, null);
  });

  test("inactive when models.json has a non-gateway base url", async () => {
    mkdirSync(primeDir(), { recursive: true });
    writeFileSync(
      modelsPath(),
      JSON.stringify({ providers: { aiand: { baseUrl: "https://elsewhere.example/v1" } } })
    );
    const res = await primeAdapter.probe();
    assert.equal(res.active, false);
    assert.equal(res.foreignTool, null);
  });

  test("inactive on a broken models.json (probe never crashes)", async () => {
    mkdirSync(primeDir(), { recursive: true });
    writeFileSync(modelsPath(), "{ not valid json");
    const res = await primeAdapter.probe();
    assert.equal(res.active, false);
    assert.equal(res.foreignTool, null);
  });
});

describe("prime foreign detection", () => {
  test("planted foreign markers in models.json report foreignTool before enable clears them", async () => {
    // Plant another setup tool's signature INTO our models.json (the file
    // probe reads). detectForeign scans managedFiles() and must surface it.
    const foreign = foreignMarkerFixtures().codexConfig;
    mkdirSync(primeDir(), { recursive: true });
    writeFileSync(modelsPath(), foreign);

    const res = await primeAdapter.probe();
    assert.equal(res.active, false);
    assert.ok(res.foreignTool, "foreign tool detected before enable");

    // A normal enable rewrites models.json with our clean bytes; the foreign
    // signature is gone and probe reports none.
    await primeAdapter.enable(enableInput());
    const clean = await primeAdapter.probe();
    assert.equal(clean.active, true);
    assert.equal(clean.foreignTool, null);
  });
});

describe("prime disable", () => {
  test("removes the whole agents/prime dir", async () => {
    await primeAdapter.enable(enableInput());
    assert.equal(existsSync(primeDir()), true);

    await primeAdapter.disable();
    assert.equal(existsSync(primeDir()), false);
    assert.equal(existsSync(modelsPath()), false);
  });
});

describe("prime session launch", () => {
  test("env carries the coding-agent dir plus the real session key", async () => {
    const launch = await primeAdapter.sessionLaunch({
      apiKey: BASE_KEY,
      model: "zai-org/glm-5.3",
      catalog: [model()],
    });
    assert.equal(launch.env.PRIME_AGENT_CODING_AGENT_DIR, primeDir());
    assert.equal(launch.env.AIAND_API_KEY, BASE_KEY);
    assert.deepEqual(launch.clear, []);
    assert.equal(launch.cleanup, undefined, "nothing ephemeral to clean up");
  });

  test("sessionLaunch ensures the dir exists even without a prior enable", async () => {
    await primeAdapter.disable();
    await primeAdapter.sessionLaunch({ apiKey: BASE_KEY, model: undefined, catalog: [model()] });
    assert.equal(statSync(primeDir()).isDirectory(), true);
    if (!isWin()) assert.equal(statSync(primeDir()).mode & 0o777, 0o700);
  });
});