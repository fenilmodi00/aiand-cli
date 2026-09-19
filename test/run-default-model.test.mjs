import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { withMockGateway, withTestEnv } from "./helpers.mjs";

// run/chat must resolve a concrete catalog id via resolveDefault when -m is
// omitted — never invent model "auto". Mock gateway echoes the request model
// in the completion body so we can assert what left the CLI.

const BIN = join(dirname(import.meta.dirname), "dist", "index.js");

const env = withTestEnv("aiand-run-default-model-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = dir;
  delete process.env.AIAND_API_KEY;
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  delete process.env.AIAND_PROFILE;
  delete process.env.AIAND_KEY_STORAGE;
  process.env.CI = "1";
});

/**
 * Spawn the CLI with stdin ignored. execFile's default socketpair stdin makes
 * readStdin() wait forever for EOF (src/cli/stdin.ts treats sockets as pipes).
 */
const runCli = (args, extraEnv = {}) =>
  new Promise((resolve) => {
    const childEnv = { ...process.env, NO_COLOR: "1", CI: "1", ...extraEnv };
    for (const [key, value] of Object.entries(extraEnv)) {
      if (value === undefined) delete childEnv[key];
    }
    const child = spawn(process.execPath, [BIN, ...args], {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

function freshCfg(tag) {
  const cfg = mkdtempSync(join(env.dir, `run-default-${tag}-`));
  mkdirSync(join(cfg, "home"), { recursive: true });
  return { cfg, home: join(cfg, "home") };
}

describe("run default model resolution (mock gateway)", () => {
  test("omitting -m sends the curated preferred catalog id, not auto", async () => {
    await withMockGateway(async ({ url }) => {
      const { cfg, home } = freshCfg("preferred");
      const { code, stdout } = await runCli(["run", "--no-stream", "--json", "hi"], {
        AIAND_CONFIG_DIR: cfg,
        AIAND_HOME: home,
        AIAND_API_KEY: "sk-test-not-real",
        AIAND_BASE_URL: url,
      });
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.model, "zai-org/glm-5.3");
      assert.equal(parsed.choices[0].message.content, "echo:zai-org/glm-5.3");
    });
  });

  test("profile model still listed in the catalog wins when -m is omitted", async () => {
    await withMockGateway(async ({ url }) => {
      const { cfg, home } = freshCfg("profile");
      writeFileSync(
        join(cfg, "config.json"),
        JSON.stringify({
          profile: "default",
          profiles: { default: { model: "deepseek-ai/deepseek-v4-flash" } },
        }) + "\n"
      );
      const { code, stdout } = await runCli(["run", "--no-stream", "--json", "hi"], {
        AIAND_CONFIG_DIR: cfg,
        AIAND_HOME: home,
        AIAND_API_KEY: "sk-test-not-real",
        AIAND_BASE_URL: url,
      });
      assert.equal(code, 0);
      assert.equal(JSON.parse(stdout).model, "deepseek-ai/deepseek-v4-flash");
    });
  });

  test("explicit -m auto is still sent (opt-in)", async () => {
    await withMockGateway(async ({ url }) => {
      const { cfg, home } = freshCfg("explicit-auto");
      const { code, stdout } = await runCli(
        ["run", "--no-stream", "--json", "-m", "auto", "hi"],
        {
          AIAND_CONFIG_DIR: cfg,
          AIAND_HOME: home,
          AIAND_API_KEY: "sk-test-not-real",
          AIAND_BASE_URL: url,
        }
      );
      assert.equal(code, 0);
      assert.equal(JSON.parse(stdout).model, "auto");
    });
  });

  test("omitting -m fails when the catalog is unreachable and no profile model is set", async () => {
    await withMockGateway(async ({ url }) => {
      const { cfg, home } = freshCfg("catalog-down");
      const { code, stdout, stderr } = await runCli(["run", "--no-stream", "--json", "hi"], {
        AIAND_CONFIG_DIR: cfg,
        AIAND_HOME: home,
        AIAND_API_KEY: "sk-test-not-real",
        AIAND_BASE_URL: `${url}/stub/catalog-down`,
      });
      assert.notEqual(code, 0);
      assert.match(`${stderr}${stdout}`, /catalog|not supported|HTTP 500/i);
      assert.doesNotMatch(stdout, /"model": "auto"/);
    });
  });

  test("unreachable catalog still sends a configured profile model", async () => {
    await withMockGateway(async ({ url }) => {
      const { cfg, home } = freshCfg("catalog-down-profile");
      writeFileSync(
        join(cfg, "config.json"),
        JSON.stringify({
          profile: "default",
          profiles: { default: { model: "deepseek-ai/deepseek-v4-flash" } },
        }) + "\n"
      );
      const { code, stdout } = await runCli(["run", "--no-stream", "--json", "hi"], {
        AIAND_CONFIG_DIR: cfg,
        AIAND_HOME: home,
        AIAND_API_KEY: "sk-test-not-real",
        AIAND_BASE_URL: `${url}/stub/catalog-down`,
      });
      assert.equal(code, 0);
      assert.equal(JSON.parse(stdout).model, "deepseek-ai/deepseek-v4-flash");
    });
  });
});
