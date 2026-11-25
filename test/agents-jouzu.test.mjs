// Jouzu adapter: Pi's wiring, in Jouzu's own agent dir. The shared Pi-family
// core is covered in depth by agents-pi; this file pins what Jouzu adds:
// where its files live, that Pi's dir is never touched, and what `open` adds.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, resolve } from "node:path";
import test, { beforeEach, describe } from "node:test";
import {
  enableInput as baseEnableInput,
  catalogModel,
  hermeticPath,
  plantStub,
  withEnv,
  withTestEnv,
} from "./helpers.mjs";

withTestEnv("aiand-jouzu-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_API_KEY = "sk-test-123";
  mkdirSync(process.env.AIAND_CONFIG_DIR, { recursive: true });
});

const { jouzuAdapter, resolveJouzuRoot } = await import("../dist/agents/jouzu/adapter.js");
const { piAdapter } = await import("../dist/agents/pi/adapter.js");
const { findAgent, AGENTS } = await import("../dist/agents/registry.js");
const { snapshotFiles, restoreSnapshot } = await import("../dist/agents/snapshot.js");
const { CliError } = await import("../dist/cli/errors.js");

/** Jouzu's default agent dir for this platform, under the scoped AIAND_HOME. */
function defaultAgentDir() {
  const home = process.env.AIAND_HOME;
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Jouzu", "agent");
  }
  if (process.platform === "win32") return join(home, "AppData", "Roaming", "Jouzu", "agent");
  return join(home, ".config", "jouzu", "agent");
}

const agentDir = () => defaultAgentDir();
const modelsPath = () => join(agentDir(), "models.json");
const authPath = () => join(agentDir(), "auth.json");
const settingsPath = () => join(agentDir(), "settings.json");
const piDir = () => join(process.env.AIAND_HOME, ".pi", "agent");

beforeEach(() => {
  rmSync(process.env.AIAND_HOME, { recursive: true, force: true });
  for (const id of ["jouzu", "pi"]) {
    rmSync(join(process.env.AIAND_CONFIG_DIR, "snapshots", id), { recursive: true, force: true });
  }
  mkdirSync(agentDir(), { recursive: true });
});

const CATALOG = [
  catalogModel("zai-org/glm-5.3", { capabilities: ["tools", "vision"] }),
  catalogModel("qwen/qwen3.8-27b"),
];

const enableInput = (overrides = {}) =>
  baseEnableInput({
    apiKey: "sk-enable-1",
    model: "zai-org/glm-5.3",
    catalog: CATALOG,
    baseUrl: "https://api.aiand.com",
    ...overrides,
  });

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

