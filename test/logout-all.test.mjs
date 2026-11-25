// `aiand logout --all`: hand a shared or loaner machine back. Real
// src/auth modules (dist build) against the loopback stub in ./auth-stub.mjs,
// plus the built CLI for the argument and confirmation contract.
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { afterEach, beforeEach, describe } from "node:test";
import {
  captureOutput,
  cliStdout,
  dir,
  registerAuthStub,
  state,
  stubBinding,
} from "./auth-stub.mjs";
import {
  CLOSED_URL,
  catalogModel,
  cliEnv,
  enableInput,
  plantStub,
  runCli,
  withEnv,
  writeConfigMarker,
} from "./helpers.mjs";

const { logoutAll } = await import("../dist/auth/logout-all.js");
const { logout } = await import("../dist/auth/logout.js");
const { makeOverlayDir, sweepOverlays } = await import("../dist/agents/overlays.js");
const config = await import("../dist/config.js");
const snapshot = await import("../dist/agents/snapshot.js");
const copilotApp = await import("../dist/agents/copilot-app/adapter.js");
const { piAdapter } = await import("../dist/agents/pi/adapter.js");
const { jouzuAdapter } = await import("../dist/agents/jouzu/adapter.js");

registerAuthStub();

/** A pid no process holds: the overlay's session is over. */
const DEAD_PID = 2_147_483_646;

