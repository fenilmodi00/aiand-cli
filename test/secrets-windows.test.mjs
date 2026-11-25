// The Windows DPAPI tier, driven on any OS: process.platform reads win32 and
// a stub powershell.exe sits under a fake SystemRoot, where the CLI looks for
// it (never PATH). Each scenario runs in its own process because a DPAPI
// failure and decrypted secrets are cached for the process lifetime.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { pathToFileURL } from "node:url";
import {
  asWin32,
  cliEnv,
  plantWindowsTools,
  runCli,
  systemRootEnv,
  withEnv,
  withTestEnv,
} from "./helpers.mjs";

const env = withTestEnv("aiand-secrets-win-test-", () => {});
const secrets = await import("../dist/secrets.js");
const dist = (rel) => pathToFileURL(join(import.meta.dirname, "..", "dist", rel)).href;

const SECRET = '{"access_token":"sk-test-dpapi-value","refresh_token":"rt-dpapi-secret"}';
const SECRET_B64 = Buffer.from(SECRET).toString("base64");

// Protect wraps the plaintext as "dpapi:<bytes>"; Unprotect unwraps it.
// AIAND_TEST_PS_MODE=clm exits like a Constrained Language Mode session,
// =fail like a PowerShell that cannot load the assembly.
const POWERSHELL = `
import { appendFileSync, readFileSync } from "node:fs";
const stdin = readFileSync(0, "utf8");
const script = process.argv.at(-1);
const op = /::Protect\\(/.test(script) ? "Protect" : "Unprotect";
appendFileSync(process.env.AIAND_TEST_TOOL_LOG, JSON.stringify({ argv: process.argv.slice(2), env: Object.fromEntries(["AIAND_API_KEY", "AIAND_SECRET_STORE_MASTER_KEY", "NoDefaultCurrentDirectoryInExePath"].map((k) => [k, process.env[k]])), stdinInEnv: stdin.trim() !== "" && Object.values(process.env).some((v) => v.includes(stdin.trim()) || v.includes("sk-test-dpapi-value")), stdin, op }) + "\\n");
if (process.env.AIAND_TEST_PS_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.AIAND_TEST_PS_DELAY_MS)));
if (process.env.AIAND_TEST_PS_MODE === "clm") process.exit(3);
if (process.env.AIAND_TEST_PS_MODE === "fail") { process.stderr.write("Add-Type: denied"); process.exit(1); }
const input = Buffer.from(stdin.trim(), "base64");
const out = op === "Protect"
  ? Buffer.concat([Buffer.from("dpapi:"), input])
  : input.subarray(6);
if (op === "Unprotect" && input.subarray(0, 6).toString() !== "dpapi:") process.exit(1);
process.stdout.write("aiand-dpapi:" + out.toString("base64") + "\\r\\n");
`;

function sandbox({ whoami, icacls } = {}) {
  const root = mkdtempSync(join(env.dir, "win-"));
  plantWindowsTools(root, {
    "System32/WindowsPowerShell/v1.0/powershell.exe": POWERSHELL,
    "System32/whoami.exe":
      whoami ?? `process.stdout.write('"host\\\\\\\\me","S-1-5-21-1-2-3-1001"');`,
    "System32/icacls.exe": icacls ?? "process.exit(process.env.AIAND_TEST_ICACLS_FAIL ? 5 : 0);",
  });
  const cfg = join(root, "cfg");
  const log = join(root, "powershell.log");
  writeFileSync(log, "");
  return {
    root,
    cfg,
    log,
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

function winSpawn(box, body, extraEnv = {}, prelude = "") {
  const script = `
    Object.defineProperty(process, "platform", { value: "win32" });
    ${prelude}
    const secrets = await import(${JSON.stringify(dist("secrets.js"))});
    const config = await import(${JSON.stringify(dist("config.js"))});
    const identity = await import(${JSON.stringify(dist("auth/identity.js"))});
    const result = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify(result ?? null));
  `;
  const childEnv = { ...process.env };
  delete childEnv.AIAND_KEY_STORAGE;
  delete childEnv.AIAND_SECRET_STORE_MASTER_KEY;
  delete childEnv.AIAND_API_KEY;
  Object.assign(childEnv, {
    ...systemRootEnv(box.root),
    AIAND_CONFIG_DIR: box.cfg,
    AIAND_TEST_TOOL_LOG: box.log,
    ...extraEnv,
  });
  for (const [k, v] of Object.entries(extraEnv)) if (v === undefined) delete childEnv[k];
  return [
    process.execPath,
    ["--input-type=module", "-e", script],
    { env: childEnv, encoding: "utf8" },
  ];
}

/** Run `body` (an async function body) as win32 in a fresh process; returns its JSON result. */
function runWin(box, body, extraEnv = {}, prelude = "") {
  const r = spawnSync(...winSpawn(box, body, extraEnv, prelude));
  assert.equal(r.status, 0, r.stderr);
  return { value: JSON.parse(r.stdout), stderr: r.stderr };
}

/** runWin without waiting: for scenarios that need two processes at once. */
function runWinAsync(box, body, extraEnv = {}, prelude = "") {
  const [cmd, args, options] = winSpawn(box, body, extraEnv, prelude);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: options.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => {
      assert.equal(code, 0, stderr);
      resolve({ value: JSON.parse(stdout), stderr });
    });
  });
}

