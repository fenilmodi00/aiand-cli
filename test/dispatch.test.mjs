import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import test, { describe } from "node:test";
import {
  CLOSED_URL,
  cliEnv,
  FAKE_API_KEY,
  fixtureFile,
  hermeticPath,
  makeFixture,
  runCli,
  seedCatalogCache,
  withEnv,
  withMockGateway,
  withTestEnv,
} from "./helpers.mjs";

// Command dispatch through the built CLI (unknown commands, agent nouns,
// flag suggestions, leading globals, help topics, status exit codes) plus
// the setup engine driven directly against the makeFixture adapter.

// Load the registry once at module scope (it ships opencode) so the
// adapter-dependent dispatch test below runs against the real adapter.
const registry = await import("../dist/agents/registry.js");
const eng = await import("../dist/agents/setup.js");

let home, cfg;
const box = withTestEnv("aiand-dispatch-", (dir) => {
  home = join(dir, "home");
  cfg = join(dir, "cfg");
  mkdirSync(home, { recursive: true });
  process.env.AIAND_HOME = home;
  process.env.AIAND_CONFIG_DIR = cfg;
  process.env.AIAND_API_KEY = FAKE_API_KEY;
  process.env.AIAND_BASE_URL = CLOSED_URL;
  // A fresh catalog cache so agentOn never touches the network.
  seedCatalogCache(cfg);
});

/** Child env on a fresh, empty home + config dir (removed with the file's temp dir). */
function freshEnv(overrides = {}) {
  const spy = mkdtempSync(join(box.dir, "spy-"));
  return cliEnv({ AIAND_HOME: join(spy, "h"), AIAND_CONFIG_DIR: join(spy, "c"), ...overrides });
}

/** Run the CLI on a fresh home; `overrides` layer over the inherited env. */
const cli = (args, overrides) => runCli(args, { env: freshEnv(overrides) });

/** Same, signed out: an empty AIAND_API_KEY reads as unset. */
const cliSignedOut = (args, overrides = {}) => cli(args, { AIAND_API_KEY: "", ...overrides });

// --- Subprocess dispatch tests (built dist/index.js) --------------------------

describe("dispatch subprocess", () => {
  test("unknown command -> 127 with a suggestion", async () => {
    const { code, stderr } = await cli(["sttaus"]);
    assert.equal(code, 127);
    assert.match(stderr, /Did you mean .*status/);
  });

  test("unknown agent noun -> 127", async () => {
    const { code, stderr } = await cli(["not-an-agent"]);
    assert.equal(code, 127);
    assert.match(stderr, /Unknown command/);
  });

  // Adapter-dependent dispatch: routes to the opencode adapter shipped in
  // AGENTS. `status --json` needs no session; it returns agent status JSON.
  test("opencode noun dispatches to the opencode adapter, not unknown-command", async () => {
    const r = await cli(["opencode", "status", "--json"]);
    assert.notEqual(r.code, 127);
    assert.ok(JSON.parse(r.stdout).agent);
  });

  // Same registry integration for codeaf: `status --json` needs no
  // session and returns agent status JSON through the real adapter.
  test("codeaf noun dispatches to the codeaf adapter, not unknown-command", async () => {
    const r = await cli(["codeaf", "status", "--json"]);
    assert.notEqual(r.code, 127);
    assert.ok(JSON.parse(r.stdout).agent);
  });

  test("aiand init --all with no detectable agents is friendly and exits 0", async () => {
    // PATH holds only node's own directory: the registry ships opencode
    // (a real adapter), but `which` cannot resolve there, so
    // detection finds nothing and init has nothing to wire.
    const { code, stdout } = await cli(["init", "--all"], {
      PATH: hermeticPath(dirname(process.execPath)),
    });
    assert.equal(code, 0);
    assert.match(stdout, /No coding agents detected/);
  });

  test("aiand status --json has the {auth, agents} shape", async () => {
    const { code, stdout } = await cliSignedOut(["status", "--json"]);
    // Signed-out is a script gate: exit 1, body still parses.
    assert.equal(code, 1);
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.auth && typeof parsed.auth === "object");
    assert.ok(Array.isArray(parsed.agents));
  });
});

// --- Engine-level tests (temp env, direct engine calls) ----------------------

function cleanFixture() {
  // The engine's snapshot manifest outlives the config file between tests —
  // clear both so each test starts from a genuinely pristine agent state.
  rmSync(join(cfg, "snapshots", "fixture-agent"), { recursive: true, force: true });
  if (existsSync(fixtureFile(home))) unlinkSync(fixtureFile(home));
}

