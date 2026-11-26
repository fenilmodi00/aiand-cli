// Real-Windows check of the DPAPI tier and the owner-only ACLs, which the
// unit suite can only drive through stubs. Run on windows-latest after a
// build: node scripts/windows-secrets-smoke.mjs
// - a secret stores in DPAPI and a fresh process reads it back;
// - neither the DPAPI store nor credentials.json holds the plaintext;
// - icacls shows the current user alone on the config dir and the store;
// - with __PSLockdownPolicy=4 (Constrained Language Mode for Windows
//   PowerShell) the secret falls back to the encrypted file and status
//   explains why.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

if (process.platform !== "win32") {
  console.log("windows-secrets-smoke: skipped (not Windows)");
  process.exit(0);
}

const dist = (rel) => pathToFileURL(join(import.meta.dirname, "..", "dist", rel)).href;
const system32 = join(process.env.SystemRoot || "C:\\Windows", "System32");
const SECRET = `sk-smoke-${Date.now()}`;
const credential = {
  access_token: SECRET,
  origin: "paste",
  user: { id: "u", email: "smoke@example.com" },
  org: { id: "o", name: "Smoke" },
};

function child(cfg, body, env = {}) {
  const script = `
    const config = await import(${JSON.stringify(dist("config.js"))});
    const identity = await import(${JSON.stringify(dist("auth/identity.js"))});
    process.stdout.write(JSON.stringify(await (async () => { ${body} })()));
  `;
  // AIAND_DEBUG makes a failed owner-only restriction say why on stderr.
  const childEnv = {
    ...process.env,
    AIAND_CONFIG_DIR: cfg,
    AIAND_DEBUG: "1",
    ...env,
  };
  delete childEnv.AIAND_KEY_STORAGE;
  delete childEnv.AIAND_API_KEY;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      env: childEnv,
      encoding: "utf8",
    }),
  );
}

const icacls = (path) => execFileSync(join(system32, "icacls.exe"), [path], { encoding: "utf8" });

function aclPrincipals(path) {
  return icacls(path)
    .split(/\r?\n/)
    .map((line) => line.replace(path, "").trim())
    .filter((line) => line.includes(":("))
    .map((line) => line.slice(0, line.indexOf(":(")));
}

const me = execFileSync(join(system32, "whoami.exe"), { encoding: "utf8" }).trim().toLowerCase();
const root = mkdtempSync(join(tmpdir(), "aiand-win-smoke-"));
try {
  const cfg = join(root, "cfg");
  assert.equal(
    child(cfg, `return await config.saveCredential("default", ${JSON.stringify(credential)});`),
    "dpapi",
  );
  assert.equal(child(cfg, `return (await config.loadCredential("default")).access_token;`), SECRET);
  for (const file of ["secret-store.dpapi.json", "credentials.json"]) {
    assert.ok(!readFileSync(join(cfg, file), "utf8").includes(SECRET), `${file} holds plaintext`);
  }
  for (const path of [cfg, join(cfg, "secret-store.dpapi.json"), join(cfg, "credentials.json")]) {
    const principals = aclPrincipals(path).map((p) => p.toLowerCase());
    assert.deepEqual(principals, [me], `${path} ACL: ${principals.join(", ")}\n${icacls(path)}`);
  }
  const status = child(cfg, "return await identity.authStatus({ local: true });");
  assert.equal(status.storage, "Windows DPAPI");

  const lockdown = { __PSLockdownPolicy: "4" };
  // Windows PowerShell reads __PSLockdownPolicy from the machine environment
  // on some builds (Server 2022, 5.1.20348), so a process-level value leaves
  // it in Full Language mode. The leg asserts the fallback only where the
  // variable took effect; elsewhere the unit suite's exit-3 stub owns the
  // contract and a manual `setx /M __PSLockdownPolicy 4` run
  // (docs/windows-key-storage.md) covers the real thing.
  const mode = execFileSync(
    join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", "$ExecutionContext.SessionState.LanguageMode"],
    { env: { ...process.env, ...lockdown }, encoding: "utf8" },
  ).trim();
  if (mode === "ConstrainedLanguage") {
    const clm = join(root, "clm");
    assert.equal(
      child(
        clm,
        `return await config.saveCredential("default", ${JSON.stringify(credential)});`,
        lockdown,
      ),
      "file",
    );
    const clmStatus = child(clm, "return await identity.authStatus({ local: true });", lockdown);
    assert.equal(clmStatus.storage, "file (owner-only, not encrypted at rest)");
    assert.equal(clmStatus.storage_tier, "file");
    assert.match(clmStatus.storage_notice, /Constrained Language Mode/);
  } else {
    console.log(
      `windows-secrets-smoke: Constrained Language Mode leg skipped: a process-level __PSLockdownPolicy left PowerShell in ${mode}`,
    );
  }
  console.log("windows-secrets-smoke: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
