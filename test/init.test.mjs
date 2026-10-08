import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { stdin, stdout } from "node:process";
import test, { beforeEach, describe } from "node:test";
import {
  CLOSED_URL,
  cliEnv,
  FAKE_API_KEY,
  hermeticPath,
  makeFixture,
  plantStub,
  runCli,
  seedCatalogCache,
  withEnv,
  withMockGateway,
  withTestEnv,
} from "./helpers.mjs";

// `aiand init` and the `<agent> on|off` verbs it shares with setup.ts, driven
// both in-process (setup.ts / init.ts) and through the built CLI. The catalog
// caches are seeded against a closed loopback base URL, so `on` wires from
// cache and never reaches the network.

let home, cfg, stubBin, copilotHome;
withTestEnv("aiand-init-", (dir) => {
  home = join(dir, "home");
  cfg = join(dir, "cfg");
  stubBin = join(dir, "bin");
  copilotHome = join(dir, "copilot-home");
  mkdirSync(stubBin, { recursive: true });

  process.env.AIAND_HOME = home;
  process.env.AIAND_CONFIG_DIR = cfg;
  process.env.AIAND_API_KEY = FAKE_API_KEY;
  process.env.AIAND_BASE_URL = CLOSED_URL;
  // capabilities ["tools"] (no vision): every wired model warns as text-only.
  seedCatalogCache(cfg);
});

// Every test starts from an empty agent home and no snapshots; the catalog
// seeds and any stored credential stay.
beforeEach(() => {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  rmSync(join(cfg, "snapshots"), { recursive: true, force: true });
});

const setup = await import("../dist/agents/setup.js");
const initCmd = await import("../dist/commands/init.js");

// --- Helpers -----------------------------------------------------------------

/**
 * Run the built CLI against the shared home. `detectBinary` shells out to
 * `which`, so the child PATH decides what is "installed": `withStubs` puts
 * the stub bin dir first on the inherited PATH; `env.PATH` replaces it.
 */
const cli = (args, { withStubs = false, env = {} } = {}) =>
  runCli(args, {
    env: cliEnv({
      AIAND_HOME: home,
      AIAND_CONFIG_DIR: cfg,
      // Relocate the copilot-app config tree so its detect() never reads
      // the host's absolute GUI-install paths (an installed app on the
      // dev machine would join `detected` and flip these tests).
      COPILOT_HOME: copilotHome,
      ...(withStubs ? { PATH: `${stubBin}${delimiter}${process.env.PATH}` } : {}),
      ...env,
    }),
  });

/** Plant a POSIX-sh `opencode` stub on the temp bin dir so detection finds it. */
const plantOpencodeStub = () => plantStub(stubBin, "opencode");

/** PATH of the node dir only: `which` itself is unresolvable, so no agent is detected. */
const noAgentsPath = () => hermeticPath(dirname(process.execPath));

/**
 * Hermetic PATH: stubs + which + node only. System-wide agent binaries (a
 * dev machine or CI image with real installs, possibly sharing a dir with
 * node itself) must not leak into detection and change what --all wires —
 * so node resolves through the stub dir too.
 */
function stubsOnlyPath() {
  try {
    symlinkSync(process.execPath, join(stubBin, "node"));
  } catch {
    // Already linked by an earlier test in this file.
  }
  return hermeticPath(stubBin, "/usr/bin");
}

/** A non-trivial original opencode.json a user might have before wiring. */
const ORIGINAL_SETTINGS = '{\n  "theme": "dark"\n}\n';
const settingsPath = () => join(home, ".config", "opencode", "opencode.json");

function writeSettings(raw = ORIGINAL_SETTINGS) {
  mkdirSync(dirname(settingsPath()), { recursive: true });
  writeFileSync(settingsPath(), raw);
}

function assertAiandStripped(raw) {
  const config = JSON.parse(raw);
  assert.equal(config["x-aiand"], undefined);
  assert.equal(config.provider?.aiand, undefined);
  assert.equal(config.enabled_providers, undefined);
  assert.equal(config.disabled_providers, undefined);
  return config;
}