function plant(content) {
  const file = fixtureFile(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

describe("engine: fixture adapter", () => {
  test("on writes via the adapter and reports files", async () => {
    cleanFixture();
    const result = await eng.agentOn(makeFixture(home));
    assert.equal(result.state, "on");
    assert.equal(result.model, "zai-org/glm-5.3");
    const file = fixtureFile(home);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).aiand, true);
    assert.deepEqual(result.files, [file]);
  });

  test("registerAgent is idempotent by id", async () => {
    const before = registry.AGENTS.length;
    registry.registerAgent(makeFixture(home));
    registry.registerAgent(makeFixture(home));
    assert.equal(registry.AGENTS.length, before + 1);
    assert.equal(registry.AGENTS.filter((a) => a.id === "fixture-agent").length, 1);
    assert.ok(registry.findAgent("fixture-agent"));
  });

  test("off subtracts aiand keys and keeps the user's", async () => {
    cleanFixture();
    const original = '{"permissions":{"allow":["Bash*"]}}\n';
    plant(original);
    await eng.agentOn(makeFixture(home));
    assert.notEqual(readFileSync(fixtureFile(home), "utf8"), original);
    const off = await eng.agentOff(makeFixture(home));
    assert.equal(off.state, "off");
    const after = JSON.parse(readFileSync(fixtureFile(home), "utf8"));
    assert.equal(after.aiand, undefined);
    assert.deepEqual(after.permissions, { allow: ["Bash*"] });
  });

  test("agentOn with no binary prints an install hint and exits 127", async () => {
    cleanFixture();
    await assert.rejects(eng.agentOn(makeFixture(home, { installed: false })), (e) => {
      assert.equal(e.exitCode, 127);
      assert.match(e.message, /is not installed/);
      assert.match(e.hint, /Install it with: npm i -g fixture-agent/);
      assert.match(e.hint, /See: https:\/\/example.com\/fixture/);
      return true;
    });
  });

  test("off without a snapshot reports nothing to turn off", async () => {
    cleanFixture();
    const off = await eng.agentOff(makeFixture(home));
    assert.equal(off.state, "off");
    assert.equal(off.note, "Already your own config — nothing to turn off.");
  });

  test("status reports on/off states", async () => {
    cleanFixture();
    // off (no file)
    assert.equal((await eng.agentStatus(makeFixture(home))).state, "off");

    // inactive existing config still reports off
    plant(JSON.stringify({ permissions: { allow: ["Bash*"] } }));
    let status = await eng.agentStatus(makeFixture(home));
    assert.equal(status.state, "off");
    assert.equal(status.model, null);

    // on
    await eng.agentOn(makeFixture(home));
    status = await eng.agentStatus(makeFixture(home));
    assert.equal(status.state, "on");
    assert.equal(status.installed, true);
  });

  test("second on keeps the first snapshot; off keeps edits; restore --force rewinds", async () => {
    cleanFixture();
    const original = '{"original":true}\n';
    const file = plant(original);
    await eng.agentOn(makeFixture(home));
    writeFileSync(file, JSON.stringify({ aiand: true, model: "touched", extra: 1 }));
    await eng.agentOn(makeFixture(home));
    await eng.agentOff(makeFixture(home));
    const afterOff = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(afterOff.aiand, undefined);
    assert.equal(afterOff.extra, 1);
    const { restoreSnapshot } = await import("../dist/agents/snapshot.js");
    assert.equal(await restoreSnapshot("fixture-agent", [file]), true);
    assert.equal(readFileSync(file, "utf8"), original);
  });
});

describe("engine: not signed in", () => {
  test("agentOn without a session throws NotLoggedInError (exit 2)", async () => {
    const emptyCfg = join(box.dir, "empty-cfg");
    mkdirSync(emptyCfg, { recursive: true });
    const { NotLoggedInError } = await import("../dist/cli/errors.js");
    await withEnv(
      { AIAND_API_KEY: undefined, AIAND_BASE_URL: undefined, AIAND_CONFIG_DIR: emptyCfg },
      () =>
        assert.rejects(eng.agentOn(makeFixture(home)), (e) => {
          assert.ok(e instanceof NotLoggedInError);
          assert.equal(e.exitCode, 2);
          return true;
        }),
    );
  });
});

// --- Flag suggestions ---
describe("flag suggestions", () => {
  test("status --profle suggests --profile and exits nonzero", async () => {
    const { code, stderr } = await cli(["status", "--profle"]);
    assert.notEqual(code, 0);
    assert.match(stderr, /Did you mean --profile\?/);
  });

  test("status --zzzqqq keeps the generic hint", async () => {
    const { code, stderr } = await cli(["status", "--zzzqqq"]);
    assert.notEqual(code, 0);
    assert.match(stderr, /Run the command with --help to see its flags/);
    assert.doesNotMatch(stderr, /Did you mean/);
  });
});