/** Prelude that stretches every atomic write of `file` by `ms`, widening a race window. */
const slowRename = (file, ms) => `
  const fsp = (await import("node:fs/promises")).default;
  const realRename = fsp.rename;
  fsp.rename = async (from, to) => {
    if (String(to).endsWith(${JSON.stringify(file)})) await new Promise((r) => setTimeout(r, ${ms}));
    return realRename(from, to);
  };
  (await import("node:module")).syncBuiltinESMExports();
`;

const credential = {
  access_token: "sk-test-dpapi-value",
  refresh_token: "rt-dpapi-secret",
  origin: "device",
  user: { id: "u1", email: "me@example.com" },
  org: { id: "o1", name: "Org" },
};

describe("tier selection", () => {
  test("win32 defaults to dpapi without starting PowerShell", async () => {
    await withEnv({ AIAND_KEY_STORAGE: undefined }, () =>
      asWin32(async () => assert.equal(await secrets.detectTier(), "dpapi")),
    );
  });

  test("AIAND_KEY_STORAGE pins a tier on win32, and dpapi is refused elsewhere", async () => {
    await withEnv({ AIAND_KEY_STORAGE: "file" }, () =>
      asWin32(async () => assert.equal(await secrets.detectTier(), "file")),
    );
    await withEnv({ AIAND_KEY_STORAGE: "dpapi" }, async () => {
      if (process.platform !== "win32") {
        await assert.rejects(secrets.detectTier(), /only on Windows/);
      }
      await asWin32(async () => assert.equal(await secrets.detectTier(), "dpapi"));
    });
    await withEnv({ AIAND_KEY_STORAGE: "vault" }, () =>
      assert.rejects(secrets.detectTier(), /keychain, dpapi, file, plaintext/),
    );
  });

  test("PowerShell is spawned by absolute path with no profile and no policy override", () => {
    assert.match(secrets.powershellPath(), /System32.WindowsPowerShell.v1\.0.powershell\.exe$/);
    for (const op of ["Protect", "Unprotect"]) {
      const script = secrets.dpapiScript(op);
      assert.ok(!script.includes('"'), "no double quote to survive command-line quoting");
      assert.match(script, /LanguageMode -ne 'FullLanguage'\) \{ exit 3 \}/);
      assert.match(script, /DataProtectionScope\]::CurrentUser/);
      assert.match(script, /\[Console\]::In\.ReadToEnd\(\)/);
    }
  });
});

