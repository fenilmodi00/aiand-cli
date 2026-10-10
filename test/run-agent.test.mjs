import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { describe, test } from "node:test";
import {
  BIN,
  catalogModel,
  harnessEnv,
  hermeticPath,
  plantStub,
  runCli,
  seedCatalogCache,
  WAIT_TIMEOUT_MS,
  withEnv,
  withMockGateway,
  withTestEnv,
} from "./helpers.mjs";

const { run, routingBanner } = await import("../dist/commands/run-agent.js");
const { sessionReceipt, sumSessionUsage, sessionUsageFooter } = await import(
  "../dist/commands/session-usage.js"
);
const { _setColorEnabled } = await import("../dist/cli/output.js");

// --- Stub-agent scaffolding ------------------------------------------------
// A temp bin dir holds shell stub scripts that dump the child env + argv to
// capture files and exit 42. The catalog cache is seeded so getCatalog never
// touches the network.

const CAPTURE_STUB = `env > "$AIAND_CAPTURE.env"
printf '%s\\n' "$@" > "$AIAND_CAPTURE.args"
exit 42`;

// A stub that always writes a marker file, so an invalid --model (which must
// never spawn the child) can be detected by the marker's absence.
const MARKER_STUB = `touch "$AIAND_MARKER"
exit 42`;

// A stub that dumps env, then lingers until the test drops $AIAND_DONE (or a
// bounded wait expires), so the launcher parent can be signaled mid-session.
const LINGER_STUB = `env > "$AIAND_CAPTURE.env"
i=0
while [ ! -f "$AIAND_DONE" ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done`;

const CATALOG = [catalogModel("aiand/glm-5.3"), catalogModel("aiand/other")];

let home, cfg, binDir;

