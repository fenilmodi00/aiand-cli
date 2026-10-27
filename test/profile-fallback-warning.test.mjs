import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";
import { runCli } from "./helpers.mjs";

function childEnv(dir, profile) {
  const env = { ...process.env };
  delete env.AIAND_API_KEY;
  delete env.AIAND_PROFILE;
  if (profile !== undefined) env.AIAND_PROFILE = profile;
  env.AIAND_HOME = join(dir, "home");
  env.AIAND_CONFIG_DIR = join(dir, "cfg");
  env.AIAND_NO_SYNC = "1";
  env.NO_UPDATE_CHECK = "1";
  env.CI = "1";
  return env;
}

// #103: store/efficiency/mcp called resolveProfile() bare, so an explicit
// unknown --profile (or AIAND_PROFILE) fell back to the default silently —
// the #100 warning never fired outside `config`/`cache`.
describe("unknown-profile fallback warning on store/efficiency/mcp (#103)", () => {
  test("store status warns on --profile and AIAND_PROFILE; --json stdout stays parseable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiand-store-warning-"));
    try {
      const flag = await runCli(["store", "--profile", "does-not-exist"], {
        env: childEnv(dir),
      });
      assert.equal(flag.code, 0, `exit ${flag.code}: ${flag.stderr}`);
      assert.match(flag.stderr, /profile "does-not-exist" is not defined/);
      assert.match(flag.stderr, /falling back to the built-in defaults/);

      const viaEnv = await runCli(["store"], { env: childEnv(dir, "does-not-exist") });
      assert.equal(viaEnv.code, 0, viaEnv.stderr);
      assert.match(viaEnv.stderr, /profile "does-not-exist" is not defined/);

      const asJson = await runCli(["store", "--json", "--profile", "ghost"], {
        env: childEnv(dir),
      });
      assert.equal(asJson.code, 0, asJson.stderr);
      assert.match(asJson.stderr, /profile "ghost" is not defined/);
      assert.doesNotThrow(() => JSON.parse(asJson.stdout), "stdout stays parseable");
      assert.throws(() => JSON.parse(asJson.stderr), "warning is stderr-only");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("efficiency warns on an unknown profile without network (--no-sync)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiand-efficiency-warning-"));
    try {
      const r = await runCli(["efficiency", "--no-sync", "--profile", "does-not-exist"], {
        env: childEnv(dir),
      });
      assert.equal(r.code, 0, `exit ${r.code}: ${r.stderr}`);
      assert.match(r.stderr, /profile "does-not-exist" is not defined/);
      assert.match(r.stderr, /falling back to the built-in defaults/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mcp server warns on an unknown AIAND_PROFILE at startup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiand-mcp-warning-"));
    try {
      const r = await runCli(["mcp"], { env: childEnv(dir, "does-not-exist") });
      assert.equal(r.code, 0, `exit ${r.code}: ${r.stderr}`);
      assert.match(r.stderr, /profile "does-not-exist" is not defined/);
      assert.match(r.stderr, /falling back to the built-in defaults/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("defined profiles and the default flow stay warning-free", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiand-known-profile-quiet-"));
    try {
      mkdirSync(join(dir, "cfg"), { recursive: true });
      writeFileSync(
        join(dir, "cfg", "config.json"),
        `${JSON.stringify({ profile: "default", profiles: { default: {}, real: {} } })}\n`,
      );
      for (const [cmd, profile] of [
        [["store"], "real"],
        [["efficiency", "--no-sync"], "real"],
        [["store"], undefined],
        [["efficiency", "--no-sync"], undefined],
      ]) {
        const r = await runCli(cmd, { env: childEnv(dir, profile) });
        assert.equal(r.code, 0, `${cmd.join(" ")}: ${r.stderr}`);
        assert.equal(r.stderr, "", `${cmd.join(" ")} (profile ${profile}) must not warn`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
