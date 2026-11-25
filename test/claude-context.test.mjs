import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  cliEnv,
  hermeticPath,
  plantStub,
  runCli,
  withMockGateway,
  withTestEnv,
} from "./helpers.mjs";

let home, cfg, bin, capture;
withTestEnv("aiand-claude-context-", (dir) => {
  home = join(dir, "home");
  cfg = join(dir, "cfg");
  bin = join(dir, "bin");
  capture = join(dir, "settings.json");
  mkdirSync(home, { recursive: true });
  plantStub(
    bin,
    "claude",
    `cp "$2" "$AIAND_CAPTURE"
printf '%s\\n' "$@"
exit 0`,
  );
});

// compare generated startup hints with the HTTP catalog, not a copy of the fixture.
test("API catalog context_window matches permanent and launcher hints for every model", async () => {
  await withMockGateway(async ({ url }) => {
    const baseUrl = `${url}/stub/context-catalog`;
    const { data: catalog } = await (await fetch(`${baseUrl}/v1/models`)).json();
    assert.ok(new Set(catalog.map((model) => model.context_window)).size > 1);
    const env = cliEnv({
      AIAND_HOME: home,
      AIAND_CONFIG_DIR: cfg,
      AIAND_API_KEY: "sk-context-parity",
      AIAND_BASE_URL: baseUrl,
      AIAND_CAPTURE: capture,
      PATH: hermeticPath(bin, "/usr/bin", "/bin"),
      // The overlay must replace an old cap inherited from the shell.
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000",
    });
    for (const model of catalog) {
      const on = await runCli(["claude", "on", "--model", model.id], { env });
      assert.equal(on.code, 0, on.stderr);
      const permanent = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
      assert.equal(
        permanent.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
        String(model.context_window),
        model.id,
      );

      // --help passes through to the stub because --model is the first Claude arg.
      const opened = await runCli(["claude", "--model", model.id, "--help"], { env });
      assert.equal(opened.code, 0, opened.stderr);
      assert.match(opened.stdout, /--help/);
      const overlay = JSON.parse(readFileSync(capture, "utf8"));
      assert.equal(
        overlay.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
        String(model.context_window),
        model.id,
      );
      assert.equal(overlay.env.CLAUDE_CODE_DISABLE_1M_CONTEXT, "1");
    }
  });
});

// Through the real launcher: aiand lifts a concrete --model and --fast-model,
// and leaves an alias for Claude Code, whose slot then sets the budget.
test("aiand claude sizes the budget for --model, or for the slot an alias starts on", async () => {
  await withMockGateway(async ({ url }) => {
    const env = cliEnv({
      AIAND_HOME: home,
      AIAND_CONFIG_DIR: cfg,
      AIAND_API_KEY: "sk-context-parity",
      AIAND_BASE_URL: `${url}/stub/context-catalog`,
      AIAND_CAPTURE: capture,
      PATH: hermeticPath(bin, "/usr/bin", "/bin"),
    });
    const hint = async (args) => {
      const opened = await runCli(["claude", ...args, "--help"], { env });
      assert.equal(opened.code, 0, opened.stderr);
      return JSON.parse(readFileSync(capture, "utf8")).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
    };
    const fast = ["--fast-model", "openai/gpt-5"];
    assert.equal(await hint(["--model", "zai-org/glm-5.3", ...fast]), "1048576");
    assert.equal(await hint(["--model", "zai-org/glm-5.3", ...fast, "--model", "haiku"]), "32768");
  });
});