/** Run fn with isTTY overridden on stdio (faked TTY or forced pipe). */
async function withIsTty({ stdinIsTty, stdoutIsTty }, fn) {
  const targets = [
    [stdin, stdinIsTty],
    [stdout, stdoutIsTty],
  ];
  const saved = targets.map(([stream]) => Object.getOwnPropertyDescriptor(stream, "isTTY"));
  try {
    for (const [stream, value] of targets) {
      Object.defineProperty(stream, "isTTY", { value, configurable: true, writable: true });
    }
    return await fn();
  } finally {
    targets.forEach(([stream], i) => {
      if (saved[i]) Object.defineProperty(stream, "isTTY", saved[i]);
      else delete stream.isTTY;
    });
  }
}

/** Run init.run in-process on a faked TTY, capturing both streams.
 * Chunks stay per write: the runner streams its own progress to stdout, so
 * the command's output is the one chunk that parses as JSON. */
function runInitOnTty(args, { path }) {
  return withEnv({ PATH: path, COPILOT_HOME: copilotHome }, () =>
    withIsTty({ stdinIsTty: true, stdoutIsTty: true }, async () => {
      const outChunks = [];
      let errOut = "";
      const origOut = stdout.write;
      const origErr = process.stderr.write;
      stdout.write = (chunk) => {
        outChunks.push(String(chunk));
        return true;
      };
      process.stderr.write = (chunk) => {
        errOut += String(chunk);
        return true;
      };
      try {
        await initCmd.run(args);
      } finally {
        stdout.write = origOut;
        process.stderr.write = origErr;
      }
      const jsonChunks = outChunks.filter((c) => {
        try {
          JSON.parse(c);
          return true;
        } catch {
          return false;
        }
      });
      return { outChunks, jsonChunks, err: errOut };
    }),
  );
}

// --- on: detect before session ------------------------------------------------

describe("on: detect before session", () => {
  test("agentOn with no binary and no session exits 127, never a login", async () => {
    const emptyCfg = join(home, "empty-cfg");
    mkdirSync(emptyCfg, { recursive: true });
    await withEnv(
      { AIAND_API_KEY: undefined, AIAND_BASE_URL: undefined, AIAND_CONFIG_DIR: emptyCfg },
      () =>
        assert.rejects(setup.agentOn(makeFixture(home, { installed: false })), (e) => {
          assert.equal(e.exitCode, 127);
          assert.match(e.message, /is not installed/);
          assert.match(e.hint, /Install it with: npm i -g fixture-agent/);
          assert.match(e.hint, /See: https:\/\/example.com\/fixture/);
          return true;
        }),
    );
  });

  test("opencode on with missing binary and no session: 127 + Install hint, no login text", async () => {
    const { code, stdout, stderr } = await cli(["opencode", "on"], {
      env: { PATH: noAgentsPath(), AIAND_API_KEY: "" },
    });
    assert.equal(code, 127);
    assert.match(stderr, /OpenCode is not installed\./);
    assert.match(stderr, /Install it with: npm install -g opencode-ai/);
    assert.match(stderr, /https:\/\/opencode\.ai/);
    assert.doesNotMatch(stderr, /Not logged in|Not signed in/);
    assert.equal(stdout, "");
  });

  test("opencode on signed-out with binary installed still exits 2", async () => {
    plantOpencodeStub();
    const { code, stderr } = await cli(["opencode", "on"], {
      withStubs: true,
      env: { AIAND_API_KEY: "" },
    });
    assert.equal(code, 2);
    assert.match(stderr, /Not logged in\./);
  });

  test("opencode on with a rejected key refuses before any write", async () => {
    await withMockGateway(async ({ url }) => {
      plantOpencodeStub();
      const agentHome = join(home, "reject-key");
      const { code, stderr, stdout } = await cli(["opencode", "on"], {
        withStubs: true,
        env: {
          AIAND_API_KEY: "sk-test-rejected-by-gateway",
          AIAND_BASE_URL: `${url}/stub/401`,
          AIAND_HOME: agentHome,
        },
      });
      assert.equal(code, 1);
      assert.match(stderr, /rejected/i);
      assert.equal(stdout, "");
      // Nothing wired: the adapter never ran, no file was written.
      assert.equal(existsSync(join(agentHome, ".config", "opencode")), false);
    });
  });

  test("opencode on with a whitespace-only env key reads as signed out", async () => {
    plantOpencodeStub();
    const { code, stderr } = await cli(["opencode", "on"], {
      withStubs: true,
      env: { AIAND_API_KEY: "   " },
    });
    assert.equal(code, 2);
    assert.match(stderr, /Not logged in\./);
  });
});

