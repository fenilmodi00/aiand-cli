import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, describe } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  captureStdio,
  cliEnv,
  hermeticPath,
  plantStub,
  runCli,
  withEnv,
  withTestEnv,
} from "./helpers.mjs";

// Behaviour coverage for `run` (streaming + empty/error paths), `update`
// (registry failure, already-up-to-date, installer fallback, re-verify) and
// `restore` (argument guards plus a real snapshot round-trip). Nothing
// reaches the network: completions come from the loopback stub below, and
// the registry answer is stubbed inside the update child.

withTestEnv("aiand-run-update-restore-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  mkdirSync(process.env.AIAND_HOME, { recursive: true });
  mkdirSync(process.env.AIAND_CONFIG_DIR, { recursive: true });
  delete process.env.AIAND_API_KEY;
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_DIR;
  delete process.env.AIAND_PROFILE;
  process.env.CI = "1";
});

const { FAKE_API_KEY } = await import("./helpers.mjs");
const snapshot = await import("../dist/agents/snapshot.js");
const { AGENTS, findAgent } = await import("../dist/agents/registry.js");
const { VERSION } = await import("../dist/api/client.js");

const RUN_UPDATE = fileURLToPath(new URL("../dist/commands/update.js", import.meta.url));

/** CLI with an ignored stdin, so readStdin() never waits on an open pipe. */
const cli = (args, overrides = {}, options = {}) => {
  const stdin =
    options.input !== undefined ? (options.stdin ?? "pipe") : (options.stdin ?? "ignore");
  return runCli(args, {
    env: cliEnv({ NO_COLOR: "1", CI: "1", ...overrides }),
    // options.input implies a piped stdin unless the caller says otherwise;
    // every other call gets an ignored stdin so readStdin() never waits.
    ...options,
    stdin,
  });
};

// ---------------------------------------------------------------------------
// Loopback completion stub: scenario is the first path segment of the base
// URL (the client appends /v1/chat/completions to it).
// ---------------------------------------------------------------------------

const SSE_HEADERS = { "Content-Type": "text/event-stream" };

const server = createServer((req, res) => {
  const scenario = (req.url ?? "/").split("/")[1] ?? "";
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {}

    if (scenario === "sse") {
      res.writeHead(200, {
        ...SSE_HEADERS,
        "X-Model": "stub-model",
        "X-Inference-Ms": "7",
      });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "pondering" } }] })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
      return;
    }

    if (scenario === "emptysse") {
      res.writeHead(200, { ...SSE_HEADERS, "X-Model": "stub-model" });
      res.end(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "length" }],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 4,
            completion_tokens_details: { reasoning_tokens: 4 },
          },
        })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }

    if (scenario === "inspect" || scenario === "json") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "X-Model": body.model ?? "stub-model",
        "X-Cost": "0.5",
        "X-Cost-Currency": "usd",
        "X-Inference-Ms": "12",
        "X-Request-Id": "req-1",
        "X-Reasoning-Effort": "high",
      });
      res.end(
        JSON.stringify({
          id: "chatcmpl-stub",
          object: "chat.completion",
          model: body.model ?? "stub-model",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "hello there",
                reasoning_content: "deep thoughts",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          echo: body,
        }),
      );
      return;
    }

    if (scenario === "empty") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "X-Model": "stub-model",
        "X-Empty-Completion": "empty",
      });
      res.end(
        JSON.stringify({
          id: "chatcmpl-empty",
          model: "stub-model",
          choices: [
            { index: 0, message: { role: "assistant", content: null }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 0 },
        }),
      );
      return;
    }

    if (scenario === "auto400") {
      res.writeHead(400, { "Content-Type": "application/json", "X-Request-Id": "req-400" });
      res.end(
        JSON.stringify({
          error: { message: "model 'auto' is not supported for this account", type: "invalid" },
        }),
      );
      return;
    }

    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `unknown scenario ${scenario}` } }));
  });
});

let gatewayUrl = "";

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  gatewayUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve()));
});

const gateway = (scenario) => `${gatewayUrl}/${scenario}`;