// os.homedir() reads USERPROFILE on Windows, HOME elsewhere.
let savedHome;
let savedProfile;
let home;
let cfg;
beforeEach(() => {
  savedHome = process.env.HOME;
  savedProfile = process.env.USERPROFILE;
  home = join(dir, "home");
  cfg = join(home, ".config", "aiand");
  mkdirSync(cfg, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.AIAND_HOME = home;
  process.env.AIAND_CONFIG_DIR = cfg;
  process.env.AIAND_KEY_STORAGE = "plaintext";
});
afterEach(() => {
  process.env.HOME = savedHome;
  if (savedProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedProfile;
  delete process.env.AIAND_WIPE_OUTSIDE_HOME;
  process.exitCode = 0;
});

const opencodePath = () => join(home, ".config", "opencode", "opencode.json");
const claudePath = () => join(home, ".claude", "settings.json");

/** What sign-in leaves behind: the credential, then the profile in config.json. */
async function signIn(name, credential) {
  await config.saveCredential(name, credential);
  await config.updateProfile(name, {});
}

/** Two device-minted profiles and one pasted; `work` is wired but not active. */
async function seedMachine() {
  await config.saveCredential("default", {
    access_token: "sk-default-minted",
    refresh_token: "rt-default",
    origin: "device",
    bound_to: stubBinding(),
  });
  await config.saveCredential("work", {
    access_token: "sk-work-minted",
    refresh_token: "rt-work",
    origin: "device",
    bound_to: stubBinding(),
  });
  await config.saveCredential("mine", { access_token: "sk-mine-pasted", origin: "paste" });
  await config.updateProfile("work", {});
  mkdirSync(dirname(opencodePath()), { recursive: true });
  writeFileSync(
    opencodePath(),
    `${JSON.stringify({
      theme: "dark",
      provider: {
        aiand: {
          options: {
            baseURL: "https://api.aiand.com/v1",
            apiKey: "sk-work-minted",
            "x-aiand": true,
          },
        },
      },
    })}\n`,
  );
  mkdirSync(dirname(claudePath()), { recursive: true });
  writeFileSync(
    claudePath(),
    `${JSON.stringify({
      env: {
        AIAND_MANAGED: "1",
        ANTHROPIC_BASE_URL: "https://api.aiand.com",
        ANTHROPIC_AUTH_TOKEN: "sk-mine-pasted",
      },
    })}\n`,
  );
  // A snapshot an older aiand took of a file that already held a key.
  const leaky = join(home, "leaky.json");
  writeFileSync(leaky, '{"key":"sk-default-minted"}\n');
  await snapshot.snapshotFiles("leaky-agent", [leaky]);
}

/** A marked overlay as a crashed session leaves it, with a key inside. */
function plantOverlay(pid, { name = "aiand-pi-", age = 0 } = {}) {
  const overlay = mkdtempSync(join(tmpdir(), name));
  writeFileSync(
    join(overlay, ".aiand-overlay"),
    JSON.stringify({ pid, createdAt: Date.now() - age }),
  );
  writeFileSync(join(overlay, "auth.json"), '{"key":"sk-default-minted"}\n');
  return overlay;
}

const writeFileAtomicIn = async (file) => {
  const { writeFileAtomic } = await import("../dist/fsutil.js");
  await writeFileAtomic(file, "{}\n", { mode: 0o600 });
};

async function runAll(opts) {
  const captured = captureOutput();
  try {
    await logoutAll({ force: true, ...opts });
  } finally {
    captured.restore();
  }
  return captured;
}

describe("logout --all (serial)", { concurrency: 1 }, () => {
  test("revokes every minted key, strips every agent, wipes the config dir", async () => {
    await seedMachine();
    const dead = plantOverlay(DEAD_PID);
    const foreign = mkdtempSync(join(tmpdir(), "aiand-not-ours-"));

    const captured = await runAll({ json: true });
    const report = JSON.parse(cliStdout(captured));

    assert.deepEqual([...state.revocations].sort(), ["rt-default", "rt-work"]);
    assert.equal(report.complete, true, JSON.stringify(report));
    assert.equal(process.exitCode ?? 0, 0);
    assert.equal(report.console_url, "https://console.aiand.com/api-keys");
    const pasted = report.profiles.find((p) => p.profile === "mine");
    assert.deepEqual(pasted, { profile: "mine", source: "pasted-key", revoked: false });

    // Every agent stripped, whichever profile wired it.
    const opencode = readFileSync(opencodePath(), "utf8");
    assert.ok(!opencode.includes("sk-work-minted"));
    assert.ok(opencode.includes('"theme"'), "the user's own settings survive");
    assert.ok(!existsSync(claudePath()) || !readFileSync(claudePath(), "utf8").includes("sk-mine"));
    assert.deepEqual(report.keys_left_on_disk, []);

    // Overlays: the crashed one goes, a dir without our marker stays.
    assert.equal(existsSync(dead), false);
    assert.equal(existsSync(foreign), true);
    rmSync(foreign, { recursive: true, force: true });

    // Config dir, credentials and snapshots are gone.
    assert.equal(existsSync(cfg), false);
    assert.equal(report.config_dir.removed, true);
    assert.equal(await config.loadCredential("default"), null);
  });

  test("every file aiand keeps in its config dir goes, not only the ones logout --all was first written for", async () => {
    await seedMachine();
    // What real use leaves beside the sign-in: a wired-endpoint record, the DPAPI
    // store, a git opt-in, stray lock files, and the caches.
    const wired = await import("../dist/agents/wired.js");
    await wired.recordWired("opencode", "work", "https://api.aiand.com");
    await snapshot.recordGitOptIn("leaky-agent", join(home, "leaky.json"));
    for (const name of [
      "secret-store.dpapi.json",
      "update-check.json",
      "finalize.json",
      "model-catalog.json",
      "opencode-api.json",
    ]) {
      writeFileSync(join(cfg, name), "{}\n");
    }
    mkdirSync(join(cfg, "locks"), { recursive: true });
    writeFileSync(join(cfg, "locks", "refresh-work"), "123");

    const captured = await runAll({ json: true });
    const report = JSON.parse(cliStdout(captured));
    assert.deepEqual(report.config_dir.left, []);
    assert.equal(report.complete, true, JSON.stringify(report));
    assert.equal(existsSync(cfg), false);
  });

  test("lock files a killed process left behind are aiand's too", async () => {
    const { wipeConfigDir } = await import("../dist/auth/config-wipe.js");
    const stray = join(dir, "stray-locks");
    mkdirSync(stray, { recursive: true });
    for (const name of [
      ".aiand-config",
      "secret-store.lock",
      "secret-store.lock.steal",
      "credentials.lock",
      "credentials.lock.steal",
      "wired.json",
    ]) {
      writeFileSync(join(stray, name), "123");
    }
    const result = await wipeConfigDir(stray, { keep: new Set(), keepSnapshots: new Set() });
    assert.deepEqual(result, { removed: true, left: [], kept: [] });
  });

  test("error text in the report is one clean line with no key in it", async () => {
    // A credentials.json entry that cannot be read quotes its profile name in the
    // error, and the name carries a key and terminal escapes.
    writeConfigMarker(cfg);
    writeFileSync(
      join(cfg, "credentials.json"),
      JSON.stringify({ "sk-leaky-name\x1b]52;c;QQ==\x07\x1b[31mred": 5 }),
    );
    const captured = await runAll({});
    const text = cliStdout(captured);
    assert.match(text, /Could not read stored credentials: .*sk-\[redacted\]/);
    assert.ok(!text.includes("sk-leaky-name"), text);
    assert.doesNotMatch(text, /[\x00-\x08\x0b-\x1f\x7f]/, JSON.stringify(text));
    assert.ok(!captured.log.err.join("").includes("\x1b"), "nothing on stderr either");
  });

  test("a hostile profile name never reaches the terminal as a control sequence", async () => {
    const name = "evil\x1b]52;c;QQ==\x07\x1b[31mred";
    await signIn(name, {
      access_token: "sk-evil-minted",
      refresh_token: "rt-evil",
      origin: "device",
      bound_to: stubBinding(),
    });
    state.deviceMode = "down";
    let captured;
    try {
      captured = await runAll({});
    } finally {
      state.deviceMode = "up";
      // The failed revoke keeps this sign-in; later tests start from nothing.
      rmSync(cfg, { recursive: true, force: true });
    }
    const text = cliStdout(captured);
    assert.match(text, /evilred: could not revoke the key/);
    assert.match(text, /Kept the sign-in for: evilred/);
    assert.doesNotMatch(text, /[\x00-\x08\x0b-\x1f\x7f]/, JSON.stringify(text));
  });

  test("the text report names pasted keys and the console page", async () => {
    await seedMachine();
    const captured = await runAll({});
    const text = cliStdout(captured);
    assert.match(text, /Signed out everywhere/);
    assert.match(text, /Pasted keys are removed here but still valid: mine/);
    assert.match(text, /https:\/\/console\.aiand\.com\/api-keys/);
    assert.ok(!text.includes("sk-"), "no key in the report");
  });

  test("a failed revoke keeps that sign-in, exits 1, and says how to retry", async () => {
    await seedMachine();
    state.deviceMode = "down";
    const captured = await runAll({ json: true });
    state.deviceMode = "up";
    const report = JSON.parse(cliStdout(captured));
    assert.equal(report.complete, false);
    assert.equal(process.exitCode, 1);
    const work = report.profiles.find((p) => p.profile === "work");
    assert.equal(work.revoked, false);
    assert.equal(work.kept, true);
    assert.match(work.error, /answered HTTP 500/);
    assert.equal(work.http_status, 500);

    // The refresh token is the only way to revoke the key: it stays.
    const kept = await config.loadCredential("work");
    assert.equal(kept?.refresh_token, "rt-work");
    assert.equal((await config.loadCredential("default"))?.refresh_token, "rt-default");
    assert.equal(existsSync(cfg), true, "the config dir stays with them");
    assert.equal(report.config_dir.removed, false);
    // Everything that is not owed a retry is still removed.
    assert.equal(await config.loadCredential("mine"), null, "a pasted key has nothing to retry");
    assert.ok(!readFileSync(opencodePath(), "utf8").includes("sk-work-minted"));
    assert.equal(existsSync(join(cfg, "snapshots")), false);
  });

  test("a revoke the server answers with an HTTP status names it; one it never answers does not", async () => {
    await signIn("default", {
      access_token: "sk-default-minted",
      refresh_token: "rt-default",
      origin: "device",
      bound_to: stubBinding(),
    });
    state.logoutStatus = 404;
    let report = JSON.parse(cliStdout(await runAll({ json: true })));
    state.logoutStatus = null;
    assert.match(report.profiles[0].error, /answered HTTP 404/);
    assert.equal(report.profiles[0].http_status, 404);
    assert.equal(report.profiles[0].kept, true);

    process.exitCode = 0;
    await config.saveCredential("default", {
      access_token: "sk-default-minted",
      refresh_token: "rt-default",
      origin: "device",
      bound_to: { auth_url: CLOSED_URL, api_url: CLOSED_URL },
    });
    report = JSON.parse(cliStdout(await runAll({ json: true })));
    assert.equal(report.profiles[0].error, "the server could not be reached");
    assert.equal(report.profiles[0].http_status, undefined);
  });

  test("logout names the HTTP status in its hint, and tells a network failure apart", async () => {
    await config.saveCredential("default", {
      access_token: "sk-x",
      refresh_token: "rt-x",
      origin: "device",
      bound_to: stubBinding(),
    });
    state.logoutStatus = 404;
    await assert.rejects(
      () => logout({ profile: "default", revoke: true }),
      (error) => {
        assert.match(error.hint, /answered HTTP 404 to the sign-out request/);
        assert.doesNotMatch(error.hint, /Check your connection/);
        return true;
      },
    );
    state.logoutStatus = null;
    assert.ok(await config.loadCredential("default"), "the sign-in is kept");

    await config.saveCredential("default", {
      access_token: "sk-x",
      refresh_token: "rt-x",
      origin: "device",
      bound_to: { auth_url: CLOSED_URL, api_url: CLOSED_URL },
    });
    await assert.rejects(
      () => logout({ profile: "default", revoke: true }),
      (error) => /^Check your connection/.test(error.hint),
    );
  });

  test("only the profile whose revoke failed is kept, and a second run finishes the job", async () => {
    await seedMachine();
    state.rejectRefresh = ["rt-work"];
    let captured = await runAll({ json: true });
    let report = JSON.parse(cliStdout(captured));
    assert.deepEqual(state.revocations, ["rt-default"]);
    assert.equal(report.profiles.find((p) => p.profile === "default").revoked, true);
    assert.equal(report.profiles.find((p) => p.profile === "work").kept, true);
    assert.equal(await config.loadCredential("default"), null, "revoked: gone");
    assert.equal((await config.loadCredential("work"))?.refresh_token, "rt-work");
    assert.equal(report.complete, false);
    assert.equal(process.exitCode, 1);

    process.exitCode = 0;
    state.rejectRefresh = [];
    captured = await runAll({ json: true });
    report = JSON.parse(cliStdout(captured));
    assert.deepEqual([...state.revocations].sort(), ["rt-default", "rt-work"]);
    assert.equal(report.complete, true, JSON.stringify(report));
    assert.equal(process.exitCode ?? 0, 0);
    assert.equal(existsSync(cfg), false);
  });

  test("the text report says which sign-ins stayed and how to retry or give up", async () => {
    await seedMachine();
    state.deviceMode = "down";
    const captured = await runAll({});
    state.deviceMode = "up";
    const text = cliStdout(captured);
    assert.match(text, /work: could not revoke the key/);
    assert.match(text, /Kept the sign-in for: default, work/);
    assert.match(text, /aiand logout --all again/);
    assert.match(text, /--keep-remote/);
    assert.match(text, /https:\/\/console\.aiand\.com\/api-keys/);
    assert.ok(!text.includes("rt-") && !text.includes("sk-"), "no secret in the report");
  });

  test("--keep-remote forgets everything locally even when the gateway is down", async () => {
    await seedMachine();
    state.deviceMode = "down";
    const captured = await runAll({ json: true, keepRemote: true });
    state.deviceMode = "up";
    assert.equal(JSON.parse(cliStdout(captured)).complete, true);
    assert.equal(existsSync(cfg), false);
  });

  test("--keep-remote skips revocation and is still complete", async () => {
    await seedMachine();
    const captured = await runAll({ json: true, keepRemote: true });
    const report = JSON.parse(cliStdout(captured));
    assert.deepEqual(state.revocations, []);
    assert.equal(report.complete, true);
    assert.equal(existsSync(cfg), false);
  });

  test("a session overlay still in use is reported, not deleted", async () => {
    await seedMachine();
    const live = plantOverlay(process.ppid);
    const captured = await runAll({ json: true });
    const report = JSON.parse(cliStdout(captured));
    assert.deepEqual(report.overlays.in_use, [live]);
    assert.equal(existsSync(live), true);
    assert.equal(report.complete, false);
    rmSync(live, { recursive: true, force: true });
  });

  test("a key the strip could not remove is listed and exits 1", async () => {
    await seedMachine();
    // A hand-broken opencode.json: off cannot parse it, so the key stays.
    writeFileSync(opencodePath(), '{"provider":{"aiand":{"options":{"apiKey":"sk-work-minted"');
    const captured = await runAll({ json: true });
    const report = JSON.parse(cliStdout(captured));
    assert.deepEqual(report.keys_left_on_disk, [opencodePath()]);
    assert.equal(report.complete, false);
    const opencode = report.agents.find((a) => a.agent === "opencode");
    assert.match(opencode.notes.join(" "), /may still hold your ai& key/);
  });

  test("a config dir holding foreign files is emptied of ours and kept", async () => {
    await seedMachine();
    writeFileSync(join(cfg, "my-notes.txt"), "mine\n");
    const captured = await runAll({ json: true });
    const report = JSON.parse(cliStdout(captured));
    assert.deepEqual(report.config_dir.left, ["my-notes.txt"]);
    assert.equal(report.complete, false);
    assert.equal(readFileSync(join(cfg, "my-notes.txt"), "utf8"), "mine\n");
    assert.equal(existsSync(join(cfg, "credentials-plaintext.json")), false);
    assert.equal(existsSync(join(cfg, "snapshots")), false);
  });

  test("a symlinked config dir is removed along with its link", async () => {
    const real = join(home, "real-aiand");
    mkdirSync(real, { recursive: true });
    rmSync(cfg, { recursive: true, force: true });
    symlinkSync(real, cfg);
    await seedMachine();
    await runAll({ json: true });
    assert.equal(existsSync(real), false);
    assert.equal(existsSync(cfg), false);
  });

  test("refuses a config dir outside home before touching anything", async () => {
    const outside = join(dir, "outside-cfg");
    process.env.AIAND_CONFIG_DIR = outside;
    await seedMachine();
    await assert.rejects(() => logoutAll({ force: true }), /outside your home directory/);
    assert.deepEqual(state.revocations, []);
    assert.ok(await config.loadCredential("default"), "nothing was cleared");
    assert.ok(readFileSync(opencodePath(), "utf8").includes("sk-work-minted"), "nothing stripped");

    process.env.AIAND_WIPE_OUTSIDE_HOME = "1";
    await runAll({ json: true });
    assert.equal(existsSync(outside), false);
  });

  test("refuses the home directory itself even with the override", async () => {
    process.env.AIAND_CONFIG_DIR = home;
    process.env.AIAND_WIPE_OUTSIDE_HOME = "1";
    await assert.rejects(() => logoutAll({ force: true }), /not a config directory/);
    assert.equal(existsSync(home), true);
  });

  test("with no config dir it still strips agents and reports the dir as absent", async () => {
    rmSync(cfg, { recursive: true, force: true });
    mkdirSync(dirname(opencodePath()), { recursive: true });
    writeFileSync(
      opencodePath(),
      `${JSON.stringify({
        provider: {
          aiand: {
            options: { baseURL: "https://api.aiand.com/v1", apiKey: "sk-x", "x-aiand": true },
          },
        },
      })}\n`,
    );
    const captured = await runAll({});
    assert.match(cliStdout(captured), /did not exist/);
    assert.ok(!readFileSync(opencodePath(), "utf8").includes("sk-x"));
  });

  test("strips Jouzu like Pi: each agent dir loses ai&'s key and keeps the user's", async () => {
    await seedMachine();
    const wire = (adapter) =>
      adapter.enable(
        enableInput({
          apiKey: "sk-work-minted",
          catalog: [catalogModel("zai-org/glm-5.3")],
          baseUrl: "https://api.aiand.com",
        }),
      );
    const jouzuAuth = jouzuAdapter.managedFiles()[1];
    mkdirSync(dirname(jouzuAuth), { recursive: true });
    writeFileSync(jouzuAuth, '{"shisa":{"type":"api_key","key":"sk-user-shisa"}}\n');
    await wire(piAdapter);
    await wire(jouzuAdapter);
    assert.match(readFileSync(jouzuAuth, "utf8"), /sk-work-minted/);

    const captured = await runAll({ json: true });
    const report = JSON.parse(cliStdout(captured));

    assert.equal(report.complete, true, JSON.stringify(report));
    assert.deepEqual(report.keys_left_on_disk, []);
    for (const id of ["pi", "jouzu"]) {
      assert.equal(report.agents.find((a) => a.agent === id)?.stripped, true, id);
    }
    const auth = JSON.parse(readFileSync(jouzuAuth, "utf8"));
    assert.equal(auth.aiand, undefined);
    assert.equal(auth.shisa.key, "sk-user-shisa", "the user's own credential stays");
    const piAuth = piAdapter.managedFiles()[1];
    assert.ok(!existsSync(piAuth) || !readFileSync(piAuth, "utf8").includes("sk-work-minted"));
  });
});

describe("logout --all deletes only the directory it checked (serial)", { concurrency: 1 }, () => {
  /** A user's own folder that a swapped link would point the deletion at. */
  const plantDocuments = () => {
    const documents = join(home, "Documents");
    mkdirSync(documents, { recursive: true });
    writeFileSync(join(documents, "config.json"), "my own settings\n");
    writeFileSync(join(documents, "credentials.json"), "{}\n");
    writeFileSync(join(documents, "notes.txt"), "mine\n");
    return documents;
  };
  const untouched = (documents) => {
    assert.equal(readFileSync(join(documents, "config.json"), "utf8"), "my own settings\n");
    assert.equal(readFileSync(join(documents, "credentials.json"), "utf8"), "{}\n");
    assert.equal(readFileSync(join(documents, "notes.txt"), "utf8"), "mine\n");
  };
  /** The config dir is replaced by a link to `documents`, the way a slow step lets someone do. */
  const swapForLink = (documents) => {
    renameSync(cfg, `${cfg}.original`);
    symlinkSync(documents, cfg);
  };

  test("a config dir swapped for a link during a slow revoke loses nothing", async () => {
    await seedMachine();
    const documents = plantDocuments();
    let swapped = false;
    state.onLogout = () => {
      if (swapped) return;
      swapped = true;
      swapForLink(documents);
    };
    const captured = await runAll({ json: true });
    state.onLogout = null;
    const report = JSON.parse(cliStdout(captured));
    assert.equal(swapped, true);
    untouched(documents);
    assert.deepEqual(readdirSync(documents).sort(), [
      "config.json",
      "credentials.json",
      "notes.txt",
    ]);
    assert.equal(report.complete, false);
    assert.equal(process.exitCode, 1);
    assert.match(report.problems.join("\n"), /no longer the config directory/);
    assert.equal(report.config_dir.removed, false);
  });

  test("a config dir swapped just before the deletion is refused too", async () => {
    // The slow part is over and the secrets are cleared; only the delete is left.
    await seedMachine();
    const documents = plantDocuments();
    rmSync(join(documents, "credentials.json"));
    const fsp = (await import("node:fs/promises")).default;
    const realRename = fsp.rename;
    let swapped = false;
    fsp.rename = async (from, to) => {
      const done = await realRename(from, to);
      if (!swapped && String(to).endsWith("credentials-plaintext.json")) {
        swapped = true;
        swapForLink(documents);
      }
      return done;
    };
    (await import("node:module")).syncBuiltinESMExports();
    let report;
    try {
      report = JSON.parse(cliStdout(await runAll({ json: true })));
    } finally {
      fsp.rename = realRename;
      (await import("node:module")).syncBuiltinESMExports();
    }
    assert.equal(swapped, true);
    assert.equal(readFileSync(join(documents, "config.json"), "utf8"), "my own settings\n");
    assert.equal(readFileSync(join(documents, "notes.txt"), "utf8"), "mine\n");
    assert.equal(report.complete, false);
    assert.equal(report.config_dir.removed, false);
    assert.match(report.problems.join("\n"), /no longer the config directory/);
  });

  test("a config dir that stays put is still deleted", async () => {
    await seedMachine();
    const report = JSON.parse(cliStdout(await runAll({ json: true })));
    assert.equal(report.complete, true);
    assert.equal(existsSync(cfg), false);
  });
});

describe("logout --all reports the overlays it could not deal with (serial)", {
  concurrency: 1,
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, () => {
  /** A marked overlay with a subfolder no one can delete from, holding the work profile's key. */
  const plantStuckOverlay = () => {
    const stuck = plantOverlay(DEAD_PID);
    mkdirSync(join(stuck, "sub"));
    writeFileSync(join(stuck, "sub", "auth.json"), '{"key":"sk-default-minted"}\n');
    chmodSync(join(stuck, "sub"), 0o500);
    return stuck;
  };
  const release = (stuck) => {
    chmodSync(join(stuck, "sub"), 0o700);
    rmSync(stuck, { recursive: true, force: true });
  };

  test("an overlay it cannot delete is reported, and the run is not complete", async () => {
    await seedMachine();
    const stuck = plantStuckOverlay();
    try {
      const report = JSON.parse(cliStdout(await runAll({ json: true, keepRemote: true })));
      assert.equal(report.complete, false);
      assert.equal(process.exitCode, 1);
      assert.deepEqual(
        report.overlays.failed.map((entry) => entry.dir),
        [stuck],
      );
      assert.match(report.overlays.failed[0].reason, /EACCES|EPERM/);
    } finally {
      release(stuck);
    }
  });

  test("the text report names it and says to delete it by hand", async () => {
    await seedMachine();
    const stuck = plantStuckOverlay();
    try {
      const text = cliStdout(await runAll({ keepRemote: true }));
      assert.match(text, /Could not delete the session overlay .*aiand-pi-.*Delete it by hand/);
    } finally {
      release(stuck);
    }
  });

  test("a temp dir it cannot read is a problem, not a silent complete", async () => {
    await seedMachine();
    const locked = join(dir, "locked-tmp");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      const report = await withEnv({ TMPDIR: locked }, async () =>
        JSON.parse(cliStdout(await runAll({ json: true, keepRemote: true }))),
      );
      assert.equal(report.complete, false);
      assert.deepEqual(
        report.overlays.failed.map((entry) => entry.dir),
        [locked],
      );
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  /**
   * A crashed Hermes session's overlay whose store shim still points into it
   * after the sweep's restore: the snapshot it would restore from names the
   * overlay too, so putting it back cannot clear the pointer.
   */
  const plantHeldHermesOverlay = () => {
    const overlay = plantOverlay(DEAD_PID, { name: "aiand-hermes-" });
    const shims = mkdtempSync(join(dir, "held-shims-"));
    const pointing = `#!/bin/sh\nexec ${overlay}/tools/python3\n`;
    writeFileSync(join(shims, "hermes"), pointing, { mode: 0o755 });
    writeFileSync(
      join(overlay, ".aiand-overlay-shims"),
      JSON.stringify({
        dir: shims,
        entries: { hermes: { mode: 0o755, body: Buffer.from(pointing).toString("base64") } },
      }),
    );
    return { overlay, shims };
  };

  test("an overlay a Hermes shim still points into is kept and reported, and the run is not complete", async () => {
    await seedMachine();
    const { overlay, shims } = plantHeldHermesOverlay();
    try {
      const report = JSON.parse(cliStdout(await runAll({ json: true, keepRemote: true })));
      assert.equal(existsSync(join(overlay, "auth.json")), true, "kept, so hermes still runs");
      assert.deepEqual(report.overlays.failed, [
        { dir: overlay, reason: "a Hermes shim still points into it" },
      ]);
      assert.equal(report.complete, false);
      assert.equal(process.exitCode, 1);
    } finally {
      rmSync(overlay, { recursive: true, force: true });
      rmSync(shims, { recursive: true, force: true });
    }
  });

  test("the text report says to reinstall Hermes, not to delete the overlay by hand", async () => {
    await seedMachine();
    const { overlay, shims } = plantHeldHermesOverlay();
    try {
      const text = cliStdout(await runAll({ keepRemote: true }));
      assert.match(text, /Kept the session overlay .*aiand-hermes-.*Reinstall Hermes/);
      assert.doesNotMatch(text, /aiand-hermes-.*Delete it by hand/);
    } finally {
      rmSync(overlay, { recursive: true, force: true });
      rmSync(shims, { recursive: true, force: true });
    }
  });

  /** An older aiand's overlay (no marker) and a foreign aiand-* folder, both holding a key the machine knows. */
  const plantUnmarked = () => {
    const older = mkdtempSync(join(tmpdir(), "aiand-claude-"));
    writeFileSync(
      join(older, "settings.json"),
      '{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-work-minted"}}\n',
    );
    const harmless = mkdtempSync(join(tmpdir(), "aiand-claude-"));
    writeFileSync(join(harmless, "settings.json"), '{"theme":"dark"}\n');
    const foreign = join(tmpdir(), `aiand-notes-${process.pid}`);
    mkdirSync(foreign);
    writeFileSync(join(foreign, "todo.txt"), "rotate sk-default-minted\n");
    return { older, harmless, foreign };
  };
  const dropAll = (planted) => {
    for (const path of Object.values(planted)) rmSync(path, { recursive: true, force: true });
  };

  test("an overlay from before the marker that still holds a known key is listed, not deleted", async () => {
    await seedMachine();
    const planted = plantUnmarked();
    try {
      const report = JSON.parse(cliStdout(await runAll({ json: true, keepRemote: true })));
      assert.deepEqual(
        report.overlays.unmarked_with_key.sort(),
        [planted.older, planted.foreign].sort(),
      );
      assert.equal(report.complete, false);
      assert.equal(
        existsSync(join(planted.older, "settings.json")),
        true,
        "never deleted on a guess",
      );
      assert.equal(existsSync(join(planted.foreign, "todo.txt")), true);
    } finally {
      dropAll(planted);
    }
  });

  test("the text report says to delete such a folder by hand", async () => {
    await seedMachine();
    const planted = plantUnmarked();
    try {
      const text = cliStdout(await runAll({ keepRemote: true }));
      assert.match(text, /looks like a leftover session folder .* still holds your key/);
    } finally {
      dropAll(planted);
    }
  });
});

describe("logout --all only wipes a directory that proves it is aiand's (serial)", {
  concurrency: 1,
}, () => {
  const foreignTree = (root) => {
    mkdirSync(join(root, "locks"), { recursive: true });
    writeFileSync(join(root, "locks", "important"), "keep\n");
    writeFileSync(join(root, "other"), "keep\n");
    writeFileSync(join(root, "config.json"), '{"auths":{"registry":{}}}\n');
  };

  test("a foreign dir holding only a config.json is refused and left whole", async () => {
    const docker = join(home, ".docker");
    mkdirSync(docker, { recursive: true });
    writeFileSync(join(docker, "config.json"), '{"auths":{}}\n');
    process.env.AIAND_CONFIG_DIR = docker;
    await assert.rejects(() => logoutAll({ force: true }), /not aiand's/);
    assert.equal(readFileSync(join(docker, "config.json"), "utf8"), '{"auths":{}}\n');
    assert.deepEqual(state.revocations, []);
  });

  test("a foreign dir with its own locks/ and other files loses nothing", async () => {
    const stuff = join(home, "stuff");
    mkdirSync(stuff, { recursive: true });
    foreignTree(stuff);
    process.env.AIAND_CONFIG_DIR = stuff;
    await assert.rejects(() => logoutAll({ force: true }), /not aiand's/);
    assert.equal(readFileSync(join(stuff, "config.json"), "utf8").includes("auths"), true);
    assert.equal(readFileSync(join(stuff, "locks", "important"), "utf8"), "keep\n");
    assert.equal(readFileSync(join(stuff, "other"), "utf8"), "keep\n");
  });

  test("the refusal names the marker file that vouches for a real aiand dir", async () => {
    const stuff = join(home, "stuff");
    mkdirSync(stuff, { recursive: true });
    foreignTree(stuff);
    process.env.AIAND_CONFIG_DIR = stuff;
    await assert.rejects(
      () => logoutAll({ force: true }),
      (error) => {
        assert.match(error.hint, /\.aiand-config/);
        return true;
      },
    );
  });

  test("aiand's first write into a dir drops the marker, new install or old", async () => {
    await config.saveConfig({ profile: "default", profiles: { default: {} } });
    assert.equal(existsSync(join(cfg, ".aiand-config")), true);

    const old = join(home, "old-install");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "config.json"), '{"profile":"default","profiles":{"default":{}}}\n');
    process.env.AIAND_CONFIG_DIR = old;
    assert.equal(existsSync(join(old, ".aiand-config")), false);
    await config.saveConfig({ profile: "default", profiles: { default: {} } });
    assert.equal(existsSync(join(old, ".aiand-config")), true);
  });

  test("an old install with no marker but aiand's own config.json is still wiped", async () => {
    const old = join(home, "old-install");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "config.json"), '{"profile":"work","profiles":{"work":{}}}\n');
    process.env.AIAND_CONFIG_DIR = old;
    const captured = await runAll({ json: true });
    assert.equal(JSON.parse(cliStdout(captured)).config_dir.removed, true);
    assert.equal(existsSync(old), false);
  });

  test("a proven dir's foreign locks/ entries survive; only aiand's lock files go", async () => {
    await config.saveConfig({ profile: "default", profiles: { default: {} } });
    mkdirSync(join(cfg, "locks"), { recursive: true });
    writeFileSync(join(cfg, "locks", "refresh-default"), "123");
    writeFileSync(join(cfg, "locks", "important"), "keep\n");
    const captured = await runAll({ json: true });
    const report = JSON.parse(cliStdout(captured));
    assert.equal(readFileSync(join(cfg, "locks", "important"), "utf8"), "keep\n");
    assert.equal(existsSync(join(cfg, "locks", "refresh-default")), false);
    assert.equal(existsSync(join(cfg, "config.json")), false);
    assert.equal(report.config_dir.removed, false);
    assert.deepEqual(report.config_dir.left, ["locks/important"]);
  });

  test("a proven dir's foreign snapshots/ entries survive; only aiand's snapshot dirs go", async () => {
    await config.saveConfig({ profile: "default", profiles: { default: {} } });
    const leaky = join(home, "plain.json");
    writeFileSync(leaky, "{}\n");
    await snapshot.snapshotFiles("pi", [leaky]);
    mkdirSync(join(cfg, "snapshots", "mine"), { recursive: true });
    writeFileSync(join(cfg, "snapshots", "mine", "notes.txt"), "keep\n");
    const captured = await runAll({ json: true });
    const report = JSON.parse(cliStdout(captured));
    assert.equal(existsSync(join(cfg, "snapshots", "pi")), false);
    assert.equal(readFileSync(join(cfg, "snapshots", "mine", "notes.txt"), "utf8"), "keep\n");
    assert.deepEqual(report.config_dir.left, ["snapshots/mine"]);
  });

  describe("a marker vouches only when it names the install", () => {
    const userFiles = (root) => {
      writeFileSync(join(root, "credentials.json"), "{}\n");
      writeFileSync(join(root, "config.json"), '{"auths":{"registry":{}}}\n');
      writeFileSync(join(root, "update-check.json"), "mine\n");
    };
    const assertKept = (root) => {
      assert.equal(readFileSync(join(root, "credentials.json"), "utf8"), "{}\n");
      assert.equal(readFileSync(join(root, "config.json"), "utf8").includes("auths"), true);
      assert.equal(readFileSync(join(root, "update-check.json"), "utf8"), "mine\n");
    };

    test("an empty .aiand-config beside someone else's files deletes none of them", async () => {
      const project = join(home, "project");
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, ".aiand-config"), "");
      userFiles(project);
      process.env.AIAND_CONFIG_DIR = project;
      await assert.rejects(() => logoutAll({ force: true }), /not aiand's/);
      assertKept(project);
      assert.deepEqual(state.revocations, []);
    });

    test("the same through the CLI: exit 1, nothing deleted, never complete", async () => {
      const project = join(home, "project");
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, ".aiand-config"), "");
      userFiles(project);
      const { code, stdout, stderr } = await runCli(["logout", "--all", "--force", "--json"], {
        env: cliEnv({
          HOME: home,
          USERPROFILE: home,
          AIAND_HOME: home,
          AIAND_CONFIG_DIR: project,
          AIAND_KEY_STORAGE: "plaintext",
          AIAND_API_KEY: undefined,
        }),
      });
      assert.notEqual(code, 0);
      assert.doesNotMatch(stdout, /"complete":\s*true/);
      assert.match(stderr, /not aiand's/);
      assertKept(project);
    });

    test("an empty marker beside only files with aiand's names is no proof either", async () => {
      const project = join(home, "project");
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, ".aiand-config"), "");
      writeFileSync(join(project, "credentials.json"), "{}\n");
      writeFileSync(join(project, "update-check.json"), "mine\n");
      process.env.AIAND_CONFIG_DIR = project;
      await assert.rejects(() => logoutAll({ force: true }), /not aiand's/);
      assert.equal(readFileSync(join(project, "credentials.json"), "utf8"), "{}\n");
    });

    test("a marker copied from an install, beside a foreign config.json, proves nothing", async () => {
      await config.saveConfig({ profile: "default", profiles: { default: {} } });
      const copied = readFileSync(join(cfg, ".aiand-config"), "utf8");
      const project = join(home, "project");
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, ".aiand-config"), copied);
      userFiles(project);
      process.env.AIAND_CONFIG_DIR = project;
      await assert.rejects(() => logoutAll({ force: true }), /not aiand's/);
      assertKept(project);
    });

    test("a marker copied beside an aiand config.json that records another id proves nothing", async () => {
      await config.saveConfig({ profile: "default", profiles: { default: {} } });
      const copied = readFileSync(join(cfg, ".aiand-config"), "utf8");
      const other = join(home, "other-install");
      mkdirSync(other, { recursive: true });
      process.env.AIAND_CONFIG_DIR = other;
      await config.saveConfig({ profile: "default", profiles: { default: {} } });
      writeFileSync(join(other, ".aiand-config"), copied);
      writeFileSync(join(other, "notes.txt"), "mine\n");
      await assert.rejects(
        () => logoutAll({ force: true }),
        (error) => {
          assert.match(error.message, /not aiand's config directory\.$/);
          assert.match(
            error.hint,
            /records another id[\s\S]*delete its \.aiand-config file, run aiand login with AIAND_CONFIG_DIR set to it/,
          );
          return true;
        },
      );
      assert.equal(readFileSync(join(other, "notes.txt"), "utf8"), "mine\n");
      assert.equal(existsSync(join(other, "config.json")), true);
    });

    test("a marker naming an id, beside foreign sign-in files and no config.json, deletes none of them", async () => {
      const project = join(home, "project");
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, ".aiand-config"), `id: ${"ab".repeat(16)}\n`);
      writeFileSync(join(project, "credentials.json"), "{}\n");
      writeFileSync(join(project, "update-check.json"), "mine\n");
      process.env.AIAND_CONFIG_DIR = project;
      await assert.rejects(
        () => logoutAll({ force: true }),
        (error) => {
          assert.match(error.message, /not aiand's config directory.*no config\.json/);
          assert.match(error.hint, /aiand login/);
          return true;
        },
      );
      assert.equal(readFileSync(join(project, "credentials.json"), "utf8"), "{}\n");
      assert.equal(readFileSync(join(project, "update-check.json"), "utf8"), "mine\n");
      assert.deepEqual(state.revocations, []);
    });

    test("a cache write into a dir holding another tool's credentials.json drops no marker", async () => {
      const project = join(home, "project");
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, "credentials.json"), "{}\n");
      process.env.AIAND_CONFIG_DIR = project;
      await writeFileAtomicIn(join(project, "model-catalog.json"));
      assert.equal(existsSync(join(project, ".aiand-config")), false);
      await assert.rejects(() => logoutAll({ force: true }), /not aiand's/);
      assert.equal(readFileSync(join(project, "credentials.json"), "utf8"), "{}\n");
    });

    test("a signed-in install, sign-in files and caches included, is still wiped", async () => {
      await signIn("default", {
        access_token: "sk-default-minted",
        refresh_token: "rt-default",
        origin: "device",
        bound_to: stubBinding(),
      });
      await writeFileAtomicIn(join(cfg, "update-check.json"));
      assert.equal(existsSync(join(cfg, "credentials.json")), true);
      const report = JSON.parse(cliStdout(await runAll({ json: true })));
      assert.equal(report.config_dir.removed, true);
      assert.equal(existsSync(cfg), false);
    });

    test("a signed-in install from before the marker is marked on its next write and wiped", async () => {
      const old = join(home, "old-install");
      mkdirSync(old, { recursive: true });
      writeFileSync(join(old, "config.json"), '{"profile":"default","profiles":{"default":{}}}\n');
      writeFileSync(join(old, "credentials.json"), "{}\n");
      process.env.AIAND_CONFIG_DIR = old;
      await writeFileAtomicIn(join(old, "model-catalog.json"));
      assert.match(readFileSync(join(old, ".aiand-config"), "utf8"), /^id: [0-9a-f]{32}$/m);
      const report = JSON.parse(cliStdout(await runAll({ json: true })));
      assert.equal(report.config_dir.removed, true);
      assert.equal(existsSync(old), false);
    });

    test("a dir aiand wrote only caches into, which has a marker and no config.json, is wiped", async () => {
      process.env.AIAND_CONFIG_DIR = join(home, "caches-only");
      await writeFileAtomicIn(join(home, "caches-only", "model-catalog.json"));
      assert.match(
        readFileSync(join(home, "caches-only", ".aiand-config"), "utf8"),
        /^id: [0-9a-f]{32}$/m,
      );
      const report = JSON.parse(cliStdout(await runAll({ json: true })));
      assert.equal(report.config_dir.removed, true);
    });

    test("an install from before the ids, with an id-less marker, is wiped and re-marked on its next write", async () => {
      const old = join(home, "old-install");
      mkdirSync(old, { recursive: true });
      writeFileSync(join(old, "config.json"), '{"profile":"work","profiles":{"work":{}}}\n');
      writeFileSync(join(old, ".aiand-config"), "This directory belongs to the ai& CLI (aiand).\n");
      process.env.AIAND_CONFIG_DIR = old;
      await writeFileAtomicIn(join(old, "model-catalog.json"));
      assert.match(readFileSync(join(old, ".aiand-config"), "utf8"), /^id: [0-9a-f]{32}$/m);
      const report = JSON.parse(cliStdout(await runAll({ json: true })));
      assert.equal(report.config_dir.removed, true);
      assert.equal(existsSync(old), false);
    });
  });
});

