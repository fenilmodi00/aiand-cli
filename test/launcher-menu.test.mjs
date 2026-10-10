import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import test, { describe } from "node:test";
import { KEY } from "../dist/cli/select.js";
import {
  captureStdio,
  catalogModel,
  FakeInput,
  FakeOutput,
  fixtureFile,
  makeFixture,
  plantStub,
  seedCatalogCache,
  waitFor,
  waitForListener,
  withEnv,
  withTestEnv,
} from "./helpers.mjs";

const { launcherMenuChoices, runLauncherMenu } = await import("../dist/cli/ui/menu.js");
const { registerAgent } = await import("../dist/agents/registry.js");

let home;
let cfg;
let binDir;

const withMenuEnv = (fn) =>
  withEnv(
    {
      AIAND_HOME: home,
      AIAND_CONFIG_DIR: cfg,
      AIAND_API_KEY: "sk-test-aiand",
      PATH: `${binDir}${delimiter}${process.env.PATH}`,
    },
    fn,
  );

// Fixtures registered once: one launchable, one installed-but-sessionless,
// one missing. The registry persists in-process, so ids stay unique to this file.
const env = withTestEnv("aiand-menu-", (dir) => {
  home = join(dir, "home");
  cfg = join(dir, "cfg");
  binDir = join(dir, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(cfg, { recursive: true });
  seedCatalogCache(cfg, {
    baseUrl: "https://api.aiand.com",
    models: [catalogModel("aiand/glm-5.3"), catalogModel("aiand/other")],
  });
  process.env.AIAND_HOME = home;
  process.env.AIAND_CONFIG_DIR = cfg;
  const launch = makeFixture(home, { id: "menu-launch", installed: true });
  registerAgent({ ...launch, sessionLaunch: async () => ({ env: {} }) });
  registerAgent(makeFixture(home, { id: "menu-nosess", installed: true }));
  const missing = makeFixture(home, { id: "menu-missing", installed: false });
  registerAgent({ ...missing, sessionLaunch: async () => ({ env: {} }) });
  plantStub(binDir, "menu-launch", 'touch "$AIAND_MARKER"\nexit 42');
});

const values = (choices) => choices.map((c) => c.value);
const byValue = (choices) => Object.fromEntries(choices.map((c) => [c.value, c]));

describe("launcherMenuChoices", () => {
  test("orders launchable, wire, show-more, quit with run hints", () => {
    const choices = launcherMenuChoices({ includeMissing: false });
    const v = values(choices);
    assert.ok(v.includes("menu-launch"));
    assert.ok(v.indexOf("menu-launch") < v.indexOf("wire"));
    assert.ok(v.indexOf("wire") < v.indexOf("show-more"));
    assert.equal(v[v.length - 1], "quit");
    assert.equal(byValue(choices)["menu-launch"].hint, "aiand run-agent menu-launch");
    assert.equal(byValue(choices).wire.hint, "aiand init");
  });

  test("show-more appears only while something is missing and collapsed", () => {
    assert.ok(values(launcherMenuChoices({ includeMissing: false })).includes("show-more"));
    assert.ok(!values(launcherMenuChoices({ includeMissing: true })).includes("show-more"));
  });

  test("expanded lists missing agents with install-command hints", () => {
    const choices = launcherMenuChoices({ includeMissing: true });
    const v = values(choices);
    assert.ok(v.indexOf("menu-launch") < v.indexOf("menu-missing"));
    assert.ok(v.indexOf("menu-missing") < v.indexOf("wire"));
    assert.equal(byValue(choices)["menu-missing"].hint, "npm i -g menu-missing");
    // Installed but not session-capable counts as missing, not launchable.
    assert.ok(v.includes("menu-nosess"));
    assert.equal(byValue(choices)["menu-nosess"].hint, "npm i -g menu-nosess");
    assert.ok(!v.includes("show-more"));
  });
});

describe("runLauncherMenu", () => {
  test("Enter on a launchable agent runs run-agent and returns 0", async () => {
    const marker = join(env.dir, "launched-marker");
    const input = new FakeInput();
    const output = new FakeOutput();
    const idx = values(launcherMenuChoices({ includeMissing: false })).indexOf("menu-launch");
    const prevExit = process.exitCode;
    const cap = captureStdio({ mute: true });
    try {
      const code = await withEnv({ AIAND_MARKER: marker }, () =>
        withMenuEnv(async () => {
          const promise = runLauncherMenu({ argv: [], input, output });
          await waitForListener(input);
          for (let i = 0; i < idx; i++) input.send(KEY.DOWN);
          input.send(KEY.ENTER_CR);
          return promise;
        }),
      );
      assert.equal(code, 0);
      // The stub agent exits 42; run-agent must have propagated it through
      // process.exitCode for main() to honor (saved/restored around this).
      assert.equal(process.exitCode, 42);
      readFileSync(marker, "utf8");
    } finally {
      cap.restore();
      process.exitCode = prevExit;
    }
  });

  test("Esc returns 130 and prints Cancelled.", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const cap = captureStdio();
    try {
      const promise = runLauncherMenu({ argv: [], input, output });
      await waitForListener(input);
      input.send(KEY.ESC);
      assert.equal(await promise, 130);
    } finally {
      cap.restore();
    }
    assert.match(cap.log.out.join(""), /Cancelled\./);
  });

  test("show-more then a missing agent rejects with the 127 install hint", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const collapsed = values(launcherMenuChoices({ includeMissing: false }));
    const expanded = values(launcherMenuChoices({ includeMissing: true }));
    const promise = withMenuEnv(() => runLauncherMenu({ argv: [], input, output }));
    await waitForListener(input);
    for (let i = 0; i < collapsed.indexOf("show-more"); i++) input.send(KEY.DOWN);
    input.send(KEY.ENTER_CR);
    await waitFor(() => output.text.includes("Show more agents"), 10_000, "show-more confirm");
    await waitForListener(input);
    for (let i = 0; i < expanded.indexOf("menu-missing"); i++) input.send(KEY.DOWN);
    input.send(KEY.ENTER_CR);
    await assert.rejects(promise, (error) => {
      assert.equal(error.exitCode, 127);
      assert.match(error.hint, /npm i -g menu-missing/);
      return true;
    });
  });

  test("wire runs init --all and wires the installed fixture", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const idx = values(launcherMenuChoices({ includeMissing: false })).indexOf("wire");
    const prevExit = process.exitCode;
    const cap = captureStdio({ mute: true });
    try {
      const promise = withMenuEnv(() => runLauncherMenu({ argv: ["--all"], input, output }));
      await waitForListener(input);
      for (let i = 0; i < idx; i++) input.send(KEY.DOWN);
      input.send(KEY.ENTER_CR);
      assert.equal(await promise, 0);
    } finally {
      cap.restore();
      process.exitCode = prevExit;
    }
    const wired = JSON.parse(readFileSync(fixtureFile(home, "menu-launch"), "utf8"));
    assert.equal(wired.aiand, true);
  });
});
