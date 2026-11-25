// What `uninstall --purge` decides from. The installers parse the JSON the
// installed CLI prints for `logout --all --force --json` (or `logout --profile
// <name> --json` on an older CLI), not its exit code, so the field names and
// the pasted / minted / revoked distinction have to match what the real CLI
// emits. Nothing is stubbed here: the real built CLI runs against a loopback
// double and install.sh's own parser (the node script inside
// `unrevoked_profiles`) reads what it printed. scripts/e2e.mjs runs the whole
// purge the same way; this keeps the contract in `npm test`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test, { after, before, describe } from "node:test";
import { BIN, cliEnv, runCli, withTestEnv } from "./helpers.mjs";

const env = withTestEnv("aiand-purge-contract-", () => {});
const root = join(import.meta.dirname, "..");
const installSh = readFileSync(join(root, "install.sh"), "utf8");
const installPs1 = readFileSync(join(root, "install.ps1"), "utf8");

/** The node program install.sh's `unrevoked_profiles` runs on stdin. */
const PARSER = /unrevoked_profiles\(\) \{\n {2}node -e '([\s\S]*?)'\s*2>\/dev\/null\n\}/.exec(
  installSh,
)?.[1];

/**
 * install.sh's verdict on `text`: the profiles it calls unrevoked, or
 * "unreadable". `names` is what credentials.json listed before sign-out
 * (AIAND_PURGE_NAMES).
 */
function installerVerdict(text, names = []) {
  assert.ok(PARSER, "found the parser in install.sh");
  const run = spawnSync(process.execPath, ["-e", PARSER], {
    input: text,
    encoding: "utf8",
    env: { ...process.env, AIAND_PURGE_NAMES: names.join("\n") },
  });
  if (run.status === 2) return "unreadable";
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.split("\n").filter(Boolean);
}