describe("logout --all keeps the snapshot of an agent it could not clean (serial)", {
  concurrency: 1,
}, () => {
  /** A pre-aiand snapshot of opencode.json plus the record `on` left, then a hand-broken wired file. */
  async function breakOpencode() {
    mkdirSync(dirname(opencodePath()), { recursive: true });
    writeFileSync(opencodePath(), '{"theme":"dark"}\n');
    await snapshot.snapshotFiles("opencode", [opencodePath()]);
    await snapshot.recordAddedState("opencode", { providerAiand: { options: {} } });
    writeFileSync(opencodePath(), '{"provider":{"aiand":{"options":{"apiKey":"sk-work-minted"');
  }

  test("an agent still holding a key keeps snapshots/<id> and its recorded state", async () => {
    await seedMachine();
    await breakOpencode();
    const clean = join(home, "plain.json");
    writeFileSync(clean, "{}\n");
    await snapshot.snapshotFiles("pi", [clean]);

    const captured = await runAll({ json: true });
    const report = JSON.parse(cliStdout(captured));

    assert.equal(existsSync(join(cfg, "snapshots", "opencode", "latest.json")), true);
    assert.equal(existsSync(join(cfg, "snapshots", "opencode", "added.json")), true);
    assert.equal(existsSync(join(cfg, "snapshots", "pi")), false, "a cleaned agent's goes");
    assert.deepEqual(report.config_dir.kept, ["snapshots/opencode"]);
    assert.equal(report.config_dir.removed, false);
    assert.equal(report.complete, false);
    assert.equal(await snapshot.hasSnapshot("opencode"), true);
  });

  test("an agent whose off threw keeps its snapshot too", async () => {
    await seedMachine();
    rmSync(claudePath());
    mkdirSync(claudePath()); // a directory where settings.json should be: off cannot read it
    await snapshot.recordAddedState("claude", { env: {} });
    const captured = await runAll({ json: true });
    const report = JSON.parse(cliStdout(captured));
    const claude = report.agents.find((a) => a.agent === "claude");
    assert.ok(claude.error, "disable() threw");
    assert.equal(existsSync(join(cfg, "snapshots", "claude", "added.json")), true);
    assert.deepEqual(report.config_dir.kept, ["snapshots/claude"]);
  });

  test("the text report says what it kept and how to finish", async () => {
    await seedMachine();
    await breakOpencode();
    const captured = await runAll({});
    assert.match(cliStdout(captured), /Kept .*snapshots.opencode/);
    assert.match(cliStdout(captured), /aiand opencode off/);
  });
});

