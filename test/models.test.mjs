import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";

const execFileAsync = promisify(execFile);

let dir;
let server;
let port = 0;
let baseUrl = "";
let stdout = "";
let stderr = "";
const originalEnv = { ...process.env };

/** A minimal GET /v1/models payload shaped exactly like the gateway returns. */
function model(id, capabilities, contextWindow = 128000) {
  return {
    id,
    name: id,
    object: "model",
    created: 0,
    owned_by: "aiand",
    provider: "aiand",
    context_window: contextWindow,
    capabilities,
    reasoning_efforts: null,
    reasoning_effort_default: null,
    description: null,
    currency: "usd",
    input_per_1m: "1",
    output_per_1m: "1",
    cached_input_per_1m: null,
  };
}

const CATALOG = [
  model("vendor/vision-model", ["vision", "tool_calling"]),
  model("vendor/text-model", ["tool_calling"]),
];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "aiand-models-test-"));
  const cfg = join(dir, "cfg");
  mkdirSync(cfg, { recursive: true });

  // The models command lists the live catalog over HTTP (it has no cache), so
  // serve a local /v1/models endpoint and point AIAND_BASE_URL at it. Signed
  // out → publicJson → plain GET, no auth needed.
  server = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: CATALOG }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address && typeof address === "object") port = address.port;
  baseUrl = `http://127.0.0.1:${port}`;

  process.env.AIAND_CONFIG_DIR = cfg;
  process.env.AIAND_BASE_URL = baseUrl;
  process.env.AIAND_API_KEY = "";
  process.env.NO_COLOR = "1";

  const bin = join(dirname(import.meta.dirname), "dist", "index.js");
  const { stdout: so, stderr: se } = await execFileAsync("node", [bin, "models"], {
    env: { ...process.env },
  });
  stdout = so;
  stderr = se;
});

after(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
  process.env = originalEnv;
});

describe("models table", () => {
  test("prints a Vision column header after Context", () => {
    const headerLine = stdout.split("\n").find((line) => /^id\s+context/i.test(line));
    assert.ok(headerLine, "table header present");
    assert.match(headerLine, /\bvision\b/i, "Vision header present");
    // Vision sits between the context and in/1m columns.
    const idxContext = headerLine.toLowerCase().indexOf("context");
    const idxVision = headerLine.toLowerCase().indexOf("vision");
    const idxIn = headerLine.toLowerCase().indexOf("in/1m");
    assert.ok(idxContext >= 0 && idxVision > idxContext && idxIn > idxVision);
  });

  test("labels vision models 'vision' and text-only models 'text-only'", () => {
    const visionLine = stdout.split("\n").find((line) => line.includes("vendor/vision-model"));
    assert.ok(visionLine, "vision model row present");
    assert.match(visionLine, /\bvision\b/, "vision model labeled vision");

    const textLine = stdout.split("\n").find((line) => line.includes("vendor/text-model"));
    assert.ok(textLine, "text-only model row present");
    assert.match(textLine, /\btext-only\b/, "text-only model labeled text-only");
  });

  test("--json returns the raw catalog without a vision field", async () => {
    const bin = join(dirname(import.meta.dirname), "dist", "index.js");
    const { stdout: jsonOut } = await execFileAsync("node", [bin, "models", "--json"], {
      env: { ...process.env },
    });
    const parsed = JSON.parse(jsonOut);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, CATALOG.length);
    // JSON stays the raw catalog: no injected presentation field.
    assert.equal(parsed[0].vision, undefined);
    assert.equal(parsed[0].id, "vendor/text-model"); // sorted by id ascending
  });
});