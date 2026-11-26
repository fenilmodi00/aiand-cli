// `aiand logout --all` with a secret in every storage tier. The key stores
// share one non-reentrant cross-process lock (secret-store.lock), and
// logout --all reads, migrates, deletes and wipes across all of them, so this
// is the call graph that would deadlock if anything under the lock took it
// again. Each scenario runs in its own process under a timeout: a deadlock
// fails the test instead of hanging the run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import test, { describe } from "node:test";
import { pathToFileURL } from "node:url";
import { plantStub, plantWindowsTools, withTestEnv, writeConfigMarker } from "./helpers.mjs";

const env = withTestEnv("aiand-logout-tiers-test-", () => {});
const dist = (rel) => pathToFileURL(join(import.meta.dirname, "..", "dist", rel)).href;

const TIMEOUT_MS = 60_000;
const BINDING = { auth_url: "https://api.example.test", api_url: "https://api.example.test" };

// A file-backed stand-in for the OS keychain that speaks both tools' protocols.
const KEYCHAIN_STUB = `
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const store = process.env.AIAND_TEST_KEYCHAIN_DIR;
mkdirSync(store, { recursive: true });
const file = (account) => join(store, Buffer.from(account).toString("hex"));
const argv = process.argv.slice(2);
const stdin = () => readFileSync(0, "utf8");
const unquote = (token) => token.replace(/^'|'$/g, "").replaceAll("'\\\\''", "'");
if (argv[0] === "-i") {
  const m = /^add-generic-password -s aiand -a ('(?:[^']|'\\\\'')*') -U -w ('(?:[^']|'\\\\'')*')\\n$/.exec(stdin());
  if (m) writeFileSync(file(unquote(m[1])), unquote(m[2]));
} else if (argv[0] === "find-generic-password" || argv[0] === "lookup") {
  const account = argv[0] === "lookup" ? argv[4] : argv[argv.indexOf("-a") + 1];
  if (!existsSync(file(account))) process.exit(44);
  process.stdout.write(readFileSync(file(account), "utf8") + "\\n");
} else if (argv[0] === "store") {
  writeFileSync(file(argv[argv.length - 1]), stdin());
} else if (argv[0] === "delete-generic-password" || argv[0] === "clear") {
  const account = argv[0] === "clear" ? argv[4] : argv[argv.indexOf("-a") + 1];
  if (!existsSync(file(account))) process.exit(44);
  rmSync(file(account));
}
`;

const POWERSHELL = `
import { readFileSync } from "node:fs";
const stdin = readFileSync(0, "utf8");
const script = process.argv.at(-1);
const input = Buffer.from(stdin.trim(), "base64");
const out = /::Protect\\(/.test(script)
  ? Buffer.concat([Buffer.from("dpapi:"), input])
  : input.subarray(6);
process.stdout.write("aiand-dpapi:" + out.toString("base64") + "\\r\\n");
`;

function sandbox() {
  const root = mkdtempSync(join(env.dir, "tiers-"));
  const home = join(root, "home");
  const cfg = join(home, ".config", "aiand");
  const bin = join(root, "bin");
  const keychain = join(root, "keychain");
  mkdirSync(cfg, { recursive: true });
  // The home directory is where `logout --all` is willing to delete.
  writeConfigMarker(cfg);
  plantStub(
    bin,
    process.platform === "darwin" ? "security" : "secret-tool",
    `exec "${process.execPath}" "${join(bin, "keychain.mjs")}" "$@"`,
  );
  writeFileSync(join(bin, "keychain.mjs"), KEYCHAIN_STUB);
  const sysroot = join(root, "sysroot");
  plantWindowsTools(sysroot, {
    "System32/WindowsPowerShell/v1.0/powershell.exe": POWERSHELL,
    "System32/tasklist.exe": "process.exit(0);",
    "System32/whoami.exe": `process.stdout.write('"host\\\\\\\\me","S-1-5-21-1-2-3-1001"');`,
    "System32/icacls.exe": "process.exit(0);",
  });
  return { root, home, cfg, bin, keychain, sysroot };
}

/** Run `body` (an async function body) in a fresh process; returns its JSON result. */
function inChild(box, body, { win32 = false } = {}) {
  const script = `
    ${win32 ? 'Object.defineProperty(process, "platform", { value: "win32" });' : ""}
    const config = await import(${JSON.stringify(dist("config.js"))});
    const { logoutAll } = await import(${JSON.stringify(dist("auth/logout-all.js"))});
    const seed = async (name, tier, origin = "device") => {
      process.env.AIAND_KEY_STORAGE = tier;
      await config.saveCredential(name, {
        access_token: "sk-" + name + "-minted",
        refresh_token: origin === "device" ? "rt-" + name : undefined,
        origin,
        bound_to: ${JSON.stringify(BINDING)},
      });
      delete process.env.AIAND_KEY_STORAGE;
    };
    const result = await (async () => { ${body} })();
    process.stdout.write("\\n@@" + JSON.stringify(result ?? null));
    process.exitCode = 0;
  `;
  const childEnv = { ...process.env };
  delete childEnv.AIAND_API_KEY;
  delete childEnv.AIAND_KEY_STORAGE;
  delete childEnv.AIAND_SECRET_STORE_MASTER_KEY;
  Object.assign(childEnv, {
    HOME: box.home,
    USERPROFILE: box.home,
    AIAND_HOME: box.home,
    AIAND_CONFIG_DIR: box.cfg,
    AIAND_TEST_KEYCHAIN_DIR: box.keychain,
    PATH: [box.bin, process.env.PATH].join(delimiter),
    ...(win32 ? { SystemRoot: box.sysroot } : {}),
  });
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: childEnv,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  assert.equal(
    run.error,
    undefined,
    `the child did not finish in ${TIMEOUT_MS} ms: a lock deadlock? ${run.error}`,
  );
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
  const result = run.stdout.slice(run.stdout.lastIndexOf("\n@@") + 3);
  return { value: JSON.parse(result), stderr: run.stderr };
}

