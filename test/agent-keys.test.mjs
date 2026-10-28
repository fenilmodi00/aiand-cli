import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { withTestEnv } from "./helpers.mjs";

withTestEnv("aiand-agent-keys-test-", (dir) => {
  process.env.AIAND_CONFIG_DIR = dir;
  delete process.env.AIAND_API_KEY;
});

const {
  agentForMaskedKey,
  buildHarnessIndex,
  collectBakedKeys,
  forgetAgentKeys,
  listAgentKeys,
  maskKey,
  recordAgentKey,
  resolveHarness,
} = await import("../dist/api/agent-keys.js");

describe("maskKey", () => {
  test("masks the way the gateway does", () => {
    // A synthetic key shaped like the gateway's: 7 leading characters, an
    // ellipsis, and the last 4. A real key never belongs in a test.
    assert.equal(
      maskKey("sk-test-1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff77779953"),
      "sk-test...9953",
    );
  });

  test("leaves a short key alone", () => {
    assert.equal(maskKey("sk-short"), "sk-short");
  });
});

describe("recordAgentKey", () => {
  test("remembers the agent for a key", async () => {
    await recordAgentKey(
      "claude",
      "sk-test-1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff77779953",
    );
    assert.equal(agentForMaskedKey("sk-test...9953"), "claude");
  });

  test("re-recording the same key does not duplicate it", async () => {
    await recordAgentKey(
      "codex",
      "sk-test-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    await recordAgentKey(
      "codex",
      "sk-test-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    const records = listAgentKeys().filter((r) => r.agent === "codex");
    assert.equal(records.length, 1);
  });

  test("two agents can hold two different keys", async () => {
    await recordAgentKey(
      "claude",
      "sk-test-1111111111111111111111111111111111111111111111111111111111111111",
    );
    await recordAgentKey(
      "codex",
      "sk-test-2222222222222222222222222222222222222222222222222222222222222222",
    );
    assert.equal(agentForMaskedKey("sk-test...1111"), "claude");
    assert.equal(agentForMaskedKey("sk-test...2222"), "codex");
  });

  // A key init baked into several agents (one sign-in, many harnesses) is
  // genuinely ambiguous per request — the gateway identifies only the key.
  // Attribution must say "shared", not confidently claim the first agent.
  test("a key held by several agents resolves to shared, not the first agent", async () => {
    const shared = "sk-test-shared-7777777777777777777777777777777777777777777777";
    await recordAgentKey("claude", shared);
    await recordAgentKey("codex", shared);
    assert.equal(agentForMaskedKey(maskKey(shared)), "shared");

    const solo = "sk-test-solo-8888888888888888888888888888888888888888888888888";
    await recordAgentKey("omp", solo);
    assert.equal(agentForMaskedKey(maskKey(solo)), "omp");
  });

  test("forgetting an agent drops only its keys", async () => {
    await recordAgentKey(
      "claude",
      "sk-test-3333333333333333333333333333333333333333333333333333333333333333",
    );
    await recordAgentKey(
      "codex",
      "sk-test-4444444444444444444444444444444444444444444444444444444444444444",
    );
    const before = listAgentKeys().filter((r) => r.agent === "claude").length;
    const removed = await forgetAgentKeys("claude");
    assert.equal(removed, before);
    assert.equal(agentForMaskedKey("sk-test...3333"), undefined);
    assert.equal(agentForMaskedKey("sk-test...4444"), "codex");
  });

  test("a missing map file reads as no keys", async () => {
    // forgetAgentKeys on an empty map removes nothing and does not throw.
    assert.equal(await forgetAgentKeys("never-wired"), 0);
  });
});

describe("collectBakedKeys", () => {
  test("reads the key each wired agent carries", async () => {
    const adapters = [
      {
        id: "claude",
        bakedKey: async () =>
          "sk-test-5555555555555555555555555555555555555555555555555555555555555555",
      },
      { id: "codex" },
      { id: "pi", bakedKey: async () => null },
    ];
    const records = await collectBakedKeys(adapters);
    assert.equal(records.length, 1);
    assert.equal(records[0].agent, "claude");
    assert.equal(records[0].masked, "sk-test...5555");
  });

  test("an adapter that throws is skipped, not fatal", async () => {
    const adapters = [
      {
        id: "claude",
        bakedKey: async () =>
          "sk-test-6666666666666666666666666666666666666666666666666666666666666666",
      },
      {
        id: "broken",
        bakedKey: async () => {
          throw new Error("config mid-edit");
        },
      },
    ];
    const records = await collectBakedKeys(adapters);
    assert.deepEqual(
      records.map((r) => r.agent),
      ["claude"],
    );
  });
});

// The gateway's /logs rows carry the wire-dialect endpoint ("/v1/messages",
// "/v1/responses", "/v1/chat/completions"), which narrows which harness on a
// shared key can have made the request. Never a guess: an endpoint that
// matches none of the recorded holders leaves attribution as "shared".
describe("agentForMaskedKey with endpoint", () => {
  const CLAUDE_OMP_KEY = "sk-test-7777777777777777777777777777777777777777777777777777777777777";
  const CODEX_PI_KEY = "sk-test-8888888888888888888888888888888888888888888888888888888888888888";
  const SELF_OMP_KEY = "sk-test-9999999999999999999999999999999999999999999999999999999999999999";

  test("a dialect narrows a shared key to one harness", async () => {
    await recordAgentKey("claude", CLAUDE_OMP_KEY);
    await recordAgentKey("omp", CLAUDE_OMP_KEY);
    const masked = maskKey(CLAUDE_OMP_KEY);
    assert.equal(agentForMaskedKey(masked), "shared");
    assert.equal(agentForMaskedKey(masked, "/v1/messages"), "claude");
    assert.equal(agentForMaskedKey(masked, "/v1/chat/completions"), "omp");
  });

  test("an unknown endpoint or null endpoint stays shared", async () => {
    await recordAgentKey("claude", CLAUDE_OMP_KEY);
    await recordAgentKey("omp", CLAUDE_OMP_KEY);
    const masked = maskKey(CLAUDE_OMP_KEY);
    assert.equal(agentForMaskedKey(masked, "/v9/whatever"), "shared");
    assert.equal(agentForMaskedKey(masked, null), "shared");
  });

  test("codex narrows on /v1/responses", async () => {
    await recordAgentKey("codex", CODEX_PI_KEY);
    await recordAgentKey("pi", CODEX_PI_KEY);
    assert.equal(agentForMaskedKey(maskKey(CODEX_PI_KEY), "/v1/responses"), "codex");
  });

  test("the CLI self-entry still loses to a wired agent on the same dialect", async () => {
    await recordAgentKey("aiand-cli", SELF_OMP_KEY);
    await recordAgentKey("omp", SELF_OMP_KEY);
    assert.equal(agentForMaskedKey(maskKey(SELF_OMP_KEY), "/v1/chat/completions"), "omp");
  });
});

describe("buildHarnessIndex / resolveHarness", () => {
  test("one index answers per-endpoint labels for every request", async () => {
    const key = "sk-test-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await recordAgentKey("claude", key);
    await recordAgentKey("omp", key);
    const masked = maskKey(key);
    const index = buildHarnessIndex();
    assert.equal(resolveHarness(index, masked, "/v1/messages"), "claude");
    assert.equal(resolveHarness(index, masked, "/v1/chat/completions"), "omp");
    assert.equal(resolveHarness(index, masked, "/v9/unknown"), "shared");
    assert.equal(resolveHarness(index, masked, null), "shared");
    assert.equal(resolveHarness(index, null, "/v1/messages"), "unknown");
    assert.equal(resolveHarness(index, "sk-test...ffff"), "unknown");
  });
});