// --- on: explicit --model ------------------------------------------------------

describe("on: explicit --model", () => {
  test("agentOn with model '' errors instead of silently defaulting", async () => {
    await assert.rejects(setup.agentOn(makeFixture(home), { model: "" }), (e) => {
      assert.match(e.message, /--model "" is not in the catalog\./);
      return true;
    });
  });

  test("agentOn with a non-empty --model still wires it", async () => {
    const result = await setup.agentOn(makeFixture(home), { model: "other/model" });
    assert.equal(result.state, "on");
    assert.equal(result.model, "other/model");
  });

  test("opencode on --model '' errors clearly", async () => {
    plantOpencodeStub();
    const { code, stderr } = await cli(["opencode", "on", "--model", ""], { withStubs: true });
    assert.equal(code, 1);
    assert.match(stderr, /--model "" is not in the catalog\./);
  });

  test("opencode on --model <id> still wires (non-empty unchanged)", async () => {
    plantOpencodeStub();
    const { code, stderr } = await cli(["opencode", "on", "--model", "zai-org/glm-5.3"], {
      withStubs: true,
    });
    assert.equal(code, 0, stderr);
  });

  test("opencode on --base-url trailing slash still hits the trimmed catalog cache", async () => {
    plantOpencodeStub();
    writeSettings();
    const { code, stderr } = await cli(["opencode", "on", "--base-url", `${CLOSED_URL}/`], {
      withStubs: true,
    });
    assert.equal(code, 0, stderr);
  });

  test("launcherOnlyRefusal names the agent and the per-session path", () => {
    // The one shared refusal launcher-only adapters throw from on/off and
    // print in --help: no persistent wiring exists, every session goes
    // through `aiand run-agent`.
    assert.equal(
      setup.launcherOnlyRefusal({ label: "Example Agent" }),
      "Example Agent runs on ai& per session only.",
    );
  });
});

// --- init: detection and non-interactive hints ------------------------------------

