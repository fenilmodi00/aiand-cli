import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { AGENTS } from "../dist/agents/registry.js";
import { INIT_ALL_ACTION, mainMenuItems, signInItems, signInMode } from "../dist/cli/menu-items.js";
import { withTestEnv } from "./helpers.mjs";

withTestEnv("aiand-menu-items-", (dir) => {
  process.env.AIAND_CONFIG_DIR = dir;
  process.env.AIAND_HOME = dir;
});

/** Agent ids this machine actually has, per the registry's detection. */
const installed = AGENTS.filter((adapter) => adapter.detect().installed);
const missing = AGENTS.filter((adapter) => !adapter.detect().installed);

describe("signInItems", () => {
  test("offers the two ways in and nothing else", () => {
    const rows = signInItems();
    assert.deepEqual(
      rows.map((row) => row.value),
      ["__login", "__paste"],
    );
    for (const row of rows) {
      assert.equal(row.group, "Get started");
    }
  });

  test("the browser row needs no key and the paste row flags one", () => {
    const [browser, paste] = signInItems();
    assert.equal(browser?.hint, "no key to copy");
    assert.equal(paste?.state?.text, "key missing");
    assert.equal(paste?.state?.tone, "warning");
  });

  test("a signed-in install keeps the key-missing flag off", () => {
    const paste = signInItems(true).at(-1);
    assert.equal(paste?.state, undefined);
  });

  test("each row names the command it runs", () => {
    assert.match(signInItems()[0]?.shortcut ?? "", /^aiand login$/);
    assert.match(signInItems()[1]?.shortcut ?? "", /^aiand login --paste$/);
  });
});

describe("signInMode", () => {
  test("maps a sign-in row to its flow", () => {
    assert.equal(signInMode("__login"), "browser");
    assert.equal(signInMode("__paste"), "paste");
  });

  test("anything else is not a sign-in row", () => {
    for (const value of ["status", "__quit", "__init_all", "opencode", ""]) {
      assert.equal(signInMode(value), undefined, value);
    }
  });
});