/** Env for one `run` against the loopback stub. */
const runEnv = (scenario) => ({
  AIAND_API_KEY: FAKE_API_KEY,
  AIAND_BASE_URL: gateway(scenario),
});

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

describe("aiand run", () => {
  test("streams content to stdout and the footer to stderr", async () => {
    const { code, stdout, stderr } = await cli(["run", "-m", "stub-model", "hi"], runEnv("sse"));
    assert.equal(code, 0);
    assert.equal(stdout, "hello\n");
    // Reasoning is not echoed without --show-reasoning, but the footer names
    // the model and the token/ms numbers.
    assert.doesNotMatch(stderr, /pondering/);
    assert.match(stderr, /stub-model/);
    assert.match(stderr, /3 in \/ 2 out/);
    assert.match(stderr, /7ms/);
  });

  test("--show-reasoning streams reasoning to stderr", async () => {
    const { code, stderr } = await cli(
      ["run", "-m", "stub-model", "--show-reasoning", "hi"],
      runEnv("sse"),
    );
    assert.equal(code, 0);
    assert.match(stderr, /thinking: pondering/);
  });

  test("--quiet suppresses the stats footer", async () => {
    const { code, stdout, stderr } = await cli(
      ["run", "-m", "stub-model", "-q", "hi"],
      runEnv("sse"),
    );
    assert.equal(code, 0);
    assert.equal(stdout, "hello\n");
    assert.equal(stderr, "");
  });

  test("an empty stream explains the missing content", async () => {
    const { code, stdout, stderr } = await cli(
      ["run", "-m", "stub-model", "hi"],
      runEnv("emptysse"),
    );
    assert.equal(code, 0);
    assert.equal(stdout, "");
    assert.match(
      stderr,
      /No content\. The token budget was spent reasoning \(4 reasoning tokens\)/,
    );
  });

  test("--no-stream prints the answer and the stats line", async () => {
    const { code, stdout, stderr } = await cli(
      ["run", "--no-stream", "-m", "stub-model", "hi"],
      runEnv("json"),
    );
    assert.equal(code, 0);
    assert.equal(stdout.replace(/\r\n/g, "\n"), "hello there\n");
    assert.match(stderr, /stub-model/);
    assert.match(stderr, /5 in \/ 2 out/);
    assert.match(stderr, /0\.5 USD/);
    assert.match(stderr, /12ms/);
    assert.match(stderr, /effort=high/);
    assert.match(stderr, /req-1/);
    assert.doesNotMatch(stderr, /deep thoughts/);
  });

  test("--no-stream --show-reasoning prints the reasoning to stderr", async () => {
    const { code, stdout, stderr } = await cli(
      ["run", "--no-stream", "--show-reasoning", "-m", "stub-model", "hi"],
      runEnv("json"),
    );
    assert.equal(code, 0);
    assert.equal(stdout.replace(/\r\n/g, "\n"), "hello there\n");
    assert.match(stderr, /thinking: deep thoughts/);
  });

  test("--no-stream explains a contentless answer", async () => {
    const { code, stdout, stderr } = await cli(
      ["run", "--no-stream", "-m", "stub-model", "hi"],
      runEnv("empty"),
    );
    assert.equal(code, 0);
    assert.equal(stdout, "");
    assert.match(stderr, /No content\. The model produced nothing at all\./);
  });

  test("--json sends every flag it was given and the piped stdin", async () => {
    const { code, stdout, stderr } = await cli(
      [
        "run",
        "--no-stream",
        "--json",
        "-m",
        "flag-model",
        "--system",
        "be terse",
        "--max-tokens",
        "5",
        "--temperature",
        "0.3",
        "--top-p",
        "0.9",
        "--reasoning-effort",
        "high",
        "--stop",
        "END",
        "--stop",
        "STOP",
        "inline",
      ],
      runEnv("inspect"),
      { input: "piped" },
    );
    assert.equal(code, 0, stderr);
    assert.equal(stderr, "");
    const raw = JSON.parse(stdout);
    assert.equal(raw.model, "flag-model");
    assert.deepEqual(raw.echo.messages, [
      { role: "system", content: "be terse" },
      { role: "user", content: "inline\n\npiped" },
    ]);
    assert.equal(raw.echo.max_tokens, 5);
    assert.equal(raw.echo.temperature, 0.3);
    assert.equal(raw.echo.top_p, 0.9);
    assert.equal(raw.echo.reasoning_effort, "high");
    assert.deepEqual(raw.echo.stop, ["END", "STOP"]);
  });

  test("a rejected auto selection is rewritten with the model hint", async () => {
    const { code, stdout, stderr } = await cli(
      ["run", "--no-stream", "-m", "auto", "hi"],
      runEnv("auto400"),
    );
    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /HTTP 400: Automatic model selection is not enabled for this account\./);
    assert.match(stderr, /request id: req-400/);
    assert.match(stderr, /Name a model with -m/);
  });

  test("no prompt at all is a usage error", async () => {
    const { code, stdout, stderr } = await cli(["run"], runEnv("sse"));
    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /No prompt given\./);
    assert.match(stderr, /Pass one as an argument/);
  });

  test("an unknown flag is rejected before any request", async () => {
    const { code, stderr } = await cli(["run", "--bogus", "hi"], runEnv("sse"));
    assert.equal(code, 1);
    assert.match(stderr, /Unknown option '--bogus'/);
  });

  test("a non-integer --max-tokens is rejected", async () => {
    const { code, stderr } = await cli(
      ["run", "-m", "stub-model", "--max-tokens", "1.5", "hi"],
      runEnv("sse"),
    );
    assert.equal(code, 1);
    assert.match(stderr, /--max-tokens must be a whole number \(got "1\.5"\)/);
  });

  test("a non-numeric --temperature is rejected", async () => {
    const { code, stderr } = await cli(
      ["run", "-m", "stub-model", "--temperature", "hot", "hi"],
      runEnv("sse"),
    );
    assert.equal(code, 1);
    assert.match(stderr, /--temperature must be a number \(got "hot"\)/);
  });

  test("run --help documents its flags", async () => {
    const { code, stdout } = await cli(["run", "--help"]);
    assert.equal(code, 0);
    assert.match(stdout, /--model/);
    assert.match(stdout, /--no-stream/);
  });
});