describe("DPAPI round trip", () => {
  test("stores and reads back; the secret never reaches argv, env, or the store file", () => {
    const box = sandbox();
    const stored = runWin(box, `return await secrets.storeSecret("p", ${JSON.stringify(SECRET)});`);
    assert.equal(stored.value, "dpapi");
    const read = runWin(box, `return await secrets.loadSecret("p", "dpapi");`);
    assert.equal(read.value, SECRET);

    const calls = box.calls();
    assert.deepEqual(
      calls.map((c) => c.op),
      ["Protect", "Unprotect"],
      "one PowerShell start per operation",
    );
    for (const call of calls) {
      assert.deepEqual(call.argv.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
      assert.ok(!call.argv.includes("-ExecutionPolicy"));
      for (const value of call.argv) {
        assert.ok(!value.includes("sk-test-dpapi-value"), "secret in argv");
        assert.ok(!value.includes(SECRET_B64), "encoded secret in argv");
      }
      assert.equal(call.stdinInEnv, false, "secret in the environment");
    }
    assert.equal(calls[0].stdin, SECRET_B64, "the secret rides stdin, base64-encoded");
    const store = readFileSync(join(box.cfg, "secret-store.dpapi.json"), "utf8");
    assert.ok(!store.includes("sk-test-dpapi-value"));
    assert.ok(!existsSync(join(box.cfg, "secret-store.json")), "no file-tier copy");
  });

  test("PowerShell starts without the CLI's own secrets, and never searches the cwd", () => {
    const box = sandbox();
    const leaky = {
      AIAND_API_KEY: "sk-test-env-key",
      AIAND_SECRET_STORE_MASTER_KEY: "ab".repeat(32),
    };
    runWin(box, `await secrets.storeSecret("p", ${JSON.stringify(SECRET)});`, leaky);
    runWin(box, `return await secrets.loadSecret("p", "dpapi");`, leaky);
    const calls = box.calls();
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.env.AIAND_API_KEY, undefined);
      assert.equal(call.env.AIAND_SECRET_STORE_MASTER_KEY, undefined);
      assert.equal(call.env.NoDefaultCurrentDirectoryInExePath, "1");
    }
  });

  test("a second read in one process is served from memory", () => {
    const box = sandbox();
    runWin(box, `await secrets.storeSecret("p", ${JSON.stringify(SECRET)});`);
    runWin(
      box,
      `await secrets.loadSecret("p", "dpapi"); return await secrets.loadSecret("p", "dpapi");`,
    );
    assert.deepEqual(
      box.calls().map((c) => c.op),
      ["Protect", "Unprotect"],
    );
  });

  test("a read after another process rotated the token sees the new blob, not the cached one", () => {
    const box = sandbox();
    const rotated = '{"access_token":"sk-rotated","refresh_token":"rt-rotated"}';
    runWin(box, `await secrets.storeSecret("p", ${JSON.stringify(SECRET)});`);
    const read = runWin(
      box,
      `const fs = await import("node:fs");
       const file = (await import("node:path")).join(process.env.AIAND_CONFIG_DIR, "secret-store.dpapi.json");
       const first = await secrets.loadSecret("p", "dpapi");
       const map = JSON.parse(fs.readFileSync(file, "utf8"));
       map.p = Buffer.from("dpapi:" + ${JSON.stringify(rotated)}).toString("base64");
       fs.writeFileSync(file, JSON.stringify(map));
       return [first, await secrets.loadSecret("p", "dpapi")];`,
    );
    assert.deepEqual(read.value, [SECRET, rotated]);
  });

  test("a read after another process signed out finds nothing, not the cached blob", () => {
    const box = sandbox();
    runWin(box, `await secrets.storeSecret("p", ${JSON.stringify(SECRET)});`);
    const read = runWin(
      box,
      `const fs = await import("node:fs");
       const file = (await import("node:path")).join(process.env.AIAND_CONFIG_DIR, "secret-store.dpapi.json");
       const first = await secrets.loadSecret("p", "dpapi");
       fs.writeFileSync(file, "{}");
       return [first, await secrets.loadSecret("p", "dpapi")];`,
    );
    assert.deepEqual(read.value, [SECRET, null]);
  });

  test("logout's sweep removes the DPAPI entry", () => {
    const box = sandbox();
    runWin(box, `await secrets.storeSecret("p", ${JSON.stringify(SECRET)});`);
    const after = runWin(
      box,
      `await secrets.deleteSecret("p"); return await secrets.loadSecret("p", "dpapi");`,
    );
    assert.equal(after.value, null);
    assert.deepEqual(
      JSON.parse(readFileSync(join(box.cfg, "secret-store.dpapi.json"), "utf8")),
      {},
    );
  });

  test("a ciphertext DPAPI cannot open warns and reads as signed out", () => {
    const box = sandbox();
    runWin(box, `await secrets.storeSecret("p", ${JSON.stringify(SECRET)});`);
    writeFileSync(join(box.cfg, "secret-store.dpapi.json"), JSON.stringify({ p: "Z2FyYmFnZQ==" }));
    const read = runWin(box, `return await secrets.loadSecret("p", "dpapi");`);
    assert.equal(read.value, null);
    assert.match(read.stderr, /could not decrypt the stored key/);
  });
});