const heldSecrets = (box) => ({
  keychain: existsSync(box.keychain) ? readdirSync(box.keychain) : [],
  config: existsSync(box.cfg),
});

describe("logout --all with a secret in every tier", { skip: process.platform === "win32" }, () => {
  test("keychain, encrypted file, plaintext and a DPAPI record all go, and nothing waits on a lock", () => {
    const box = sandbox();
    const { value } = inChild(
      box,
      `
      await seed("kc", "keychain");
      await seed("fl", "file");
      await seed("pl", "plaintext");
      const stored = await config.loadAllCredentials();
      const tiers = Object.fromEntries(Object.entries(stored).map(([name, entry]) => [name, entry.storage]));
      // A config folder shared with Windows: a record DPAPI wrote, unreadable here.
      const fs = await import("node:fs");
      const path = await import("node:path");
      const credentialsFile = path.join(process.env.AIAND_CONFIG_DIR, "credentials.json");
      const all = JSON.parse(fs.readFileSync(credentialsFile, "utf8"));
      all.dp = { origin: "paste", bound_to: ${JSON.stringify(BINDING)}, storage: "dpapi" };
      fs.writeFileSync(credentialsFile, JSON.stringify(all));
      fs.writeFileSync(path.join(process.env.AIAND_CONFIG_DIR, "secret-store.dpapi.json"), JSON.stringify({ dp: "Y2lwaGVydGV4dA==" }));
      process.exitCode = 0;
      const out = [];
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk, ...rest) => { out.push(String(chunk)); return true; };
      await logoutAll({ force: true, keepRemote: true, json: true });
      process.stdout.write = write;
      return { tiers, report: JSON.parse(out.join("")), exitCode: process.exitCode ?? 0 };
      `,
    );
    assert.deepEqual(value.tiers, { kc: "keychain", fl: "file", pl: "plaintext" });
    assert.equal(value.report.complete, true, JSON.stringify(value.report));
    assert.equal(value.exitCode, 0);
    const left = heldSecrets(box);
    assert.deepEqual(left.keychain, [], "the keychain entry is deleted");
    assert.equal(left.config, false, "credentials, every store and the lock files are gone");
  });

  test("the same on Windows: DPAPI, encrypted file and plaintext, with a stub PowerShell", () => {
    const box = sandbox();
    const { value } = inChild(
      box,
      `
      await seed("dp", "dpapi");
      await seed("fl", "file");
      await seed("pl", "plaintext");
      const stored = await config.loadAllCredentials();
      const tiers = Object.fromEntries(Object.entries(stored).map(([name, entry]) => [name, entry.storage]));
      process.exitCode = 0;
      const out = [];
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk, ...rest) => { out.push(String(chunk)); return true; };
      await logoutAll({ force: true, keepRemote: true, json: true });
      process.stdout.write = write;
      return { tiers, report: JSON.parse(out.join("")), exitCode: process.exitCode ?? 0 };
      `,
      { win32: true },
    );
    assert.deepEqual(value.tiers, { dp: "dpapi", fl: "file", pl: "plaintext" });
    assert.equal(value.report.complete, true, JSON.stringify(value.report));
    assert.equal(value.exitCode, 0);
    assert.equal(
      existsSync(box.cfg),
      false,
      "credentials, every store and the lock files are gone",
    );
  });

  test("a DPAPI sign-in whose revoke failed keeps its ciphertext for the retry", () => {
    const box = sandbox();
    const { value } = inChild(
      box,
      `
      await seed("dp", "dpapi");
      await seed("fl", "file");
      process.exitCode = 0;
      const out = [];
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk, ...rest) => { out.push(String(chunk)); return true; };
      await logoutAll({ force: true, json: true });
      process.stdout.write = write;
      const again = await config.loadCredential("dp");
      return { report: JSON.parse(out.join("")), refresh: again?.refresh_token ?? null };
      `,
      { win32: true },
    );
    assert.equal(value.report.complete, false);
    assert.equal(value.refresh, "rt-dp", "the kept sign-in still decrypts");
    assert.ok(existsSync(join(box.cfg, "secret-store.dpapi.json")));
  });

  test("a revoke that fails keeps one profile and still clears the others from every tier", () => {
    const box = sandbox();
    const { value } = inChild(
      box,
      `
      await seed("kc", "keychain");
      await seed("fl", "file");
      await seed("pl", "plaintext");
      process.exitCode = 0;
      const out = [];
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk, ...rest) => { out.push(String(chunk)); return true; };
      // https://api.example.test is not reachable from the sandbox: every revoke fails.
      await logoutAll({ force: true, json: true });
      process.stdout.write = write;
      const kept = Object.keys(await config.loadAllCredentials());
      return { report: JSON.parse(out.join("")), exitCode: process.exitCode ?? 0, kept };
      `,
    );
    assert.equal(value.report.complete, false);
    assert.equal(value.exitCode, 1);
    assert.deepEqual(
      value.kept.sort(),
      ["fl", "kc", "pl"],
      "every failed revoke keeps its sign-in",
    );
    assert.ok(
      readFileSync(join(box.cfg, "credentials.json"), "utf8").includes('"kc"'),
      "kept profiles stay in credentials.json for a retry",
    );
  });
});