describe("logout --all keeps a sign-in it cannot read (serial)", { concurrency: 1 }, () => {
  /** A locked keychain over SSH: credentials.json lists the profile, the secret will not come back. */
  function lockSecret(name) {
    const path = join(cfg, "credentials-plaintext.json");
    const map = JSON.parse(readFileSync(path, "utf8"));
    delete map[name];
    writeFileSync(path, JSON.stringify(map));
  }

  test("a profile whose secret cannot be read is reported and kept, not deleted", async () => {
    await seedMachine();
    lockSecret("work");
    const captured = await runAll({ json: true });
    const report = JSON.parse(cliStdout(captured));

    const work = report.profiles.find((p) => p.profile === "work");
    assert.equal(work.revoked, false);
    assert.equal(work.kept, true);
    assert.match(work.error, /could not be read/);
    assert.equal(report.complete, false);
    assert.equal(process.exitCode, 1);
    assert.ok(
      report.problems.some((p) => p.includes('"work"')),
      JSON.stringify(report.problems),
    );
    // Its sign-in files stay, so a retry with the keychain unlocked can still revoke it.
    assert.equal(existsSync(join(cfg, "credentials.json")), true);
    assert.equal(existsSync(join(cfg, "config.json")), true);
    assert.equal(report.config_dir.removed, false);
    assert.ok(JSON.parse(readFileSync(join(cfg, "credentials.json"), "utf8")).work);
    // The readable profiles are still revoked.
    assert.deepEqual([...state.revocations], ["rt-default"]);
  });

  test("--keep-remote does not delete a sign-in it cannot read either", async () => {
    await seedMachine();
    lockSecret("work");
    const captured = await runAll({ json: true, keepRemote: true });
    const report = JSON.parse(cliStdout(captured));
    assert.equal(report.profiles.find((p) => p.profile === "work").kept, true);
    assert.equal(report.complete, false);
    assert.equal(existsSync(join(cfg, "credentials.json")), true);
  });

  test("a corrupt credentials.json keeps every sign-in file and is incomplete", async () => {
    await seedMachine();
    writeFileSync(join(cfg, "credentials.json"), "{ not json");
    const captured = await runAll({ json: true });
    const report = JSON.parse(cliStdout(captured));

    assert.equal(report.complete, false);
    assert.equal(process.exitCode, 1);
    assert.ok(report.problems.some((p) => /Could not read stored credentials/.test(p)));
    assert.equal(existsSync(join(cfg, "credentials.json")), true);
    assert.equal(existsSync(join(cfg, "credentials-plaintext.json")), true);
    assert.equal(existsSync(join(cfg, "config.json")), true);
    assert.equal(report.config_dir.removed, false);
    for (const name of ["default", "work"]) {
      const row = report.profiles.find((p) => p.profile === name);
      assert.ok(row, `${name} is listed`);
      assert.equal(row.revoked, false);
      assert.equal(row.kept, true);
    }
  });
});