// ---------------------------------------------------------------------------
// update: driven in a child so its registry fetch can be stubbed locally and
// argv[1] can name the install that "launched" it.
// ---------------------------------------------------------------------------

/** A real file, so detectInstallKind's realpath() resolves instead of throwing. */
const realFile = (path) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "");
  return path;
};

const newerVersion = (version) => {
  const [major, minor, patch] = version.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
};

/**
 * `aiand update <args>` in a child whose registry answers `registry` (a
 * version string, or "reject" for an unreachable registry) and whose
 * launched entry point is `entry`. `bin` becomes the child's whole PATH, so
 * the install step can only ever reach a planted stub.
 */
async function runUpdate(args, { entry, registry = VERSION, bin, dir } = {}) {
  const fetchStub =
    registry === "reject"
      ? `globalThis.fetch = async () => { throw new Error("registry down"); };`
      : `globalThis.fetch = async () => new Response(JSON.stringify({ version: ${JSON.stringify(registry)} }), { status: 200, headers: { "Content-Type": "application/json" } });`;
  const script = `${fetchStub}
const { run } = await import(${JSON.stringify(pathToFileURL(RUN_UPDATE).href)});
try {
  await run(${JSON.stringify(args)});
} catch (error) {
  process.stderr.write("ERR:" + (error?.message ?? String(error)) + "\\n");
  for (const line of (error?.hint ?? "").split("\\n")) {
    process.stderr.write("HINT:" + line + "\\n");
  }
  process.exit(error?.exitCode ?? 1);
  }
  process.exit(process.exitCode ?? 0);
`;
  let result;
  try {
    result = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", script, entry],
      {
        env: cliEnv({ AIAND_DIR: dir, NO_COLOR: "1", CI: "1", PATH: bin ?? hermeticPath() }),
      },
    );
  } catch (error) {
    const failed = error;
    result = { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
  return {
    code: result.code ?? 0,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.stderr.match(/^ERR:(.*)$/m)?.[1],
    hint: result.stderr
      .split("\n")
      .filter((line) => line.startsWith("HINT:"))
      .join(" "),
  };
}

const npmEntry = () =>
  realFile(
    join(
      mkdtempSync(join(tmpdir(), "aiand-npm-update-")),
      "lib/node_modules/@aiand/cli/dist/index.js",
    ),
  );

/** A bin dir holding only a stub `npm` that exits with `code`. */
const npmStub = (code = 0) => {
  const bin = mkdtempSync(join(tmpdir(), "aiand-npm-bin-"));
  plantStub(bin, "npm", `exit ${code}`);
  return bin;
};

describe("aiand update", () => {
  test("--help documents its flags", async () => {
    const { code, stdout } = await runUpdate(["--help"], { entry: npmEntry() });
    assert.equal(code, 0);
    assert.match(stdout, /--check/);
    assert.match(stdout, /--yes/);
  });

  test("an unknown flag is refused", async () => {
    const { code, stderr } = await runUpdate(["--bogus"], { entry: npmEntry() });
    assert.equal(code, 1);
    assert.match(stderr, /Unknown option/);
    assert.match(stderr, /bogus/);
  });

  test("an unreachable registry explains the manual path", async () => {
    const { code, error, hint } = await runUpdate(["--check"], {
      entry: npmEntry(),
      registry: "reject",
    });
    assert.equal(code, 1);
    assert.match(error ?? "", /Could not reach the npm registry: .*registry down/);
    assert.match(hint, /update by hand/);
    assert.match(hint, /npm install -g @aiand\/cli/);
  });

  test("an install already at the latest version says so and exits 0", async () => {
    const { code, stdout } = await runUpdate([], { entry: npmEntry(), registry: VERSION });
    assert.equal(code, 0);
    assert.match(stdout, /is up to date\./);
    assert.match(stdout, new RegExp(`v${VERSION.replace(/\./g, "\\.")}`));
  });

  test("an install.sh that vanished falls back to npm, then re-verifies", async () => {
    // A launcher checkout without install.sh, and a package.json beside the
    // entry that already carries the new version: the update succeeds.
    const root = mkdtempSync(join(tmpdir(), "aiand-installer-"));
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "@aiand/cli" })}\n`);
    const entry = realFile(join(root, "dist", "index.js"));
    const latest = newerVersion(VERSION);
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ version: latest })}\n`);
    const { code, stdout, stderr } = await runUpdate([], {
      entry,
      registry: latest,
      bin: hermeticPath(npmStub(0)),
      dir: root,
    });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /install\.sh is missing; updating with npm instead\./);
    assert.match(
      stdout,
      new RegExp(`v${VERSION.replace(/\./g, "\\.")} → v${latest.replace(/\./g, "\\.")}`),
    );
    assert.match(stdout, /\(up to date\)/);
  });

  test("a missing npm fails with the manual hint", async () => {
    const { code, error, hint } = await runUpdate(["--yes"], {
      entry: npmEntry(),
      registry: newerVersion(VERSION),
      bin: hermeticPath(),
    });
    assert.equal(code, 1);
    assert.match(error ?? "", /Update failed: .*ENOENT/);
    assert.match(hint, /Run it yourself with: npm install -g @aiand\/cli/);
  });

  test("a version still below latest after the install is a PATH shadow", async () => {
    // No package.json beside the entry: probeVersion falls back to the
    // running VERSION, which is still older than the registry's answer.
    const latest = newerVersion(VERSION);
    const { code, error, hint } = await runUpdate(["--yes"], {
      entry: realFile(
        join(
          mkdtempSync(join(tmpdir(), "aiand-shadow-")),
          "lib/node_modules/@aiand/cli/dist/index.js",
        ),
      ),
      registry: latest,
      bin: hermeticPath(npmStub(0)),
    });
    assert.equal(code, 127);
    assert.match(error ?? "", new RegExp(`Updated to v${latest.replace(/\./g, "\\.")}`));
    assert.match(error ?? "", new RegExp(`still reports v${VERSION.replace(/\./g, "\\.")}`));
    assert.match(hint, /shadowing this one on PATH/);
  });

  test("a failing install child reports its exit code", async () => {
    const { code, error } = await runUpdate(["--yes"], {
      entry: npmEntry(),
      registry: newerVersion(VERSION),
      bin: hermeticPath(npmStub(3)),
    });
    assert.equal(code, 1);
    assert.match(error ?? "", /Update failed: exit 3\./);
  });
});

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