const env = withTestEnv("aiand-runagent-", (dir) => {
  home = join(dir, "home");
  cfg = join(dir, "cfg");
  binDir = join(dir, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  // Seed a fresh catalog cache so session launches never hit the network.
  seedCatalogCache(cfg, { baseUrl: "https://api.aiand.com", models: CATALOG });
});

const plantCaptureStub = (name) => plantStub(binDir, name, CAPTURE_STUB);
const plantMarkerStub = (name) => plantStub(binDir, name, MARKER_STUB);
const plantLingerStub = (name) => plantStub(binDir, name, LINGER_STUB);

/** A fresh capture dir under the file's temp dir. */
const captureDir = () => mkdtempSync(join(env.dir, "cap-"));

/**
 * The launcher child's whole environment: only what the launcher needs, so
 * the stub's env dump shows exactly what run-agent forwards. An explicit
 * undefined deletes a default (`AIAND_API_KEY: undefined` is signed out).
 */
function launcherEnv(captureRoot, extraEnv = {}) {
  const raw = {
    ...harnessEnv(),
    AIAND_HOME: home,
    AIAND_CONFIG_DIR: cfg,
    AIAND_API_KEY: "sk-test-aiand",
    PATH: `${binDir}${delimiter}${process.env.PATH}`,
    AIAND_CAPTURE: join(captureRoot, "capture"),
    ...extraEnv,
  };
  return Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
}

const stubCli = (args, extraEnv, captureRoot) =>
  runCli(["run-agent", ...args], { env: launcherEnv(captureRoot, extraEnv) });

// Sessionless env for direct run() calls: no key and an empty config dir, so
// a missing validation would surface as NotLoggedIn instead.
function withoutSession(fn) {
  const empty = mkdtempSync(join(env.dir, "nosess-"));
  return withEnv({ AIAND_API_KEY: undefined, AIAND_HOME: empty, AIAND_CONFIG_DIR: empty }, fn);
}

/** Stubs + system probe dirs only, with node resolved through the stub dir. */
function stubsOnlyPath() {
  try {
    symlinkSync(process.execPath, join(binDir, "node"));
  } catch {
    // Already linked by an earlier test in this file.
  }
  return hermeticPath(binDir, "/usr/bin", "/bin");
}

describe("run-agent launcher", () => {
  test("opencode: OPENCODE_CONFIG_CONTENT carries the session key, exit 42 propagates", async () => {
    plantCaptureStub("opencode");
    const capture = captureDir();
    try {
      const { code } = await stubCli(["opencode", "--", "--version"], {}, capture);
      assert.equal(code, 42);

      const envText = readFileSync(join(capture, "capture.env"), "utf8");
      const match = envText.match(/^OPENCODE_CONFIG_CONTENT=(.*)$/m);
      const config = JSON.parse(match[1]);
      // Key rides in a throwaway 0600 file via {file:} substitution, not
      // the child env; the launcher's cleanup unlinks it after the exit.
      assert.match(config.provider?.aiand?.options?.apiKey, /^\{file:.+\}$/);
      // The CLI has exited: the launcher's cleanup must already have
      // unlinked the throwaway key file (contents + 0600 are covered in
      // test/agents-opencode.test.mjs while the launch is still live).
      const keyFile = config.provider.aiand.options.apiKey.slice("{file:".length, -1);
      assert.equal(existsSync(keyFile), false);
      assert.match(readFileSync(join(capture, "capture.args"), "utf8"), /^--version\n/);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("claude: a throwaway --settings file carries the key, never the child env", async () => {
    plantCaptureStub("claude");
    const capture = captureDir();
    try {
      const { code } = await stubCli(["claude", "--", "--version"], {}, capture);
      assert.equal(code, 42);
      const args = readFileSync(join(capture, "capture.args"), "utf8").split("\n");
      assert.equal(args[0], "--settings");
      assert.equal(args[2], "--version");
      // Contents and 0600 are covered in test/agents-claude.test.mjs; after
      // the exit the launcher's cleanup must have removed the file.
      assert.equal(existsSync(args[1]), false);
      assert.doesNotMatch(readFileSync(join(capture, "capture.env"), "utf8"), /sk-test-aiand/);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("-- passthrough preserves flags and order verbatim", async () => {
    plantCaptureStub("opencode");
    const capture = captureDir();
    try {
      await stubCli(["opencode", "--", "--version", "--flag", "x"], {}, capture);
      const args = readFileSync(join(capture, "capture.args"), "utf8").trim().split("\n");
      assert.deepEqual(args, ["--version", "--flag", "x"]);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("non-flag positional before -- is passthrough too", async () => {
    plantCaptureStub("opencode");
    const capture = captureDir();
    try {
      await stubCli(["opencode", "--model", "aiand/glm-5.3", "--", "extra", "--args"], {}, capture);
      const args = readFileSync(join(capture, "capture.args"), "utf8").trim().split("\n");
      assert.deepEqual(args, ["extra", "--args"]);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("no agent name -> CliError usage hint", async () => {
    const { code, stderr } = await stubCli([], {}, env.dir);
    assert.equal(code, 1);
    assert.match(stderr, /run-agent needs a coding agent name/i);
    assert.match(stderr, /aiand run-agent opencode -- --version/i);
  });

  test("invalid --model -> exit 1 with valid-ids hint, child never spawned", async () => {
    // opencode stub writes a marker file only when actually spawned; an invalid
    // model must fail before spawn, so the marker never appears.
    plantMarkerStub("opencode");
    const capture = captureDir();
    const marker = join(capture, "marker");
    try {
      const { code, stderr } = await stubCli(
        ["opencode", "--model", "nope"],
        { AIAND_MARKER: marker },
        capture,
      );
      assert.equal(code, 1);
      assert.match(stderr, /--model "nope" is not in the catalog/);
      assert.match(stderr, /Valid ids: aiand\/glm-5.3, aiand\/other/);
      assert.throws(() => readFileSync(marker, "utf8"), /ENOENT/);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("unknown agent -> exit 1 listing the opencode registry", async () => {
    const { code, stderr } = await stubCli(["not-an-agent"], {}, env.dir);
    assert.equal(code, 1);
    assert.match(stderr, /Unknown agent "not-an-agent"/);
    assert.match(stderr, /Agents: opencode/);
  });

  test("missing binary -> 127 with install hint", async () => {
    // The hermetic PATH hides any real opencode install (the launcher would
    // spawn it and hang on a TTY), and the stub earlier tests planted is
    // removed, so detect() misses: 127 + install hint.
    rmSync(join(binDir, "opencode"), { force: true });
    const capture = captureDir();
    const path = stubsOnlyPath();
    try {
      const { code, stderr } = await stubCli(["opencode"], { PATH: path }, capture);
      assert.equal(code, 127);
      assert.match(stderr, /OpenCode is not installed/);
      assert.match(stderr, /Install it with:/);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("signed-out + missing binary -> 127 with install hint, never a login", async () => {
    // Detect runs before session: no Env key and no binary is still 127 +
    // Install hint, never "Not logged in" or a login ceremony.
    rmSync(join(binDir, "opencode"), { force: true });
    const capture = captureDir();
    const path = stubsOnlyPath();
    try {
      const { code, stderr } = await stubCli(
        ["opencode"],
        { PATH: path, AIAND_API_KEY: undefined },
        capture,
      );
      assert.equal(code, 127);
      assert.match(stderr, /OpenCode is not installed/);
      assert.match(stderr, /Install it with:/);
      assert.doesNotMatch(stderr, /Not logged in/);
      assert.doesNotMatch(stderr, /aiand login/);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("signed-out + binary present -> Not logged in, never 127", async () => {
    // With the binary present, the session key still resolves first, so a
    // signed-out launch fails as NotLoggedIn.
    plantCaptureStub("opencode");
    await withoutSession(() =>
      withEnv({ PATH: `${binDir}${delimiter}${process.env.PATH}` }, () =>
        assert.rejects(run(["opencode"]), (error) => {
          assert.match(error.message, /Not logged in/);
          assert.doesNotMatch(error.message, /is not installed/);
          return true;
        }),
      ),
    );
  });

  test("throwaway config has tool_call true when the catalog lists tools", async () => {
    // The seeded catalog fixture carries capabilities ["tools"]; the session
    // overlay must map that to tool_call true on every model entry.
    plantCaptureStub("opencode");
    const capture = captureDir();
    try {
      const { code } = await stubCli(["opencode"], {}, capture);
      assert.equal(code, 42);
      const envText = readFileSync(join(capture, "capture.env"), "utf8");
      const match = envText.match(/^OPENCODE_CONFIG_CONTENT=(.*)$/m);
      assert.ok(match, "OPENCODE_CONFIG_CONTENT in child env");
      const config = JSON.parse(match[1]);
      assert.equal(config.provider.aiand.models["aiand/glm-5.3"].tool_call, true);
      assert.equal(config.provider.aiand.models["aiand/other"].tool_call, true);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("opencode: OPENCODE_CONFIG_CONTENT carries provider.aiand config", async () => {
    // opencode is registered and its sessionLaunch emits OPENCODE_CONFIG_CONTENT.
    // When --model is omitted the launcher resolves a default, so a concrete
    // aiand/<id> root ref appears.
    plantCaptureStub("opencode");
    const capture = captureDir();
    try {
      const { code } = await stubCli(["opencode"], {}, capture);
      assert.equal(code, 42);
      const envText = readFileSync(join(capture, "capture.env"), "utf8");
      const match = envText.match(/^OPENCODE_CONFIG_CONTENT=(.*)$/m);
      assert.ok(match, "OPENCODE_CONFIG_CONTENT in child env");
      const config = JSON.parse(match[1]);
      assert.ok(config.provider?.aiand, "provider.aiand present");
      assert.match(config.provider.aiand.options?.baseURL, /^https:\/\/api\.aiand\.com/);
      assert.ok(config.model, "a concrete model root ref resolved");
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("omitted --model uses the profile model when still in the catalog", async () => {
    // Seeded catalog lists aiand/glm-5.3 first (the fallback default) — a
    // profile model of aiand/other must win the root ref instead.
    plantCaptureStub("opencode");
    writeFileSync(
      join(cfg, "config.json"),
      JSON.stringify({ profile: "default", profiles: { default: { model: "aiand/other" } } }),
    );
    const capture = captureDir();
    try {
      const { code } = await stubCli(["opencode"], {}, capture);
      assert.equal(code, 42);
      const envText = readFileSync(join(capture, "capture.env"), "utf8");
      const config = JSON.parse(envText.match(/^OPENCODE_CONFIG_CONTENT=(.*)$/m)[1]);
      assert.equal(config.model, "aiand/aiand/other");
    } finally {
      writeFileSync(join(cfg, "config.json"), JSON.stringify({ profile: "default", profiles: {} }));
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("explicit --model wins over the profile model", async () => {
    plantCaptureStub("opencode");
    writeFileSync(
      join(cfg, "config.json"),
      JSON.stringify({ profile: "default", profiles: { default: { model: "aiand/other" } } }),
    );
    const capture = captureDir();
    try {
      const { code } = await stubCli(["opencode", "--model", "aiand/glm-5.3"], {}, capture);
      assert.equal(code, 42);
      const envText = readFileSync(join(capture, "capture.env"), "utf8");
      const config = JSON.parse(envText.match(/^OPENCODE_CONFIG_CONTENT=(.*)$/m)[1]);
      assert.equal(config.model, "aiand/aiand/glm-5.3");
    } finally {
      writeFileSync(join(cfg, "config.json"), JSON.stringify({ profile: "default", profiles: {} }));
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("http --base-url rejects with the https error before session key resolution", async () => {
    // Sessionless: without the early guard this fails as NotLoggedIn, so the
    // https error proves validation runs before session key resolution.
    await withoutSession(() =>
      assert.rejects(run(["opencode", "--base-url", "http://evil.example"]), (error) => {
        assert.match(error.message, /Base URL must use https/);
        assert.doesNotMatch(error.message, /Not logged in/);
        return true;
      }),
    );
  });

  test("--help with a bad --base-url still prints help (no https error)", async () => {
    // Help must win over base-url validation so `run-agent --help --base-url
    // http://…` is usable.
    await withoutSession(async () => {
      const chunks = [];
      const originalWrite = process.stdout.write;
      process.stdout.write = (chunk, ...rest) => {
        chunks.push(String(chunk));
        return originalWrite.call(process.stdout, chunk, ...rest);
      };
      try {
        await run(["--help", "--base-url", "http://evil.example"]);
      } finally {
        process.stdout.write = originalWrite;
      }
      assert.match(chunks.join(""), /run-agent/);
    });
  });

  test("omitted --base-url passes the profile apiUrl into sessionLaunch", async () => {
    plantCaptureStub("opencode");
    const custom = "https://gw.example.test";
    writeFileSync(
      join(cfg, "config.json"),
      JSON.stringify({ profile: "default", profiles: { default: { apiUrl: custom } } }),
    );
    seedCatalogCache(cfg, { baseUrl: custom, models: CATALOG });
    const capture = captureDir();
    try {
      const { code } = await stubCli(["opencode"], {}, capture);
      assert.equal(code, 42);
      const envText = readFileSync(join(capture, "capture.env"), "utf8");
      const match = envText.match(/^OPENCODE_CONFIG_CONTENT=(.*)$/m);
      assert.ok(match, "OPENCODE_CONFIG_CONTENT in child env");
      const config = JSON.parse(match[1]);
      assert.equal(config.provider?.aiand?.options?.baseURL, `${custom}/v1`);
    } finally {
      writeFileSync(join(cfg, "config.json"), JSON.stringify({ profile: "default", profiles: {} }));
      seedCatalogCache(cfg, { baseUrl: "https://api.aiand.com", models: CATALOG });
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("child env scrubs AIAND_API_KEY but keeps the adapter injection", async () => {
    // stubCli always sets AIAND_API_KEY in the parent env; the launcher must
    // not forward it — the adapter's own injection carries the key instead.
    plantCaptureStub("opencode");
    const capture = captureDir();
    try {
      const { code } = await stubCli(["opencode"], {}, capture);
      assert.equal(code, 42);
      const envText = readFileSync(join(capture, "capture.env"), "utf8");
      assert.doesNotMatch(envText, /^AIAND_API_KEY=/m);
      assert.match(envText, /^OPENCODE_CONFIG_CONTENT=/m);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("routingBanner includes the model parenthetical when a model resolves", () => {
    assert.equal(
      routingBanner("Claude Code", "zai-org/glm-5.3"),
      "aiand ▸ Routing Claude Code → ai& (zai-org/glm-5.3)",
    );
  });

  test("routingBanner omits the parenthetical when no model resolves", () => {
    assert.equal(routingBanner("OpenCode", undefined), "aiand ▸ Routing OpenCode → ai&");
  });

  test("routingBanner treats an empty model as absent", () => {
    assert.equal(routingBanner("X", ""), "aiand ▸ Routing X → ai&");
  });

  test("routingBanner right-aligns a dim detail on a TTY width", () => {
    const line = routingBanner("Claude Code", "zai-org/glm-5.3", "ai& models", 80);
    // 51 visible columns + padding to the 76-column cap lands the detail
    // at the right edge (min(76, max(24, width-2))).
    assert.match(
      line,
      /^aiand ▸ Routing Claude Code → ai& \(zai-org\/glm-5\.3\)\s{25}(?:\x1b\[2m)?ai& models(?:\x1b\[22m)?$/,
    );
  });

  test("routingBanner drops the detail when the line already fills the width", () => {
    assert.equal(
      routingBanner("Claude Code", "zai-org/glm-5.3", "ai& models", 40),
      "aiand ▸ Routing Claude Code → ai& (zai-org/glm-5.3)",
    );
  });

  test("routingBanner without a width keeps the piped form exactly", () => {
    assert.equal(
      routingBanner("Claude Code", "zai-org/glm-5.3", "ai& models"),
      "aiand ▸ Routing Claude Code → ai& (zai-org/glm-5.3)",
    );
  });

  test("successful launch prints the banner to stderr before child output", async () => {
    plantStub(binDir, "opencode", `echo child-marker >&2\n${CAPTURE_STUB}`);
    const capture = captureDir();
    try {
      const { code, stderr } = await stubCli(["opencode", "--model", "aiand/glm-5.3"], {}, capture);
      assert.equal(code, 42);
      const banner = "aiand ▸ Routing OpenCode → ai& (aiand/glm-5.3)";
      assert.ok(stderr.includes(banner), `banner in stderr:\n${stderr}`);
      assert.ok(
        stderr.indexOf(banner) < stderr.indexOf("child-marker"),
        `banner before child output:\n${stderr}`,
      );
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("omitted --model prints the banner without a model parenthetical", async () => {
    plantCaptureStub("opencode");
    const capture = captureDir();
    try {
      const { code, stderr } = await stubCli(["opencode"], {}, capture);
      assert.equal(code, 42);
      assert.match(stderr, /aiand ▸ Routing OpenCode → ai&/);
      assert.doesNotMatch(stderr, /aiand ▸ Routing OpenCode → ai& \(/);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("missing binary prints no routing banner", async () => {
    rmSync(join(binDir, "opencode"), { force: true });
    const capture = captureDir();
    const path = stubsOnlyPath();
    try {
      const { code, stderr } = await stubCli(["opencode"], { PATH: path }, capture);
      assert.equal(code, 127);
      assert.doesNotMatch(stderr, /▸ Routing/);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("http loopback --base-url passes https validation", async () => {
    // Same sessionless env: the failure must come from a later stage
    // (session, detection), never the https guard.
    await withoutSession(() =>
      assert.rejects(run(["opencode", "--base-url", "http://localhost:1234"]), (error) => {
        assert.doesNotMatch(error.message, /Base URL must use https/);
        return true;
      }),
    );
  });

  for (const [signal, expectedCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    test(`${signal} to run-agent removes the throwaway key dir before exit`, async () => {
      if (process.platform === "win32") return;
      plantLingerStub("opencode");
      const capture = captureDir();
      const doneFile = join(capture, "done");
      const child = spawn(process.execPath, [BIN, "run-agent", "opencode"], {
        env: launcherEnv(capture, { AIAND_DONE: doneFile }),
        stdio: "ignore",
      });
      try {
        // Wait until the stub dump includes the overlay (existsSync alone
        // races: `env > file` truncates before env finishes writing).
        const captureEnv = join(capture, "capture.env");
        const deadline = Date.now() + WAIT_TIMEOUT_MS;
        let envText = "";
        while (Date.now() < deadline) {
          if (existsSync(captureEnv)) {
            envText = readFileSync(captureEnv, "utf8");
            if (/^OPENCODE_CONFIG_CONTENT=/m.test(envText)) break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        const match = envText.match(/^OPENCODE_CONFIG_CONTENT=(.*)$/m);
        assert.ok(match, "OPENCODE_CONFIG_CONTENT in child env");
        const apiKey = JSON.parse(match[1]).provider.aiand.options.apiKey;
        assert.match(apiKey, /^\{file:.+\}$/);
        const keyFile = apiKey.slice("{file:".length, -1);
        assert.ok(keyFile.includes("aiand-opencode-"));
        assert.equal(existsSync(keyFile), true);
        // Signal the parent only: cleanup must wipe the dir before exit.
        child.kill(signal);
        const exitCode = await new Promise((resolve) => child.on("exit", (code) => resolve(code)));
        assert.equal(exitCode, expectedCode);
        assert.equal(existsSync(keyFile), false);
        assert.equal(existsSync(dirname(keyFile)), false);
      } finally {
        writeFileSync(doneFile, "done");
        child.kill("SIGKILL");
        rmSync(capture, { recursive: true, force: true });
      }
    });
  }
});

describe("session usage footer", () => {
  test("sumSessionUsage treats null tokens as 0 and adds entries up", () => {
    const totals = sumSessionUsage([
      { input_tokens: 100, output_tokens: null, cached_tokens: 5, cost: 0.5, currency: "usd" },
      { input_tokens: null, output_tokens: 40, cached_tokens: null, cost: 0.25, currency: null },
    ]);
    assert.deepEqual(totals, {
      inputTokens: 100,
      outputTokens: 40,
      cachedTokens: 5,
      cost: 0.75,
      currency: "usd",
    });
  });

  test("sumSessionUsage parses cost strings and drops NaN costs", () => {
    const totals = sumSessionUsage([
      { input_tokens: 1, output_tokens: 1, cached_tokens: null, cost: "0.0123", currency: null },
      {
        input_tokens: 1,
        output_tokens: 1,
        cached_tokens: null,
        cost: "not-a-number",
        currency: null,
      },
    ]);
    assert.equal(totals.cost, 0.0123);
    assert.equal(totals.inputTokens, 2);
  });

  test("sessionUsageFooter is null when in+out tokens are zero", () => {
    assert.equal(
      sessionUsageFooter({
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 7,
        cost: 0.5,
        currency: null,
      }),
      null,
    );
  });

  test("sessionUsageFooter formats thousands and 4-decimal USD", () => {
    assert.equal(
      sessionUsageFooter({
        inputTokens: 45231,
        outputTokens: 8210,
        cachedTokens: 0,
        cost: 0.0123,
        currency: null,
      }),
      "aiand ▸ session: 45,231 in / 8,210 out · $0.0123",
    );
  });

  test("sessionUsageFooter renders cached tokens only when nonzero", () => {
    assert.equal(
      sessionUsageFooter({
        inputTokens: 45231,
        outputTokens: 8210,
        cachedTokens: 12004,
        cost: 0.0123,
        currency: null,
      }),
      "aiand ▸ session: 45,231 in / 8,210 out · 12,004 cached · $0.0123",
    );
  });

  test("sessionUsageFooter appends the lowercase code for non-usd", () => {
    assert.equal(
      sessionUsageFooter({
        inputTokens: 12,
        outputTokens: 3,
        cachedTokens: 0,
        cost: 1.2345,
        currency: "eur",
      }),
      "aiand ▸ session: 12 in / 3 out · 1.2345 (eur)",
    );
    // A known symbol still prefixes the amount, then the code.
    assert.equal(
      sessionUsageFooter({
        inputTokens: 1,
        outputTokens: 1,
        cachedTokens: 0,
        cost: 2.5,
        currency: "jpy",
      }),
      "aiand ▸ session: 1 in / 1 out · ¥2.5000 (jpy)",
    );
  });
});

describe("session receipt", () => {
  test("renders four cells with header and bold spend at TTY width", () => {
    _setColorEnabled(true);
    try {
      const receipt = sessionReceipt(
        {
          inputTokens: 123456,
          outputTokens: 78901,
          cachedTokens: 456789,
          cost: 0.05612,
          currency: "usd",
        },
        "Claude Code",
        305_000,
        80,
      );
      const lines = receipt.split("\n");
      assert.match(lines[1], /Session receipt · Claude Code · 5min/);
      assert.match(lines[2], /\x1b\[1m\$0\.06\x1b\[22m\s+123\.5K\s+456\.8K\s+78\.9K$/);
      assert.match(lines[3].trimEnd(), /spent\s+in\s+cached\s+out$/);
    } finally {
      _setColorEnabled(false);
    }
  });

  test("falls back to two cells below width 34", () => {
    const receipt = sessionReceipt(
      { inputTokens: 10, outputTokens: 5, cachedTokens: 0, cost: 0.02, currency: null },
      "OpenCode",
      30_000,
      30,
    );
    const lines = receipt.split("\n");
    assert.match(lines[2], /\$0\.02\s+5$/);
    assert.match(lines[3].trimEnd(), /spent\s+out$/);
    assert.doesNotMatch(lines[3], /cached/);
  });

  test("sub-cent costs keep four decimals; non-finite prints the dash", () => {
    const tiny = sessionReceipt(
      { inputTokens: 100, outputTokens: 50, cachedTokens: 0, cost: 0.0012, currency: "usd" },
      "X",
      5_400_000,
      80,
    );
    assert.match(tiny.split("\n")[1], /1h 30m$/);
    assert.match(tiny.split("\n")[2], /\$0\.0012/);

    const nanCost = sessionReceipt(
      { inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: Number.NaN, currency: "usd" },
      "X",
      30_000,
      80,
    );
    assert.match(nanCost.split("\n")[2], /\$—/);
  });

  test("null when the session has no tokens", () => {
    assert.equal(
      sessionReceipt(
        { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0, currency: null },
        "X",
        1000,
        80,
      ),
      null,
    );
  });
});

describe("run-agent session usage footer", () => {
  test("stderr footer after child exit sums only this session's entries", async () => {
    await withMockGateway(async ({ url }) => {
      const base = `${url}/stub/session-usage`;
      seedCatalogCache(cfg, { baseUrl: base, models: CATALOG });
      // Echo a marker from the child so the footer's position after the
      // session (not before spawn) is observable on the same stream.
      plantStub(binDir, "opencode", `echo child-marker >&2\n${CAPTURE_STUB}`);
      const capture = captureDir();
      try {
        const { code, stdout, stderr } = await stubCli(
          ["opencode"],
          { AIAND_BASE_URL: base },
          capture,
        );
        assert.equal(code, 42);
        const footer = "aiand ▸ session: 1,000 in / 200 out · 10 cached · $0.0123";
        assert.ok(stderr.includes(footer), `footer in stderr:\n${stderr}`);
        assert.ok(
          stderr.indexOf("child-marker") < stderr.indexOf(footer),
          `footer after child output:\n${stderr}`,
        );
        assert.doesNotMatch(stdout, /aiand ▸ session:/);
      } finally {
        seedCatalogCache(cfg, { baseUrl: "https://api.aiand.com", models: CATALOG });
        rmSync(capture, { recursive: true, force: true });
      }
    });
  });

  test("a gateway with no /logs route prints no footer, exit code unaffected", async () => {
    await withMockGateway(async ({ url }) => {
      const base = `${url}/stub/logs-404`;
      seedCatalogCache(cfg, { baseUrl: base, models: CATALOG });
      plantCaptureStub("opencode");
      const capture = captureDir();
      try {
        const { code, stderr } = await stubCli(["opencode"], { AIAND_BASE_URL: base }, capture);
        assert.equal(code, 42);
        assert.doesNotMatch(stderr, /aiand ▸ session:/);
      } finally {
        seedCatalogCache(cfg, { baseUrl: "https://api.aiand.com", models: CATALOG });
        rmSync(capture, { recursive: true, force: true });
      }
    });
  });

  test("a hung /logs reply aborts at the deadline: exit bounded, no footer", async () => {
    await withMockGateway(async ({ url }) => {
      const base = `${url}/stub/hung-logs`;
      seedCatalogCache(cfg, { baseUrl: base, models: CATALOG });
      plantCaptureStub("opencode");
      const capture = captureDir();
      const started = Date.now();
      try {
        const { code, stderr } = await stubCli(["opencode"], { AIAND_BASE_URL: base }, capture);
        // The child's code still propagates, and the footer fetch's abort
        // (~1.5s) bounds the exit: without it, the hung fetch socket keeps
        // the event loop alive and runCli never resolves.
        assert.equal(code, 42);
        assert.doesNotMatch(stderr, /aiand ▸ session:/);
        assert.ok(Date.now() - started < 10_000, "exit bounded by the abort");
      } finally {
        seedCatalogCache(cfg, { baseUrl: "https://api.aiand.com", models: CATALOG });
        rmSync(capture, { recursive: true, force: true });
      }
    });
  });
});