describe("jouzu adapter", () => {
  test("is registered after hermes, answers to jz, and pins an npm install", () => {
    assert.equal(jouzuAdapter.id, "jouzu");
    assert.equal(jouzuAdapter.label, "Jouzu");
    assert.equal(jouzuAdapter.bin, "jouzu");
    assert.equal(findAgent("jz"), jouzuAdapter);
    assert.equal(findAgent("jouzu"), jouzuAdapter);
    const ids = AGENTS.map((agent) => agent.id);
    assert.equal(ids.indexOf("jouzu"), ids.indexOf("hermes") + 1);
    assert.match(
      jouzuAdapter.install.command,
      /^npm install -g --ignore-scripts jouzu@\d+\.\d+\.\d+$/,
    );
    assert.equal(jouzuAdapter.install.url, "https://github.com/shisa-ai/jouzu");
    // No launcher: JOUZU_HOME moves sessions and state with the config.
    assert.equal(jouzuAdapter.sessionLaunch, undefined);
    assert.equal(jouzuAdapter.allowUnpinnedModel, true);
  });

  test("managedFiles are Pi's three files in Jouzu's per-platform agent dir", () => {
    assert.deepEqual(jouzuAdapter.managedFiles(), [modelsPath(), authPath(), settingsPath()]);
  });

  test("JOUZU_HOME moves the agent dir to <JOUZU_HOME>/agent", async () => {
    const root = join(process.env.AIAND_HOME, "custom-jouzu");
    await withEnv({ JOUZU_HOME: root }, async () => {
      assert.deepEqual(jouzuAdapter.managedFiles(), [
        join(root, "agent", "models.json"),
        join(root, "agent", "auth.json"),
        join(root, "agent", "settings.json"),
      ]);
    });
  });

  test("JOUZU_HOME expands ~ and resolves a relative path like Jouzu does", async () => {
    await withEnv({ JOUZU_HOME: "~/jz-home" }, async () => {
      assert.equal(
        jouzuAdapter.managedFiles()[0],
        join(homedir(), "jz-home", "agent", "models.json"),
      );
    });
    await withEnv({ JOUZU_HOME: "rel-jz" }, async () => {
      assert.equal(jouzuAdapter.managedFiles()[0], join(resolve("rel-jz"), "agent", "models.json"));
    });
  });

  test("under AIAND_HOME the platform's config-home variables are ignored", async () => {
    // They describe the real home; the scoped home must win so a WSL-style
    // AIAND_HOME (or a test) never reaches the user's own Jouzu config.
    await withEnv(
      { XDG_CONFIG_HOME: "/elsewhere/xdg", APPDATA: "/elsewhere/appdata" },
      async () => {
        assert.equal(jouzuAdapter.managedFiles()[0], modelsPath());
      },
    );
  });

  test("probe(): nothing wired is inactive", async () => {
    assert.deepEqual(await jouzuAdapter.probe(), { active: false, model: null });
  });

  test("on writes Pi's provider, credential and defaults into Jouzu's dir only", async () => {
    writeJson(authPath(), { shisa: { type: "api_key", key: "sk-user-shisa" } });
    writeJson(settingsPath(), { tuiMode: "regular", defaultProvider: "shisa" });
    const result = await jouzuAdapter.enable(enableInput());
    assert.equal(result.model, "zai-org/glm-5.3");
    assert.deepEqual(result.filesWritten, [modelsPath(), authPath(), settingsPath()]);

    const provider = readJson(modelsPath()).providers.aiand;
    assert.equal(provider.baseUrl, "https://api.aiand.com/v1");
    assert.equal(provider.api, "openai-completions");
    assert.deepEqual(
      provider.models.map((model) => model.id),
      ["zai-org/glm-5.3", "qwen/qwen3.8-27b"],
    );
    const auth = readJson(authPath());
    assert.deepEqual(auth.aiand, { type: "api_key", key: "sk-enable-1", managedBy: "aiand" });
    assert.equal(auth.shisa.key, "sk-user-shisa");
    if (process.platform !== "win32") assert.equal(statSync(authPath()).mode & 0o777, 0o600);
    const settings = readJson(settingsPath());
    assert.equal(settings.defaultProvider, "aiand");
    assert.equal(settings.defaultModel, "zai-org/glm-5.3");
    assert.equal(settings.tuiMode, "regular");

    assert.deepEqual(await jouzuAdapter.probe(), { active: true, model: "zai-org/glm-5.3" });
    // Pi is a separate agent with its own files and record.
    assert.equal(existsSync(join(piDir(), "models.json")), false);
    assert.deepEqual(await piAdapter.probe(), { active: false, model: null });
  });

  test("off hands back the user's provider and removes only what on added", async () => {
    writeJson(authPath(), { shisa: { type: "api_key", key: "sk-user-shisa" } });
    writeJson(settingsPath(), { tuiMode: "regular", defaultProvider: "shisa" });
    const authBefore = readFileSync(authPath(), "utf8");
    const settingsBefore = readFileSync(settingsPath(), "utf8");
    await snapshotFiles("jouzu", jouzuAdapter.managedFiles());
    await jouzuAdapter.enable(enableInput());
    const result = await jouzuAdapter.disable();
    assert.equal(result.stripped, true);
    assert.equal(readFileSync(authPath(), "utf8"), authBefore);
    assert.equal(readFileSync(settingsPath(), "utf8"), settingsBefore);
    assert.equal(existsSync(modelsPath()), false, "the models.json on created is gone");
    assert.deepEqual(await jouzuAdapter.probe(), { active: false, model: null });
  });

  test("on refuses an aiand provider it did not write, naming Jouzu", async () => {
    writeJson(modelsPath(), {
      providers: { aiand: { baseUrl: "https://example.test/v1", api: "openai-completions" } },
    });
    await assert.rejects(
      () => jouzuAdapter.enable(enableInput()),
      (error) =>
        error instanceof CliError &&
        /Jouzu already has an aiand config/.test(error.message) &&
        /aiand jouzu on again/.test(error.hint),
    );
  });

  test("a defaultModel ai& cannot serve is set aside until off, with Jouzu's command", async () => {
    writeJson(settingsPath(), { defaultProvider: "shisa", defaultModel: "shisa-v3-coder" });
    const result = await jouzuAdapter.enable(enableInput());
    assert.ok(
      result.warnings.some((warning) => warning.includes("aiand jouzu off puts it back")),
      JSON.stringify(result.warnings),
    );
    await jouzuAdapter.disable();
    assert.deepEqual(readJson(settingsPath()), {
      defaultProvider: "shisa",
      defaultModel: "shisa-v3-coder",
    });
  });

  test("--model native wires the provider but leaves Jouzu's own model", async () => {
    const result = await jouzuAdapter.enable(enableInput({ model: "native" }));
    assert.match(result.warnings.join("\n"), /Jouzu's own default model is not on ai&/);
    const settings = readFileSync(settingsPath(), "utf8");
    assert.equal(
      settings.trim() === "" ? undefined : JSON.parse(settings).defaultProvider,
      undefined,
    );
  });

  test("refreshKey swaps only the baked key", async () => {
    await jouzuAdapter.enable(enableInput());
    assert.equal(
      await jouzuAdapter.refreshKey({ apiKey: "sk-new", previousKey: "sk-other" }),
      false,
    );
    assert.equal(
      await jouzuAdapter.refreshKey({ apiKey: "sk-new", previousKey: "sk-enable-1" }),
      true,
    );
    assert.equal(readJson(authPath()).aiand.key, "sk-new");
  });

  test("restore --force puts back the exact pre-aiand bytes", async () => {
    writeJson(settingsPath(), { tuiMode: "fullscreen" });
    const before = readFileSync(settingsPath());
    await snapshotFiles("jouzu", jouzuAdapter.managedFiles());
    await jouzuAdapter.enable(enableInput());
    assert.equal(await restoreSnapshot("jouzu", jouzuAdapter.managedFiles()), true);
    assert.ok(before.equals(readFileSync(settingsPath())));
    assert.equal(existsSync(authPath()), false);
  });

  test("a moved JOUZU_HOME still strips the files on wrote", async () => {
    const first = join(process.env.AIAND_HOME, "first");
    await withEnv({ JOUZU_HOME: first }, () => jouzuAdapter.enable(enableInput()));
    const result = await jouzuAdapter.disable();
    assert.equal(result.stripped, true);
    assert.match(result.notes.join("; "), /because the jouzu config dir moved/);
    const stale = join(first, "agent", "auth.json");
    assert.equal(existsSync(stale) && readJson(stale).aiand !== undefined, false);
  });
});

describe("jouzu carries every adapter's 0.8.0 surface", () => {
  test("carriesWiring() knows Pi's marker in Jouzu's auth.json, and nothing else", async () => {
    await jouzuAdapter.enable(enableInput());
    assert.equal(jouzuAdapter.carriesWiring(readFileSync(authPath(), "utf8")), true);
    assert.equal(jouzuAdapter.carriesWiring('{ "aiand": { "managedBy" :  "aiand" } }'), true);
    assert.equal(jouzuAdapter.carriesWiring(readFileSync(settingsPath(), "utf8")), false);
    assert.equal(jouzuAdapter.carriesWiring('{"shisa":{"type":"api_key","key":"k"}}'), false);
  });

  test("bakedBaseUrl(): reads back the https://api.aiand.com/v1 `on` baked, and nothing once off", async () => {
    assert.equal(await jouzuAdapter.bakedBaseUrl(), undefined, "nothing wired yet");
    await jouzuAdapter.enable(enableInput());
    assert.equal(await jouzuAdapter.bakedBaseUrl(), "https://api.aiand.com/v1");
    await jouzuAdapter.disable();
    assert.equal(await jouzuAdapter.bakedBaseUrl(), undefined, "off: nothing baked");
  });

  test("enableGuard(): refuses a second dir while the first holds the key, naming JOUZU_HOME", async () => {
    const first = join(process.env.AIAND_HOME, "first");
    await withEnv({ JOUZU_HOME: first }, async () => {
      await jouzuAdapter.enable(enableInput());
      await jouzuAdapter.enableGuard({ force: false });
    });
    await assert.rejects(
      () => jouzuAdapter.enableGuard({ force: false }),
      (error) =>
        error instanceof CliError &&
        error.message === `Jouzu is already wired through ${join(first, "agent")}.` &&
        /aiand jouzu off first, then aiand jouzu on for the new JOUZU_HOME/.test(error.hint),
    );
    await jouzuAdapter.disable();
    await jouzuAdapter.enableGuard({ force: false });
  });

  test("on refuses to write the key into a git work tree, and writes nothing", async () => {
    const repo = join(process.env.AIAND_HOME, "dotfiles");
    mkdirSync(join(repo, ".git"), { recursive: true });
    await withEnv({ JOUZU_HOME: join(repo, "jouzu") }, async () => {
      mkdirSync(join(repo, "jouzu", "agent"), { recursive: true });
      await assert.rejects(
        () => jouzuAdapter.enable(enableInput()),
        /Refusing to write your ai& key/,
      );
      for (const path of jouzuAdapter.managedFiles()) assert.equal(existsSync(path), false, path);
    });
  });
});

describe("jouzu detection and paths", () => {
  test("a `jz` alone belongs to another tool: not Jouzu", async () => {
    const bin = join(process.env.AIAND_HOME, "bin-jz");
    plantStub(bin, "jz");
    await withEnv({ PATH: hermeticPath(bin, "/usr/bin", "/bin") }, async () => {
      assert.deepEqual(jouzuAdapter.detect(), { installed: false, path: null });
    });
    plantStub(bin, "jouzu");
    await withEnv({ PATH: hermeticPath(bin, "/usr/bin", "/bin") }, async () => {
      assert.equal(jouzuAdapter.detect().installed, true);
    });
  });

  test("the root matches Jouzu's resolveJouzuPaths per platform, without AIAND_HOME", () => {
    const home = "/hm";
    const at = (platform, env, scopedHome) =>
      resolveJouzuRoot({
        platform,
        env,
        home: platform === "win32" ? "C:\\Users\\u" : home,
        scopedHome,
      });
    assert.equal(at("darwin", {}), "/hm/Library/Application Support/Jouzu");
    assert.equal(at("linux", {}), "/hm/.config/jouzu");
    assert.equal(at("linux", { XDG_CONFIG_HOME: "/xdg" }), "/xdg/jouzu");
    // Jouzu expands a leading ~ in XDG_CONFIG_HOME and APPDATA too.
    assert.equal(at("linux", { XDG_CONFIG_HOME: "~/cfg" }), "/hm/cfg/jouzu");
    assert.equal(at("linux", { XDG_CONFIG_HOME: "~" }), "/hm/jouzu");
    assert.equal(at("win32", {}), "C:\\Users\\u\\AppData\\Roaming\\Jouzu");
    assert.equal(at("win32", { APPDATA: "D:\\Roam" }), "D:\\Roam\\Jouzu");
    assert.equal(at("win32", { APPDATA: "~\\Roam" }), "C:\\Users\\u\\Roam\\Jouzu");
    assert.equal(at("linux", { JOUZU_HOME: "~/jz", XDG_CONFIG_HOME: "/xdg" }), "/hm/jz");
    // AIAND_HOME stands in for the home and ignores the config-home vars.
    assert.equal(at("linux", { XDG_CONFIG_HOME: "/xdg" }, "/scoped"), "/scoped/.config/jouzu");
    assert.equal(at("win32", { APPDATA: "D:\\Roam" }, "C:\\s"), "C:\\s\\AppData\\Roaming\\Jouzu");
  });

  test("the root: ~ only as a whole path segment, blank variables read as unset", () => {
    const at = (platform, env) =>
      resolveJouzuRoot({ platform, env, home: platform === "win32" ? "C:\\Users\\u" : "/hm" });
    // `~cfg` is a relative dir named ~cfg, not the home.
    assert.equal(
      at("linux", { XDG_CONFIG_HOME: "~cfg" }),
      posix.join(posix.resolve("~cfg"), "jouzu"),
    );
    assert.equal(at("win32", { APPDATA: "~" }), "C:\\Users\\u\\Jouzu");
    assert.equal(at("linux", { XDG_CONFIG_HOME: "  " }), "/hm/.config/jouzu");
    assert.equal(at("win32", { APPDATA: "  " }), "C:\\Users\\u\\AppData\\Roaming\\Jouzu");
    assert.equal(at("linux", { JOUZU_HOME: "  ", XDG_CONFIG_HOME: "/xdg" }), "/xdg/jouzu");
    // macOS reads neither variable.
    assert.equal(
      at("darwin", { XDG_CONFIG_HOME: "/xdg", APPDATA: "/ad" }),
      "/hm/Library/Application Support/Jouzu",
    );
  });
});

describe("jouzu beside pi", () => {
  test("each keeps its own files and record: off on one leaves the other on", async () => {
    mkdirSync(piDir(), { recursive: true });
    await piAdapter.enable(enableInput({ apiKey: "sk-pi" }));
    await jouzuAdapter.enable(enableInput({ apiKey: "sk-jz" }));
    assert.equal((await piAdapter.probe()).active, true);
    assert.equal((await jouzuAdapter.probe()).active, true);
    await jouzuAdapter.disable();
    assert.equal((await jouzuAdapter.probe()).active, false);
    assert.equal((await piAdapter.probe()).active, true, "pi stays on");
    assert.equal(readJson(join(piDir(), "auth.json")).aiand.key, "sk-pi");
    assert.ok(existsSync(join(process.env.AIAND_CONFIG_DIR, "snapshots", "pi", "added.json")));
    await piAdapter.disable();
  });

  test("off on Pi leaves Jouzu on, and each lists only its own files for restore", async () => {
    mkdirSync(piDir(), { recursive: true });
    await piAdapter.enable(enableInput({ apiKey: "sk-pi", model: "qwen/qwen3.8-27b" }));
    await jouzuAdapter.enable(enableInput({ apiKey: "sk-jz" }));
    const jouzuFiles = jouzuAdapter.managedFiles();
    assert.deepEqual(jouzuFiles, [modelsPath(), authPath(), settingsPath()]);
    const piFiles = piAdapter.managedFiles();
    assert.ok(
      piFiles.every((path) => path.startsWith(piDir())),
      piFiles.join(", "),
    );
    await piAdapter.disable();
    assert.equal((await piAdapter.probe()).active, false);
    assert.equal((await jouzuAdapter.probe()).active, true, "jouzu stays on");
    assert.equal(readJson(authPath()).aiand.key, "sk-jz");
    assert.equal(readJson(settingsPath()).defaultModel, "zai-org/glm-5.3");
    assert.deepEqual(await jouzuAdapter.openExtras({ args: [] }), {
      args: ["--provider", "aiand", "--model", "zai-org/glm-5.3"],
    });
    assert.deepEqual(jouzuAdapter.managedFiles(), jouzuFiles);
    await jouzuAdapter.disable();
    assert.equal(readJson(authPath()).aiand, undefined);
  });
});

describe("jouzu open extras", () => {
  test("names the wired ai& model when the args leave the model to Jouzu", async () => {
    await jouzuAdapter.enable(enableInput());
    assert.deepEqual(await jouzuAdapter.openExtras({ args: [] }), {
      args: ["--provider", "aiand", "--model", "zai-org/glm-5.3"],
    });
    assert.deepEqual(await jouzuAdapter.openExtras({ args: ["fix the failing test"] }), {
      args: ["--provider", "aiand", "--model", "zai-org/glm-5.3"],
    });
  });

  test("adds nothing when the args pick a model or session, or run a subcommand", async () => {
    await jouzuAdapter.enable(enableInput());
    for (const args of [
      ["--model", "shisa/x"],
      ["--model=shisa/x"],
      ["--provider", "shisa"],
      ["--models", "aiand/**"],
      ["--continue"],
      ["-c"],
      ["--resume"],
      ["--session", "abc"],
      ["--jouzu-profile", "ja"],
      ["--version"],
      // A forked session keeps its own model (Pi core/sdk.js).
      ["--fork", "abc", "-p", "hi"],
      ["doctor"],
      ["catalog", "status"],
      ["acp"],
      ["self-update", "check"],
      // Pi's own commands, read only as args[0] (Pi 1.5.0): flags in front
      // would turn them into a chat prompt.
      ["install", "npm:left-pad"],
      ["uninstall", "npm:left-pad"],
      ["remove", "npm:left-pad"],
      ["update"],
      ["list"],
      ["config"],
      ["mcp", "list"],
      ["auth", "login"],
    ]) {
      assert.deepEqual(await jouzuAdapter.openExtras({ args }), {}, args.join(" "));
    }
  });

  test("a Pi command word counts only as the first argument", async () => {
    await jouzuAdapter.enable(enableInput());
    const wired = { args: ["--provider", "aiand", "--model", "zai-org/glm-5.3"] };
    // Here `list` and `install` are prompt words, so the run still gets the model.
    assert.deepEqual(await jouzuAdapter.openExtras({ args: ["-p", "list", "the files"] }), wired);
    assert.deepEqual(await jouzuAdapter.openExtras({ args: ["explain", "install"] }), wired);
  });

  test("`--` only ends option parsing: the injected flags still go in front", async () => {
    await jouzuAdapter.enable(enableInput());
    const wired = { args: ["--provider", "aiand", "--model", "zai-org/glm-5.3"] };
    assert.deepEqual(await jouzuAdapter.openExtras({ args: ["--verbose", "--", "@a.ts"] }), wired);
    // After `--`, `--model` is a prompt word, not a model choice.
    assert.deepEqual(await jouzuAdapter.openExtras({ args: ["--", "--model"] }), wired);
  });

  test("adds nothing under --model native or before on", async () => {
    assert.deepEqual(await jouzuAdapter.openExtras({ args: [] }), {});
    await jouzuAdapter.enable(enableInput({ model: "native" }));
    assert.deepEqual(await jouzuAdapter.openExtras({ args: [] }), {});
  });

  test("on, then on --model native, hands the defaults back and stops naming a model", async () => {
    writeJson(settingsPath(), { tuiMode: "regular", defaultProvider: "shisa" });
    await jouzuAdapter.enable(enableInput());
    assert.equal(readJson(settingsPath()).defaultProvider, "aiand");
    await jouzuAdapter.enable(enableInput({ model: "native" }));
    assert.deepEqual(readJson(settingsPath()), { tuiMode: "regular", defaultProvider: "shisa" });
    assert.deepEqual(await jouzuAdapter.openExtras({ args: [] }), {});
    // The provider and credential stay wired; off still removes them.
    assert.ok(readJson(modelsPath()).providers.aiand);
    await jouzuAdapter.disable();
    assert.equal(readJson(authPath()).aiand, undefined);
  });

  test("on --model native names nothing while the default provider is someone else's", async () => {
    writeJson(settingsPath(), { defaultProvider: "shisa", defaultModel: "shisa/x" });
    await jouzuAdapter.enable(enableInput({ model: "native" }));
    assert.deepEqual(readJson(settingsPath()), {
      defaultProvider: "shisa",
      defaultModel: "shisa/x",
    });
    assert.deepEqual(await jouzuAdapter.openExtras({ args: [] }), {});
  });

  test("on --model native with no earlier on leaves a defaultProvider of aiand alone", async () => {
    writeJson(settingsPath(), { defaultProvider: "aiand", defaultModel: "zai-org/glm-5.3" });
    const before = readFileSync(settingsPath());
    await jouzuAdapter.enable(enableInput({ model: "native" }));
    assert.equal(readFileSync(settingsPath()).equals(before), true);
  });

  test("on, a hand-picked model, then on --model native: the pick stays", async () => {
    await jouzuAdapter.enable(enableInput());
    const settings = readJson(settingsPath());
    settings.defaultModel = "qwen/qwen3.8-27b";
    writeJson(settingsPath(), settings);
    await jouzuAdapter.enable(enableInput({ model: "native" }));
    assert.deepEqual(readJson(settingsPath()), { defaultModel: "qwen/qwen3.8-27b" });
  });

  test("after on --model native, off leaves a model the user picked since", async () => {
    writeJson(settingsPath(), { defaultModel: "gone/model" });
    await jouzuAdapter.enable(enableInput());
    await jouzuAdapter.enable(enableInput({ model: "native" }));
    assert.deepEqual(readJson(settingsPath()), { defaultModel: "gone/model" });
    // The user then picks the model the first on wrote: it is theirs now.
    writeJson(settingsPath(), { defaultModel: "zai-org/glm-5.3" });
    await jouzuAdapter.disable();
    assert.deepEqual(readJson(settingsPath()), { defaultModel: "zai-org/glm-5.3" });
  });
});