const opencode = findAgent("opencode");

/** Write the adapter's managed file and snapshot it, as `init` would. */
async function seedSnapshot(agent, content) {
  const [file] = agent.managedFiles();
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
  await snapshot.snapshotFiles(agent.id, agent.managedFiles());
  return file;
}

describe("aiand restore", () => {
  test("--help documents --force", async () => {
    const { code, stdout } = await cli(["restore", "--help"]);
    assert.equal(code, 0);
    assert.match(stdout, /--force/);
    assert.match(stdout, /interactively/);
  });

  test("a missing agent name is a usage error", async () => {
    const { code, stderr } = await cli(["restore"]);
    assert.equal(code, 1);
    assert.match(stderr, /Missing agent name\./);
    assert.match(stderr, /Usage: aiand restore <agent> --force/);
  });

  test("bare --json keeps the usage error and never prompts", async () => {
    const { code, stdout, stderr } = await cli(["restore", "--json"], {}, { input: "" });
    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /Missing agent name\./);
    assert.match(stderr, /Usage: aiand restore <agent> --force/);
  });

  test("two agent names are rejected", async () => {
    const { code, stderr } = await cli(["restore", "opencode", "claude", "--force"]);
    assert.equal(code, 1);
    assert.match(stderr, /Restore takes exactly one agent name\./);
    assert.match(stderr, /You passed: opencode claude/);
  });

  test("an unknown agent lists the valid ones", async () => {
    const { code, stderr } = await cli(["restore", "nope", "--force"]);
    assert.equal(code, 1);
    assert.match(stderr, /Unknown agent "nope"\./);
    assert.match(stderr, new RegExp(`Valid agents: ${AGENTS.map((agent) => agent.id).join(", ")}`));
  });

  test("without --force it refuses to overwrite", async () => {
    const { code, stderr } = await cli(["restore", "opencode"]);
    assert.equal(code, 1);
    assert.match(stderr, /Restore overwrites current config files\./);
    assert.match(stderr, /Pass --force/);
  });

  test("an agent with no snapshot explains how to wire it", async () => {
    const { code, stderr } = await cli(["restore", "codex", "--force"]);
    assert.equal(code, 1);
    assert.match(stderr, /No snapshot found for Codex\./);
    assert.match(stderr, /Wire Codex first with/);
  });

  test("--force restores the snapshot byte-for-byte", async () => {
    const original = '{"theme":"dark","user":"mine"}\n';
    const file = await seedSnapshot(opencode, original);
    writeFileSync(file, '{"provider":{"aiand":{}}}\n');

    const { code, stdout, stderr } = await cli(["restore", "opencode", "--force"]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /OpenCode config restored from snapshot\./);
    assert.equal(readFileSync(file, "utf8"), original);
  });

  test("--json reports the restored agent", async () => {
    const file = await seedSnapshot(opencode, '{"snapshot":"yes"}\n');
    writeFileSync(file, '{"clobbered":true}\n');

    const { code, stdout } = await cli(["restore", "opencode", "--force", "--json"]);
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout), { agent: "opencode", state: "restored" });
    assert.equal(readFileSync(file, "utf8"), '{"snapshot":"yes"}\n');
  });

  test("bare interactive restore with no snapshots reports and resolves", async () => {
    const restore = await import("../dist/commands/restore.js");
    const stdoutDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const stdinDesc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { get: () => true, configurable: true });
    Object.defineProperty(process.stdin, "isTTY", { get: () => true, configurable: true });
    const captured = captureStdio();
    try {
      await withEnv({ CI: undefined }, () => restore.run([]));
    } finally {
      captured.restore();
      if (stdoutDesc) Object.defineProperty(process.stdout, "isTTY", stdoutDesc);
      else delete process.stdout.isTTY;
      if (stdinDesc) Object.defineProperty(process.stdin, "isTTY", stdinDesc);
      else delete process.stdin.isTTY;
    }
    assert.match(captured.log.out.join(""), /No config snapshots found\./);
  });
});
