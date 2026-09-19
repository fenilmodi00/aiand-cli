// Live end-to-end: install opencode, install aiand-cli, run the CLI to point
// opencode at us, then `opencode run "…"` with a short prompt and assert the
// response. Real network calls to api.aiand.com are the point — no mocks, no
// offline catalog fixtures in this file.
//
// Activates only when BOTH are present:
//   - process.env.AIAND_API_KEY (repo secret in CI, withheld on fork PRs)
//   - the `opencode` binary on PATH (installed in CI per INSTALL_HINTS.opencode)
// Otherwise the file registers a single skipped test and exits 0.
// Fork CI with a billed-out key skips the live assertion (balance is not a
// CLI failure). Official-repo CI still fails so an empty org key is visible.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const bin = join(dirname(import.meta.dirname), "dist", "index.js");
const PROMPT = "Reply with exactly the single word: pong";

function binaryOnPath(name) {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [name], {
    encoding: "utf8",
  });
  return probe.status === 0 && !probe.error;
}

function errorText(error) {
  return [error?.message, error?.stderr, error?.stdout]
    .filter((s) => typeof s === "string" && s.length > 0)
    .join("\n");
}

const hasKey = Boolean(process.env.AIAND_API_KEY);
const hasBinary = binaryOnPath("opencode");
const skipReason = !hasKey
  ? "AIAND_API_KEY is not set — live gateway assertions need a real key"
  : !hasBinary
    ? "opencode binary not on PATH — install it with: npm install -g opencode-ai@1.18.30"
    : null;

if (skipReason) {
  console.log(`[e2e-live] skipping: ${skipReason}`);
  test("live opencode e2e (skipped without key+binary)", { skip: skipReason }, () => {});
} else {
  test("live opencode e2e: on -> run -> assert", { timeout: 420_000 }, (t) => {
    // Sandbox BOTH homes: the CLI resolves adapter configs from AIAND_HOME
    // (see agentHome() in src/fsutil.ts: AIAND_HOME || homedir()), while the
    // opencode binary itself only knows HOME/XDG_CONFIG_HOME. Pointing all of
    // them at the same sandbox keeps the real home untouched and makes the
    // file the CLI writes the same file opencode reads. XDG_CONFIG_HOME is
    // set explicitly (not just deleted) so an ambient CI value can't divert
    // opencode's lookup elsewhere.
    const sandbox = mkdtempSync(join(tmpdir(), "aiand-e2e-live-"));
    const home = join(sandbox, "home");
    const work = join(sandbox, "work");
    mkdirSync(home, { recursive: true });
    mkdirSync(work, { recursive: true });
    let phase = "setup";
    try {
      const env = {
        ...process.env,
        AIAND_HOME: home,
        AIAND_CONFIG_DIR: join(sandbox, "config"),
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
      };
      const cli = (args, timeoutMs) =>
        execFileSync("node", [bin, ...args], {
          encoding: "utf8",
          env,
          timeout: timeoutMs,
          cwd: work,
          stdio: ["ignore", "pipe", "pipe"],
        });

      // (a) Sanity: `opencode on --json` wires the sandbox config. Exit 0 and
      // JSON reporting routing/model is the assertion; the live catalog
      // resolves the default model, so no --model flag (exercises that path).
      phase = "opencode on --json";
      const onOut = cli(["opencode", "on", "--json"], 180_000);
      const on = JSON.parse(onOut);
      assert.equal(on.agent, "opencode");
      assert.equal(on.state, "on");
      assert.ok(typeof on.model === "string" && on.model.length > 0, "wired model reported");
      const configPath = join(home, ".config", "opencode", "opencode.json");
      assert.ok(on.files.includes(configPath), `opencode.json in files: ${on.files}`);
      assert.ok(existsSync(configPath), "opencode.json written to sandbox home");
      assert.match(readFileSync(configPath, "utf8"), /api\.aiand\.com/, "config routes at ai&");

      // (b) The real ask: `opencode run` against the live gateway through the
      // config step (a) just wrote, assert the deterministic word comes back.
      phase = `opencode run "${PROMPT}"`;
      const runOut = execFileSync("opencode", ["run", PROMPT], {
        encoding: "utf8",
        env,
        timeout: 180_000,
        cwd: work,
        stdio: ["ignore", "pipe", "pipe"],
      });
      assert.match(runOut, /pong/i, `gateway replied with the expected word: ${runOut.slice(0, 500)}`);
    } catch (error) {
      const insufficient = /insufficient credits/i.test(errorText(error));
      const officialCi = process.env.GITHUB_REPOSITORY === "aiandlabs/aiand-cli";
      if (insufficient && !officialCi) {
        t.skip("live gateway returned insufficient credits");
        return;
      }
      error.message = `[e2e-live] failed during ${phase}: ${error.message}`;
      throw error;
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
}