describe("logout --all does not strip the Copilot app while it is running (serial)", {
  concurrency: 1,
  skip: process.platform === "win32",
}, () => {
  const { copilotAppAdapter } = copilotApp;
  let copilotHome;
  let savedPath;
  beforeEach(() => {
    copilotHome = join(home, "copilot-home");
    mkdirSync(copilotHome, { recursive: true });
    const db = new DatabaseSync(join(copilotHome, "data.db"));
    db.exec(`
      CREATE TABLE "accounts" (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE "model_providers" (
        id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        type TEXT NOT NULL DEFAULT 'openai', settings_json TEXT NOT NULL DEFAULT '{}',
        account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE);
      CREATE TABLE "provider_models" (
        id TEXT PRIMARY KEY NOT NULL,
        provider_id TEXT NOT NULL REFERENCES "model_providers"(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL, wire_model TEXT, display_name TEXT NOT NULL,
        max_prompt_tokens INTEGER, max_output_tokens INTEGER, wire_api_override TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        supported_reasoning_efforts TEXT, UNIQUE (provider_id, model_id));
    `);
    db.close();
    savedPath = process.env.PATH;
    const stubBin = join(home, "stub-bin");
    plantStub(stubBin, "pgrep", `printf '%s\\n' "/opt/GitHub Copilot/GitHub Copilot"\nexit 0`);
    process.env.PATH = [stubBin, savedPath].join(delimiter);
  });
  afterEach(() => {
    process.env.PATH = savedPath;
  });

  const ourRows = () => {
    const db = new DatabaseSync(join(copilotHome, "data.db"), { readOnly: true });
    try {
      return db.prepare("SELECT id FROM model_providers WHERE id LIKE 'aiand-%'").all();
    } finally {
      db.close();
    }
  };
  const wireApp = () =>
    copilotAppAdapter.enable({
      apiKey: "sk-work-minted",
      model: "zai-org/glm-5.3",
      slots: {},
      catalog: [catalogModel("zai-org/glm-5.3")],
      home,
      baseUrl: "https://api.aiand.com",
    });

  test("the row stays, the agent is reported as failed, and its state is kept", async () => {
    await seedMachine();
    await withEnv({ COPILOT_HOME: copilotHome }, async () => {
      await wireApp();
      const captured = await runAll({ json: true });
      const report = JSON.parse(cliStdout(captured));
      const app = report.agents.find((a) => a.agent === "copilot-app");
      assert.match(app.error, /Quit the GitHub Copilot app first/);
      assert.equal(app.stripped, false);
      assert.equal(ourRows().length, 1, "the running app would rewrite it back anyway");
      assert.equal(report.complete, false);
      assert.deepEqual(report.config_dir.kept, ["snapshots/copilot-app"]);
      assert.equal(existsSync(join(cfg, "snapshots", "copilot-app", "added.json")), true);
    });
  });

  test("a running app we never wired is no reason to refuse", async () => {
    await seedMachine();
    await withEnv({ COPILOT_HOME: copilotHome }, async () => {
      const captured = await runAll({ json: true });
      const report = JSON.parse(cliStdout(captured));
      assert.equal(report.agents.find((a) => a.agent === "copilot-app").error, undefined);
      assert.equal(report.complete, true, JSON.stringify(report));
    });
  });
});

