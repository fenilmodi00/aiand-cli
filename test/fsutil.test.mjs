import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, win32 } from "node:path";
import test, { after, before, describe } from "node:test";
import { fileURLToPath } from "node:url";

import { createSessionOverlay } from "../dist/agents/managed-file.js";
import { makeOverlayDir } from "../dist/agents/overlays.js";
import { stealLock, withFileLock } from "../dist/filelock.js";
import {
  configDir,
  makePrivateTempDir,
  ownerRestrictionFailedFor,
  PRIVATE_FILE_MODE,
  pathIsInside,
  resetOwnerRestriction,
  restrictToOwner,
  writeFileAtomic,
} from "../dist/fsutil.js";
import { assertMode, asWin32, plantWindowsTools, systemRootEnv, withEnv } from "./helpers.mjs";

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "aiand-fsutil-test-"));
  // configDir() must point inside the sandbox: the "chmod under configDir"
  // test writes through the real configDir() and must never touch ~/.config/aiand.
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  test("a file where a directory belongs is a CliError, not a raw errno", async () => {
    const sandbox = mkdtempSync(join(dir, "squat-"));
    const blocker = join(sandbox, "blocker");
    writeFileSync(blocker, "in the way\n");
    await assert.rejects(
      () => writeFileAtomic(join(blocker, "config.json"), "{}\n"),
      (error) =>
        error.name === "CliError" &&
        /not a directory/.test(error.message) &&
        /Remove or rename/.test(error.hint),
    );
    assert.equal(readFileSync(blocker, "utf8"), "in the way\n");
  });

  test("writes through a symlink instead of replacing the link", async () => {
    if (process.platform === "win32") return; // symlinkSync needs Developer Mode
    const sandbox = mkdtempSync(join(dir, "link-"));
    const real = join(sandbox, "real.json");
    const link = join(sandbox, "link.json");
    writeFileSync(real, '{"old":true}\n');
    symlinkSync(real, link);

    const next = '{"new":true}\n';
    await writeFileAtomic(link, next, { mode: 0o600 });

    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(readFileSync(link, "utf8"), next);
    assert.equal(readFileSync(real, "utf8"), next);
    assert.deepEqual(
      readdirSync(sandbox).filter((name) => name.endsWith(".tmp")),
      [],
    );
  });

  test("writes a plain path and preserves an existing file's mode", async () => {
    const sandbox = mkdtempSync(join(dir, "plain-"));
    const target = join(sandbox, "config.json");
    writeFileSync(target, '{"old":true}\n');
    chmodSync(target, 0o640);

    const next = '{"new":true}\n';
    await writeFileAtomic(target, next);
    assert.equal(readFileSync(target, "utf8"), next);
    assertMode(target, 0o640);
    assert.deepEqual(
      readdirSync(sandbox).filter((name) => name.endsWith(".tmp")),
      [],
    );
  });

  test("writes through a relative symlink", async () => {
    if (process.platform === "win32") return; // symlinkSync needs Developer Mode
    const sandbox = mkdtempSync(join(dir, "rel-"));
    const real = join(sandbox, "real.json");
    const link = join(sandbox, "link.json");
    writeFileSync(real, '{"old":true}\n');
    symlinkSync("real.json", link);

    const next = '{"new":true}\n';
    await writeFileAtomic(link, next, { mode: 0o600 });
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(readFileSync(real, "utf8"), next);
  });

  test("does not chmod third-party parent directories", async () => {
    const thirdParty = mkdtempSync(join(dir, "third-party-"));
    chmodSync(thirdParty, 0o755);
    const target = join(thirdParty, "nested", "config.json");
    await writeFileAtomic(target, '{"ok":true}\n', { mode: 0o600 });
    assertMode(thirdParty, 0o755);
    assert.equal(readFileSync(target, "utf8"), '{"ok":true}\n');
  });

  test("pathIsInside rejects absolute relative results (win32 cross-drive)", () => {
    // win32.relative('C:\\cfg', 'D:\\other') === 'D:\\other': absolute, no
    // '..' prefix. Without the isAbsolute guard this reads as "inside" and
    // writeFileAtomic would chmod 0700 a foreign drive.
    assert.equal(win32.isAbsolute(win32.relative("C:\\cfg", "D:\\other")), true);
    assert.equal(pathIsInside("C:\\cfg", "D:\\other", win32), false);
    assert.equal(pathIsInside("C:\\cfg", "C:\\cfg\\nested", win32), true);
    assert.equal(pathIsInside("C:\\cfg", "C:\\cfg", win32), true);
    assert.equal(pathIsInside("C:\\cfg", "C:\\other", win32), false);
    // POSIX sanity on the default impl.
    assert.equal(pathIsInside("/cfg", "/cfg/nested"), true);
    assert.equal(pathIsInside("/cfg", "/cfg"), true);
    assert.equal(pathIsInside("/cfg", "/other"), false);
  });

  test("chmod 0700 parents under configDir", async () => {
    const cfgRoot = configDir();
    const nested = join(cfgRoot, "profiles", "nested");
    mkdirSync(nested, { recursive: true, mode: 0o755 });
    chmodSync(nested, 0o755);
    const target = join(nested, "state.json");
    await writeFileAtomic(target, '{"ok":true}\n', { mode: 0o600 });
    assertMode(nested, 0o700);
    assert.equal(readFileSync(target, "utf8"), '{"ok":true}\n');
  });

  test("does not chmod symlinked-outside parent directories under configDir", async () => {
    if (process.platform === "win32") return;
    const cfgRoot = configDir();
    mkdirSync(cfgRoot, { recursive: true });
    const outside = mkdtempSync(join(dir, "outside-"));
    chmodSync(outside, 0o755);
    const linkPath = join(cfgRoot, "outside-link");
    try {
      symlinkSync(outside, linkPath);
    } catch {
      return;
    }
    const target = join(linkPath, "nested", "config.json");
    await writeFileAtomic(target, '{"ok":true}\n', { mode: 0o600 });
    assertMode(outside, 0o755);
    assert.equal(readFileSync(target, "utf8"), '{"ok":true}\n');
  });

  test("replaces a broken symlink with a regular file", async () => {
    if (process.platform === "win32") return; // symlinkSync needs Developer Mode
    const sandbox = mkdtempSync(join(dir, "broken-"));
    const link = join(sandbox, "link.json");
    symlinkSync(join(sandbox, "missing.json"), link);

    const next = '{"new":true}\n';
    await writeFileAtomic(link, next, { mode: 0o600 });
    assert.equal(lstatSync(link).isSymbolicLink(), false);
    assert.equal(readFileSync(link, "utf8"), next);
  });
});

