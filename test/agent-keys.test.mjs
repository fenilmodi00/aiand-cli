import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { withTestEnv } from "./helpers.mjs";

withTestEnv("aiand-agent-keys-test-", (dir) => {
  process.env.AIAND_CONFIG_DIR = dir;
  delete process.env.AIAND_API_KEY;
});

const {
  agentForMaskedKey,
  collectBakedKeys,
  forgetAgentKeys,
  listAgentKeys,
  maskKey,
  recordAgentKey,
} = await import("../dist/api/agent-keys.js");

describe("maskKey", () => {
  test("masks the way the gateway does", () => {
    // A synthetic key shaped like the gateway's: 7 leading characters, an
    // ellipsis, and the last 4. A real key never belongs in a test.
    assert.equal(
      maskKey("sk-1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff77779953"),
      "sk-1111...9953",
    );
  });

  test("leaves a short key alone", () => {
    assert.equal(maskKey("sk-short"), "sk-short");
  });
});

describe("recordAgentKey", () => {
  test("remembers the agent for a key", async () => {
    await recordAgentKey("claude", "sk-1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff77779953");
    assert.equal(agentForMaskedKey("sk-1111...9953"), "claude");
  });

  test("re-recording the same key does not duplicate it", async () => {
    await recordAgentKey("codex", "sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    await recordAgentKey("codex", "sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const records = listAgentKeys().filter((r) => r.agent === "codex");
    assert.equal(records.length, 1);
  });

  test("two agents can hold two different keys", async () => {
    await recordAgentKey(
      "claude",
      "sk-1111111111111111111111111111111111111111111111111111111111111111",
    );
    await recordAgentKey(
      "codex",
      "sk-2222222222222222222222222222222222222222222222222222222222222222",
    );
    assert.equal(agentForMaskedKey("sk-1111...1111"), "claude");
    assert.equal(agentForMaskedKey("sk-2222...2222"), "codex");
  });

  test("forgetting an agent drops only its keys", async () => {
    await recordAgentKey(
      "claude",
      "sk-3333333333333333333333333333333333333333333333333333333333333333",
    );
    await recordAgentKey(
      "codex",
      "sk-4444444444444444444444444444444444444444444444444444444444444444",
    );
    const before = listAgentKeys().filter((r) => r.agent === "claude").length;
    const removed = await forgetAgentKeys("claude");
    assert.equal(removed, before);
    assert.equal(agentForMaskedKey("sk-3333...3333"), undefined);
    assert.equal(agentForMaskedKey("sk-4444...4444"), "codex");
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
        bakedKey: async () => "sk-5555555555555555555555555555555555555555555555555555555555555555",
      },
      { id: "codex" },
      { id: "pi", bakedKey: async () => null },
    ];
    const records = await collectBakedKeys(adapters);
    assert.equal(records.length, 1);
    assert.equal(records[0].agent, "claude");
    assert.equal(records[0].masked, "sk-5555...5555");
  });

  test("an adapter that throws is skipped, not fatal", async () => {
    const adapters = [
      {
        id: "claude",
        bakedKey: async () => "sk-6666666666666666666666666666666666666666666666666666666666666666",
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