describe("logout sweeps session overlays (serial)", { concurrency: 1 }, () => {
  test("logout sweeps a crashed session's overlay", async () => {
    await config.saveCredential("default", {
      access_token: "sk-x",
      refresh_token: "rt-x",
      origin: "device",
      bound_to: stubBinding(),
    });
    const dead = plantOverlay(DEAD_PID);
    const captured = captureOutput();
    try {
      await logout({ profile: "default" });
    } finally {
      captured.restore();
    }
    assert.equal(existsSync(dead), false);
  });
});

describe("sweepOverlays", () => {
  test("only marked, finished, old-enough overlays go", async () => {
    const fresh = plantOverlay(DEAD_PID, { age: 0 });
    const old = plantOverlay(DEAD_PID, { age: 2 * 24 * 60 * 60 * 1000 });
    const abandoned = plantOverlay(process.ppid, { age: 8 * 24 * 60 * 60 * 1000 });
    const mine = await makeOverlayDir("aiand-self-");
    const unmarked = mkdtempSync(join(tmpdir(), "aiand-unmarked-"));
    const badMarker = mkdtempSync(join(tmpdir(), "aiand-bad-"));
    writeFileSync(join(badMarker, ".aiand-overlay"), "not json");
    const linked = join(tmpdir(), `aiand-link-${process.pid}`);
    symlinkSync(old, linked);

    const result = await sweepOverlays({ minAgeMs: 24 * 60 * 60 * 1000 });
    assert.equal(existsSync(fresh), true, "younger than minAge");
    assert.equal(existsSync(old), false, "old and finished");
    assert.equal(existsSync(abandoned), false, "older than any session runs");
    assert.equal(existsSync(mine), true, "this process's own overlay");
    assert.equal(existsSync(unmarked), true, "no marker, never ours");
    assert.equal(existsSync(badMarker), true, "an unreadable marker proves nothing");
    assert.ok(result.removed.includes(old));
    assert.ok(!result.removed.includes(linked), "a symlink is never followed");
    for (const path of [fresh, mine, unmarked, badMarker, linked]) {
      rmSync(path, { recursive: true, force: true });
    }
  });
});

