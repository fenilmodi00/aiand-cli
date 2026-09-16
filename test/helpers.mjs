// Shared test scaffolding: temp-dir + env isolation, adapter input fixtures,
// and catalog model fixtures. Replaces the copy-pasted
// `let dir / originalEnv / before(mkdtemp) / after(rm)` skeleton (~22 files),
// the 7× `enableInput()` helpers, and the 8× catalog Model fixtures.
// Semantics match the old boilerplate exactly: mkdtemp in before(), recursive
// rm + full env restore in after(). No afterEach per-test restore, as before.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";

/**
 * Isolate a test file: fresh temp dir, `setup(dir)` runs inside before() and
 * typically points AIAND_CONFIG_DIR/AIAND_HOME at it. Returns a box whose
 * `.dir` is valid after before() runs. Replaces:
 *   let dir; const originalEnv = {...process.env};
 *   before(() => { dir = mkdtempSync(...); ... });
 *   after(() => { rmSync(dir, {recursive:true,force:true}); process.env = originalEnv; });
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

/**
 * Standard EnableInput fixture. apiKey defaults to the literal "sk-test-key";
 * override per test as before. `home` is read lazily at call time.
 */
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

/**
 * Model object shaped like GET /v1/models returns. Price/capability knobs
 * cover every existing fixture's values; anything else via rest.
 */
export function catalogModel(
  id,
  { input = "0.60", output = "2.20", capabilities = ["tools"], ...rest } = {}
) {
  return {
    id,
    name: id,
    object: "model",
    created: 0,
    owned_by: "aiand",
    provider: "aiand",
    context_window: 128000,
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
 * Run test/mock-gateway.mjs as its own process and yield { port, url, kill }
 * to `fn`, killing the server and awaiting its exit in a finally. A separate
 * process — not an in-test-process server — because specs drive the CLI via
 * child processes, which a blocked parent event loop could never answer.
 * Imports stay inside so existing helpers above are untouched.
 */
export async function withMockGateway(fn) {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
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
  try {
    const port = await new Promise((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => {
        reject(new Error("mock gateway did not print its port in time"));
      }, 10000);
      timer.unref();
      const fail = (cause) => {
        clearTimeout(timer);
        reject(cause);
      };
      child.on("error", fail);
      child.on("exit", (code) => fail(new Error(`mock gateway exited early (code ${code}): ${out}`)));
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
    await fn({ port, url: `http://127.0.0.1:${port}`, kill });
  } finally {
    kill();
    await closed;
  }
}