describe("init: detection", () => {
  test("bare init non-TTY, one detected: hint names the agent", async () => {
    plantOpencodeStub();
    const { code, stderr } = await cli(["init"], { withStubs: true });
    assert.equal(code, 1);
    assert.match(stderr, /aiand init opencode/);
  });

  test("bare init non-TTY, zero detected: actionable no-agents hint", async () => {
    const { code, stderr } = await cli(["init"], { env: { PATH: noAgentsPath() } });
    assert.equal(code, 1);
    assert.match(stderr, /No coding agents detected on this machine\./);
    assert.match(stderr, /Install one and re-run aiand init\./);
  });

  test("init --json with zero detected: {agents:[], message} shape", async () => {
    const { code, stdout } = await cli(["init", "--json"], { env: { PATH: noAgentsPath() } });
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.deepEqual(parsed.agents, []);
    assert.equal(
      parsed.message,
      "No coding agents detected on this machine. Install one and re-run aiand init.",
    );
  });

  test("non-TTY init --json with detected agents is unchanged", async () => {
    plantOpencodeStub();
    // Stubs only: a developer's real claude on PATH must not join `detected`.
    const { code, stdout } = await cli(["init", "--json"], { env: { PATH: stubsOnlyPath() } });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout), {
      agents: [],
      message: "Non-interactive: pass --all or name agents.",
      detected: ["opencode"],
    });
  });

  test("TTY init --json with zero detected emits JSON only", async () => {
    const { outChunks, jsonChunks, err } = await runInitOnTty(["--json"], { path: noAgentsPath() });
    assert.equal(jsonChunks.length, 1, `one JSON write, got: ${JSON.stringify(outChunks)}`);
    const parsed = JSON.parse(jsonChunks[0]);
    assert.deepEqual(parsed.agents, []);
    assert.match(parsed.message, /No coding agents detected/);
    assert.ok(
      outChunks.every((c) => !c.includes("Which agents")),
      "no checkbox chrome",
    );
    assert.equal(err, "");
  });

  test("TTY init --json with detected agents emits JSON only, no checkbox", async () => {
    plantOpencodeStub();
    const { outChunks, jsonChunks, err } = await runInitOnTty(["--json"], {
      path: stubsOnlyPath(),
    });
    assert.equal(jsonChunks.length, 1, `one JSON write, got: ${JSON.stringify(outChunks)}`);
    const parsed = JSON.parse(jsonChunks[0]);
    assert.deepEqual(parsed.agents, []);
    assert.deepEqual(parsed.detected, ["opencode"]);
    assert.ok(
      outChunks.every((c) => !c.includes("Which agents")),
      "no checkbox chrome",
    );
    assert.equal(err, "");
  });

  test("non-TTY init --json with only hermes detected lists it as wireable", async () => {
    // #16 hermes is a wired adapter now: a hermes-only machine offers it for
    // wiring, where the launcher-only note used to be the whole offering.
    const hermesBin = join(dirname(stubBin), "hermes-only-bin");
    mkdirSync(hermesBin, { recursive: true });
    plantStub(hermesBin, "hermes");
    try {
      const { code, stdout } = await cli(["init", "--json"], {
        env: { PATH: hermeticPath(hermesBin, "/usr/bin") },
      });
      assert.equal(code, 0);
      assert.deepEqual(JSON.parse(stdout), {
        agents: [],
        message: "Non-interactive: pass --all or name agents.",
        detected: ["hermes"],
      });
    } finally {
      rmSync(hermesBin, { recursive: true, force: true });
    }
  });
});

// --- init: failures keep exit code + hint ------------------------------------------

describe("init: failures", () => {
  test("init opencode with missing binary: Install hint + URL on stderr, exit 127", async () => {
    const { code, stdout, stderr } = await cli(["init", "opencode"], {
      env: { PATH: noAgentsPath() },
    });
    assert.equal(code, 127);
    assert.match(stderr, /OpenCode is not installed\./);
    assert.match(stderr, /Install it with: npm install -g opencode-ai/);
    assert.match(stderr, /https:\/\/opencode\.ai/);
    assert.equal(stdout, "");
  });

  test("init opencode --json with missing binary carries hint + exit_code", async () => {
    const { code, stdout } = await cli(["init", "opencode", "--json"], {
      env: { PATH: noAgentsPath() },
    });
    assert.equal(code, 127);
    const [row] = JSON.parse(stdout).agents;
    assert.equal(row.agent, "opencode");
    assert.equal(row.failed, true);
    assert.equal(row.exit_code, 127);
    assert.match(row.note, /is not installed/);
    assert.match(row.hint, /Install it with:/);
    assert.match(row.hint, /https:\/\/opencode\.ai/);
  });

  test("init --all signed-out and non-interactive exits 2", async () => {
    plantOpencodeStub();
    const { code, stderr } = await cli(["init", "--all"], {
      env: { PATH: stubsOnlyPath(), AIAND_API_KEY: "" },
    });
    assert.equal(code, 2);
    assert.match(stderr, /Not logged in\./);
  });

  test("init --all --json signed-out carries hint + exit_code 2", async () => {
    plantOpencodeStub();
    const { code, stdout } = await cli(["init", "--all", "--json"], {
      env: { PATH: stubsOnlyPath(), AIAND_API_KEY: "" },
    });
    assert.equal(code, 2);
    const [row] = JSON.parse(stdout).agents;
    assert.equal(row.failed, true);
    assert.equal(row.exit_code, 2);
    assert.match(row.note, /Not logged in/);
    assert.match(row.hint, /aiand login/);
  });

  test("init --all puts a failed agent's reason on stderr", async () => {
    plantOpencodeStub();
    writeSettings(
      `${JSON.stringify({
        provider: {
          aiand: {
            options: { baseURL: "https://foreign.example.com/v1", apiKey: "sk-foreign-1" },
          },
        },
      })}\n`,
    );
    const { code, stdout, stderr } = await cli(["init", "--all"], {
      env: { PATH: stubsOnlyPath() },
    });
    assert.equal(code, 1);
    assert.match(stderr, /does not manage/);
    assert.doesNotMatch(stdout, /does not manage/);
  });
});