let gateway;
let baseUrl;
before(async () => {
  gateway = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const refused = req.url === "/auth/device/logout" && body.includes("rt-fail");
      res.writeHead(refused ? 500 : 200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${gateway.address().port}`;
});
after(() => new Promise((resolve) => gateway.close(resolve)));

/** A config dir holding the given sign-ins ({ name: { origin, refresh? } }), in the plaintext tier. */
function seed(signIns) {
  const home = mkdtempSync(join(env.dir, "home-"));
  const cfg = join(home, ".config", "aiand");
  mkdirSync(cfg, { recursive: true });
  const binding = { auth_url: baseUrl, api_url: baseUrl };
  const meta = {};
  const secrets = {};
  for (const [name, { origin, refresh }] of Object.entries(signIns)) {
    meta[name] = { origin, bound_to: binding, storage: "plaintext" };
    secrets[name] = JSON.stringify({
      access_token: `sk-${name}-contract-000000`,
      ...(refresh ? { refresh_token: refresh } : {}),
    });
  }
  writeFileSync(join(cfg, "credentials.json"), JSON.stringify(meta));
  writeFileSync(join(cfg, "credentials-plaintext.json"), JSON.stringify(secrets));
  writeFileSync(
    join(cfg, "config.json"),
    JSON.stringify({
      profile: Object.keys(signIns)[0] ?? "default",
      profiles: Object.fromEntries(Object.keys(signIns).map((name) => [name, {}])),
    }),
  );
  return { home, cfg };
}

function cli(box, args) {
  return runCli(args, {
    env: cliEnv({
      HOME: box.home,
      USERPROFILE: box.home,
      AIAND_HOME: box.home,
      AIAND_CONFIG_DIR: box.cfg,
      AIAND_API_KEY: undefined,
      AIAND_BASE_URL: "http://127.0.0.1:9",
      AIAND_AUTH_URL: undefined,
    }),
    stdin: "ignore",
  });
}

describe("logout --all --force --json, as install.sh reads it", () => {
  test("every minted key revoked, and a pasted one, leave nothing unrevoked", async () => {
    const box = seed({
      default: { origin: "device", refresh: "rt-ok-1" },
      work: { origin: "device", refresh: "rt-ok-2" },
      mine: { origin: "paste" },
    });
    const { code, stdout } = await cli(box, ["logout", "--all", "--force", "--json"]);
    assert.equal(code, 0);
    const report = JSON.parse(stdout);
    assert.deepEqual(
      report.profiles.map((p) => [p.profile, p.source, p.revoked]),
      [
        ["default", "device-login", true],
        ["work", "device-login", true],
        ["mine", "pasted-key", false],
      ],
    );
    assert.deepEqual(installerVerdict(stdout), []);
  });

  test("a revoke the gateway refuses is named, and the exit code agrees", async () => {
    const box = seed({
      default: { origin: "device", refresh: "rt-ok-1" },
      work: { origin: "device", refresh: "rt-fail-2" },
    });
    const { code, stdout } = await cli(box, ["logout", "--all", "--force", "--json"]);
    assert.equal(code, 1);
    assert.deepEqual(installerVerdict(stdout), ["work"]);
  });

  test("a minted key with no refresh token cannot be confirmed revoked, so it blocks the purge", async () => {
    const box = seed({ default: { origin: "device" } });
    const { stdout } = await cli(box, ["logout", "--all", "--force", "--json"]);
    assert.deepEqual(installerVerdict(stdout), ["default"]);
  });

  test("a machine with no sign-in at all has nothing unrevoked", async () => {
    const box = seed({});
    const { code, stdout } = await cli(box, ["logout", "--all", "--force", "--json"]);
    assert.equal(code, 0);
    assert.deepEqual(installerVerdict(stdout), []);
  });

  test("a refusal prints no JSON, which the installer reads as unconfirmed", async () => {
    const box = seed({ default: { origin: "device", refresh: "rt-ok-1" } });
    // Without --force off a terminal, logout --all refuses before touching anything.
    const { code, stdout } = await cli(box, ["logout", "--all", "--json"]);
    assert.notEqual(code, 0);
    assert.equal(installerVerdict(stdout), "unreadable");
  });
});

// What `logout --all` prints when it could not read what it was asked to sign
// out of: a row with revoked:false for each unreadable credential, and
// complete:false with a `problems` entry when the credentials file itself
// could not be read. None of it may pass for "nothing was signed in".
describe("logout --all results that fail closed", () => {
  test("a credential it could not read is a kept row, so it is unrevoked", () => {
    const doc = {
      complete: false,
      profiles: [
        { profile: "default", source: "device-login", revoked: true },
        { profile: "work", source: "unknown", revoked: false, kept: true, error: "boom" },
      ],
      problems: [],
    };
    assert.deepEqual(installerVerdict(JSON.stringify(doc)), ["work"]);
  });

  test("complete:false with problems is unrevoked even when every row reads as revoked", () => {
    const doc = {
      complete: false,
      profiles: [{ profile: "default", source: "device-login", revoked: true }],
      problems: ["Could not read stored credentials: boom"],
    };
    assert.equal(installerVerdict(JSON.stringify(doc)).length, 1);
  });

  test("an empty profile list with problems is unrevoked", () => {
    const doc = { complete: false, profiles: [], problems: ["Could not read config.json: boom"] };
    assert.equal(installerVerdict(JSON.stringify(doc)).length, 1);
  });

  test("an empty profile list over credentials.json names reports those names", () => {
    const doc = { complete: true, profiles: [], problems: [] };
    assert.deepEqual(installerVerdict(JSON.stringify(doc), ["default", "work"]), [
      "default",
      "work",
    ]);
  });

  test("complete:false without problems leaves the verdict to the rows", () => {
    const doc = {
      complete: false,
      profiles: [{ profile: "default", source: "device-login", revoked: true }],
      problems: [],
    };
    assert.deepEqual(installerVerdict(JSON.stringify(doc)), []);
  });

  test("an empty list with no names in credentials.json is a clean machine", () => {
    assert.deepEqual(installerVerdict(JSON.stringify({ complete: true, profiles: [] })), []);
  });

  test("control characters in a name never reach the terminal", () => {
    const doc = { profiles: [{ profile: "a\u001b[2Jb", source: "device-login", revoked: false }] };
    assert.deepEqual(installerVerdict(JSON.stringify(doc)), ["a?[2Jb"]);
  });
});

describe("a credential whose secret cannot be read (a locked keychain)", () => {
  /** credentials.json lists `default`, but its secret is gone from the store. */
  function seedUnreadable() {
    const box = seed({ default: { origin: "device", refresh: "rt-ok-1" } });
    writeFileSync(join(box.cfg, "credentials-plaintext.json"), "{}");
    return box;
  }

  test("the real logout --all keeps it, says so, and install.sh reads it as unrevoked", async () => {
    const box = seedUnreadable();
    const { code, stdout } = await cli(box, ["logout", "--all", "--force", "--json"]);
    assert.equal(code, 1);
    const report = JSON.parse(stdout);
    assert.equal(report.complete, false);
    const row = report.profiles.find((p) => p.profile === "default");
    assert.equal(row.revoked, false);
    assert.equal(row.kept, true);
    const verdict = installerVerdict(stdout, ["default"]);
    assert.ok(Array.isArray(verdict) && verdict.includes("default"), JSON.stringify(verdict));
    assert.ok(existsSync(join(box.cfg, "credentials.json")), "the sign-in stays for a retry");
  });

  test("install.sh uninstall --purge aborts on it and deletes nothing", () => {
    const box = seedUnreadable();
    const checkout = join(box.home, ".aiand", "cli");
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "@aiand/cli" }));
    writeFileSync(
      join(checkout, ".aiand-installer-owned"),
      "aiand-cli installer ownership marker\n",
    );
    const launcherDir = join(box.home, ".local", "bin");
    mkdirSync(launcherDir, { recursive: true });
    const launcher = join(launcherDir, "aiand");
    writeFileSync(
      launcher,
      `#!/bin/sh\n# aiand launcher (test stub)\nexec "${process.execPath}" "${BIN}" "$@"\n`,
    );
    chmodSync(launcher, 0o755);

    const run = spawnSync("bash", [join(root, "install.sh"), "uninstall", "--purge"], {
      env: {
        ...process.env,
        HOME: box.home,
        AIAND_HOME: box.home,
        AIAND_CONFIG_DIR: box.cfg,
        AIAND_API_KEY: undefined,
        AIAND_BASE_URL: "http://127.0.0.1:9",
        AIAND_AUTH_URL: undefined,
        AIAND_DIR: undefined,
        AIAND_UNINSTALL_FORCE: undefined,
        AIAND_SOURCE: undefined,
        // This case seeds production layout (~/.aiand/cli, ~/.local/bin/aiand);
        // unset, cli-v2's preview default would target aiand-v2 instead.
        AIAND_V2_SIDEBYSIDE: "0",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.notEqual(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /could not revoke the keys of:.*default/i);
    assert.ok(existsSync(join(box.cfg, "credentials.json")), "kept the sign-in");
    assert.ok(existsSync(join(box.cfg, "config.json")), "kept the config dir");
    assert.ok(existsSync(checkout), "kept the checkout");
    assert.ok(existsSync(launcher), "kept the launcher");
  });
});

describe("logout --profile <name> --json, as install.sh reads it", () => {
  test("revoked, pasted and signed-out profiles pass; a refused revoke prints nothing", async () => {
    const box = seed({
      default: { origin: "device", refresh: "rt-ok-1" },
      work: { origin: "device", refresh: "rt-fail-2" },
      mine: { origin: "paste" },
    });
    const revoked = await cli(box, ["logout", "--profile", "default", "--json"]);
    assert.equal(revoked.code, 0);
    assert.deepEqual(installerVerdict(revoked.stdout), []);

    const pasted = await cli(box, ["logout", "--profile", "mine", "--json"]);
    assert.equal(pasted.code, 0);
    assert.deepEqual(installerVerdict(pasted.stdout), []);

    const gone = await cli(box, ["logout", "--profile", "default", "--json"]);
    assert.deepEqual(JSON.parse(gone.stdout).signed_in, false);
    assert.deepEqual(installerVerdict(gone.stdout), []);

    const refused = await cli(box, ["logout", "--profile", "work", "--json"]);
    assert.notEqual(refused.code, 0);
    assert.equal(installerVerdict(refused.stdout), "unreadable");
  });
});

test("install.ps1 fails closed on the same shapes install.sh does", () => {
  const parser = /function Get-UnrevokedProfiles \{[\s\S]*?\n\}/.exec(installPs1)?.[0] ?? "";
  assert.match(parser, /complete -eq \$false/, "complete:false");
  assert.match(
    parser,
    /\$all -and \$rows\.Count -eq 0/,
    "an empty profile list over credentials.json names",
  );
  assert.match(
    installPs1,
    /Get-PurgeCredentialNames -Path \$credentialsPath/,
    "reads credentials.json before sign-out",
  );
  assert.match(
    installPs1,
    /Invoke-PurgeSignOut -Launcher \$workingLauncher -ConfigDir \$configDir/,
  );
  assert.match(
    installPs1,
    /\$script:PurgeAllExit -eq 0/,
    "deletes the config dir only after a clean logout --all",
  );
});

test("install.ps1 reads the same fields install.sh does", () => {
  const parser = /function Get-UnrevokedProfiles \{[\s\S]*?\n\}/.exec(installPs1)?.[0];
  assert.ok(parser, "found the parser in install.ps1");
  for (const field of [
    "profiles",
    "signed_in",
    "source",
    "pasted-key",
    "revoked",
    "profile",
    "complete",
    "problems",
  ]) {
    assert.ok(parser.includes(field), `install.ps1 reads ${field}`);
    assert.ok(PARSER.includes(field), `install.sh reads ${field}`);
  }
});

test("install.ps1 link-checks the checkout before it deletes it", () => {
  const uninstall = /function Uninstall-Cli \{[\s\S]*?\n\}/.exec(installPs1)?.[0] ?? "";
  const guard = uninstall.indexOf("Test-LinkBelow -Path $checkout");
  const inside = uninstall.indexOf("Test-ReparsePointInside -Path $checkout");
  const teardown = uninstall.indexOf("Turning agents off");
  const remove = uninstall.indexOf("Remove-Item -LiteralPath $checkout -Recurse");
  assert.ok(guard > 0 && inside > 0, "checks the checkout for links");
  assert.ok(guard < teardown && inside < teardown, "before any teardown");
  assert.ok(inside < remove, "before the recursive delete");
});