describe("withFileLock", () => {
  test("runs one holder at a time and replaces a stale lock", async () => {
    const lock = join(dir, "locks", "one");
    const order = [];
    const hold = (name) =>
      withFileLock(lock, async () => {
        order.push(`${name}+`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push(`${name}-`);
      });
    await Promise.all([hold("a"), hold("b")]);
    assert.ok(["a+,a-,b+,b-", "b+,b-,a+,a-"].includes(order.join()));

    writeFileSync(lock, "");
    assert.equal(await withFileLock(lock, async () => "ran", { unreadableGraceMs: 100 }), "ran");
  });

  test("replaces a fresh lock whose holder was killed", async () => {
    const lock = join(dir, "locks", "dead");
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
      encoding: "utf8",
    }).stdout;
    writeFileSync(lock, dead);
    const started = Date.now();
    assert.equal(await withFileLock(lock, async () => "ran"), "ran");
    assert.ok(Date.now() - started < 5_000, "did not wait out the stale age");
  });

  test("keeps a lock whose live holder has not touched it for a minute", async () => {
    const lock = join(dir, "locks", "live-old");
    writeFileSync(lock, String(process.pid));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    let ran = false;
    const pending = withFileLock(lock, async () => {
      ran = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(ran, false, "stole the lock of a process that is still running");
    rmSync(lock);
    await pending;
    assert.equal(ran, true);
  });

  test("steals a live pid's lock once nothing has touched it for the hung limit", async () => {
    // A killed `aiand key export` whose pid now belongs to an unrelated
    // process: alive, and it will never touch the lock.
    const lock = join(dir, "locks", "hung");
    writeFileSync(lock, `${process.pid} 0123456789abcdef`);
    const started = Date.now();
    assert.equal(await withFileLock(lock, async () => "ran", { hungMs: 400 }), "ran");
    const waited = Date.now() - started;
    assert.ok(waited >= 400, `stole after ${waited} ms, before the limit`);
    assert.ok(waited < 5_000, `waited ${waited} ms: the limit is not what held it`);
  });

  test("a live holder whose lock mtime is far behind the clock but still changing is not hung", async () => {
    // After a sleep or a clock step, mtimes (written from the wall clock) and
    // Date.now() disagree for good. Only a lock that stops changing is hung.
    const lock = join(dir, "locks", "clock-behind");
    writeFileSync(lock, `${process.pid} 0123456789abcdef`);
    let beat = 0;
    const heartbeat = setInterval(() => {
      beat += 1;
      const behind = new Date(Date.now() - 3_600_000 + beat * 1_000);
      utimesSync(lock, behind, behind);
    }, 50);
    let ran = false;
    const pending = withFileLock(
      lock,
      async () => {
        ran = true;
      },
      { hungMs: 300 },
    );
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    clearInterval(heartbeat);
    assert.equal(ran, false, "took the lock of a holder that was still beating");
    assert.equal(await pending, undefined);
    assert.equal(ran, true, "once the beat stopped the lock was taken");
  });

  test("a waiter that was itself stopped does not count the stop against the holder", async () => {
    // A sleeping laptop stops the waiter and the holder together: the holder's
    // next beat is still to come when the waiter wakes. Stand in for the stop
    // by blocking this process's event loop.
    const lock = join(dir, "locks", "waiter-frozen");
    writeFileSync(lock, `${process.pid} 0123456789abcdef`);
    const started = Date.now();
    setTimeout(() => {
      const until = Date.now() + 1_400;
      while (Date.now() < until);
    }, 300);
    await withFileLock(lock, async () => {}, { hungMs: 1_500 });
    const waited = Date.now() - started;
    // Without the restart the lock is judged hung at about 1.7 s (1.4 s of it
    // stopped); with it, 1.5 s of silence has to be watched from the wake.
    assert.ok(waited >= 2_900, `stole after ${waited} ms: the stop counted as silence`);
  });

  test("a lock from before the nonce, which names a pid alone, is still judged by that pid", async () => {
    const lock = join(dir, "locks", "legacy-pid");
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
      encoding: "utf8",
    }).stdout;
    writeFileSync(lock, dead);
    assert.equal(await withFileLock(lock, async () => "ran"), "ran");
    writeFileSync(lock, String(process.pid));
    let ran = false;
    const pending = withFileLock(lock, async () => {
      ran = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(ran, false, "stole the lock of a live pid");
    rmSync(lock);
    await pending;
  });

  test("a holder writes its pid and a nonce, and a second run gets a different nonce", async () => {
    const lock = join(dir, "locks", "identity");
    const seen = [];
    for (let i = 0; i < 2; i += 1) {
      await withFileLock(lock, async () => {
        seen.push(readFileSync(lock, "utf8"));
      });
    }
    for (const text of seen) assert.match(text, new RegExp(`^${process.pid} [0-9a-f]{16}$`));
    assert.notEqual(seen[0], seen[1]);
  });

  test("a release never deletes a lock a recycled pid with another nonce holds", async () => {
    const lock = join(dir, "locks", "same-pid");
    await withFileLock(lock, async () => {
      rmSync(lock);
      writeFileSync(lock, `${process.pid} ffffffffffffffff`);
    });
    assert.equal(readFileSync(lock, "utf8"), `${process.pid} ffffffffffffffff`);
    rmSync(lock);
  });

  test("refreshes the lock's mtime while the holder is still working", async () => {
    const lock = join(dir, "locks", "heartbeat");
    const seen = [];
    await withFileLock(
      lock,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        seen.push(Date.now() - statSync(lock).mtimeMs);
      },
      { heartbeatMs: 25 },
    );
    assert.ok(seen[0] < 150, `mtime was ${seen[0]} ms old after 250 ms of work`);
  });

  test("an unreadable lock is stolen only after a grace period", async () => {
    const lock = join(dir, "locks", "unreadable");
    writeFileSync(lock, "");
    let ran = false;
    const pending = withFileLock(
      lock,
      async () => {
        ran = true;
      },
      { unreadableGraceMs: 400 },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(ran, false, "stole a lock whose holder may still be writing its pid");
    await pending;
    assert.equal(ran, true);
  });

  test("waiters stealing the same dead lock never run together", async () => {
    const lock = join(dir, "locks", "steal-race");
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
      encoding: "utf8",
    }).stdout;
    writeFileSync(lock, dead);
    let active = 0;
    let overlapped = false;
    await Promise.all(
      Array.from({ length: 12 }, () =>
        withFileLock(lock, async () => {
          active += 1;
          if (active > 1) overlapped = true;
          await new Promise((resolve) => setTimeout(resolve, 15));
          active -= 1;
        }),
      ),
    );
    assert.equal(overlapped, false, "two holders ran inside the lock at once");
    assert.deepEqual(
      readdirSync(join(dir, "locks")).filter((name) => name.startsWith("steal-race")),
      [],
      "left a stolen lock behind",
    );
  });

  test("a steal guard left by a dead stealer does not block the next steal", async () => {
    const lock = join(dir, "locks", "dead-guard");
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
      encoding: "utf8",
    }).stdout;
    writeFileSync(lock, dead);
    writeFileSync(`${lock}.steal`, dead);
    assert.equal(await withFileLock(lock, async () => "ran"), "ran");
    assert.equal(existsSync(`${lock}.steal`), false);
  });

  test("a lock that vanishes between the open and the read is retried, never judged stale", {
    skip: process.platform === "win32" && "creating a symlink needs a privilege on Windows",
  }, async () => {
    // A dangling symlink answers the exclusive open with EEXIST and every read
    // with ENOENT, which is what a lock released mid-check looks like.
    const lock = join(dir, "locks", "vanished");
    mkdirSync(join(dir, "locks"), { recursive: true });
    symlinkSync(join(dir, "nowhere"), lock);
    const pending = withFileLock(lock, async () => "ran");
    await new Promise((resolve) => setTimeout(resolve, 100));
    rmSync(lock);
    assert.equal(await pending, "ran");
  });

  describe("the steal re-check", () => {
    // A waiter judges a lock stale, then another waiter steals it and creates
    // its own. Under the guard the first one must look again: deleting the new
    // lock would put two holders in the critical section, and the refresh
    // token would be rotated twice.
    const staleText = "999999999 0000000000000000";
    const freshText = `${process.pid} 1111111111111111`;

    test("leaves a lock that changed after it was judged stale", async () => {
      const lock = join(dir, "locks", "recheck-changed");
      writeFileSync(lock, freshText);
      assert.equal(await stealLock(lock, staleText, () => true), false);
      assert.equal(readFileSync(lock, "utf8"), freshText, "deleted the new holder's lock");
      assert.equal(existsSync(`${lock}.steal`), false, "left its guard behind");
    });

    test("leaves a lock that is not stale when looked at again", async () => {
      const lock = join(dir, "locks", "recheck-fresh");
      writeFileSync(lock, freshText);
      assert.equal(await stealLock(lock, freshText, () => false), false);
      assert.equal(readFileSync(lock, "utf8"), freshText);
    });

    test("leaves a lock that vanished", async () => {
      const lock = join(dir, "locks", "recheck-gone");
      mkdirSync(join(dir, "locks"), { recursive: true });
      assert.equal(await stealLock(lock, staleText, () => true), false);
      assert.equal(existsSync(lock), false);
    });

    test("removes the lock it judged, when it is still that lock and still stale", async () => {
      const lock = join(dir, "locks", "recheck-steals");
      writeFileSync(lock, staleText);
      assert.equal(await stealLock(lock, staleText, () => true), true);
      assert.equal(existsSync(lock), false);
      assert.equal(existsSync(`${lock}.steal`), false);
    });

    test("two waiters that judged the same lock stale take it one after the other", async () => {
      // The slow one arrives after the fast one has already put its own lock
      // in place: only the first steal may remove anything.
      const lock = join(dir, "locks", "recheck-two");
      writeFileSync(lock, staleText);
      assert.equal(await stealLock(lock, staleText, () => true), true);
      writeFileSync(lock, freshText);
      assert.equal(await stealLock(lock, staleText, () => true), false);
      assert.equal(readFileSync(lock, "utf8"), freshText);
    });
  });

  test("a release never deletes a lock another process took over", async () => {
    const lock = join(dir, "locks", "taken-over");
    await withFileLock(lock, async () => {
      rmSync(lock);
      writeFileSync(lock, "999999999");
    });
    assert.equal(readFileSync(lock, "utf8"), "999999999");
    rmSync(lock);
  });
});

