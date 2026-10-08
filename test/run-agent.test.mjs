import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
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
  withTestEnv,
} from "./helpers.mjs";

const { run } = await import("../dist/commands/run-agent.js");
const { registerAgent } = await import("../dist/agents/registry.js");

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
      // ANTHROPIC_API_KEY rides along here: the hermes-only child-env
      // cleanup below must not strip it for other agents.
      const { code } = await stubCli(
        ["opencode", "--", "--version"],
        { ANTHROPIC_API_KEY: "inherited-keep" },
        capture,
      );
      assert.equal(code, 42);

      const envText = readFileSync(join(capture, "capture.env"), "utf8");
      assert.match(envText, /^ANTHROPIC_API_KEY=inherited-keep$/m);
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

  test("codex: -c overrides carry the settings; an env key is handed back, never argv", async () => {
    plantCaptureStub("codex");
    const capture = captureDir();
    try {
      const { code } = await stubCli(["codex", "--", "exec", "hi"], {}, capture);
      assert.equal(code, 42);
      const args = readFileSync(join(capture, "capture.args"), "utf8").split("\n").filter(Boolean);
      assert.equal(args[0], "-c");
      assert.ok(args.includes('model_provider="aiand"'));
      assert.deepEqual(args.slice(-2), ["exec", "hi"]);
      assert.doesNotMatch(args.join(" "), /sk-test-aiand/);
      assert.match(
        readFileSync(join(capture, "capture.env"), "utf8"),
        /^AIAND_API_KEY=sk-test-aiand$/m,
      );
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("pi: overlay dir + session dir env, key never in child env, overlay removed", async () => {
    plantCaptureStub("pi");
    const capture = captureDir();
    try {
      const { code } = await stubCli(["pi", "--", "--version"], {}, capture);
      assert.equal(code, 42);

      const envText = readFileSync(join(capture, "capture.env"), "utf8");
      const agentDir = envText.match(/^PI_CODING_AGENT_DIR=(.*)$/m)?.[1];
      assert.ok(agentDir, "PI_CODING_AGENT_DIR in child env");
      assert.ok(agentDir.includes("aiand-pi-"), "overlay is a throwaway mkdtemp dir");
      const sessionDir = envText.match(/^PI_CODING_AGENT_SESSION_DIR=(.*)$/m)?.[1];
      const encodedCwd = resolve(process.cwd())
        .replace(/^[/\\]/, "")
        .replace(/[/\\:]/g, "-");
      assert.ok(
        sessionDir?.endsWith(join(".pi", "agent", "sessions", `--${encodedCwd}--`)),
        "session history points at the user's real per-cwd session dir",
        String(sessionDir),
      );
      // The key rides the overlay auth.json, never the child env.
      assert.doesNotMatch(envText, /sk-test-aiand/);
      // The CLI has exited: the launcher's cleanup must already have
      // removed the whole overlay.
      assert.equal(existsSync(agentDir), false);

      const args = readFileSync(join(capture, "capture.args"), "utf8").trim().split("\n");
      assert.equal(args[0], "--provider");
      assert.equal(args[1], "aiand");
      assert.equal(args[2], "--model");
      assert.ok(args[3], "a concrete model resolved");
      // runCli pipes stdin, so the launcher must add --print: upstream Pi
      // hangs on redirected stdin without an explicit one-shot mode.
      assert.ok(args.includes("--print"), "--print injected for non-TTY stdin");
      assert.equal(args.at(-1), "--version");
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("pi: user routing flags cannot override the injected routing", async () => {
    plantCaptureStub("pi");
    const capture = captureDir();
    try {
      const { code } = await stubCli(
        [
          "pi",
          "--",
          "--api-key",
          "evil",
          "--provider=openai",
          "--model",
          "gpt-4o",
          "--models",
          "a,b",
          "--print",
        ],
        {},
        capture,
      );
      assert.equal(code, 42);
      const args = readFileSync(join(capture, "capture.args"), "utf8").trim().split("\n");
      assert.equal(args[0], "--provider");
      assert.equal(args[1], "aiand");
      assert.equal(args[2], "--model");
      assert.ok(args[3] !== "gpt-4o", "the user's --model is stripped");
      assert.ok(!args.includes("evil"), "the user's --api-key value is stripped");
      assert.ok(!args.includes("--provider=openai"), "--flag= form stripped");
      assert.ok(!args.includes("gpt-4o"), "the user's --model value is stripped");
      assert.ok(!args.includes("a,b"), "the user's --models value is stripped");
      assert.equal(args.at(-1), "--print", "unrelated flags pass verbatim");
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  // #15
  test("pi: an owned flag followed by another flag keeps the flag (--model --print)", async () => {
    plantCaptureStub("pi");
    const capture = captureDir();
    try {
      const { code } = await stubCli(["pi", "--", "--model", "--print"], {}, capture);
      assert.equal(code, 42);
      const args = readFileSync(join(capture, "capture.args"), "utf8").trim().split("\n");
      // The launcher injects its own --print for piped stdin, so the user's
      // --print surviving the strip shows up twice. The unconditional skip
      // ate the flag after --model as if it were its value.
      assert.equal(
        args.filter((a) => a === "--print").length,
        2,
        `expected the user's --print to survive, got: ${args.join(" ")}`,
      );
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("pi: missing binary -> 127 with the pi install hint", async () => {
    rmSync(join(binDir, "pi"), { force: true });
    const capture = captureDir();
    const path = stubsOnlyPath();
    try {
      const { code, stderr } = await stubCli(["pi"], { PATH: path }, capture);
      assert.equal(code, 127);
      assert.match(stderr, /Pi is not installed/);
      assert.match(stderr, /npm install -g --ignore-scripts @earendil-works\/pi-coding-agent/);
      assert.match(stderr, /https:\/\/pi\.dev/);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  // omp mirrors pi's overlay launch: throwaway PI_CODING_AGENT_DIR holding the
  // key, real session history pointed at separately.
  test("omp: overlay dir + session dir env, key never in child env, overlay removed", async () => {
    plantCaptureStub("omp");
    const capture = captureDir();
    try {
      const { code } = await stubCli(["omp", "--", "--version"], {}, capture);
      assert.equal(code, 42);

      const envText = readFileSync(join(capture, "capture.env"), "utf8");
      const agentDir = envText.match(/^PI_CODING_AGENT_DIR=(.*)$/m)?.[1];
      assert.ok(agentDir, "PI_CODING_AGENT_DIR in child env");
      assert.ok(agentDir.includes("aiand-omp-"), "overlay is a throwaway mkdtemp dir");
      const sessionDir = envText.match(/^PI_CODING_AGENT_SESSION_DIR=(.*)$/m)?.[1];
      assert.ok(
        sessionDir?.endsWith(join(".omp", "agent", "sessions")),
        "session history points at the user's real session dir",
        String(sessionDir),
      );
      // The key rides the overlay models.yml, never the child env.
      assert.doesNotMatch(envText, /sk-test-aiand/);
      // The CLI has exited: the launcher's cleanup must already have
      // removed the whole overlay.
      assert.equal(existsSync(agentDir), false);

      const args = readFileSync(join(capture, "capture.args"), "utf8").trim().split("\n");
      assert.equal(args[0], "--model");
      assert.ok(args[1].startsWith("aiand/"), "a concrete model selector resolved");
      // runCli pipes stdin, so the launcher must add --print: upstream omp
      // hangs on redirected stdin without an explicit one-shot mode.
      assert.ok(args.includes("--print"), "--print injected for non-TTY stdin");
      assert.equal(args.at(-1), "--version");
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("omp: user routing flags cannot override the injected routing", async () => {
    plantCaptureStub("omp");
    const capture = captureDir();
    try {
      const { code } = await stubCli(
        [
          "omp",
          "--",
          "--api-key",
          "evil",
          "--provider=openai",
          "--model",
          "gpt-4o",
          "--models",
          "a,b",
          "--print",
        ],
        {},
        capture,
      );
      assert.equal(code, 42);
      const args = readFileSync(join(capture, "capture.args"), "utf8").trim().split("\n");
      assert.equal(args[0], "--model");
      assert.ok(args[1].startsWith("aiand/"), "our selector comes first");
      assert.ok(!args.includes("evil"), "the user's --api-key value is stripped");
      assert.ok(!args.includes("--provider=openai"), "--flag= form stripped");
      assert.ok(!args.includes("gpt-4o"), "the user's --model value is stripped");
      assert.ok(!args.includes("a,b"), "the user's --models value is stripped");
      assert.equal(args.at(-1), "--print", "unrelated flags pass verbatim");
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("omp: missing binary -> 127 with the omp install hint", async () => {
    rmSync(join(binDir, "omp"), { force: true });
    const capture = captureDir();
    const path = stubsOnlyPath();
    try {
      const { code, stderr } = await stubCli(["omp"], { PATH: path }, capture);
      assert.equal(code, 127);
      assert.match(stderr, /Oh My Pi is not installed/);
      assert.match(stderr, /oh-my-pi\/releases\/download\/v\d+\.\d+\.\d+\/omp-/);
      assert.doesNotMatch(stderr, /\|\s*sh\b/);
      assert.match(stderr, /https:\/\/omp\.sh/);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  // copilot mirrors the overlay launch through COPILOT_HOME: the throwaway
  // dir holds providers.json (with the key) + settings.json, and
  // COPILOT_MODEL pins the qualified selection the CLI accepts.
  test("copilot: overlay env + qualified model, key in the overlay file only, overlay removed", async () => {
    plantStub(
      binDir,
      "copilot",
      `env > "$AIAND_CAPTURE.env"
cp "$COPILOT_HOME/providers.json" "$AIAND_CAPTURE.providers.json"
printf '%s\\n' "$@" > "$AIAND_CAPTURE.args"
exit 42`,
    );
    const capture = captureDir();
    try {
      const { code } = await stubCli(["copilot", "--", "--version"], {}, capture);
      assert.equal(code, 42);

      const envText = readFileSync(join(capture, "capture.env"), "utf8");
      const overlay = envText.match(/^COPILOT_HOME=(.*)$/m)?.[1];
      assert.ok(overlay?.includes("aiand-copilot-"), "COPILOT_HOME is a throwaway overlay");
      assert.match(envText, /^COPILOT_MODEL=aiand\/.+$/m, "qualified selection pins the model");
      assert.match(envText, /^COPILOT_OFFLINE=true$/m, "pure-BYOK mode, no GitHub calls");
      // The key rides the overlay providers.json, never the child env.
      assert.doesNotMatch(envText, /sk-test-aiand/);
      assert.match(readFileSync(join(capture, "capture.providers.json"), "utf8"), /sk-test-aiand/);
      // The child exited: the launcher's cleanup removed the whole overlay.
      assert.equal(existsSync(overlay), false);

      const args = readFileSync(join(capture, "capture.args"), "utf8").trim().split("\n");
      assert.equal(args[0], "--no-auto-update");
      assert.equal(args.at(-1), "--version");
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("copilot: an inherited COPILOT_PROVIDER_* env is dropped", async () => {
    plantCaptureStub("copilot");
    const capture = captureDir();
    try {
      // A user's own BYOK env must not repoint the session off
      // ai&: the CLI reads COPILOT_PROVIDER_* over the overlay,
      // so the launcher deletes exactly copilotAdapter.shadowEnv.
      const { code } = await stubCli(
        ["copilot", "--", "--version"],
        {
          COPILOT_PROVIDER_BASE_URL: "https://my-proxy.example/v1",
          COPILOT_PROVIDER_MODEL_ID: "gpt-5.1",
        },
        capture,
      );
      assert.equal(code, 42);
      const envText = readFileSync(join(capture, "capture.env"), "utf8");
      assert.doesNotMatch(
        envText,
        /^COPILOT_PROVIDER_BASE_URL=/m,
        "inherited provider base URL must not repoint the session",
      );
      assert.doesNotMatch(
        envText,
        /^COPILOT_PROVIDER_MODEL_ID=/m,
        "inherited provider model must not repoint the session",
      );
      // The launcher's own names are injected after the drop.
      assert.match(envText, /^COPILOT_MODEL=aiand\/.+$/m);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("copilot: the user's --model cannot override the injected routing", async () => {
    plantCaptureStub("copilot");
    const capture = captureDir();
    try {
      const { code } = await stubCli(
        ["copilot", "--", "--model", "gpt-4o", "--model=x", "--version"],
        {},
        capture,
      );
      assert.equal(code, 42);
      const args = readFileSync(join(capture, "capture.args"), "utf8").trim().split("\n");
      assert.deepEqual(args, ["--no-auto-update", "--version"]);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  // The filter edge, on copilot's owned flag: an owned flag followed by
  // another flag keeps the flag.
  test("copilot: --model --version keeps --version", async () => {
    plantCaptureStub("copilot");
    const capture = captureDir();
    try {
      const { code } = await stubCli(["copilot", "--", "--model", "--version"], {}, capture);
      assert.equal(code, 42);
      const args = readFileSync(join(capture, "capture.args"), "utf8").trim().split("\n");
      assert.equal(args.at(-1), "--version");
      assert.ok(!args.includes("--model"));
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("copilot: missing binary -> 127 with the npm install hint", async () => {
    rmSync(join(binDir, "copilot"), { force: true });
    const capture = captureDir();
    const path = stubsOnlyPath();
    try {
      const { code, stderr } = await stubCli(["copilot"], { PATH: path }, capture);
      assert.equal(code, 127);
      assert.match(stderr, /GitHub Copilot is not installed/);
      assert.match(stderr, /npm install -g @github\/copilot@/);
      assert.match(stderr, /docs\.github\.com/);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  // The desktop app is config-only: run-agent refuses before any session,
  // pointing at `aiand copilot-app on`.
  test("copilot-app: run-agent refuses session launches", async () => {
    mkdirSync(join(home, ".copilot"), { recursive: true });
    writeFileSync(join(home, ".copilot", "data.db"), "");
    const capture = captureDir();
    try {
      const { code, stderr } = await stubCli(["copilot-app", "--", "--version"], {}, capture);
      assert.equal(code, 1);
      assert.match(stderr, /does not support session launches/);
      assert.match(stderr, /aiand copilot-app on/);
      assert.equal(existsSync(join(capture, "capture.args")), false, "child never spawned");
    } finally {
      rmSync(join(home, ".copilot"), { recursive: true, force: true });
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

  test("--model= inline form validates and launches like the spaced form", async () => {
    // The launcher's `--flag=value` parsing is shared by --model, --profile,
    // and --base-url: the inline form must validate against the catalog and
    // reach the child exactly like `--model <id>`.
    plantCaptureStub("opencode");
    const capture = captureDir();
    try {
      const { code } = await stubCli(
        ["opencode", "--model=aiand/glm-5.3", "--", "extra"],
        {},
        capture,
      );
      assert.equal(code, 42);
      const args = readFileSync(join(capture, "capture.args"), "utf8").trim().split("\n");
      assert.deepEqual(args, ["extra"]);
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

  // The launcher's --model native gate: an adapter that opts in
  // via allowUnpinnedModel reads the literal "native" as "leave
  // the model unpinned" and skips catalog validation; every other
  // adapter keeps the ordinary catalog-membership error.
  test("--model native passes through to an allowUnpinnedModel adapter", async () => {
    // A fixture adapter over the capture stub: sessionLaunch echoes
    // the model it was handed into argv, so the stub's args prove
    // the launcher honored "native" instead of rejecting it.
    plantCaptureStub("native-gate");
    registerAgent({
      id: "native-gate",
      label: "Native Gate Fixture",
      bin: "native-gate",
      detect: () => ({ installed: true }),
      allowUnpinnedModel: true,
      async sessionLaunch(input) {
        return { args: ["--model", input.model ?? "default"], env: {} };
      },
    });
    const capture = captureDir();
    try {
      // run() is called in-process here (the fixture only exists
      // in this process's registry), so the session env the child
      // CLI would get from launcherEnv() must be set on process.env.
      // run() sets process.exitCode in-process; save and restore it
      // around the call so the test process exits clean.
      await withEnv(
        {
          AIAND_HOME: home,
          AIAND_CONFIG_DIR: cfg,
          AIAND_API_KEY: "sk-test-aiand",
          AIAND_CAPTURE: join(capture, "capture"),
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
        },
        async () => {
          const previousExitCode = process.exitCode;
          try {
            await run(["native-gate", "--model", "native", "--", "--version"]);
          } finally {
            assert.equal(process.exitCode, 42, "the child's exit code propagates");
            process.exitCode = previousExitCode;
          }
        },
      );
      const args = readFileSync(join(capture, "capture.args"), "utf8").trim().split("\n");
      assert.deepEqual(args, ["--model", "native", "--version"], "native reached the child argv");
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("--model native is a catalog error for adapters without the opt-in", async () => {
    // opencode does not opt in: the literal must fail validation
    // before any spawn (the marker stub only touches the marker
    // when actually spawned).
    plantMarkerStub("opencode");
    const capture = captureDir();
    const marker = join(capture, "marker");
    try {
      const { code, stderr } = await stubCli(
        ["opencode", "--model", "native"],
        { AIAND_MARKER: marker },
        capture,
      );
      assert.equal(code, 1);
      assert.match(stderr, /--model "native" is not in the catalog/);
      assert.match(stderr, /Valid ids: aiand\/glm-5\.3, aiand\/other/);
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

describe("run-agent hermes launcher", () => {
  /** A real-shaped HERMES_HOME: state to link back, credentials, config. */
  function plantHermesReal() {
    const real = join(env.dir, "hermes-real");
    rmSync(real, { recursive: true, force: true });
    mkdirSync(join(real, "sessions"), { recursive: true });
    mkdirSync(join(real, "plugins", "extra-tool"), { recursive: true });
    writeFileSync(join(real, "sessions", "s1.json"), '{"s":1}\n');
    writeFileSync(join(real, "plugins", "extra-tool", "keep.txt"), "tool\n");
    writeFileSync(
      join(real, "config.yaml"),
      'theme: dark\nmodel:\n  provider: "auto"\n  default: "user-model"\n',
    );
    writeFileSync(
      join(real, ".env"),
      'USER_KEY=keep\nANTHROPIC_API_KEY="user-key"\nAIAND_HERMES_BASE_URL="https://stale.example"\n',
    );
    return real;
  }

  test("overlay env/args/cleanup: HERMES_HOME overlay, stripped passthrough, real home intact", async () => {
    // The overlay is removed when the CLI exits, so the stub snapshots it
    // (`cp -a` keeps symlinks and modes) while the child is still running.
    plantStub(
      binDir,
      "hermes",
      `env > "$AIAND_CAPTURE.env"
printf '%s\\n' "$@" > "$AIAND_CAPTURE.args"
cp -a "$HERMES_HOME" "$AIAND_CAPTURE.overlay"
exit 42`,
    );
    const real = plantHermesReal();
    const before = [
      join(real, "config.yaml"),
      join(real, ".env"),
      join(real, "sessions", "s1.json"),
    ].map((path) => readFileSync(path));
    const capture = captureDir();
    try {
      const { code } = await stubCli(
        [
          "hermes",
          "--model",
          "aiand/glm-5.3",
          "--",
          "--provider",
          "x",
          "--model=y",
          "-m",
          "z",
          "--keep",
        ],
        // Inherited ANTHROPIC_* must not reach the hermes child: they
        // would shadow or confuse the overlay routing.
        {
          HERMES_HOME: real,
          ANTHROPIC_API_KEY: "inherited-anthropic-key",
          ANTHROPIC_BASE_URL: "https://inherited.example",
          ANTHROPIC_TOKEN: "inherited-token",
          CLAUDE_CODE_OAUTH_TOKEN: "inherited-oauth-token",
          OPENAI_API_KEY: "inherited-openai-key",
          OPENAI_BASE_URL: "https://inherited-openai.example",
        },
        capture,
      );
      assert.equal(code, 42);

      const envText = readFileSync(join(capture, "capture.env"), "utf8");
      // The child sees a temp overlay as HERMES_HOME, never the real home.
      const homeLine = envText.match(/^HERMES_HOME=(.*)$/m);
      assert.ok(homeLine, "HERMES_HOME in child env");
      const overlay = homeLine[1];
      assert.ok(overlay.includes("aiand-hermes-"), overlay);
      assert.notEqual(overlay, real);
      // The session key rides the overlay .env file, never the child env.
      assert.doesNotMatch(envText, /sk-test-aiand/);
      assert.doesNotMatch(envText, /AIAND_HERMES_/, "no routing secret in the child env");
      // Routing pointers ride the child env; inherited ANTHROPIC_* do not:
      // they would shadow or confuse the overlay routing.
      assert.match(envText, /^HERMES_INFERENCE_PROVIDER=aiand$/m);
      assert.match(envText, /^HERMES_MODEL=aiand\/glm-5\.3$/m);
      assert.match(envText, /^HERMES_INFERENCE_MODEL=aiand\/glm-5\.3$/m);
      assert.doesNotMatch(envText, /^ANTHROPIC_API_KEY=/m);
      assert.doesNotMatch(envText, /^ANTHROPIC_BASE_URL=/m);
      assert.doesNotMatch(envText, /^ANTHROPIC_TOKEN=/m);
      // #17: the same for the other credential/base-URL routes Hermes
      // consults — the OAuth token folded into the ANTHROPIC tuple and the
      // auxiliary-route OPENAI_* pair.
      assert.doesNotMatch(envText, /^CLAUDE_CODE_OAUTH_TOKEN=/m);
      assert.doesNotMatch(envText, /^OPENAI_API_KEY=/m);
      assert.doesNotMatch(envText, /^OPENAI_BASE_URL=/m);

      const copy = join(capture, "capture.overlay");
      // Overlay .env: 0600, gateway routing, the user's ANTHROPIC_* and
      // stale AIAND_HERMES_* stripped.
      const overlayEnv = readFileSync(join(copy, ".env"), "utf8");
      assert.equal(statSync(join(copy, ".env")).mode & 0o777, 0o600);
      assert.match(overlayEnv, /AIAND_HERMES_API_KEY="sk-test-aiand"/);
      assert.match(overlayEnv, /AIAND_HERMES_BASE_URL="https:\/\/api\.aiand\.com\/v1"/);
      assert.ok(overlayEnv.includes("USER_KEY=keep"), "unrelated user lines carried");
      assert.ok(!overlayEnv.includes("user-key"), "user ANTHROPIC_API_KEY stripped");
      assert.ok(!overlayEnv.includes("stale.example"), "stale AIAND_HERMES_BASE_URL stripped");

      // Overlay config.yaml: model pinned in place, user's keys preserved.
      const overlayConfig = readFileSync(join(copy, "config.yaml"), "utf8");
      assert.match(overlayConfig, /provider: aiand/);
      assert.match(overlayConfig, /default: "aiand\/glm-5\.3"/);
      assert.ok(overlayConfig.includes("key_env: AIAND_HERMES_API_KEY"), "providers.aiand block");
      assert.ok(overlayConfig.includes('default_model: "aiand/glm-5.3"'));
      assert.ok(overlayConfig.includes("theme: dark"), "user keys survive");
      // The overlay's own provider plugin ships as real files.
      assert.ok(
        readFileSync(
          join(copy, "plugins", "model-providers", "aiand", "__init__.py"),
          "utf8",
        ).includes("register_provider(aiand)"),
      );
      assert.ok(
        readFileSync(
          join(copy, "plugins", "model-providers", "aiand", "plugin.yaml"),
          "utf8",
        ).includes("kind: model-provider"),
      );

      // State links back; credentials never do.
      if (process.platform !== "win32") {
        assert.equal(
          readlinkSync(join(copy, "sessions")),
          join(real, "sessions"),
          "sessions symlinked back",
        );
        assert.equal(
          readlinkSync(join(copy, "plugins", "extra-tool")),
          join(real, "plugins", "extra-tool"),
          "user plugins symlinked back",
        );
      }
      assert.ok(!existsSync(join(copy, "active_profile")));

      // Launcher routing args lead; user --provider/--model/-m overrides
      // stripped (both forms), rest verbatim.
      const args = readFileSync(join(capture, "capture.args"), "utf8").trim().split("\n");
      assert.deepEqual(args, ["--provider", "aiand", "--model", "aiand/glm-5.3", "--keep"]);

      // The real home is byte-identical; the overlay is gone after exit.
      const after = [
        join(real, "config.yaml"),
        join(real, ".env"),
        join(real, "sessions", "s1.json"),
      ].map((path) => readFileSync(path));
      for (let i = 0; i < before.length; i += 1) assert.ok(before[i].equals(after[i]));
      assert.equal(existsSync(overlay), false, "overlay removed after exit");
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("hermes --model native is the normal catalog error; an unknown model refuses before spawn", async () => {
    // Native never reaches the binary (a bare --provider exits 2), so
    // run-agent keeps the ordinary catalog-membership error for the
    // literal and hermes never spawns. Unknown ids fail the same way.
    plantMarkerStub("hermes");
    const capture = captureDir();
    const marker = join(capture, "marker");
    try {
      const r = await stubCli(["hermes", "--model", "native"], { AIAND_MARKER: marker }, capture);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /not in the catalog/);
      assert.equal(existsSync(marker), false, "hermes never spawned");

      // An id that is not in the catalog fails before any spawn.
      const bogus = await stubCli(
        ["hermes", "--model", "definitely-bogus"],
        { AIAND_MARKER: marker },
        capture,
      );
      assert.equal(bogus.code, 1);
      assert.match(bogus.stderr, /not in the catalog/);
      assert.equal(existsSync(marker), false, "hermes never spawned");
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("the generic strip never eats a flag or a dash-leading prompt", async () => {
    // Owned routing flags drop only a plain-word value: --print after
    // --model is its own flag, and `-- -explain` is a prompt, not a value.
    // The launcher's own routing args still lead the child argv.
    plantCaptureStub("hermes");
    const capture = captureDir();
    try {
      const { code } = await stubCli(
        ["hermes", "--", "--model", "--print", "-m", "--", "-explain"],
        {},
        capture,
      );
      assert.equal(code, 42);
      const args = readFileSync(join(capture, "capture.args"), "utf8").trim().split("\n");
      assert.deepEqual(args, [
        "--provider",
        "aiand",
        "--model",
        "aiand/glm-5.3",
        "--print",
        "--",
        "-explain",
      ]);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("SIGINT removes the hermes overlay before exit", async () => {
    if (process.platform === "win32") return;
    plantLingerStub("hermes");
    const real = plantHermesReal();
    const capture = captureDir();
    const doneFile = join(capture, "done");
    const child = spawn(process.execPath, [BIN, "run-agent", "hermes"], {
      env: launcherEnv(capture, { AIAND_DONE: doneFile, HERMES_HOME: real }),
      stdio: "ignore",
    });
    try {
      // Poll the env dump until HERMES_HOME shows the live overlay.
      const captureEnv = join(capture, "capture.env");
      const deadline = Date.now() + WAIT_TIMEOUT_MS;
      let envText = "";
      while (Date.now() < deadline) {
        if (existsSync(captureEnv)) {
          envText = readFileSync(captureEnv, "utf8");
          if (/^HERMES_HOME=/m.test(envText)) break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      const overlay = envText.match(/^HERMES_HOME=(.*)$/m)?.[1];
      assert.ok(overlay, "overlay path captured");
      assert.ok(existsSync(overlay), "overlay live while the child runs");
      child.kill("SIGINT");
      const exitCode = await new Promise((resolve) => child.on("exit", resolve));
      assert.equal(exitCode, 130);
      assert.equal(existsSync(overlay), false, "overlay removed before exit");
    } finally {
      writeFileSync(doneFile, "done");
      child.kill("SIGKILL");
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("native stays a catalog error for the wired adapters", async () => {
    // Hermes keeps the same catalog error as every other adapter now:
    // opencode and codex must behave exactly as before.
    plantMarkerStub("opencode");
    const capture = captureDir();
    const marker = join(capture, "marker");
    try {
      const r = await stubCli(["opencode", "--model", "native"], { AIAND_MARKER: marker }, capture);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /not in the catalog/);
      assert.equal(existsSync(marker), false, "opencode never spawned");

      plantMarkerStub("codex");
      const codexMarker = join(capture, "codex-marker");
      const c = await stubCli(
        ["codex", "--model", "native"],
        { AIAND_MARKER: codexMarker },
        capture,
      );
      assert.equal(c.code, 1);
      assert.match(c.stderr, /not in the catalog/);
      assert.equal(existsSync(codexMarker), false, "codex never spawned");
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("run-agent --help lists hermes", async () => {
    const { code, stdout } = await runCli(["run-agent", "--help"], { env: launcherEnv(env.dir) });
    assert.equal(code, 0);
    assert.match(stdout, /\bhermes\b/);
  });
});
