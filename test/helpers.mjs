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
 * Standard EnableInput fixture. apiKey defaults to the AIAND_API_KEY the
 * file's setup() sets (matching the old per-file BASE_KEY constants);
 * override per test as before. `home` is read lazily at call time.
 */
export function enableInput(overrides = {}) {
  return {
    apiKey: process.env.AIAND_API_KEY ?? "sk-test-key",
    model: "zai-org/glm-5.3",
    slots: { opus: "m-opus", sonnet: "m-sonnet", haiku: "m-haiku" },
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
