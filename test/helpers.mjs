// Shared test scaffolding, so test files stop copy-pasting their own:
// - withTestEnv: temp dir + full env restore per file (mkdtemp in before(),
//   recursive rm + env restore in after(); no per-test restore).
// - withEnv / withFetch: scoped process.env and globalThis.fetch overrides.
// - runCli / cliEnv / hermeticPath: drive the built CLI as a child process.
//   hermeticPath always keeps test/setup.mjs's keychain stubs first.
// - enableInput / catalogModel / seedCatalogCache / makeFixture: adapter,
//   catalog, and fixture-agent fixtures.
// - FakeInput / FakeOutput / waitForListener / waitFor: prompt and polling.
// - startMockGateway / withMockGateway: test/mock-gateway.mjs as its own
//   process, file-wide or scoped to one callback.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, before } from "node:test";
import { fileURLToPath } from "node:url";

/** The built CLI entry point every subprocess test runs. */
export const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/** A loopback URL nothing listens on: requests fail fast with ECONNREFUSED,
 * like an offline machine, and https-or-loopback validation accepts it. */
export const CLOSED_URL = "http://127.0.0.1:9";

/** The env key tests run under when the key itself does not matter. */
export const FAKE_API_KEY = "sk-test-not-real";

/** Default cap for polling a test condition (waitFor, stub-output polls). */
export const WAIT_TIMEOUT_MS = 10_000;
/** Cap for a prompt to attach its stdin listener (slow under a loaded runner). */
export const LISTENER_TIMEOUT_MS = 30_000;
/** Cap for the mock gateway child to print its port. */
const MOCK_GATEWAY_START_TIMEOUT_MS = 10_000;

/**
 * Isolate a test file: a fresh temp dir, with `setup(dir)` run in before()
 * (typically pointing AIAND_CONFIG_DIR/AIAND_HOME at it). The returned box's
 * `.dir` is valid once before() has run.
 */
export function withTestEnv(prefix, setup) {
  let dir;
  const originalEnv = { ...process.env };
  before(() => {
    dir = mkdtempSync(join(tmpdir(), prefix));
    setup(dir);
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = originalEnv;
  });
  return {
    get dir() {
      return dir;
    },
  };
}

/** EnableInput fixture (apiKey "sk-test-key"); `home` is read at call time. */
export function enableInput(overrides = {}) {
  return {
    apiKey: "sk-test-key",
    model: "zai-org/glm-5.3",
    slots: {},
    catalog: [],
    home: process.env.AIAND_HOME,
    ...overrides,
  };
}

/** A Model shaped like GET /v1/models returns; extra fields via `rest`. */
export function catalogModel(
  id,
  { input = "0.60", output = "2.20", capabilities = ["tools"], ...rest } = {},
) {
  return {
    id,
    name: id,
    object: "model",
    created: 0,
    owned_by: "aiand",
    provider: "aiand",
    context_window: 128000,
    max_output_tokens: 32768,
    capabilities,
    reasoning_efforts: null,
    reasoning_effort_default: null,
    description: null,
    currency: "usd",
    input_per_1m: input,
    output_per_1m: output,
    cached_input_per_1m: null,
    ...rest,
  };
}

/**
 * Start test/mock-gateway.mjs as its own process; resolves
 * { port, url, kill, stop } once it listens. `stop()` kills it and awaits
 * its exit. A separate process — not an in-test-process server — because
 * specs drive the CLI via child processes, which a blocked parent event loop
 * could never answer. Use it directly for a file-wide gateway (before/after);
 * withMockGateway scopes one to a single callback.
 */