describe("logout --all through the CLI", () => {
  const env = (extra = {}) =>
    cliEnv({
      AIAND_API_KEY: undefined,
      AIAND_BASE_URL: CLOSED_URL,
      AIAND_AUTH_URL: CLOSED_URL,
      ...extra,
    });

  test("off a terminal it refuses without --force and changes nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "aiand-cli-all-"));
    const cfgDir = join(root, ".config", "aiand");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, "config.json"), '{"profile":"default","profiles":{"default":{}}}\n');
    try {
      const refused = await runCli(["logout", "--all"], {
        env: env({ HOME: root, USERPROFILE: root, AIAND_HOME: root, AIAND_CONFIG_DIR: cfgDir }),
      });
      assert.equal(refused.code, 1);
      assert.match(refused.stderr, /Pass --force to confirm/);
      assert.equal(existsSync(join(cfgDir, "config.json")), true);

      const done = await runCli(["logout", "--all", "--force"], {
        env: env({ HOME: root, USERPROFILE: root, AIAND_HOME: root, AIAND_CONFIG_DIR: cfgDir }),
      });
      assert.equal(done.code, 0, done.stderr);
      assert.equal(existsSync(cfgDir), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--all rejects --profile, and --force needs --all", async () => {
    const withProfile = await runCli(["logout", "--all", "--profile", "x"], { env: env() });
    assert.equal(withProfile.code, 1);
    assert.match(withProfile.stderr, /drop --profile/);
    const forceAlone = await runCli(["logout", "--force"], { env: env() });
    assert.equal(forceAlone.code, 1);
    assert.match(forceAlone.stderr, /--force only applies to logout --all/);
    const both = await runCli(["logout", "--all", "--revoke", "--keep-remote"], { env: env() });
    assert.equal(both.code, 1);
  });

  test("help documents --all", async () => {
    const help = await runCli(["logout", "--help"], { env: env() });
    assert.match(help.stdout, /--all/);
    assert.match(help.stdout, /AIAND_WIPE_OUTSIDE_HOME/);
  });
});
