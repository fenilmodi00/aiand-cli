import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import test, { describe } from "node:test";

import {
  CLOSED_URL,
  FAKE_API_KEY,
  makeFixture,
  seedCatalogCache,
  withTestEnv,
} from "./helpers.mjs";

let home;
withTestEnv("aiand-setup-snapshot-", (dir) => {
  home = join(dir, "home");
  const cfg = join(dir, "cfg");
  mkdirSync(home, { recursive: true });

  process.env.AIAND_HOME = home;
  process.env.AIAND_CONFIG_DIR = cfg;
  process.env.AIAND_API_KEY = FAKE_API_KEY;
  process.env.AIAND_BASE_URL = CLOSED_URL;
  // A fresh catalog cache so agentOn never touches the network.
  seedCatalogCache(cfg);
});

const setup = await import("../dist/agents/setup.js");
const snapshot = await import("../dist/agents/snapshot.js");

function plantPreAiand(adapter) {
  const [file] = adapter.managedFiles();
  mkdirSync(dirname(file), { recursive: true });
  const original = '{"theme":"dark"}\n';
  writeFileSync(file, original);
  return { file, original };
}

describe("agentOn enable failure", () => {
  test("keeps the fresh snapshot when enable fails after writing, and restore recovers pre-aiand bytes", async () => {
    const adapter = makeFixture(home, { id: "fail-after-write", failAfterWrite: true });
    const { file, original } = plantPreAiand(adapter);

    await assert.rejects(() => setup.agentOn(adapter), /boom-after-write/);

    assert.equal(await snapshot.hasSnapshot(adapter.id), true);
    assert.equal(await snapshot.restoreSnapshot(adapter.id, adapter.managedFiles()), true);
    assert.equal(readFileSync(file, "utf8"), original);
  });

  test("discards the fresh snapshot when enable fails before writing anything", async () => {
    const adapter = makeFixture(home, { id: "fail-before-write", failBeforeWrite: true });
    const { file, original } = plantPreAiand(adapter);

    await assert.rejects(() => setup.agentOn(adapter), /boom-before-write/);

    assert.equal(await snapshot.hasSnapshot(adapter.id), false);
    assert.equal(readFileSync(file, "utf8"), original);
  });
});

describe("restoreSnapshot atomic write", () => {
  test("restores byte-identical content with and without a trailing newline", async () => {
    const withNewline = join(home, "atomic-with.json");
    const withoutNewline = join(home, "atomic-without.json");
    writeFileSync(withNewline, '{"a":1}\n');
    writeFileSync(withoutNewline, '{"b":2}');

    await snapshot.snapshotFiles("atomic-fixture", [withNewline, withoutNewline]);

    writeFileSync(withNewline, '{"routed":true}\n');
    writeFileSync(withoutNewline, '{"routed":true}');

    assert.equal(
      await snapshot.restoreSnapshot("atomic-fixture", [withNewline, withoutNewline]),
      true,
    );
    assert.deepEqual(readFileSync(withNewline), Buffer.from('{"a":1}\n'));
    assert.deepEqual(readFileSync(withoutNewline), Buffer.from('{"b":2}'));
  });
});

/** Every snapshot copy file under snapshots/<agent>/, with its text. */
function snapshotCopies(agentId) {
  const root = join(process.env.AIAND_CONFIG_DIR, "snapshots", agentId);
  const copies = [];
  if (!existsSync(root)) return copies;
  for (const stamp of readdirSync(root)) {
    const dir = join(root, stamp);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      copies.push({ path: join(dir, name), text: readFileSync(join(dir, name), "utf8") });
    }
  }
  return copies;
}

const { piAdapter } = await import("../dist/agents/pi/adapter.js");

describe("snapshot hygiene when the Pi config dir moves", () => {
  // agentOn detects the binary first; the wiring itself is the real adapter.
  const pi = { ...piAdapter, detect: () => ({ installed: true, path: "/usr/bin/pi" }) };
  const dirA = () => join(home, ".pi", "agent");
  const dirB = () => join(home, "pi-moved");
  const original = '{"theme":"dark"}\n';

  function reset() {
    rmSync(join(home, ".pi"), { recursive: true, force: true });
    rmSync(dirB(), { recursive: true, force: true });
    rmSync(join(process.env.AIAND_CONFIG_DIR, "snapshots", "pi"), { recursive: true, force: true });
    mkdirSync(dirA(), { recursive: true });
    writeFileSync(join(dirA(), "settings.json"), original);
  }

  async function inDir(dir, fn) {
    const prev = process.env.PI_CODING_AGENT_DIR;
    if (dir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = dir;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
    }
  }

  test("a re-on after PI_CODING_AGENT_DIR moves never snapshots the wired auth.json", async () => {
    reset();
    await setup.agentOn(pi);
    assert.match(readFileSync(join(dirA(), "auth.json"), "utf8"), new RegExp(FAKE_API_KEY));

    // The report's scenario: the old dir still holds the key, so the
    // second on refuses before any snapshot instead of copying it.
    mkdirSync(dirB(), { recursive: true });
    await inDir(dirB(), () =>
      assert.rejects(() => setup.agentOn(pi), /Pi is already wired through/),
    );
    for (const copy of snapshotCopies("pi")) {
      assert.ok(!copy.text.includes(FAKE_API_KEY), `${copy.path} holds the key`);
    }

    // The first pre-aiand capture survived: restore gives back the original.
    await setup.agentOff(pi);
    assert.equal(await snapshot.restoreSnapshot("pi", pi.managedFiles()), true);
    assert.equal(readFileSync(join(dirA(), "settings.json"), "utf8"), original);
  });

  test("on in the new dir after off keeps the first dir's pre-aiand capture", async () => {
    reset();
    await setup.agentOn(pi);
    mkdirSync(dirB(), { recursive: true });
    await inDir(dirB(), async () => {
      // off from the moved shell strips the recorded dir too.
      await setup.agentOff(pi);
      const auth = join(dirA(), "auth.json");
      assert.ok(!existsSync(auth) || !readFileSync(auth, "utf8").includes(FAKE_API_KEY));
      await setup.agentOn(pi);
    });
    for (const copy of snapshotCopies("pi")) {
      assert.ok(!copy.text.includes(FAKE_API_KEY), `${copy.path} holds the key`);
    }
    // Restoring from the moved shell leaves the first dir's capture in place
    // (it is not a managed file there) instead of losing it.
    const skipped = [];
    await inDir(dirB(), async () => {
      await setup.agentOff(pi);
      await snapshot.restoreSnapshot("pi", pi.managedFiles(), (path, reason) =>
        skipped.push([path, reason]),
      );
    });
    assert.ok(skipped.some(([path, reason]) => path.startsWith(dirA()) && reason === "unmanaged"));
    writeFileSync(join(dirA(), "settings.json"), '{"theme":"light"}\n');
    assert.equal(await snapshot.restoreSnapshot("pi", pi.managedFiles()), true);
    assert.equal(readFileSync(join(dirA(), "settings.json"), "utf8"), original);
  });
});