export async function startMockGateway() {
  const gateway = fileURLToPath(new URL("./mock-gateway.mjs", import.meta.url));
  const child = spawn(process.execPath, [gateway, "--port", "0"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  // 'close' fires after stdio drains even when spawn emits only 'error'
  // (no 'exit' in that case); await it so cleanup never hangs.
  const closed = new Promise((resolve) => child.once("close", resolve));
  const kill = () => {
    child.kill();
  };
  const stop = async () => {
    kill();
    await closed;
  };
  try {
    const port = await new Promise((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => {
        reject(new Error("mock gateway did not print its port in time"));
      }, MOCK_GATEWAY_START_TIMEOUT_MS);
      timer.unref();
      const fail = (cause) => {
        clearTimeout(timer);
        reject(cause);
      };
      child.on("error", fail);
      child.on("exit", (code) =>
        fail(new Error(`mock gateway exited early (code ${code}): ${out}`)),
      );
      child.stdout.on("data", (chunk) => {
        out += String(chunk);
        const newline = out.indexOf("\n");
        if (newline !== -1) {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(out.slice(0, newline)).port);
          } catch {
            fail(new Error(`mock gateway printed a bad port line: ${out.slice(0, newline)}`));
          }
        }
      });
    });
    return { port, url: `http://127.0.0.1:${port}`, kill, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** Run `fn({ port, url, kill })` against a fresh mock gateway, stopped in a finally. */
export async function withMockGateway(fn) {
  const { stop, ...gateway } = await startMockGateway();
  try {
    await fn(gateway);
  } finally {
    await stop();
  }
}

/**
 * Set (or, for `undefined`, delete) process.env keys for the duration of
 * `fn`, restoring every touched key afterwards even when `fn` throws.
 */
export async function withEnv(vars, fn) {
  const prev = {};
  for (const [key, value] of Object.entries(vars)) {
    prev[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Replace globalThis.fetch with `stub` for the duration of `fn`. */
export async function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * PATH for a child CLI: test/setup.mjs's keychain stubs first, then `dirs`.
 * `hermeticPath(dirname(process.execPath))` is a machine where no agent (and
 * no `which`) resolves; add a stub dir plus /usr/bin to detect only stubs.
 */
export function hermeticPath(...dirs) {
  return [process.env.AIAND_TEST_STUB_BIN, ...dirs].filter(Boolean).join(delimiter);
}

/**
 * The test/setup.mjs isolation vars (network guard, no browser, keychain
 * stubs) to carry into a child whose env is built from scratch instead of
 * from process.env.
 */
export function harnessEnv() {
  const keys = ["NODE_OPTIONS", "AIAND_NO_BROWSER", "AIAND_TEST_STUB_BIN"];
  return Object.fromEntries(
    keys.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]),
  );
}

/** process.env plus `overrides`; an `undefined` override deletes the key. */
export function cliEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
  }
  return env;
}

/**
 * Run the built CLI and resolve { code, stdout, stderr } — never rejects on
 * a nonzero exit. `env` is the child's whole environment (build it with
 * cliEnv). stdin is an async pipe, the shape a Node parent hands over: it is
 * written with `input` (if any) and then closed. `stdin: "ignore"` or a file
 * descriptor replaces the pipe.
 */
export function runCli(args, { env = process.env, input, stdin = "pipe" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: [stdin, "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (stdin === "pipe") child.stdin.end(input);
  });
}

/** Write an executable POSIX-sh stub `name` into `dir`; returns its path. */
export function plantStub(dir, name, script = "exit 0") {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * Seed the catalog caches `on` reads so it never needs the network:
 * model-catalog.json and opencode-api.json, both keyed to `baseUrl`.
 */
export function seedCatalogCache(
  cfg,
  {
    baseUrl = CLOSED_URL,
    models = [catalogModel("zai-org/glm-5.3"), catalogModel("other/model")],
    opencodeModels = { "zai-org/glm-5.3": { id: "zai-org/glm-5.3", name: "GLM 5.3" } },
  } = {},
) {
  mkdirSync(cfg, { recursive: true });
  const fetchedAt = Date.now();
  writeFileSync(join(cfg, "model-catalog.json"), JSON.stringify({ fetchedAt, baseUrl, models }));
  writeFileSync(
    join(cfg, "opencode-api.json"),
    JSON.stringify({ fetchedAt, baseUrl, models: opencodeModels }),
  );
}

/** The managed file of a makeFixture adapter. */
export const fixtureFile = (home, id = "fixture-agent") =>
  join(home, id === "fixture-agent" ? ".fixture" : `.fixture-${id}`, "config.json");

/**
 * Minimal in-process AgentAdapter over one JSON file under `home`: enable
 * sets `aiand: true` + the model, disable strips it again. `installed`
 * drives detect(); `failBeforeWrite` / `failAfterWrite` make enable throw
 * around its write.
 */
export function makeFixture(
  home,
  { id = "fixture-agent", installed = true, failBeforeWrite = false, failAfterWrite = false } = {},
) {
  const file = () => fixtureFile(home, id);
  const read = () => JSON.parse(readFileSync(file(), "utf8"));
  return {
    id,
    label: id === "fixture-agent" ? "Fixture Agent" : `Fixture ${id}`,
    bin: id,
    install: { command: `npm i -g ${id}`, url: "https://example.com/fixture" },
    detect: () =>
      installed ? { installed: true, path: `/usr/bin/${id}` } : { installed: false, path: null },
    managedFiles: () => [file()],
    probe: async () => {
      try {
        const parsed = read();
        return {
          active: parsed.aiand === true,
          model: parsed.aiand ? (parsed.model ?? null) : null,
        };
      } catch {
        return { active: false, model: null };
      }
    },
    enable: async (input) => {
      if (failBeforeWrite) throw new Error("boom-before-write");
      mkdirSync(dirname(file()), { recursive: true });
      let current = {};
      try {
        current = read();
      } catch {
        // missing file is a first-time on
      }
      writeFileSync(file(), `${JSON.stringify({ ...current, aiand: true, model: input.model })}\n`);
      if (failAfterWrite) throw new Error("boom-after-write");
      return { model: input.model, filesWritten: [file()] };
    },
    disable: async () => {
      let parsed;
      try {
        parsed = read();
      } catch {
        return { stripped: false };
      }
      if (parsed.aiand !== true) return { stripped: false };
      delete parsed.aiand;
      writeFileSync(file(), `${JSON.stringify(parsed)}\n`);
      return { stripped: true };
    },
  };
}

/**
 * Fake prompt input: a real EventEmitter that emits "data" and "end", holds
 * a stubbed setRawMode, and looks like a TTY — the seam src/cli/select.ts
 * drives, so no real stdin or pty is needed.
 */
export class FakeInput extends EventEmitter {
  constructor({ tty = true } = {}) {
    super();
    this.tty = tty;
    this.raw = false;
  }
  get isTTY() {
    return this.tty;
  }
  setRawMode(mode) {
    this.raw = mode;
  }
  resume() {}
  pause() {}
  setEncoding() {}
  send(seq) {
    this.emit("data", seq);
  }
  end() {
    this.emit("end");
  }
}

/** Fake prompt output that accumulates everything written to `.text`. */
export class FakeOutput {
  constructor() {
    this.text = "";
  }
  write(chunk) {
    this.text += chunk;
  }
}

/** Poll until `fn()` is truthy; throws after `timeoutMs`. */
export async function waitFor(fn, timeoutMs = WAIT_TIMEOUT_MS, what = "condition") {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Wait until a prompt is listening on `input`: keys sent before that are lost. */
export const waitForListener = (input, timeoutMs = LISTENER_TIMEOUT_MS) =>
  waitFor(() => input.listenerCount("data") > 0, timeoutMs, "the prompt to start listening");

// node:test runs each file in a child process and streams its results to the
// parent as binary frames over that child's process.stdout. A capture window
// that spans an await sees those frames too; swallowing them drops test
// results (failures included) from the report. CLI output is always a string
// with no C0 control bytes other than ESC/newline/tab, so anything else is a
// runner frame and goes straight through.
const RUNNER_FRAME = /[\x00-\x08\x0e-\x1a\x1c-\x1f]/;
const isRunnerFrame = (chunk) => typeof chunk !== "string" || RUNNER_FRAME.test(chunk);

/**
 * Capture (or, with `mute`, discard) CLI stdout/stderr until `restore()`,
 * passing node:test's own frames through untouched.
 */
export function captureStdio({ mute = false } = {}) {
  const log = { out: [], err: [] };
  const real = {
    out: process.stdout.write.bind(process.stdout),
    err: process.stderr.write.bind(process.stderr),
  };
  const tap =
    (stream) =>
    (chunk, ...rest) => {
      if (isRunnerFrame(chunk)) return real[stream](chunk, ...rest);
      if (!mute) log[stream].push(chunk);
      return true;
    };
  process.stdout.write = tap("out");
  process.stderr.write = tap("err");
  return {
    log,
    restore() {
      process.stdout.write = real.out;
      process.stderr.write = real.err;
    },
  };
}