// --- status exit codes ---
describe("status exit codes", () => {
  test("signed-out status --json exits 1 with reachable=true", async () => {
    const { code, stdout } = await cliSignedOut(["status", "--json"]);
    assert.equal(code, 1);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.auth.signed_in, false);
    assert.equal(parsed.auth.reachable, true);
  });

  // A gateway that fails every identity call with 500 exercises the
  // unreachable path; auth-identity covers the refused connection (dead port).
  test("unreachable gateway exits 0 with reachable=false (no false failure)", async () => {
    await withMockGateway(async ({ url }) => {
      const down = `${url}/stub/500`;
      const { code, stdout } = await cli(["status", "--json"], {
        AIAND_BASE_URL: down,
        AIAND_AUTH_URL: down,
      });
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.auth.signed_in, false);
      assert.equal(parsed.auth.reachable, false);
    });
  });

  test("unreachable gateway prose names the outage and exits 0", async () => {
    await withMockGateway(async ({ url }) => {
      const down = `${url}/stub/500`;
      const { code, stdout, stderr } = await cli(["status"], {
        AIAND_BASE_URL: down,
        AIAND_AUTH_URL: down,
      });
      assert.equal(code, 0);
      assert.match(stdout, /Gateway unreachable/);
      assert.match(stderr, /Check your network/);
    });
  });

  test("signed-out prose exits 1", async () => {
    const { code, stdout } = await cliSignedOut(["status"]);
    assert.equal(code, 1);
    assert.match(stdout, /Not signed in/);
  });
});

describe("agent help short flag", () => {
  test("opencode -h and opencode on -h exit 0 with help", async () => {
    const env = freshEnv();
    for (const args of [
      ["opencode", "-h"],
      ["opencode", "on", "-h"],
    ]) {
      const { code, stdout } = await runCli(args, { env });
      assert.equal(code, 0, `aiand ${args.join(" ")} should exit 0`);
      assert.match(stdout, /aiand opencode/);
      assert.match(stdout, /Verbs/);
    }
  });

  test("restore -h still works", async () => {
    const { code, stdout } = await cli(["restore", "-h"]);
    assert.equal(code, 0);
    assert.match(stdout, /aiand restore/);
  });
});

// Bare `opencode on` reaching the session check is covered with a stub
// binary in init.test.mjs ("opencode on signed-out with binary installed").
describe("agent extra positionals", () => {
  test("opencode on bogus errors", async () => {
    const { code, stderr } = await cli(["opencode", "on", "bogus"]);
    assert.notEqual(code, 0);
    assert.match(stderr, /at most one verb/);
  });

  test("bare status still works", async () => {
    const status = await cliSignedOut(["opencode", "status"]);
    assert.equal(status.code, 0);
    assert.match(status.stdout, /agent/);
    assert.doesNotMatch(status.stderr, /at most one verb/);
  });
});

describe("leading globals", () => {
  test("leading --json works like trailing", async () => {
    const { code, stdout } = await cliSignedOut(["--json", "status"]);
    assert.equal(code, 1);
    assert.ok(JSON.parse(stdout).auth);
  });

  test("leading --profile is accepted, not Unknown command", async () => {
    const { code, stdout, stderr } = await cliSignedOut(["--profile", "foo", "status", "--json"]);
    assert.notEqual(code, 127);
    assert.doesNotMatch(stderr, /Unknown command/);
    assert.equal(code, 1);
    assert.ok(JSON.parse(stdout).auth);
  });

  test("leading --base-url is accepted", async () => {
    const { code, stderr } = await cliSignedOut(["--base-url", CLOSED_URL, "status", "--json"]);
    assert.notEqual(code, 127);
    assert.doesNotMatch(stderr, /Unknown command "--base-url"/);
    assert.equal(code, 1);
  });

  test("leading --json reaches agent nouns", async () => {
    const r = await cli(["--json", "opencode", "status"]);
    assert.notEqual(r.code, 127);
    assert.ok(JSON.parse(r.stdout).agent);
  });
});

describe("help topics", () => {
  test("help opencode matches opencode --help", async () => {
    const env = freshEnv();
    const help = await runCli(["help", "opencode"], { env });
    const flag = await runCli(["opencode", "--help"], { env });
    assert.equal(help.code, 0);
    assert.equal(flag.code, 0);
    assert.match(help.stdout, /aiand opencode/);
    assert.ok(help.stdout.includes(flag.stdout.trim()));
  });

  test("help frobnicate exits nonzero", async () => {
    const { code, stderr } = await cli(["help", "frobnicate"]);
    assert.notEqual(code, 0);
    assert.match(stderr, /Unknown help topic/);
  });

  test("help status still works", async () => {
    const { code, stdout } = await cli(["help", "status"]);
    assert.equal(code, 0);
    assert.match(stdout, /aiand status/);
  });

  test("help flags are not topics", async () => {
    const env = freshEnv();
    for (const args of [
      ["help", "-h"],
      ["help", "--help"],
      ["help", "--json"],
    ]) {
      const { code, stdout, stderr } = await runCli(args, { env });
      assert.equal(code, 0, args.join(" "));
      assert.doesNotMatch(stderr, /Unknown help topic/);
      assert.match(stdout, /aiand/);
    }
    const login = await runCli(["help", "--json", "login"], { env });
    assert.equal(login.code, 0);
    assert.match(login.stdout, /aiand login/);
  });
});
