import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import {
  CLOSED_URL,
  captureStdio,
  catalogModel,
  cliEnv,
  FAKE_API_KEY,
  makeFixture,
  runCli,
  seedCatalogCache,
  withEnv,
  withTestEnv,
} from "./helpers.mjs";

// Print sites that quote a gateway response, a catalog id or an adapter's
// error. Each must reach the terminal as plain text, on a pipe as well as a TTY.

let home, cfg;
const box = withTestEnv("aiand-terminal-sites-", (dir) => {
  home = join(dir, "home");
  cfg = join(dir, "cfg");
  mkdirSync(home, { recursive: true });
  process.env.AIAND_HOME = home;
  process.env.AIAND_CONFIG_DIR = cfg;
  process.env.AIAND_API_KEY = FAKE_API_KEY;
  process.env.AIAND_BASE_URL = CLOSED_URL;
  process.env.COPILOT_HOME = join(dir, "copilot-home");
  process.env.NO_COLOR = "1";
  process.env.CI = "1";
});

// A file: URL, because a bare C:\\ path is not a valid --import specifier on Windows.
const FAKE_TTY = new URL("./fake-tty.mjs", import.meta.url).href;

/** The built CLI in `dir` on a faked terminal, which `aiand chat` insists on. */
function chatCli(dir, args, input) {
  return runCli(args, {
    env: cliEnv({
      AIAND_CONFIG_DIR: dir,
      AIAND_HOME: join(dir, "home"),
      AIAND_API_KEY: FAKE_API_KEY,
      AIAND_BASE_URL: CLOSED_URL,
      AIAND_TEST_FAKE_TTY_STDIN: "1",
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import ${FAKE_TTY}`].filter(Boolean).join(" "),
      NO_COLOR: "1",
      CI: "1",
    }),
    input,
  });
}

const BAD = "\x1b]52;c;Y3VybA==\x07\x1b[2J\x1b[1A\x1b[2K‮\u0090";
const CTRL = /[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/;

/** For a readline session, whose own cursor escapes are expected: only the hostile ones may not appear. */
function assertNoHostile(text, label) {
  for (const needle of ["Y3VybA==", "\x1b]", "\x07", "\u202e", "\u0090", "\x1b[2J", "\x1b[1A"]) {
    assert.ok(
      !text.includes(needle),
      `${label} has ${JSON.stringify(needle)}: ${JSON.stringify(text)}`,
    );
  }
}

function assertPlain(text, label) {
  assert.ok(!CTRL.test(text), `${label}: ${JSON.stringify(text)}`);
  assert.ok(!text.includes("Y3VybA=="), `${label} kept an OSC payload: ${JSON.stringify(text)}`);
}

const { ApiError, CliError } = await import("../dist/cli/errors.js");
const { printNotes } = await import("../dist/cli/output.js");
const { printRebakeNotes, rebakeAgentKeys } = await import("../dist/agents/rebake.js");
const { registerAgent } = await import("../dist/agents/registry.js");
const catalog = await import("../dist/agents/catalog.js");
const initCmd = await import("../dist/commands/init.js");
const { runAgentCommand } = await import("../dist/commands/agent.js");

async function capture(fn) {
  const io = captureStdio();
  try {
    await fn();
  } finally {
    io.restore();
  }
  return { out: io.log.out.join(""), err: io.log.err.join("") };
}

describe("ApiError", () => {
  test("makes the message, request id and type safe once, at construction", () => {
    const e = new ApiError(400, `bad${BAD} request\nline2`, {
      requestId: `req${BAD}`,
      type: `t${BAD}`,
    });
    assert.equal(e.message, "bad request line2");
    assert.equal(e.requestId, "req");
    assert.equal(e.type, "t");
    assertPlain(`${e.message}${e.requestId}${e.type}`, "ApiError");
  });

  test("leaves an absent request id and type absent", () => {
    const e = new ApiError(500, "plain");
    assert.equal(e.requestId, undefined);
    assert.equal(e.type, undefined);
  });
});

describe("notes and warnings", () => {
  test("printNotes prints each line sanitised, with its indent", async () => {
    const io = await capture(() => printNotes([`a${BAD}\nb`, "c"], "  "));
    assert.equal(io.err, "  a b\n  c\n");
    assert.equal(io.out, "");
  });

  test("rebake notes quote an adapter's error as one safe line", async () => {
    const adapter = {
      id: "hostile-rebake",
      label: "Hostile",
      bin: "hostile-rebake",
      install: { command: "x", url: "https://example.com" },
      detect: () => ({ installed: true, path: "/x" }),
      managedFiles: () => [],
      probe: async () => {
        throw new Error(`cannot read${BAD}\nconfig`);
      },
      refreshKey: async () => {
        throw new Error(`refresh${BAD} failed`);
      },
    };
    registerAgent(adapter);
    const notes = await rebakeAgentKeys("sk-new");
    const note = notes.find((n) => n.agent === "hostile-rebake");
    assert.ok(note, "a failed note for the hostile adapter");
    assert.match(
      note.note,
      /Could not probe its config: cannot read config Refresh also failed: refresh failed/,
    );
    assertPlain(note.note, "note");
    const io = await capture(() => printRebakeNotes([{ ...note, note: `${note.note}${BAD}` }]));
    assertPlain(io.err, "printed note");
  });
});

describe("init and agent output", () => {
  function hostileAdapters() {
    const warns = {
      ...makeFixture(home, { id: "hostile-warn" }),
      enable: async (input) => ({
        model: input.model,
        filesWritten: [],
        warnings: [`${input.model} cannot use ${BAD} tools`],
      }),
    };
    const fails = {
      ...makeFixture(home, { id: "hostile-fail" }),
      enable: async () => {
        throw new CliError(`gateway said${BAD}\nno`, { hint: `try ${BAD}\nlater` });
      },
    };
    registerAgent(warns);
    registerAgent(fails);
  }

  test("aiand init prints notes, hints and warnings as plain text", async () => {
    seedCatalogCache(cfg);
    hostileAdapters();
    const prev = process.exitCode;
    const io = await capture(() => initCmd.run(["hostile-warn", "hostile-fail"]));
    process.exitCode = prev;
    assertPlain(io.out, "init stdout");
    assertPlain(io.err, "init stderr");
    assert.match(io.err, /gateway said no/);
    assert.match(io.err, /try {1,}\s*later|try later|try +later/);
    assert.match(io.err + io.out, /cannot use +tools/);
  });

  test("aiand <agent> on prints warnings as plain text", async () => {
    seedCatalogCache(cfg);
    const adapter = {
      ...makeFixture(home, { id: "hostile-on" }),
      enable: async (input) => ({
        model: input.model,
        filesWritten: [],
        warnings: [`careful${BAD}`],
      }),
    };
    registerAgent(adapter);
    const io = await capture(() => runAgentCommand(adapter, ["on"]));
    assertPlain(io.out, "on stdout");
    assertPlain(io.err, "on stderr");
    assert.match(io.err, /careful/);
  });

  test("aiand <agent> off prints the note as plain text", async () => {
    const adapter = {
      ...makeFixture(home, { id: "hostile-off" }),
      disable: async () => ({ stripped: false, note: `left alone${BAD}` }),
    };
    registerAgent(adapter);
    const io = await capture(() => runAgentCommand(adapter, ["off"]));
    assertPlain(io.out + io.err, "off output");
  });
});

describe("catalog ids", () => {
  const hostileModels = [
    catalogModel(`evil/model${BAD}`),
    catalogModel("evil/line\nbreak"),
    catalogModel("safe/one"),
    catalogModel("bidi/‮exe"),
  ];

  test("getCatalog drops entries whose id has control or bidi characters, from the cache", async () => {
    seedCatalogCache(cfg, { models: hostileModels });
    const models = await catalog.getCatalog(CLOSED_URL);
    assert.deepEqual(
      models.map((m) => m.id),
      ["safe/one"],
    );
  });

  test("getCatalog drops them from a live fetch before they are cached", async () => {
    const live = mkdtempSync(join(box.dir, "live-"));
    await withEnv({ AIAND_CONFIG_DIR: live }, async () => {
      const original = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ object: "list", data: hostileModels }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      try {
        const models = await catalog.getCatalog("https://api.example.test/v1");
        assert.deepEqual(
          models.map((m) => m.id),
          ["safe/one"],
        );
        const cached = await catalog.getCatalog("https://api.example.test/v1");
        assert.deepEqual(
          cached.map((m) => m.id),
          ["safe/one"],
        );
      } finally {
        globalThis.fetch = original;
      }
    });
  });

  test("the chat banner and default model never come from an unsafe id", async () => {
    const dir = mkdtempSync(join(box.dir, "chat-"));
    mkdirSync(join(dir, "home"), { recursive: true });
    seedCatalogCache(dir, {
      baseUrl: CLOSED_URL,
      models: [catalogModel(`evil/model${BAD}`), catalogModel("safe/one")],
    });
    const r = await chatCli(dir, ["chat"], "/exit\n");
    assert.equal(r.code, 0, r.stderr);
    assertNoHostile(r.stdout + r.stderr, "chat output");
    assert.match(r.stdout, /ai& chat -- model one\./);
  });

  test("the chat banner sanitises a model given with -m", async () => {
    const dir = mkdtempSync(join(box.dir, "chat-m-"));
    mkdirSync(join(dir, "home"), { recursive: true });
    seedCatalogCache(dir, { baseUrl: CLOSED_URL });
    const r = await chatCli(dir, ["chat", "-m", `m/x${BAD}`], "/model\n/model q\u001b[2J\n/exit\n");
    assertNoHostile(r.stdout, "chat stdout");
    assert.match(r.stdout, /model x\./);
  });
});
