import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import {
  CLOSED_URL,
  captureStdio,
  cliEnv,
  FAKE_API_KEY,
  runCli,
  withEnv,
  withFetch,
  withMockGateway,
  withTestEnv,
} from "./helpers.mjs";

const env = withTestEnv("aiand-doctor-", (dir) => {
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_HOME = join(dir, "home");
  delete process.env.AIAND_API_KEY;
});

const CHECK_IDS = ["gateway", "auth", "adapters", "agent-keys", "store", "lag"];
const STATUSES = new Set(["ok", "nothing-found", "errors", "skipped"]);

function byId(checks) {
  return Object.fromEntries(checks.map((check) => [check.check, check]));
}

before(() => {
  mkdirSync(join(env.dir, "cfg"), { recursive: true });
  mkdirSync(join(env.dir, "home"), { recursive: true });
});

test("help documents the checks and the exit-code contract", async () => {
  const { code, stdout } = await runCli(["doctor", "--help"]);
  assert.equal(code, 0);
  for (const id of CHECK_IDS) assert.ok(stdout.includes(id), `help names ${id}`);
  assert.ok(stdout.includes("Exit codes"));
  assert.ok(stdout.includes("NOTHING FOUND"));
});

test("signed out: clear verdicts, every check still runs, exit 0", async () => {
  const { code, stdout, stderr } = await runCli(["doctor", "--json"], {
    env: cliEnv({ AIAND_BASE_URL: CLOSED_URL, AIAND_API_KEY: undefined }),
  });
  assert.equal(code, 0, `stderr: ${stderr}`);
  const { checks } = JSON.parse(stdout);
  assert.deepEqual(
    checks.map((check) => check.check),
    CHECK_IDS,
  );
  const found = byId(checks);
  assert.equal(found.gateway.status, "skipped");
  assert.equal(found.auth.status, "nothing-found");
  assert.ok(found.auth.detail.includes("aiand login"), "signed-out message names the fix");
  assert.equal(found.adapters.status, "nothing-found");
  assert.equal(found["agent-keys"].status, "nothing-found");
  assert.equal(
    found.store.status,
    "nothing-found",
    "store module present, no store.db yet (#61 merged)",
  );
  assert.equal(found.lag.status, "skipped");
  for (const check of checks) {
    assert.ok(STATUSES.has(check.status), `status ${check.status} is in the vocabulary`);
    assert.equal(typeof check.detail, "string");
    assert.ok(check.detail.length > 0);
  }
});

test("signed out, human output: one verdict line per check, no stack traces", async () => {
  const { code, stdout, stderr } = await runCli(["doctor"], {
    env: cliEnv({ AIAND_BASE_URL: CLOSED_URL, AIAND_API_KEY: undefined }),
  });
  assert.equal(code, 0);
  assert.ok(stderr === "" || !stderr.includes("at "), "no stack on stderr");
  for (const id of CHECK_IDS) {
    assert.ok(new RegExp(`^\\S*${id}`).test(stdout) || stdout.includes(id), `a line names ${id}`);
  }
  assert.ok(stdout.includes("NOTHING FOUND"));
  assert.ok(stdout.includes("SKIPPED"));
  assert.ok(!stdout.includes("ERRORS"));
});

test("gateway 200 through the mock gateway: gateway and auth OK, exit 0", async () => {
  await withMockGateway(async ({ url }) => {
    const { code, stdout } = await runCli(["doctor", "--json"], {
      env: cliEnv({ AIAND_BASE_URL: url, AIAND_API_KEY: FAKE_API_KEY }),
    });
    assert.equal(code, 0);
    const found = byId(JSON.parse(stdout).checks);
    assert.equal(found.gateway.status, "ok");
    assert.ok(found.gateway.detail.startsWith("OK"));
    assert.equal(found.auth.status, "ok");
  });
});

