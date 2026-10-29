import assert from "node:assert/strict";
import { join } from "node:path";
import test, { after, before, describe } from "node:test";
import { cliEnv, runCli, startMockGateway, withTestEnv } from "./helpers.mjs";

// The models command lists the live catalog over HTTP (it has no cache), so
// point AIAND_BASE_URL at test/mock-gateway.mjs's vision-catalog scenario:
// one vision model, one text-only. Signed out → publicJson → plain GET.
withTestEnv("aiand-models-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_API_KEY = "";
  process.env.NO_COLOR = "1";
});

const CATALOG_SIZE = 2;

let gateway;
let cli;
let table = "";
before(async () => {
  gateway = await startMockGateway();
  const env = cliEnv({ AIAND_BASE_URL: `${gateway.url}/stub/vision-catalog` });
  cli = (args) => runCli(["models", ...args], { env });
  const r = await cli([]);
  assert.equal(r.code, 0, r.stderr);
  table = r.stdout;
  const stray = await cli(["nope"]);
  assert.equal(stray.code, 1);
  assert.match(stray.stderr, /Unknown argument "nope"/);
});
after(() => gateway?.stop());

describe("models table", () => {
  test("prints a Vision column header after Context", () => {
    const headerLine = table.split("\n").find((line) => /^id\s+context/i.test(line));
    assert.ok(headerLine, "table header present");
    assert.match(headerLine, /\bvision\b/i, "Vision header present");
    // Vision sits between the context and in/1m columns.
    const idxContext = headerLine.toLowerCase().indexOf("context");
    const idxVision = headerLine.toLowerCase().indexOf("vision");
    const idxIn = headerLine.toLowerCase().indexOf("in/1m");
    assert.ok(idxContext >= 0 && idxVision > idxContext && idxIn > idxVision);
  });

  test("labels vision models 'vision' and text-only models 'text-only'", () => {
    const visionLine = table.split("\n").find((line) => line.includes("vendor/vision-model"));
    assert.ok(visionLine, "vision model row present");
    assert.match(visionLine, /\bvision\b/, "vision model labeled vision");

    const textLine = table.split("\n").find((line) => line.includes("vendor/text-model"));
    assert.ok(textLine, "text-only model row present");
    assert.match(textLine, /\btext-only\b/, "text-only model labeled text-only");
  });

  test("--json returns the raw catalog without a vision field", async () => {
    const { code, stdout } = await cli(["--json"]);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, CATALOG_SIZE);
    // JSON stays the raw catalog: no injected presentation field.
    assert.equal(parsed[0].vision, undefined);
    assert.equal(parsed[0].id, "vendor/text-model"); // sorted by id ascending
  });

  test("invalid --sort fails closed listing the allowed values", async () => {
    const { code, stdout, stderr } = await cli(["--sort", "bogus"]);
    assert.equal(code, 1);
    assert.match(
      `${stdout}${stderr}`,
      /--sort must be one of: id, input, output, context \(got "bogus"\)/,
    );
  });

  test("valid --sort values keep working", async () => {
    for (const sort of ["id", "input", "output", "context"]) {
      const { code, stdout } = await cli(["--sort", sort, "--json"]);
      assert.equal(code, 0, sort);
      assert.equal(JSON.parse(stdout).length, CATALOG_SIZE);
    }
  });
});
