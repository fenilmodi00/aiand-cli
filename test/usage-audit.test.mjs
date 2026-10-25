import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { runCli, withTestEnv } from "./helpers.mjs";

// `aiand usage --audit` (H3, ticket #68): the provenance table of every
// reported number, human and --json. Offline by design — it fetches nothing.

const box = withTestEnv("aiand-usage-audit-test-", (dir) => {
  process.env.AIAND_CONFIG_DIR = dir;
  process.env.AIAND_HOME = join(dir, "home");
  delete process.env.AIAND_API_KEY;
  delete process.env.AIAND_BASE_URL;
  process.env.NO_COLOR = "1";
  process.env.CI = "1";
});

const cli = (args) =>
  runCli(args, {
    env: {
      ...process.env,
      AIAND_CONFIG_DIR: box.dir,
      AIAND_HOME: join(box.dir, "home"),
      NO_COLOR: "1",
      CI: "1",
    },
    stdin: "ignore",
  });

describe("aiand usage --audit", () => {
  test("human output prints the provenance table", async () => {
    const { code, stdout } = await cli(["usage", "--audit"]);
    assert.equal(code, 0);
    assert.match(stdout, /Provenance of every reported number/);
    assert.match(stdout, /gateway-billed/);
    assert.match(stdout, /estimated\(/);
    assert.match(stdout, /heuristic\(/);
    // The cost line says outright the gateway billed it.
    assert.match(stdout, /never recomputed/);
  });

  test("--json lists every reported number with its label and source", async () => {
    const { code, stdout } = await cli(["usage", "--audit", "--json"]);
    assert.equal(code, 0);
    const rows = JSON.parse(stdout);
    assert.ok(Array.isArray(rows) && rows.length >= 10);
    for (const row of rows) {
      assert.ok(row.report && row.field && row.label && row.source);
      assert.match(row.label, /^(gateway-billed|estimated\(|heuristic\()/);
    }
    const cost = rows.find((r) => r.field === "totals.costUsd");
    assert.equal(cost.label, "gateway-billed");
    assert.match(cost.source, /never recomputed/);
    const sessions = rows.find((r) => r.report === "sessions");
    assert.match(sessions.label, /^heuristic\(/);
  });

  test("--audit runs offline (no session opened, no gateway call)", async () => {
    // No AIAND_BASE_URL, no credentials: if the command tried the network it
    // would fail. It must succeed.
    const { code } = await cli(["usage", "--audit"]);
    assert.equal(code, 0);
  });
});