describe("mainMenuItems", () => {
  test("puts the wire-everything row above the agents", () => {
    const rows = mainMenuItems();
    assert.equal(rows[0]?.value, INIT_ALL_ACTION);
    assert.equal(rows[0]?.shortcut, "aiand init --all");
  });

  test("separates installed agents from the supported-but-missing ones", () => {
    const rows = mainMenuItems();
    const agentRows = rows.filter((row) => AGENTS.some((a) => a.id === row.value));
    for (const row of agentRows) {
      const adapter = AGENTS.find((a) => a.id === row.value);
      if (adapter?.detect().installed) {
        assert.equal(row.group, "Agents", `${adapter.id} is installed`);
      } else {
        assert.equal(row.group, "More agents", `${adapter.id} is missing`);
        assert.equal(row.state?.text, "not installed");
      }
    }
  });

  test("no agent row appears in both sections", () => {
    const rows = mainMenuItems();
    for (const adapter of AGENTS) {
      const matches = rows.filter((row) => row.value === adapter.id);
      assert.equal(matches.length, 1, `${adapter.id} appears ${matches.length} times`);
    }
  });

  test("every command row carries its own name and summary", () => {
    const rows = mainMenuItems();
    const commands = rows.filter((row) =>
      ["Ask & run", "Spend & reports", "Harness & compare", "Setup & health", "Account"].includes(
        row.group ?? "",
      ),
    );
    assert.ok(commands.length > 0, "commands are listed");
    for (const row of commands) {
      assert.ok(row.hint, `${row.value} has a hint`);
      assert.equal(row.detail, row.hint);
    }
  });

  test("the config row carries the signed-in badge", () => {
    const config = mainMenuItems().find((row) => row.value === "config");
    assert.equal(config?.state?.text, "signed in");
    assert.equal(config?.state?.tone, "success");
  });

  test("closes with a Quit row", () => {
    assert.equal(mainMenuItems().at(-1)?.value, "__quit");
  });

  test("the setup row names every installed agent when there is one", () => {
    const row = mainMenuItems()[0];
    if (installed.length > 0) {
      for (const adapter of installed) {
        assert.match(
          row.detail ?? "",
          new RegExp(adapter.label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")),
        );
      }
    } else {
      assert.match(row.detail ?? "", /No coding agents are installed/);
      assert.equal(row.state?.text, "none installed");
    }
  });

  test("rows stay unique by value so the menu can dispatch them", () => {
    const values = mainMenuItems().map((row) => row.value);
    assert.equal(new Set(values).size, values.length, "duplicate row values");
  });
});

describe("menu rows stay searchable", () => {
  test("a missing agent is findable by its install hint", () => {
    const row = mainMenuItems().find((r) => r.value === missing[0]?.id);
    assert.ok(row, "a missing agent row exists");
    assert.match(row.keywords?.join(" ") ?? "", /install/);
    assert.match(row.detail ?? "", /Enter installs it with/);
  });

  test("an installed agent is findable by its binary name", () => {
    const adapter = installed[0];
    if (!adapter) return;
    const row = mainMenuItems().find((r) => r.value === adapter.id);
    assert.match(row?.keywords?.join(" ") ?? "", new RegExp(adapter.bin));
  });

  test("a group name matches every row under that heading", () => {
    const query = "report";
    const matched = mainMenuItems().filter((row) =>
      query
        .split(/\s+/)
        .every((word) =>
          [row.label, row.group, row.hint, row.badge, row.shortcut, ...(row.keywords ?? [])]
            .filter(Boolean)
            .some((text) => text.toLowerCase().includes(word)),
        ),
    );
    const groups = new Set(matched.map((row) => row.group));
    assert.ok(groups.has("Spend & reports"), "the Spend & reports heading itself matches");
    for (const name of ["usage", "sessions", "overview", "report", "wrapped", "heatmap"]) {
      assert.ok(
        matched.some((row) => row.value === name),
        `${name} found via group name`,
      );
    }
  });
});

describe("command groups", () => {
  const GROUP_MEMBERS = {
    "Ask & run": ["run", "chat", "run-agent", "models"],
    "Spend & reports": [
      "usage",
      "sessions",
      "overview",
      "report",
      "wrapped",
      "efficiency",
      "cache",
      "logs",
      "heatmap",
      "dashboard",
      "forecast",
    ],
    "Harness & compare": ["harness", "compare", "recommend"],
    "Setup & health": ["init", "status", "doctor", "store", "restore", "update", "export"],
    Account: ["login", "logout", "whoami", "orgs", "key", "config"],
  };
  const HEADINGS = Object.keys(GROUP_MEMBERS);

  test("each group holds exactly its members", () => {
    const rows = mainMenuItems().filter((row) => HEADINGS.includes(row.group ?? ""));
    for (const [heading, members] of Object.entries(GROUP_MEMBERS)) {
      assert.deepEqual(
        rows
          .filter((row) => row.group === heading)
          .map((row) => row.value)
          .sort(),
        [...members].sort(),
        heading,
      );
    }
  });

  test("every command appears exactly once across the groups", () => {
    const rows = mainMenuItems().filter((row) => HEADINGS.includes(row.group ?? ""));
    const values = rows.map((row) => row.value);
    assert.equal(new Set(values).size, values.length, "duplicate command rows");
    const expected = Object.values(GROUP_MEMBERS).flat().sort();
    assert.deepEqual([...values].sort(), expected, "grouped rows vs ticket membership");
  });

  test("command groups render in the pre-agreed order", () => {
    const seen = [...new Set(mainMenuItems().map((row) => row.group))];
    const positions = HEADINGS.map((heading) => seen.indexOf(heading));
    assert.ok(
      positions.every((p) => p !== -1),
      "every heading appears",
    );
    assert.deepEqual(
      [...positions].sort((a, b) => a - b),
      positions,
      "headings out of order",
    );
    assert.ok(positions[0] > seen.indexOf("Get started"), "after Get started");
    assert.ok(positions.at(-1) < seen.indexOf("Menu"), "before Menu");
  });

  test("agent sections keep their rows out of the command groups", () => {
    const rows = mainMenuItems();
    for (const adapter of AGENTS) {
      const row = rows.find((r) => r.value === adapter.id);
      assert.ok(!HEADINGS.includes(row?.group ?? ""), `${adapter.id} is not a command row`);
    }
  });

  test("a command missing from the group table fails loudly", async () => {
    const { COMMANDS } = await import("../dist/commands/index.js");
    const snapshot = COMMANDS.splice(0);
    try {
      COMMANDS.push({ ...snapshot[0], name: "__future_command__" });
      assert.throws(() => mainMenuItems(), /__future_command__/);
    } finally {
      COMMANDS.splice(0, snapshot.length, ...snapshot);
    }
  });
});
