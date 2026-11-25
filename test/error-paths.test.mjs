// Small behaviours the larger suites reach only on a good day: a tool that
// hangs, a path that is gone, a colour terminal, an analytics read. Each
// asserts what the caller sees, not that a line ran.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { withEnv, withFetch, withTestEnv } from "./helpers.mjs";

const env = withTestEnv("aiand-error-paths-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_KEY_STORAGE = "plaintext";
  delete process.env.AIAND_API_KEY;
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  process.env.CI = "1";
});

const { runTool } = await import("../dist/fsutil.js");
const { createTheme } = await import("../dist/cli/ui/theme.js");
const { loginCancelled, EXIT } = await import("../dist/cli/errors.js");
const { getSummary, getMetrics } = await import("../dist/api/analytics.js");
const { provesAiandConfigDir, wipeConfigDir } = await import("../dist/auth/config-wipe.js");
const { logoutAll } = await import("../dist/auth/logout-all.js");
const { snapshotShims, restoreShims } = await import("../dist/agents/hermes/shims.js");

describe("runTool", () => {
  test("a tool that outlives its timeout is killed and reports no exit code", async () => {
    const started = Date.now();
    const result = await runTool(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      timeoutMs: 300,
    });
    assert.equal(result.code, null, "killed, not exited");
    assert.ok(Date.now() - started < 10_000, "did not wait for the tool");
  });
});

describe("the banner theme", () => {
  test("with colour it wraps the brand in 24-bit colour and the muted text in dim", async () => {
    const theme = await withEnv({ FORCE_COLOR: "1", NO_COLOR: undefined }, () => createTheme());
    assert.equal(theme.color, true);
    assert.equal(theme.brand("ai&"), "\x1b[38;2;199;0;7mai&\x1b[39m");
    assert.equal(theme.muted("x"), "\x1b[2mx\x1b[22m");
  });

  test("without colour both are the identity", async () => {
    const theme = await withEnv({ FORCE_COLOR: undefined, NO_COLOR: "1" }, () => createTheme());
    assert.equal(theme.color, false);
    assert.equal(theme.brand("ai&"), "ai&");
    assert.equal(theme.muted("x"), "x");
  });
});

describe("loginCancelled", () => {
  test("exits as an interrupt with the cancelled-login message", () => {
    const error = loginCancelled();
    assert.equal(error.exitCode, EXIT.INTERRUPTED);
    assert.match(error.message, /Login cancelled/);
  });
});

describe("analytics reads", () => {
  const session = {
    profile: { name: "default", apiUrl: "https://api.test", authUrl: "https://api.test" },
    token: "sk-test-analytics",
    credential: null,
  };
  const reply = (body) => async (url) => {
    reply.seen.push(String(url));
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  };
  reply.seen = [];

  test("getSummary asks for the range and returns the body", async () => {
    const summary = await withFetch(reply({ requests: 3 }), () => getSummary(session, "24h"));
    assert.deepEqual(summary, { requests: 3 });
    assert.match(reply.seen.at(-1), /\/analytics\/summary\?range=24h$/);
  });

  test("getMetrics returns the data array of the response", async () => {
    const rows = await withFetch(reply({ data: [{ metric: "latency" }] }), () =>
      getMetrics(session, "7days"),
    );
    assert.deepEqual(rows, [{ metric: "latency" }]);
    assert.match(reply.seen.at(-1), /\/analytics\/metrics\?range=7days$/);
  });
});

describe("config-wipe on a path that cannot be read", () => {
  test("a dir that is not there proves nothing", async () => {
    assert.equal(await provesAiandConfigDir(join(env.dir, "not-there")), false);
  });

  test("an unreadable folder inside snapshots/ is left, not deleted", {
    skip: process.platform === "win32" || process.getuid?.() === 0,
  }, async () => {
    const root = join(env.dir, "wipe-unreadable");
    const hidden = join(root, "snapshots", "agent");
    mkdirSync(hidden, { recursive: true });
    writeFileSync(join(root, "config.json"), '{"profile":"default","profiles":{}}\n');
    writeFileSync(join(hidden, "latest.json"), "{}");
    chmodSync(hidden, 0o000);
    try {
      const result = await wipeConfigDir(root, { keep: new Set(), keepSnapshots: new Set() });
      assert.deepEqual(result.left, ["snapshots/agent"]);
      assert.equal(result.removed, false);
    } finally {
      chmodSync(hidden, 0o700);
    }
  });
});

describe("logout --all", () => {
  test("refuses a config dir outside a home directory that cannot be resolved", async () => {
    const cfg = join(env.dir, "outside-cfg");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "config.json"), '{"profile":"default","profiles":{}}\n');
    await withEnv(
      {
        HOME: join(env.dir, "no-such-home"),
        USERPROFILE: join(env.dir, "no-such-home"),
        AIAND_CONFIG_DIR: cfg,
        AIAND_WIPE_OUTSIDE_HOME: undefined,
      },
      () => assert.rejects(logoutAll({ force: true }), /outside your home directory/),
    );
    assert.equal(existsSync(join(cfg, "config.json")), true, "nothing was deleted");
  });
});

describe("the Hermes shim snapshot", () => {
  test("a binary that does not exist reveals no shim dir", async () => {
    assert.equal(await snapshotShims(join(env.dir, "no", "such", "hermes")), null);
  });

  test("restoring into a shim dir that has vanished does nothing and does not throw", async () => {
    const snapshot = { dir: join(env.dir, "vanished-shims"), entries: {} };
    await restoreShims(snapshot, join(env.dir, "overlay"));
    assert.equal(existsSync(snapshot.dir), false);
  });
});