// --- init: warnings surface like the direct verb ------------------------------------

describe("init: warnings", () => {
  test("init surfaces the same model warnings as the direct on verb", async () => {
    plantOpencodeStub();
    const direct = await cli(["opencode", "on"], { withStubs: true });
    assert.equal(direct.code, 0, direct.stderr);
    const warning = /(\S+ is text-only and can't take images\.)/.exec(direct.stderr)?.[1];
    assert.ok(warning, `direct on should warn, got: ${direct.stderr}`);

    const viaInit = await cli(["init", "opencode"], { withStubs: true });
    assert.equal(viaInit.code, 0, viaInit.stderr);
    assert.ok(viaInit.stderr.includes(warning), `init should repeat it, got: ${viaInit.stderr}`);
  });

  test("init --json success rows include warnings", async () => {
    plantOpencodeStub();
    const { code, stdout } = await cli(["init", "opencode", "--json"], { withStubs: true });
    assert.equal(code, 0);
    const [row] = JSON.parse(stdout).agents;
    assert.equal(row.failed, undefined);
    assert.ok(
      (row.warnings ?? []).some((w) => /text-only and can't take images/.test(w)),
      `expected a text-only warning, got: ${JSON.stringify(row.warnings)}`,
    );
  });
});

// --- init / on / off / restore round-trips -----------------------------------------

describe("init: wiring round-trips", () => {
  test("init --off with no routed agents -> friendly no-op, exit 0", async () => {
    const { code, stdout } = await cli(["init", "--off"]);
    assert.equal(code, 0);
    assert.match(stdout, /No agents are currently wired to ai&\./);
  });

  test("init --off ignores leftover snapshots once the agent is already off", async () => {
    plantOpencodeStub();
    writeSettings();
    const on = await cli(["init", "opencode"], { withStubs: true });
    assert.equal(on.code, 0);
    const off = await cli(["init", "--off", "opencode"], { withStubs: true });
    assert.equal(off.code, 0);
    // Snapshot remains for restore --force; bare init --off must not treat
    // that as still routed.
    const again = await cli(["init", "--off"]);
    assert.equal(again.code, 0);
    assert.match(again.stdout, /No agents are currently wired to ai&\./);
  });

  test("init opencode wires on; init --off opencode and opencode off strip our keys", async () => {
    plantOpencodeStub();
    writeSettings();

    const onResult = await cli(["init", "opencode"], { withStubs: true });
    assert.equal(onResult.code, 0);
    const wiredBytes = readFileSync(settingsPath(), "utf8");
    assert.notEqual(wiredBytes, ORIGINAL_SETTINGS, "wiring should rewrite opencode.json");
    assert.match(wiredBytes, /aiand\/zai-org\/glm-5\.3/);
    assert.equal(JSON.parse(wiredBytes).enabled_providers, undefined);

    const offA = await cli(["opencode", "off"], { withStubs: true });
    assert.equal(offA.code, 0);
    // Untouched since on: surgical off must return the pre-aiand bytes exactly.
    assert.equal(readFileSync(settingsPath(), "utf8"), ORIGINAL_SETTINGS);
    assertAiandStripped(readFileSync(settingsPath(), "utf8"));
    assert.match(offA.stdout, /is off/);
    assert.doesNotMatch(offA.stdout, /previous config was restored/);

    const onAgain = await cli(["init", "opencode"], { withStubs: true });
    assert.equal(onAgain.code, 0);
    assert.notEqual(readFileSync(settingsPath(), "utf8"), ORIGINAL_SETTINGS);
    const offB = await cli(["init", "--off", "opencode"], { withStubs: true });
    assert.equal(offB.code, 0);
    // Re-wired from the subtracted original with no edits: byte-identical again.
    assert.equal(readFileSync(settingsPath(), "utf8"), ORIGINAL_SETTINGS);
    assert.equal(assertAiandStripped(readFileSync(settingsPath(), "utf8")).theme, "dark");
  });

  test("init --all wires the detected agent", async () => {
    plantOpencodeStub();
    writeSettings();
    const path = stubsOnlyPath();
    const { code, stdout } = await cli(["init", "--all", "--json"], { env: { PATH: path } });
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    const byId = Object.fromEntries(parsed.agents.map((row) => [row.agent, row]));
    assert.equal(byId.opencode.state, "on", "wiring agent still wires");

    const off = await cli(["init", "--off"], { env: { PATH: path } });
    assert.equal(off.code, 0);
    assert.equal(assertAiandStripped(readFileSync(settingsPath(), "utf8")).theme, "dark");
  });

  test("on → user edits the file → off keeps their edit", async () => {
    plantOpencodeStub();
    writeSettings();

    const onResult = await cli(["init", "opencode"], { withStubs: true });
    assert.equal(onResult.code, 0);
    const wired = JSON.parse(readFileSync(settingsPath(), "utf8"));
    wired.autoupdate = true;
    writeFileSync(settingsPath(), `${JSON.stringify(wired, null, 2)}\n`);

    const off = await cli(["opencode", "off"], { withStubs: true });
    assert.equal(off.code, 0);
    const after = assertAiandStripped(readFileSync(settingsPath(), "utf8"));
    assert.equal(after.theme, "dark");
    assert.equal(after.autoupdate, true);
  });

  test("restore --force puts the snapshot back; restore without --force refuses", async () => {
    plantOpencodeStub();
    writeSettings();

    const onResult = await cli(["init", "opencode"], { withStubs: true });
    assert.equal(onResult.code, 0);

    const refused = await cli(["restore", "opencode"], { withStubs: true });
    assert.notEqual(refused.code, 0);
    assert.match(`${refused.stderr}${refused.stdout}`, /--force/);

    const restored = await cli(["restore", "opencode", "--force"], { withStubs: true });
    assert.equal(restored.code, 0);
    assert.equal(readFileSync(settingsPath(), "utf8"), ORIGINAL_SETTINGS);
  });

  test("init --profile bakes that profile's key", async () => {
    plantOpencodeStub();
    const { saveCredential } = await import("../dist/config.js");
    await withEnv({ AIAND_KEY_STORAGE: "plaintext" }, () =>
      saveCredential("work", { access_token: "sk-work-profile-1", origin: "paste" }),
    );
    mkdirSync(dirname(settingsPath()), { recursive: true });

    const { code } = await cli(["init", "opencode", "--profile", "work"], {
      withStubs: true,
      env: { AIAND_API_KEY: "", AIAND_KEY_STORAGE: "plaintext" },
    });
    assert.equal(code, 0);
    const config = JSON.parse(readFileSync(settingsPath(), "utf8"));
    assert.equal(config.provider.aiand.options.apiKey, "sk-work-profile-1");
  });
});