// Windows ignores 0600/0700, so key-holding paths get an owner-only DACL.
// The tools are stubbed under a fake SystemRoot: the CLI spawns them by
// absolute path, never through PATH (a cloned repo could plant one).
describe("restrictToOwner", () => {
  const SID = "S-1-5-21-111-222-333-1001";
  let root;
  let log;
  const calls = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  before(() => {
    root = mkdtempSync(join(dir, "sysroot-"));
    log = join(root, "calls.log");
    plantWindowsTools(root, {
      "System32/whoami.exe": `
import { appendFileSync } from "node:fs";
appendFileSync(process.env.AIAND_TEST_TOOL_LOG, JSON.stringify({ tool: "whoami", argv: process.argv.slice(2), leaked: Object.keys(process.env).filter((k) => /^AIAND_(API_KEY|SECRET_STORE_MASTER_KEY)$/.test(k)) }) + "\\n");
process.stdout.write('"host\\\\me","${SID}"\\r\\n');
`,
      "System32/icacls.exe": `
import { appendFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const st = statSync(process.argv[2]);
appendFileSync(process.env.AIAND_TEST_TOOL_LOG, JSON.stringify({ tool: "icacls", argv: process.argv.slice(2), size: st.isDirectory() ? "dir" : st.size, entries: st.isDirectory() ? readdirSync(process.argv[2]).length : undefined, leaked: Object.keys(process.env).filter((k) => /^AIAND_(API_KEY|SECRET_STORE_MASTER_KEY)$/.test(k)), noCwd: process.env.NoDefaultCurrentDirectoryInExePath }) + "\\n");
const [path, ...rest] = process.argv.slice(2);
if (process.env.AIAND_TEST_ACL_PLANT && rest.includes("/inheritance:r")) writeFileSync(join(path, "planted.json"), "x");
if (rest.length === 0) {
  // A listing: the user's own entry, then whatever the scenario adds.
  const own = process.env.AIAND_TEST_ACL_OWN ?? "host\\\\me";
  const names = [own, ...(process.env.AIAND_TEST_ACL_EXTRA ?? "").split(",").filter(Boolean)];
  process.stdout.write(names.map((n, i) => (i === 0 ? path + " " : "    ") + n + ":(OI)(CI)(F)").join("\\r\\n") + "\\r\\n\\r\\nSuccessfully processed 1 files; Failed processing 0 files\\r\\n");
  process.exit(0);
}
process.exit(path.includes("icacls-fails") || (path.includes("remove-fails") && rest.includes("/remove")) ? 5 : 0);
`,
    });
  });
  // A real Windows host has already cached its own SID by now, so each scenario starts clean.
  const onWindows = (fn) =>
    withEnv({ SystemRoot: root, AIAND_TEST_TOOL_LOG: log }, () =>
      asWin32(() => {
        resetOwnerRestriction();
        return fn();
      }),
    );

  test("is a no-op off Windows", { skip: process.platform === "win32" }, async () => {
    writeFileSync(log, "");
    const file = join(dir, "posix.txt");
    writeFileSync(file, "x");
    await withEnv({ SystemRoot: root, AIAND_TEST_TOOL_LOG: log }, () => restrictToOwner(file));
    assert.deepEqual(calls(), []);
  });

  test("grants the current user's SID alone, inheritable on a dir", async () => {
    writeFileSync(log, "");
    const target = mkdtempSync(join(dir, "acl-dir-"));
    const file = join(target, "f.txt");
    writeFileSync(file, "x");
    await onWindows(async () => {
      await restrictToOwner(target);
      await restrictToOwner(target);
      await restrictToOwner(file);
    });
    const icacls = calls().filter((c) => c.tool === "icacls" && c.argv.includes("/inheritance:r"));
    assert.deepEqual(icacls[0].argv, [target, "/inheritance:r", "/grant:r", `*${SID}:(OI)(CI)F`]);
    assert.deepEqual(icacls[1].argv, [file, "/inheritance:r", "/grant:r", `*${SID}:F`]);
    assert.equal(icacls.length, 2, "a dir already restricted this process is not re-spawned");
  });

  test("removes every other entry, explicit ones included, and keeps the user's own", async () => {
    writeFileSync(log, "");
    const target = mkdtempSync(join(dir, "acl-others-"));
    await withEnv(
      { AIAND_TEST_ACL_EXTRA: "NT AUTHORITY\\SYSTEM,BUILTIN\\Administrators,S-1-5-32-545" },
      () => onWindows(() => restrictToOwner(target, { dir: true })),
    );
    const removal = calls().find((c) => c.tool === "icacls" && c.argv.includes("/remove"));
    assert.deepEqual(removal.argv, [
      target,
      "/remove",
      "NT AUTHORITY\\SYSTEM",
      "/remove",
      "BUILTIN\\Administrators",
      "/remove",
      "*S-1-5-32-545",
    ]);
  });

  test("a listing that shows the user by SID, in any case, is left alone", async () => {
    writeFileSync(log, "");
    const target = mkdtempSync(join(dir, "acl-own-sid-"));
    await withEnv({ AIAND_TEST_ACL_OWN: SID.toLowerCase() }, () =>
      onWindows(() => restrictToOwner(target, { dir: true })),
    );
    assert.ok(!calls().some((c) => c.argv?.includes("/remove")), "nothing to remove");
  });

  test("an ACL already owner-only costs no removal call", async () => {
    writeFileSync(log, "");
    const target = mkdtempSync(join(dir, "acl-clean-"));
    await onWindows(() => restrictToOwner(target, { dir: true }));
    assert.ok(!calls().some((c) => c.argv?.includes("/remove")));
  });

  test("a removal that fails is recorded against that path only", async () => {
    const target = mkdtempSync(join(dir, "remove-fails-"));
    const other = mkdtempSync(join(dir, "acl-fine-"));
    const failed = await withEnv({ AIAND_TEST_ACL_EXTRA: "BUILTIN\\Users" }, () =>
      onWindows(async () => {
        const ok = await restrictToOwner(target, { dir: true });
        await restrictToOwner(other, { dir: true });
        return {
          ok,
          target: ownerRestrictionFailedFor([target]),
          other: ownerRestrictionFailedFor([other]),
        };
      }),
    );
    assert.deepEqual(failed, { ok: false, target: true, other: false });
  });

  test("a temp file that fails is recorded under the file it becomes, not its temp name", async () => {
    const target = join(mkdtempSync(join(dir, "icacls-fails-")), "secret.json");
    const seen = await onWindows(async () => {
      await writeFileAtomic(target, "data", { mode: PRIVATE_FILE_MODE });
      return {
        final: ownerRestrictionFailedFor([target]),
        unrelated: ownerRestrictionFailedFor([join(dir, "never-written.json")]),
      };
    });
    assert.deepEqual(seen, { final: true, unrelated: false });
  });

  test("a private temp dir refuses an entry planted while it still had the inherited ACL", async () => {
    await assert.rejects(
      withEnv({ AIAND_TEST_ACL_PLANT: "1" }, () =>
        onWindows(() => makePrivateTempDir("aiand-planted-")),
      ),
      /was not private/,
    );
    const left = readdirSync(tmpdir()).filter((name) => name.startsWith("aiand-planted-"));
    assert.deepEqual(left, [], "the dir is removed");
  });

  test("a private temp dir that cannot be restricted is refused and removed", async () => {
    // The stub icacls fails for a path containing "icacls-fails".
    await assert.rejects(
      onWindows(() => makePrivateTempDir("aiand-icacls-fails-")),
      (error) =>
        error.name === "CliError" && /was not private; nothing was written/.test(error.message),
    );
    const left = readdirSync(tmpdir()).filter((name) => name.startsWith("aiand-icacls-fails-"));
    assert.deepEqual(left, [], "the dir is removed");
  });

  test("a private temp dir that stays empty is handed back", async () => {
    const made = await onWindows(() => makePrivateTempDir("aiand-private-"));
    try {
      assert.deepEqual(readdirSync(made), []);
    } finally {
      rmSync(made, { recursive: true, force: true });
    }
  });

  test("icacls and whoami start without the CLI's own secrets, and never search the cwd", async () => {
    writeFileSync(log, "");
    const target = mkdtempSync(join(dir, "acl-env-"));
    await withEnv(
      { AIAND_API_KEY: "sk-test-not-real", AIAND_SECRET_STORE_MASTER_KEY: "ab".repeat(32) },
      () => onWindows(() => restrictToOwner(target, { dir: true })),
    );
    // whoami runs once per process, so an earlier test may have used it already.
    const seen = calls();
    assert.ok(seen.some((c) => c.tool === "icacls"));
    for (const call of seen) assert.deepEqual(call.leaked, [], `${call.tool} inherited a secret`);
    assert.equal(seen.find((c) => c.tool === "icacls").noCwd, "1");
  });

  test("writeFileAtomic restricts a private file before its first byte", async () => {
    writeFileSync(log, "");
    const target = join(mkdtempSync(join(dir, "acl-write-")), "secret.json");
    await onWindows(() => writeFileAtomic(target, "sk-test-not-real", { mode: PRIVATE_FILE_MODE }));
    const icacls = calls().filter((c) => c.tool === "icacls" && c.argv.includes("/inheritance:r"));
    assert.equal(icacls.length, 1);
    assert.match(icacls[0].argv[0], /\.tmp$/, "the temp file, before rename");
    assert.equal(icacls[0].size, 0, "nothing written yet when the ACL lands");
    assert.equal(readFileSync(target, "utf8"), "sk-test-not-real");
  });

  test("writeFileAtomic leaves a non-private file's ACL alone", async () => {
    writeFileSync(log, "");
    const target = join(mkdtempSync(join(dir, "acl-public-")), "plain.json");
    await onWindows(() => writeFileAtomic(target, "{}", { mode: 0o644 }));
    assert.deepEqual(calls(), []);
  });

  test("writeFileAtomic restricts the config dir it writes into", async () => {
    writeFileSync(log, "");
    await onWindows(() => writeFileAtomic(join(configDir(), "x.json"), "{}", { mode: 0o644 }));
    const icacls = calls().filter((c) => c.tool === "icacls");
    assert.deepEqual(icacls[0]?.argv[0], configDir());
    assert.equal(icacls[0]?.size, "dir");
  });

  test("a session overlay dir is restricted before the key is written into it", async () => {
    writeFileSync(log, "");
    const overlay = await onWindows(() => createSessionOverlay("aiand-acl-test-", { key: "sk-x" }));
    try {
      const icacls = calls().filter((c) => c.tool === "icacls");
      assert.equal(icacls[0]?.argv[0], overlay.dir);
      assert.equal(icacls[0]?.argv.at(-1), `*${SID}:(OI)(CI)F`);
    } finally {
      await overlay.cleanup();
    }
  });

  test("makeOverlayDir restricts the dir while it is empty, then its marker file", async () => {
    writeFileSync(log, "");
    const overlayDir = await onWindows(() => makeOverlayDir("aiand-acl-marker-"));
    try {
      const icacls = calls().filter(
        (c) => c.tool === "icacls" && c.argv.includes("/inheritance:r"),
      );
      assert.equal(icacls[0]?.argv[0], overlayDir);
      assert.equal(icacls[0]?.argv.at(-1), `*${SID}:(OI)(CI)F`);
      assert.equal(icacls[0]?.entries, 0, "nothing inside yet when the ACL lands");
      assert.equal(icacls[1]?.argv[0], join(overlayDir, ".aiand-overlay"));
      assert.equal(icacls[1]?.argv.at(-1), `*${SID}:F`);
      assert.equal(icacls.length, 2);
    } finally {
      rmSync(overlayDir, { recursive: true, force: true });
    }
  });

  test("makePrivateTempDir is the only temp dir in src, so none skips the owner-only ACL", () => {
    const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
    const sites = [];
    const walk = (current) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (path.endsWith(".ts") && /mkdtemp(Sync)?\(/.test(readFileSync(path, "utf8"))) {
          sites.push(relative(srcRoot, path).replaceAll("\\", "/"));
        }
      }
    };
    walk(srcRoot);
    assert.deepEqual(sites, ["fsutil.ts"]);
  });

  test("an icacls failure never fails the write; AIAND_DEBUG=1 names it", async () => {
    const target = join(mkdtempSync(join(dir, "icacls-fails-")), "secret.json");
    const { stderr } = await captureStderr(() =>
      withEnv({ AIAND_DEBUG: "1" }, () =>
        onWindows(() => writeFileAtomic(target, "data", { mode: PRIVATE_FILE_MODE })),
      ),
    );
    assert.equal(readFileSync(target, "utf8"), "data");
    assert.match(stderr, /could not restrict .* to its owner: icacls exited 5/);
  });

  test("whoami, the first tool a fresh process runs, starts without the CLI's secrets", () => {
    const fresh = mkdtempSync(join(dir, "sysroot-whoami-env-"));
    const freshLog = join(fresh, "calls.log");
    const record = `
import { appendFileSync } from "node:fs";
appendFileSync(process.env.AIAND_TEST_TOOL_LOG, JSON.stringify({ tool: process.argv[1].endsWith("whoami.exe.mjs") ? "whoami" : "icacls", env: Object.keys(process.env).filter((k) => /^AIAND_(API_KEY|SECRET_STORE_MASTER_KEY)$/.test(k)) }) + "\\n");
`;
    plantWindowsTools(fresh, {
      "System32/whoami.exe": `${record}process.stdout.write('"h\\\\m","${SID}"');`,
      "System32/icacls.exe": record,
    });
    const fsutilUrl = new URL("../dist/fsutil.js", import.meta.url).href;
    const script = `
      Object.defineProperty(process, "platform", { value: "win32" });
      const { restrictToOwner } = await import(${JSON.stringify(fsutilUrl)});
      await restrictToOwner(${JSON.stringify(fresh)}, { dir: true });
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: {
        ...process.env,
        ...systemRootEnv(fresh),
        AIAND_TEST_TOOL_LOG: freshLog,
        AIAND_API_KEY: "sk-test-not-real",
        AIAND_SECRET_STORE_MASTER_KEY: "ab".repeat(32),
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const seen = readFileSync(freshLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      seen.map((c) => c.tool),
      ["whoami", "icacls", "icacls"],
    );
    for (const call of seen) assert.deepEqual(call.env, [], `${call.tool} inherited a secret`);
  });

  test("falls back to DOMAIN\\user when whoami cannot name the SID", () => {
    // The principal is cached per process, so this runs in a fresh one.
    const bare = mkdtempSync(join(dir, "sysroot-nowhoami-"));
    plantWindowsTools(bare, {
      "System32/icacls.exe": `
import { appendFileSync } from "node:fs";
appendFileSync(process.env.AIAND_TEST_TOOL_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
`,
    });
    const bareLog = join(bare, "calls.log");
    const fsutilUrl = new URL("../dist/fsutil.js", import.meta.url).href;
    const script = `
      Object.defineProperty(process, "platform", { value: "win32" });
      const { restrictToOwner } = await import(${JSON.stringify(fsutilUrl)});
      await restrictToOwner(${JSON.stringify(bare)}, { dir: true });
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: {
        ...process.env,
        ...systemRootEnv(bare),
        AIAND_TEST_TOOL_LOG: bareLog,
        USERNAME: "me",
        USERDOMAIN: "HOST",
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const [grant, listing] = readFileSync(bareLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(grant, [bare, "/inheritance:r", "/grant:r", "HOST\\me:(OI)(CI)F"]);
    assert.deepEqual(listing, [bare], "then the ACL is listed to find what else is on it");
  });
});

async function captureStderr(fn) {
  const write = process.stderr.write;
  let stderr = "";
  process.stderr.write = (chunk, ...rest) => {
    if (typeof chunk === "string" && !/[\x00-\x08]/.test(chunk)) {
      stderr += chunk;
      return true;
    }
    return write.call(process.stderr, chunk, ...rest);
  };
  try {
    await fn();
  } finally {
    process.stderr.write = write;
  }
  return { stderr };
}