describe("Constrained Language Mode and other PowerShell failures", () => {
  test("clm: falls back to the encrypted file, records why, and status says so", () => {
    const box = sandbox();
    const saved = runWin(
      box,
      `return await config.saveCredential("default", ${JSON.stringify(credential)});`,
      { AIAND_TEST_PS_MODE: "clm" },
    );
    assert.equal(saved.value, "file");
    assert.match(saved.stderr, /Constrained Language Mode/);
    const creds = JSON.parse(readFileSync(join(box.cfg, "credentials.json"), "utf8"));
    assert.equal(creds.default.storage, "file");
    assert.equal(creds.default.storage_fallback, "clm");

    const before = box.calls().length;
    const status = runWin(box, `return await identity.authStatus({ local: true });`, {
      AIAND_TEST_PS_MODE: "clm",
    });
    assert.equal(box.calls().length, before, "a recorded fallback is not retried on read");
    assert.equal(status.value.storage, "file (owner-only, not encrypted at rest)");
    assert.equal(status.value.storage_tier, "file");
    assert.match(status.value.storage_notice, /Constrained Language Mode/);
    assert.equal(status.value.signed_in, true);
  });

  test("a transient failure falls back and is recorded with a time to try again", () => {
    const box = sandbox();
    const before = Date.now();
    const saved = runWin(
      box,
      `return await config.saveCredential("default", ${JSON.stringify(credential)});`,
      { AIAND_TEST_PS_MODE: "fail" },
    );
    assert.equal(saved.value, "file");
    assert.match(saved.stderr, /could not be reached through PowerShell/);
    const creds = JSON.parse(readFileSync(join(box.cfg, "credentials.json"), "utf8"));
    assert.equal(creds.default.storage, "file");
    assert.equal(creds.default.storage_fallback, "unavailable");
    const wait = creds.default.dpapi_retry_after - before;
    assert.ok(wait > 5 * 60_000 && wait < 15 * 60_000, `retry in ${wait} ms`);
  });

  test("the next save after a transient failure tries DPAPI again", () => {
    const box = sandbox();
    runWin(box, `await config.saveCredential("default", ${JSON.stringify(credential)});`, {
      AIAND_TEST_PS_MODE: "fail",
    });
    const saved = runWin(
      box,
      `return await config.saveCredential("default", ${JSON.stringify(credential)});`,
    );
    assert.equal(saved.value, "dpapi");
    const creds = JSON.parse(readFileSync(join(box.cfg, "credentials.json"), "utf8"));
    assert.equal(creds.default.storage, "dpapi");
  });

  test("a transient failure is tried at most once per process", () => {
    const box = sandbox();
    runWin(box, `await config.saveCredential("default", ${JSON.stringify(credential)});`, {
      AIAND_KEY_STORAGE: "file",
    });
    const before = box.calls().length;
    // The read tries to migrate and fails; the save that follows (a token
    // rotation) must not start PowerShell a second time.
    runWin(
      box,
      `const c = await config.loadCredential("default");
       await config.saveCredential("default", c);`,
      { AIAND_TEST_PS_MODE: "fail" },
    );
    assert.equal(box.calls().length - before, 1);
    const creds = JSON.parse(readFileSync(join(box.cfg, "credentials.json"), "utf8"));
    assert.equal(creds.default.storage_fallback, "unavailable");
  });

  // With a PowerShell that hangs, every process used to pay 20 s on its first read.
  describe("a PowerShell that does not answer", () => {
    const fileTierBox = () => {
      const box = sandbox();
      runWin(box, `await config.saveCredential("default", ${JSON.stringify(credential)});`, {
        AIAND_KEY_STORAGE: "file",
      });
      return box;
    };
    const recorded = (box) =>
      JSON.parse(readFileSync(join(box.cfg, "credentials.json"), "utf8")).default;
    const setRecord = (box, change) => {
      const file = join(box.cfg, "credentials.json");
      const all = JSON.parse(readFileSync(file, "utf8"));
      change(all.default);
      writeFileSync(file, JSON.stringify(all));
    };
    const read = (box, mode) =>
      runWin(box, `return (await config.loadCredential("default")).access_token;`, {
        ...(mode ? { AIAND_TEST_PS_MODE: mode } : {}),
      });

    test("is waited for once, not by every process that reads the key", () => {
      const box = fileTierBox();
      assert.equal(read(box, "fail").value, "sk-test-dpapi-value");
      assert.equal(box.calls().length, 1, "the first read tries");
      for (let i = 0; i < 3; i += 1) {
        assert.equal(read(box, "fail").value, "sk-test-dpapi-value", "the key still comes back");
      }
      assert.equal(box.calls().length, 1, "later processes did not start PowerShell");
      assert.equal(recorded(box).storage, "file");
    });

    test("is tried again once the retry time has passed, and DPAPI then takes the key", () => {
      const box = fileTierBox();
      read(box, "fail");
      setRecord(box, (entry) => {
        entry.dpapi_retry_after = Date.now() - 1_000;
      });
      assert.equal(read(box).value, "sk-test-dpapi-value");
      assert.equal(box.calls().length, 2, "the retry started PowerShell once more");
      const entry = recorded(box);
      assert.equal(entry.storage, "dpapi");
      assert.equal(entry.storage_fallback, undefined);
      assert.equal(entry.dpapi_retry_after, undefined);
    });

    test("is tried again when the record is from a version that kept no time", () => {
      const box = fileTierBox();
      read(box, "fail");
      setRecord(box, (entry) => {
        entry.dpapi_retry_after = undefined;
      });
      read(box, "fail");
      assert.equal(box.calls().length, 2);
    });

    test("is tried again when the clock was set back past the retry time", () => {
      const box = fileTierBox();
      read(box, "fail");
      setRecord(box, (entry) => {
        entry.dpapi_retry_after = Date.now() + 24 * 3_600_000;
      });
      read(box, "fail");
      assert.equal(box.calls().length, 2, "a retry time a day away is not trusted");
    });

    test("a failed retry sets the next time again", () => {
      const box = fileTierBox();
      read(box, "fail");
      setRecord(box, (entry) => {
        entry.dpapi_retry_after = Date.now() - 1_000;
      });
      read(box, "fail");
      assert.ok(recorded(box).dpapi_retry_after > Date.now() + 5 * 60_000);
    });

    test("status says why the key is in the file, and that aiand will try again", () => {
      const box = fileTierBox();
      read(box, "fail");
      const before = box.calls().length;
      const status = runWin(box, `return await identity.authStatus({ local: true });`, {
        AIAND_TEST_PS_MODE: "fail",
      });
      assert.equal(box.calls().length, before, "status did not start PowerShell either");
      assert.equal(status.value.storage_tier, "file");
      assert.match(status.value.storage_notice, /could not be reached through PowerShell/);
      assert.match(status.value.storage_notice, /tries again/);
    });

    test("a sign-in after PowerShell recovers goes to DPAPI and drops the note", () => {
      const box = fileTierBox();
      read(box, "fail");
      const saved = runWin(
        box,
        `return await config.saveCredential("default", ${JSON.stringify(credential)});`,
      );
      assert.equal(saved.value, "dpapi");
      const entry = recorded(box);
      assert.equal(entry.storage_fallback, undefined);
      assert.equal(entry.dpapi_retry_after, undefined);
      const status = runWin(box, `return await identity.authStatus({ local: true });`);
      assert.equal(status.value.storage_notice, null);
    });
  });

  test("`aiand status` prints the one-line note", async () => {
    const box = sandbox();
    runWin(box, `await config.saveCredential("default", ${JSON.stringify(credential)});`, {
      AIAND_TEST_PS_MODE: "clm",
    });
    const preload = join(box.root, "win32.mjs");
    writeFileSync(preload, 'Object.defineProperty(process, "platform", { value: "win32" });\n');
    const result = await runCli(["status", "--local"], {
      env: cliEnv({
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`,
        ...systemRootEnv(box.root),
        AIAND_CONFIG_DIR: box.cfg,
        AIAND_HOME: join(box.root, "home"),
        AIAND_TEST_TOOL_LOG: box.log,
        AIAND_TEST_PS_MODE: "clm",
        AIAND_KEY_STORAGE: undefined,
        AIAND_API_KEY: undefined,
        NO_COLOR: "1",
      }),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /storage\s+file \(owner-only, not encrypted at rest\)/);
    assert.match(
      result.stderr,
      /^Note: PowerShell's Constrained Language Mode blocks Windows DPAPI here/m,
    );
  });

  test("the next sign-in tries DPAPI again and clears the note", () => {
    const box = sandbox();
    runWin(box, `await config.saveCredential("default", ${JSON.stringify(credential)});`, {
      AIAND_TEST_PS_MODE: "clm",
    });
    const saved = runWin(
      box,
      `return await config.saveCredential("default", ${JSON.stringify(credential)});`,
    );
    assert.equal(saved.value, "dpapi");
    const creds = JSON.parse(readFileSync(join(box.cfg, "credentials.json"), "utf8"));
    assert.equal(creds.default.storage, "dpapi");
    assert.equal(creds.default.storage_fallback, undefined);
    const status = runWin(box, `return await identity.authStatus({ local: true });`);
    assert.equal(status.value.storage, "Windows DPAPI");
    assert.equal(status.value.storage_notice, null);
  });
});

describe("migration from the file tier", () => {
  test("a file-tier sign-in moves into DPAPI on first read and leaves no file copy", () => {
    const box = sandbox();
    const saved = runWin(
      box,
      `return await config.saveCredential("default", ${JSON.stringify(credential)});`,
      { AIAND_KEY_STORAGE: "file" },
    );
    assert.equal(saved.value, "file");
    const loaded = runWin(
      box,
      `const c = await config.loadCredential("default"); return c.access_token;`,
    );
    assert.equal(loaded.value, "sk-test-dpapi-value");
    const creds = JSON.parse(readFileSync(join(box.cfg, "credentials.json"), "utf8"));
    assert.equal(creds.default.storage, "dpapi");
    const again = runWin(box, `return (await config.loadCredential("default")).access_token;`);
    assert.equal(again.value, "sk-test-dpapi-value");
    assert.deepEqual(
      box.calls().map((c) => c.op),
      ["Protect", "Unprotect"],
      "migration protects once; the later read unprotects",
    );
  });

  test("the file store itself no longer holds the migrated profile", () => {
    const box = sandbox();
    runWin(box, `await config.saveCredential("default", ${JSON.stringify(credential)});`, {
      AIAND_KEY_STORAGE: "file",
    });
    runWin(box, `await config.loadCredential("default");`);
    // Read the file tier with DPAPI broken: only the file store can answer.
    const fileOnly = runWin(box, `return await secrets.loadSecret("default", "file");`, {
      AIAND_TEST_PS_MODE: "fail",
    });
    assert.equal(fileOnly.value, null);
  });

  test("a failed migration is recorded once and not retried on every read", () => {
    const box = sandbox();
    runWin(box, `await config.saveCredential("default", ${JSON.stringify(credential)});`, {
      AIAND_KEY_STORAGE: "file",
    });
    runWin(box, `await config.loadCredential("default");`, { AIAND_TEST_PS_MODE: "clm" });
    runWin(box, `await config.loadCredential("default");`, { AIAND_TEST_PS_MODE: "clm" });
    assert.equal(box.calls().length, 1);
    const creds = JSON.parse(readFileSync(join(box.cfg, "credentials.json"), "utf8"));
    assert.equal(creds.default.storage, "file");
    assert.equal(creds.default.storage_fallback, "clm");
  });

  test("AIAND_KEY_STORAGE=file keeps a file-tier sign-in where it is", () => {
    const box = sandbox();
    runWin(box, `await config.saveCredential("default", ${JSON.stringify(credential)});`, {
      AIAND_KEY_STORAGE: "file",
    });
    runWin(box, `await config.loadCredential("default");`, { AIAND_KEY_STORAGE: "file" });
    assert.equal(box.calls().length, 0);
  });
});

describe("concurrent processes", () => {
  const other = { ...credential, access_token: "sk-test-other-value", refresh_token: "rt-other" };

  test("two processes migrating different profiles both end up in the DPAPI store", async () => {
    const box = sandbox();
    for (const [profile, cred] of [
      ["p1", credential],
      ["p2", other],
    ]) {
      runWin(
        box,
        `await config.saveCredential(${JSON.stringify(profile)}, ${JSON.stringify(cred)});`,
        {
          AIAND_KEY_STORAGE: "file",
        },
      );
    }
    const slow = slowRename("secret-store.dpapi.json", 400);
    await Promise.all(
      ["p1", "p2"].map((profile) =>
        runWinAsync(box, `await config.loadCredential(${JSON.stringify(profile)});`, {}, slow),
      ),
    );
    const map = JSON.parse(readFileSync(join(box.cfg, "secret-store.dpapi.json"), "utf8"));
    assert.deepEqual(Object.keys(map).sort(), ["p1", "p2"], "neither ciphertext was lost");
    const read = (profile) =>
      runWin(box, `return (await config.loadCredential(${JSON.stringify(profile)})).access_token;`)
        .value;
    assert.equal(read("p1"), "sk-test-dpapi-value");
    assert.equal(read("p2"), "sk-test-other-value");
    assert.ok(!existsSync(join(box.cfg, "secret-store.lock")), "the lock is released");
  });

  test("a migration does not clobber a credential another process saved meanwhile", async () => {
    const box = sandbox();
    runWin(box, `await config.saveCredential("a", ${JSON.stringify(credential)});`, {
      AIAND_KEY_STORAGE: "file",
    });
    // The migrating process is held up inside PowerShell while the other one saves "b".
    const migrating = runWinAsync(box, `await config.loadCredential("a");`, {
      AIAND_TEST_PS_DELAY_MS: "700",
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await runWinAsync(box, `await config.saveCredential("b", ${JSON.stringify(other)});`, {
      AIAND_KEY_STORAGE: "file",
    });
    await migrating;
    const creds = JSON.parse(readFileSync(join(box.cfg, "credentials.json"), "utf8"));
    assert.equal(creds.a.storage, "dpapi");
    assert.equal(creds.b.storage, "file", "the concurrent save survived");
  });

  test("the file copy is dropped only once the DPAPI store is seen to hold the entry", () => {
    const box = sandbox();
    runWin(box, `await config.saveCredential("p", ${JSON.stringify(credential)});`, {
      AIAND_KEY_STORAGE: "file",
    });
    // A DPAPI store that silently loses the write must leave the file copy alone.
    const lost = `
      const fsp = (await import("node:fs/promises")).default;
      const realRename = fsp.rename;
      fsp.rename = async (from, to) => {
        if (String(to).endsWith("secret-store.dpapi.json")) return;
        return realRename(from, to);
      };
      (await import("node:module")).syncBuiltinESMExports();
    `;
    const moved = runWin(
      box,
      `return await secrets.migrateToDpapi("p", ${JSON.stringify(SECRET)});`,
      {},
      lost,
    );
    assert.equal(moved.value, "unavailable");
    const stillThere = runWin(box, `return await secrets.loadSecret("p", "file");`, {
      AIAND_TEST_PS_MODE: "fail",
    });
    assert.equal(stillThere.value, SECRET, "the file-tier copy is intact");
  });

  test("a DPAPI write that reports success but is not in the store leaves the file copy alone", () => {
    const box = sandbox();
    runWin(box, `await config.saveCredential("p", ${JSON.stringify(credential)});`, {
      AIAND_KEY_STORAGE: "file",
    });
    // The write lands, then something else (an older aiand with no lock, a
    // sync client) puts the store back without the entry: a read straight after
    // sees nothing, and the file copy is then the only one left.
    const overwritten = `
      const fsp = (await import("node:fs/promises")).default;
      const realRename = fsp.rename;
      fsp.rename = async (from, to) => {
        const done = await realRename(from, to);
        if (String(to).endsWith("secret-store.dpapi.json")) {
          (await import("node:fs")).writeFileSync(to, "{}");
        }
        return done;
      };
      (await import("node:module")).syncBuiltinESMExports();
    `;
    const moved = runWin(
      box,
      `return await secrets.migrateToDpapi("p", ${JSON.stringify(SECRET)});`,
      {},
      overwritten,
    );
    assert.equal(moved.value, "unavailable", "a write that is not there is not a move");
    const stillThere = runWin(box, `return await secrets.loadSecret("p", "file");`, {
      AIAND_TEST_PS_MODE: "fail",
    });
    assert.equal(stillThere.value, SECRET, "the file-tier copy is the only one left, and intact");
  });

  test("a store that loses a sign-in's write keeps the key in the file", () => {
    const box = sandbox();
    const overwritten = `
      const fsp = (await import("node:fs/promises")).default;
      const realRename = fsp.rename;
      fsp.rename = async (from, to) => {
        const done = await realRename(from, to);
        if (String(to).endsWith("secret-store.dpapi.json")) {
          (await import("node:fs")).writeFileSync(to, "{}");
        }
        return done;
      };
      (await import("node:module")).syncBuiltinESMExports();
    `;
    const saved = runWin(
      box,
      `return await secrets.storeSecret("p", ${JSON.stringify(SECRET)});`,
      {},
      overwritten,
    );
    assert.equal(saved.value, "file", "the key is where it can be read");
    assert.equal(
      runWin(box, `return await secrets.loadSecret("p", "file");`, { AIAND_TEST_PS_MODE: "fail" })
        .value,
      SECRET,
    );
  });

  test("a migration that stopped after the file copy was dropped still reads the key", () => {
    // credentials.json still says "file"; only DPAPI holds the key.
    const box = sandbox();
    runWin(box, `await config.saveCredential("p", ${JSON.stringify(credential)});`, {
      AIAND_KEY_STORAGE: "file",
    });
    runWin(box, `return await secrets.migrateToDpapi("p", ${JSON.stringify(SECRET)});`);
    const creds = JSON.parse(readFileSync(join(box.cfg, "credentials.json"), "utf8"));
    assert.equal(creds.p.storage, "file", "the interruption point: the tier is not yet recorded");

    const fromTier = runWin(box, `return await secrets.loadSecret("p", "file");`);
    assert.equal(fromTier.value, SECRET, "the file tier falls through to DPAPI");

    const loaded = runWin(
      box,
      `const c = await config.loadCredential("p"); return [c.access_token, c.storage];`,
    );
    assert.deepEqual(
      loaded.value,
      ["sk-test-dpapi-value", "dpapi"],
      "and the next read finishes it",
    );
  });

  test("a migration of a stale blob leaves a newer one alone", () => {
    const box = sandbox();
    runWin(box, `await config.saveCredential("p", ${JSON.stringify(credential)});`, {
      AIAND_KEY_STORAGE: "file",
    });
    const result = runWin(
      box,
      `return await secrets.migrateToDpapi("p", ${JSON.stringify('{"access_token":"old"}')});`,
    );
    assert.equal(result.value, "changed");
    assert.ok(!existsSync(join(box.cfg, "secret-store.dpapi.json")), "nothing written to DPAPI");
    const kept = runWin(box, `return await secrets.loadSecret("p", "file");`, {
      AIAND_TEST_PS_MODE: "fail",
    });
    assert.equal(kept.value, SECRET);
  });
});

describe("a stale file-tier store", () => {
  test("does not fail a sign-in that DPAPI already holds", () => {
    const box = sandbox();
    // Written under one master key, read under another: it no longer decrypts.
    const key = "ab".repeat(32);
    runWin(box, `await secrets.storeSecret("old", "blob");`, {
      AIAND_KEY_STORAGE: "file",
      AIAND_SECRET_STORE_MASTER_KEY: key,
    });
    const saved = runWin(
      box,
      `return await config.saveCredential("default", ${JSON.stringify(credential)});`,
      { AIAND_SECRET_STORE_MASTER_KEY: "cd".repeat(32) },
    );
    assert.equal(saved.value, "dpapi");
    assert.doesNotMatch(saved.stderr, /Warning/);
    const read = runWin(box, `return (await config.loadCredential("default")).access_token;`);
    assert.equal(read.value, "sk-test-dpapi-value");
  });
});

describe("a config folder shared with Windows", { skip: process.platform === "win32" }, () => {
  /** A box whose DPAPI store and credentials say "dpapi", read here as POSIX. */
  function dpapiBox() {
    const box = sandbox();
    runWin(box, `await config.saveCredential("default", ${JSON.stringify(credential)});`);
    return box;
  }
  const posix = (box, body) => {
    const [cmd, args, options] = winSpawn(box, body);
    // winSpawn forces win32; strip that line to run as the real platform.
    const script = args[2].replace(/Object\.defineProperty\(process, "platform".*\n/, "");
    return spawnSync(cmd, [args[0], args[1], script], options);
  };

  test("a dpapi record reads as a clear sign-in-again error and spawns nothing", () => {
    const box = dpapiBox();
    const before = box.calls().length;
    const r = posix(
      box,
      `try { await config.loadCredential("default"); return "no error"; } catch (e) { return e.message; }`,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(JSON.parse(r.stdout), /stored with Windows DPAPI; sign in again here/);
    assert.equal(box.calls().length, before, "no PowerShell start");
  });

  test("the file tier's interrupted-migration fallback does not spawn PowerShell either", () => {
    const box = dpapiBox();
    const before = box.calls().length;
    const r = posix(box, `return await secrets.loadSecret("default", "file");`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout), null);
    assert.equal(box.calls().length, before);
  });

  test("logout and a fresh sign-in still work here", () => {
    const box = dpapiBox();
    const r = posix(
      box,
      `await config.clearCredential("default"); return Object.keys(await config.loadAllCredentials());`,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), []);
  });
});

describe("the file tier's label tells the truth", () => {
  // Pinned to the file tier, or the read would migrate the key into DPAPI first.
  const status = (box, extraEnv = {}) =>
    runWin(box, `return await identity.authStatus({ local: true });`, {
      AIAND_KEY_STORAGE: "file",
      ...extraEnv,
    }).value;
  const save = (box, extraEnv) =>
    runWin(box, `await config.saveCredential("default", ${JSON.stringify(credential)});`, {
      AIAND_KEY_STORAGE: "file",
      ...extraEnv,
    });

  test("owner-only when icacls worked", () => {
    const box = sandbox();
    save(box);
    const creds = JSON.parse(readFileSync(join(box.cfg, "credentials.json"), "utf8"));
    assert.equal(creds.default.owner_only, undefined);
    assert.equal(status(box).storage, "file (owner-only, not encrypted at rest)");
  });

  test("not owner-only when icacls failed, with the tier id unchanged", () => {
    const box = sandbox();
    save(box, { AIAND_TEST_ICACLS_FAIL: "1" });
    const creds = JSON.parse(readFileSync(join(box.cfg, "credentials.json"), "utf8"));
    assert.equal(creds.default.owner_only, false);
    const read = status(box);
    assert.equal(read.storage, "file (not owner-only, not encrypted at rest)");
    assert.equal(read.storage_tier, "file");
  });

  test("a later save where icacls works clears it", () => {
    const box = sandbox();
    save(box, { AIAND_TEST_ICACLS_FAIL: "1" });
    save(box);
    const creds = JSON.parse(readFileSync(join(box.cfg, "credentials.json"), "utf8"));
    assert.equal(creds.default.owner_only, undefined);
    assert.equal(status(box).storage, "file (owner-only, not encrypted at rest)");
  });

  test("with AIAND_SECRET_STORE_MASTER_KEY the file is encrypted at rest", () => {
    const box = sandbox();
    const masterKey = { AIAND_SECRET_STORE_MASTER_KEY: "ab".repeat(32) };
    save(box, masterKey);
    assert.equal(
      status(box, masterKey).storage,
      "file (encrypted; key held outside the config folder)",
    );
    const failed = sandbox();
    save(failed, { ...masterKey, AIAND_TEST_ICACLS_FAIL: "1" });
    assert.equal(
      status(failed, masterKey).storage,
      "file (encrypted; key held outside the config folder; not owner-only)",
    );
  });

  test("a DPAPI key is labelled DPAPI whatever icacls did", () => {
    const box = sandbox();
    runWin(box, `await config.saveCredential("default", ${JSON.stringify(credential)});`, {
      AIAND_TEST_ICACLS_FAIL: "1",
    });
    assert.equal(status(box, { AIAND_KEY_STORAGE: undefined }).storage, "Windows DPAPI");
  });
});

describe("the store lock", () => {
  // whoami and icacls each take up to 10 s to start on a cold machine; a waiter
  // calls a lock stale long before four of them finish.
  const WATCH = (tool) => `
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
appendFileSync(process.env.AIAND_TEST_LOCK_LOG, JSON.stringify({ tool: "${tool}", locked: existsSync(join(process.env.AIAND_CONFIG_DIR, "secret-store.lock")) }) + "\\n");
${tool === "whoami" ? `process.stdout.write('"me","S-1-5-21-1-2-3-1001"');` : "process.exit(0);"}
`;

  for (const tier of ["file", "dpapi"]) {
    test(`a ${tier}-tier save starts whoami and icacls before it takes the lock`, () => {
      const box = sandbox({ whoami: WATCH("whoami"), icacls: WATCH("icacls") });
      const lockLog = join(box.root, "lock.log");
      writeFileSync(lockLog, "");
      runWin(box, `await secrets.storeSecret("default", ${JSON.stringify(SECRET)});`, {
        AIAND_KEY_STORAGE: tier,
        AIAND_TEST_LOCK_LOG: lockLog,
      });
      const seen = readFileSync(lockLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.ok(
        seen.some((c) => c.tool === "icacls"),
        "the config dir was restricted",
      );
      assert.deepEqual(
        seen.filter((c) => c.locked),
        [],
        "a helper process started while secret-store.lock was held",
      );
    });
  }
});

describe("what a DPAPI read costs", () => {
  test("a key stored and read back in one process starts PowerShell once, not twice", () => {
    const box = sandbox();
    runWin(
      box,
      `await secrets.storeSecret("p", ${JSON.stringify(SECRET)});
       return [await secrets.loadSecret("p", "dpapi"), await secrets.loadSecret("p", "dpapi")];`,
    );
    assert.deepEqual(
      box.calls().map((c) => c.op),
      ["Protect"],
    );
  });

  test("many reads in one process, as an agent session makes them, start PowerShell once", () => {
    const box = sandbox();
    runWin(box, `await config.saveCredential("default", ${JSON.stringify(credential)});`);
    const before = box.calls().length;
    runWin(
      box,
      `for (let i = 0; i < 5; i++) await config.loadCredential("default");
       return await identity.authStatus({ local: true });`,
    );
    assert.equal(box.calls().length - before, 1);
  });

  test("the in-process cache never reaches disk: no file under the config dir holds the key", () => {
    const box = sandbox();
    runWin(
      box,
      `await config.saveCredential("default", ${JSON.stringify(credential)});
       await config.loadCredential("default");`,
    );
    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    for (const file of walk(box.cfg)) {
      const bytes = readFileSync(file);
      assert.ok(!bytes.includes("sk-test-dpapi-value"), `${file} holds the key`);
      // The stub's "ciphertext" is the plaintext behind a 6-byte prefix, so its
      // base64 contains the key's; real DPAPI output does not.
      if (!file.endsWith("secret-store.dpapi.json")) {
        assert.ok(!bytes.includes(SECRET_B64), `${file} holds the encoded key`);
      }
    }
  });

  test("the fallback warning says how to stop trying DPAPI", () => {
    const box = sandbox();
    const saved = runWin(
      box,
      `return await config.saveCredential("default", ${JSON.stringify(credential)});`,
      { AIAND_TEST_PS_MODE: "fail" },
    );
    assert.match(saved.stderr, /AIAND_KEY_STORAGE=file/);
  });
});
