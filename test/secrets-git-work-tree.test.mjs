import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { beforeEach } from "node:test";
import { withEnv, withTestEnv } from "./helpers.mjs";

const env = withTestEnv("aiand-secrets-git-work-tree-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "repo", "config");
  process.env.AIAND_KEY_STORAGE = "file";
  delete process.env.AIAND_SECRET_STORE_MASTER_KEY;
  delete process.env.AIAND_ALLOW_GIT_TRACKED;
});

const secrets = await import("../dist/secrets.js");
const secretsFile = await import("../dist/secrets-file.js");
const { CliError } = await import("../dist/cli/errors.js");

const repoPath = () => join(env.dir, "repo");
const configPath = () => join(env.dir, "repo", "config");

beforeEach(() => {
  rmSync(env.dir, { recursive: true, force: true });
  mkdirSync(process.env.AIAND_HOME, { recursive: true });
  execFileSync("git", ["init", "--quiet", repoPath()]);
});

test("the file store refuses a config directory inside a git work tree", async () => {
  await assert.rejects(
    () => secrets.storeSecret("profile", "blob"),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(
        error.message,
        `Refusing to keep your ai& key in ${join(realpathSync(configPath()), "secret-store.json")}: it is inside the git repository at ${realpathSync(repoPath())}.`,
      );
      assert.equal(
        error.hint,
        "Move the config directory out of the repository (set AIAND_CONFIG_DIR), or add it to the repository's .gitignore and re-run with AIAND_ALLOW_GIT_TRACKED=1.",
      );
      return true;
    },
  );
});

test("AIAND_ALLOW_GIT_TRACKED=1 allows it", async () => {
  await withEnv({ AIAND_ALLOW_GIT_TRACKED: "1" }, async () => {
    assert.equal(await secrets.storeSecret("profile", "blob"), "file");
    assert.equal(await secrets.loadSecret("profile"), "blob");
  });
});

test("a config directory outside any git work tree is unaffected", async () => {
  const config = join(env.dir, "outside", "config");
  await withEnv({ AIAND_CONFIG_DIR: config }, async () => {
    assert.equal(await secrets.storeSecret("profile", "blob"), "file");
    assert.equal(await secrets.loadSecret("profile"), "blob");
  });
  assert.equal(existsSync(join(config, "secret-store.json")), true);
  assert.equal(existsSync(join(config, "secret-store.key")), true);
});

test("nothing is written when the write is refused", async () => {
  await assert.rejects(() => secrets.storeSecret("profile", "blob"), CliError);
  assert.deepEqual(readdirSync(configPath()), []);
});

test("a read that would create the key is refused", async () => {
  mkdirSync(configPath(), { recursive: true });
  writeFileSync(join(configPath(), "secret-store.json"), Buffer.from([1]));
  await assert.rejects(
    () => secretsFile.readStore(),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.match(error.message, /secret-store\.key/);
      return true;
    },
  );
  assert.deepEqual(readdirSync(configPath()), ["secret-store.json"]);
});