test("gateway 401: auth verdict names the rejection; other checks still run", async () => {
  const { run } = await import("../dist/commands/doctor.js");
  const capture = captureStdio();
  const previousExit = process.exitCode;
  try {
    await withEnv(
      { AIAND_API_KEY: FAKE_API_KEY, AIAND_BASE_URL: "https://gateway.example.test" },
      () =>
        withFetch(
          async () => new Response(JSON.stringify({ error: "invalid_token" }), { status: 401 }),
          () => run(["--json"]),
        ),
    );
  } finally {
    capture.restore();
  }
  const { checks } = JSON.parse(capture.log.out.join(""));
  const found = byId(checks);
  assert.equal(found.gateway.status, "errors");
  assert.ok(found.gateway.detail.startsWith("ERRORS"));
  assert.ok(found.gateway.detail.includes("401"));
  assert.equal(found.auth.status, "errors");
  assert.ok(found.auth.detail.includes("aiand login"));
  // Independence: a rejected gateway must not silence the local checks.
  assert.equal(found.adapters.status, "nothing-found");
  assert.equal(found["agent-keys"].status, "nothing-found");
  assert.equal(found.store.status, "nothing-found");
  assert.equal(found.lag.status, "skipped");
  assert.equal(process.exitCode, 1);
  process.exitCode = previousExit;
});

test("network failure: distinct verdict; local checks still run; exit 1", async () => {
  const { run } = await import("../dist/commands/doctor.js");
  // Plant one mapping so the independence of agent-keys is visible.
  writeFileSync(
    join(process.env.AIAND_CONFIG_DIR, "agent-keys.json"),
    `${JSON.stringify({
      version: 1,
      keys: [{ agent: "claude", masked: "sk-abcd...wxyz", fingerprint: "f".repeat(16), at: 1 }],
    })}\n`,
  );
  const capture = captureStdio();
  const previousExit = process.exitCode;
  try {
    await withEnv(
      { AIAND_API_KEY: FAKE_API_KEY, AIAND_BASE_URL: "https://gateway.example.test" },
      () =>
        withFetch(
          async () => {
            throw new TypeError("fetch failed");
          },
          () => run(["--json"]),
        ),
    );
  } finally {
    capture.restore();
  }
  const { checks } = JSON.parse(capture.log.out.join(""));
  const found = byId(checks);
  assert.equal(found.gateway.status, "errors");
  assert.ok(found.gateway.detail.includes("network"), `network reason: ${found.gateway.detail}`);
  assert.equal(found.auth.status, "skipped", "auth is unknown when the gateway is unreachable");
  assert.equal(found["agent-keys"].status, "ok", "agent-keys still runs");
  assert.equal(found["agent-keys"].count, 1);
  assert.equal(found.adapters.status, "nothing-found");
  assert.equal(found.store.status, "nothing-found");
  assert.equal(found.lag.status, "skipped");
  assert.equal(process.exitCode, 1);
  process.exitCode = previousExit;
});

// Keep last: registerAgent appends to the shared in-process registry.
test("adapters verdict counts a fixture agent with a resolvable bakedKey", async () => {
  const { makeFixture } = await import("./helpers.mjs");
  const { registerAgent } = await import("../dist/agents/registry.js");
  const { run } = await import("../dist/commands/doctor.js");
  registerAgent({
    ...makeFixture(env.dir, { id: "doctor-fixture" }),
    bakedKey: async () => "sk-test-doctor-fixture-key",
  });
  const capture = captureStdio();
  const previousExit = process.exitCode;
  try {
    await run(["--json"]);
  } finally {
    capture.restore();
  }
  const found = byId(JSON.parse(capture.log.out.join("")).checks);
  assert.equal(found.adapters.status, "ok");
  assert.match(found.adapters.detail, /^OK \(1 wired: doctor-fixture\)/);
  assert.equal(found.adapters.wired[0], "doctor-fixture");
  assert.equal(process.exitCode, previousExit);
});
