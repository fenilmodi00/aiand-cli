import { writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync, rmSync, mkdtempSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, "dist", "index.js");

// Offline catalog so this script does not need the live gateway.
function writeOfflineCatalog(cfgDir) {
  writeFileSync(
    join(cfgDir, "model-catalog.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      baseUrl: "https://api.aiand.com",
      models: [
        {
          id: "zai-org/glm-5.3",
          name: "GLM 5.3",
          object: "model",
          created: 1,
          owned_by: "zai-org",
          provider: "zai-org",
          context_window: 200000,
          capabilities: ["text", "vision", "tool_calling"],
          reasoning_efforts: null,
          reasoning_effort_default: null,
          description: null,
          currency: "usd",
          input_per_1m: "0.60",
          output_per_1m: "2.40",
          cached_input_per_1m: "0.10",
        },
      ],
    })
  );
}

// Offline api.json map so opencode `on` never fetches the live gateway.
function writeOfflineApiMap(cfgDir) {
  writeFileSync(
    join(cfgDir, "opencode-api.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      baseUrl: "https://api.aiand.com",
      models: {
        "zai-org/glm-5.3": {
          id: "zai-org/glm-5.3",
          name: "GLM 5.3",
          attachment: false,
          reasoning: true,
          temperature: true,
          tool_call: true,
          cost: { input: 1, output: 4, cache_read: 0.3 },
          limit: { context: 200000, output: 32000 },
          modalities: { input: ["text"], output: ["text"] },
        },
      },
    })
  );
}

// Isolated sandbox: tmp dirs, offline catalog + api map, a stub opencode
// binary, and CLI helpers. No network, no live gateway.
function tmpEnv() {
  const S = mkdtempSync(join(tmpdir(), "aiand-e2e-"));
  const home = join(S, "home");
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  const cfg = join(S, "cfg");
  mkdirSync(cfg, { recursive: true });
  const bin = join(S, "bin");
  mkdirSync(bin, { recursive: true });
  writeOfflineCatalog(cfg);
  writeOfflineApiMap(cfg);

  // Stub opencode binary: detection + session launch target.
  const stub = join(bin, "opencode");
  writeFileSync(
    stub,
    '#!/bin/sh\nenv > "$AIAND_CAPTURE.env"\nprintf \'%s\\n\' "$@" > "$AIAND_CAPTURE.args"\nexit 42\n'
  );
  chmodSync(stub, 0o755);

  if (process.platform === "win32") {
    // spawn looks up PATHEXT, so a shebang file named `opencode` is invisible.
    const stubJs = join(bin, "opencode-stub.cjs");
    writeFileSync(
      stubJs,
      [
        "const fs = require('fs');",
        "const c = process.env.AIAND_CAPTURE;",
        "fs.writeFileSync(c + '.env', Object.entries(process.env).map(([k, v]) => k + '=' + v).join('\\n'));",
        "fs.writeFileSync(c + '.args', process.argv.slice(2).join('\\n') + '\\n');",
        "process.exit(42);",
        "",
      ].join("\n")
    );
    writeFileSync(
      join(bin, "opencode.cmd"),
      `@echo off\r\n"${process.execPath}" "${stubJs}" %*\r\n`
    );
  }

  // Seed an original opencode.json with unrelated keys the adapter must keep.
  const configPath = join(home, ".config", "opencode", "opencode.json");
  writeFileSync(configPath, JSON.stringify({ theme: "dark" }, null, 2) + "\n");
  const BEFORE = readFileSync(configPath);

  const env = {
    ...process.env,
    AIAND_HOME: home,
    AIAND_CONFIG_DIR: cfg,
    AIAND_API_KEY: "sk-e2e-test-key-0000000000000000000000",
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
  };

  return { S, cfg, bin, home, configPath, BEFORE, env };
}

const { S, cfg, bin, home, configPath, BEFORE, env } = tmpEnv();

try {

function cli(args) {
  // All call sites pass space-separated flags with no quoted values.
  return execFileSync(process.execPath, [DIST, ...args.split(" ")], { env, encoding: "utf8" });
}

function cliOrNull(args) {
  try {
    return { ok: true, out: execFileSync(process.execPath, [DIST, ...args.split(" ")], { env, encoding: "utf8" }), err: "" };
  } catch (error) {
    return { ok: false, out: "", err: String(error.stderr ?? error.message ?? "") };
  }
}

const results = [];
function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) process.exitCode = 1;
}

// --- opencode on/off/status -------------------------------------------------
const on = JSON.parse(cli("opencode on --json"));
check("opencode on succeeds", on.state === "on" && on.agent === "opencode", JSON.stringify(on));

const st = JSON.parse(cli("opencode status --json"));
check("status: state on", st.state === "on", JSON.stringify(st));
check("status: model reported", st.model !== null, String(st.model));

const wired = JSON.parse(readFileSync(configPath, "utf8"));
check("on keeps unrelated keys", wired.theme === "dark", JSON.stringify(Object.keys(wired)));
check(
  "on routes provider.aiand at the gateway",
  wired.provider?.aiand?.options?.baseURL === "https://api.aiand.com/v1",
  String(wired.provider?.aiand?.options?.baseURL)
);
check(
  "on bakes the session key",
  wired.provider?.aiand?.options?.apiKey === "sk-e2e-test-key-0000000000000000000000"
);

cli("opencode off --json");
const AFTER_OFF = readFileSync(configPath);
check(
  "off restores opencode.json byte-identical when untouched",
  BEFORE.equals(AFTER_OFF),
  `before=${BEFORE.length}B after=${AFTER_OFF.length}B`
);
check(
  "snapshot kept after off",
  existsSync(join(S, "cfg", "backups", "opencode", "latest.json"))
);

const st2 = JSON.parse(cli("opencode status --json"));
check("status: off after teardown", st2.state === "off", JSON.stringify(st2));

// Surgical edit path: rewire, confirm a second `on` keeps the first snapshot.
cli("opencode on --json");
const wiredAgain = JSON.parse(readFileSync(configPath, "utf8"));
check("re-on rewires", wiredAgain.provider?.aiand?.options?.apiKey?.length > 0);
cli("opencode off --json");
check(
  "second off is byte-identical too",
  BEFORE.equals(readFileSync(configPath)),
  "surgical off is repeatable"
);

// Subtractive path: user edits the file while on; off must keep the edit.
cli("opencode on --json");
const edited = JSON.parse(readFileSync(configPath, "utf8"));
edited.autoupdate = true;
writeFileSync(configPath, JSON.stringify(edited, null, 2) + "\n");
cli("opencode off --json");
const afterEditOff = JSON.parse(readFileSync(configPath, "utf8"));
check(
  "off after a user edit keeps the edit and drops our keys",
  afterEditOff.autoupdate === true && afterEditOff.provider?.aiand === undefined && afterEditOff["x-aiand"] === undefined,
  JSON.stringify(Object.keys(afterEditOff))
);

// Break-glass restore refuses without --force, restores with it.
const refused = cliOrNull("restore opencode");
check("restore without --force fails", refused.ok === false, refused.err.split("\n")[0]);
cli("opencode on --json");
cli("restore opencode --force");
check(
  "restore --force puts the first pre-wiring bytes back",
  BEFORE.equals(readFileSync(configPath)),
  "break-glass snapshot restore"
);

// --- credential storage -----------------------------------------------------
const keyOut = cli("key export").trim();
check(
  "key export prints the env session key",
  keyOut === "sk-e2e-test-key-0000000000000000000000",
  keyOut.slice(0, 12)
);

// --- run-agent launcher path (offline: stub binary, cached catalog) ---------
const capture = join(S, "capture");
const launchEnv = { ...env, AIAND_CAPTURE: capture };
let launchCode = 42;
try {
  execFileSync(process.execPath, [DIST, "run-agent", "opencode", "--", "--version"], { env: launchEnv, encoding: "utf8" });
  launchCode = 0;
} catch (error) {
  launchCode = error.status ?? 42;
}
check("run-agent opencode exits with the child code", launchCode === 42, `code=${launchCode}`);
const childEnv = readFileSync(`${capture}.env`, "utf8");
const configLine = childEnv.split("\n").find((line) => line.startsWith("OPENCODE_CONFIG_CONTENT="));
check("run-agent injects OPENCODE_CONFIG_CONTENT", Boolean(configLine), configLine?.slice(0, 60) ?? "missing");
if (configLine) {
  const launched = JSON.parse(configLine.slice("OPENCODE_CONFIG_CONTENT=".length));
  check("launched config carries provider.aiand", Boolean(launched.provider?.aiand));
  check(
    "launched config references the key via {file:} substitution, not the env",
    /^\{file:.+\}$/.test(launched.provider?.aiand?.options?.apiKey ?? "")
  );
}

// --- registry: exactly opencode ---------------------------------------------
const { AGENTS } = await import(join(ROOT, "dist", "agents", "registry.js"));
const agentIds = AGENTS.map((row) => row.id).sort();
check(
  "registry ships exactly opencode",
  JSON.stringify(agentIds) === JSON.stringify(["opencode"]),
  JSON.stringify(agentIds)
);

// --- uninstall (offline: fake launcher + fake checkout) ---------------------
if (process.platform !== "win32") {
// Rewire one agent, then run the real `install.sh uninstall` against the
// sandbox HOME. The fake launcher delegates to this dist so `init --off`
// exercises the real restore path; the fake checkout stands in for
// ~/.aiand/cli. Asserts: agents restored byte-identical, launcher gone,
// checkout gone, config dir still present.
// Baseline for this section: whatever the config holds now (the subtractive
// test above legitimately leaves a user edit in the file, so the invariant
// is "back to this state", not the original seed).
const UNINSTALL_BEFORE = readFileSync(configPath);
cli("opencode on --json");
const fakeCheckout = join(home, ".aiand", "cli");
mkdirSync(fakeCheckout, { recursive: true });
writeFileSync(join(fakeCheckout, "package.json"), JSON.stringify({ name: "@aiand/cli" }, null, 2));
const launcherDir = join(home, ".local", "bin");
mkdirSync(launcherDir, { recursive: true });
const fakeLauncher = join(launcherDir, "aiand");
writeFileSync(fakeLauncher, `#!/bin/sh\nexec "${process.execPath}" "${DIST}" "$@"\n`);
chmodSync(fakeLauncher, 0o755);
const aiandConfigDir = join(home, ".config", "aiand");
mkdirSync(aiandConfigDir, { recursive: true });
writeFileSync(join(aiandConfigDir, "sentinel"), "keep");
let uninstallOk = true;
let uninstallDetail = "";
try {
  uninstallDetail = execFileSync("bash", [join(ROOT, "install.sh"), "uninstall"], {
    // Scrub the installer's own knobs: an AIAND_DIR exported in the dev
    // shell would become the rm -rf target inside the sandboxed uninstall.
    env: {
      ...env,
      HOME: home,
      AIAND_DIR: undefined,
      AIAND_UNINSTALL_FORCE: undefined,
      AIAND_SOURCE: undefined,
    },
    encoding: "utf8",
  }).trim().split("\n").pop() ?? "";
} catch (error) {
  uninstallOk = false;
  uninstallDetail = String(error.message ?? error).split("\n")[0];
}
check("uninstall exits zero", uninstallOk, uninstallDetail);
check(
  "uninstall restores opencode.json byte-identical",
  UNINSTALL_BEFORE.equals(readFileSync(configPath)),
  `before=${UNINSTALL_BEFORE.length}B after=${readFileSync(configPath).length}B`
);
check("uninstall removes the launcher", !existsSync(fakeLauncher), fakeLauncher);
check("uninstall removes the checkout", !existsSync(fakeCheckout), fakeCheckout);
check(
  "uninstall keeps profiles/credentials/snapshots",
  existsSync(join(aiandConfigDir, "sentinel")) && existsSync(cfg),
  aiandConfigDir
);

const decoy = join(home, "Documents");
mkdirSync(decoy, { recursive: true });
writeFileSync(join(decoy, "keep.txt"), "keep");
writeFileSync(fakeLauncher, `#!/bin/sh\nexec "${process.execPath}" "${DIST}" "$@"\n`);
chmodSync(fakeLauncher, 0o755);
let decoyRefused = false;
let decoyDetail = "";
try {
  execFileSync("bash", [join(ROOT, "install.sh"), "uninstall", "--force"], {
    env: {
      ...env,
      HOME: home,
      AIAND_DIR: decoy,
      AIAND_UNINSTALL_FORCE: undefined,
      AIAND_SOURCE: undefined,
    },
    encoding: "utf8",
  });
} catch (error) {
  decoyDetail = String(error.stderr ?? error.message ?? error);
  decoyRefused = decoyDetail.includes("not an aiand checkout");
}
check("uninstall refuses a non-checkout AIAND_DIR", decoyRefused, decoyDetail.split("\n")[0]);
check("uninstall left the non-checkout directory", existsSync(join(decoy, "keep.txt")), decoy);
check("uninstall left the launcher after refused decoy", existsSync(fakeLauncher), fakeLauncher);

const nestedDecoy = join(home, "NestedDecoy");
mkdirSync(nestedDecoy, { recursive: true });
writeFileSync(join(nestedDecoy, "keep.txt"), "keep");
writeFileSync(
  join(nestedDecoy, "package.json"),
  JSON.stringify({ name: "other", metadata: { name: "@aiand/cli" } }, null, 2)
);
let nestedRefused = false;
let nestedDetail = "";
try {
  execFileSync("bash", [join(ROOT, "install.sh"), "uninstall", "--force"], {
    env: {
      ...env,
      HOME: home,
      AIAND_DIR: nestedDecoy,
      AIAND_UNINSTALL_FORCE: undefined,
      AIAND_SOURCE: undefined,
    },
    encoding: "utf8",
  });
} catch (error) {
  nestedDetail = String(error.stderr ?? error.message ?? error);
  nestedRefused = nestedDetail.includes("not an aiand checkout");
}
check(
  "uninstall refuses nested-name decoy package.json",
  nestedRefused,
  nestedDetail.split("\n")[0]
);
check(
  "uninstall left the nested-name decoy directory",
  existsSync(join(nestedDecoy, "keep.txt")),
  nestedDecoy
);
check(
  "uninstall left the launcher after nested-name decoy",
  existsSync(fakeLauncher),
  fakeLauncher
);

// Hand-cloned checkout: a valid @aiand/cli package.json at a custom AIAND_DIR
// but no installer ownership marker — package-name identity alone must never
// authorize rm -rf on a directory the installer did not clone.
const handCloned = join(home, "src", "aiand-cli");
mkdirSync(handCloned, { recursive: true });
writeFileSync(join(handCloned, "keep.txt"), "keep");
writeFileSync(join(handCloned, "package.json"), JSON.stringify({ name: "@aiand/cli" }, null, 2));
writeFileSync(fakeLauncher, `#!/bin/sh\nexec "${process.execPath}" "${DIST}" "$@"\n`);
chmodSync(fakeLauncher, 0o755);
let handClonedRefused = false;
let handClonedDetail = "";
try {
  execFileSync("bash", [join(ROOT, "install.sh"), "uninstall", "--force"], {
    env: {
      ...env,
      HOME: home,
      AIAND_DIR: handCloned,
      AIAND_UNINSTALL_FORCE: undefined,
      AIAND_SOURCE: undefined,
    },
    encoding: "utf8",
  });
} catch (error) {
  handClonedDetail = String(error.stderr ?? error.message ?? error);
  handClonedRefused = handClonedDetail.includes("not an installer-owned checkout");
}
check(
  "uninstall refuses a hand-cloned @aiand/cli checkout without the ownership marker",
  handClonedRefused,
  handClonedDetail.split("\n")[0]
);
check("uninstall left the hand-cloned directory", existsSync(join(handCloned, "keep.txt")), handCloned);
check("uninstall left the launcher after refused hand-clone", existsSync(fakeLauncher), fakeLauncher);

// Identity must not require `node` on PATH: the launcher bakes an absolute
// Node path, so uninstall --force of a valid owned checkout still works
// after nvm/fnm has dropped node from PATH.
const noNodeCheckout = join(home, ".aiand", "cli");
mkdirSync(noNodeCheckout, { recursive: true });
writeFileSync(join(noNodeCheckout, "package.json"), JSON.stringify({ name: "@aiand/cli" }, null, 2));
writeFileSync(join(noNodeCheckout, ".aiand-installer-owned"), "aiand-cli installer ownership marker\n");
const slimBin = join(S, "no-node-bin");
mkdirSync(slimBin, { recursive: true });
const linkTool = (name) => {
  try {
    const src = execFileSync("/bin/bash", ["-lc", `command -v ${name}`], { encoding: "utf8" }).trim();
    if (src && existsSync(src) && name !== "node") {
      try { symlinkSync(src, join(slimBin, name)); } catch { /* already linked */ }
    }
  } catch { /* tool absent on this host */ }
};
for (const name of ["bash", "rm", "rmdir", "dirname", "basename", "pwd"]) linkTool(name);
let noNodeOk = true;
let noNodeDetail = "";
try {
  noNodeDetail = execFileSync("bash", [join(ROOT, "install.sh"), "uninstall", "--force"], {
    env: {
      ...env,
      HOME: home,
      PATH: slimBin,
      AIAND_DIR: undefined,
      AIAND_UNINSTALL_FORCE: undefined,
      AIAND_SOURCE: undefined,
    },
    encoding: "utf8",
  }).trim().split("\n").pop() ?? "";
} catch (error) {
  noNodeOk = false;
  noNodeDetail = String(error.stderr ?? error.message ?? error);
}
check("uninstall --force works when node is not on PATH", noNodeOk, noNodeDetail.split("\n")[0]);
check("uninstall without node removed the checkout", !existsSync(noNodeCheckout), noNodeCheckout);

// Local-checkout installs never create ~/.aiand/cli (the launcher points at
// the repo), so uninstall must still remove the launcher when the checkout
// is missing instead of refusing with an outside-HOME error. Regression:
// the canonicalization fallback used to read back the already-clobbered
// $checkout (""), resolving "." and tripping the guard.
writeFileSync(fakeLauncher, `#!/bin/sh\nexec "${process.execPath}" "${DIST}" "$@"\n`);
chmodSync(fakeLauncher, 0o755);
let missingCheckoutOk = true;
let missingCheckoutDetail = "";
try {
  missingCheckoutDetail = execFileSync("bash", [join(ROOT, "install.sh"), "uninstall", "--force"], {
    env: {
      ...env,
      HOME: home,
      AIAND_DIR: undefined,
      AIAND_UNINSTALL_FORCE: undefined,
      AIAND_SOURCE: undefined,
    },
    encoding: "utf8",
  }).trim().split("\n").pop() ?? "";
} catch (error) {
  missingCheckoutOk = false;
  missingCheckoutDetail = String(error.stderr ?? error.message ?? error).split("\n")[0];
}
check(
  "uninstall removes the launcher when the checkout is missing",
  missingCheckoutOk && !existsSync(fakeLauncher),
  missingCheckoutDetail
);

} // posix install.sh uninstall coverage (win32: install.ps1 block below)

// --- install.ps1 uninstall (Windows only; skipped on Linux CI) ---------------
// Fake owned checkout plus aiand.cmd. Off-failure must abort without deleting;
// a non-checkout AIAND_DIR and a hand-cloned checkout without the ownership
// marker must refuse; --force then removes the .cmd launcher and the checkout.
if (process.platform === "win32") {
  const launcherDir = join(home, ".local", "bin");
  mkdirSync(launcherDir, { recursive: true });
  const winCheckout = join(home, ".aiand", "cli");
  mkdirSync(winCheckout, { recursive: true });
  writeFileSync(join(winCheckout, "package.json"), JSON.stringify({ name: "@aiand/cli" }, null, 2));
  writeFileSync(join(winCheckout, ".aiand-installer-owned"), "aiand-cli installer ownership marker\n");
  const winCmd = join(launcherDir, "aiand.cmd");
  writeFileSync(winCmd, "@echo off\r\nexit /b 7\r\n");
  const aiandConfigDir = join(home, ".config", "aiand");
  mkdirSync(aiandConfigDir, { recursive: true });
  writeFileSync(join(aiandConfigDir, "sentinel"), "keep");
  const winEnv = {
    ...env,
    HOME: home,
    USERPROFILE: home,
    AIAND_DIR: undefined,
    AIAND_UNINSTALL_FORCE: undefined,
    AIAND_SOURCE: undefined,
  };
  const runPs1 = (args, extraEnv = {}) => {
    try {
      const out = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "install.ps1"), ...args],
        { env: { ...winEnv, ...extraEnv }, encoding: "utf8" }
      );
      return { ok: true, out, err: "" };
    } catch (error) {
      return { ok: false, out: "", err: String(error.stderr ?? error.message ?? error) };
    }
  };

  const abort = runPs1(["uninstall"]);
  check(
    "install.ps1 uninstall aborts when off fails",
    abort.ok === false && existsSync(winCheckout) && existsSync(winCmd),
    abort.err.split("\n")[0]
  );

  const decoy = join(home, "Documents");
  mkdirSync(decoy, { recursive: true });
  writeFileSync(join(decoy, "keep.txt"), "keep");
  const decoyRun = runPs1(["uninstall", "--force"], { AIAND_DIR: decoy });
  check(
    "install.ps1 uninstall refuses a non-checkout AIAND_DIR",
    decoyRun.ok === false && decoyRun.err.includes("not an aiand checkout"),
    decoyRun.err.split("\n")[0]
  );
  check("install.ps1 uninstall left the non-checkout directory", existsSync(join(decoy, "keep.txt")), decoy);
  check("install.ps1 uninstall left the launcher after refused decoy", existsSync(winCmd), winCmd);

  const handCloned = join(home, "src", "aiand-cli");
  mkdirSync(handCloned, { recursive: true });
  writeFileSync(join(handCloned, "keep.txt"), "keep");
  writeFileSync(join(handCloned, "package.json"), JSON.stringify({ name: "@aiand/cli" }, null, 2));
  const handRun = runPs1(["uninstall", "--force"], { AIAND_DIR: handCloned });
  check(
    "install.ps1 uninstall refuses a hand-cloned checkout without the ownership marker",
    handRun.ok === false && handRun.err.includes("not an installer-owned checkout"),
    handRun.err.split("\n")[0]
  );
  check("install.ps1 uninstall left the hand-cloned directory", existsSync(join(handCloned, "keep.txt")), handCloned);

  const outside = join(S, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "keep.txt"), "keep");
  const outsideRun = runPs1(["uninstall", "--force"], { AIAND_DIR: outside });
  check(
    "install.ps1 uninstall refuses a checkout outside HOME",
    outsideRun.ok === false && outsideRun.err.includes("outside"),
    outsideRun.err.split("\n")[0]
  );
  check("install.ps1 uninstall left the outside-HOME directory", existsSync(join(outside, "keep.txt")), outside);
  check("install.ps1 uninstall left the owned checkout after refuses", existsSync(winCheckout), winCheckout);

  const forced = runPs1(["uninstall", "--force"]);
  check("install.ps1 uninstall --force exits zero", forced.ok, (forced.err || forced.out).trim().split("\n").pop() ?? "");
  check("install.ps1 uninstall removes aiand.cmd", !existsSync(winCmd), winCmd);
  check("install.ps1 uninstall removes the checkout", !existsSync(winCheckout), winCheckout);
  check(
    "install.ps1 uninstall keeps profiles/credentials/snapshots",
    existsSync(join(aiandConfigDir, "sentinel")),
    aiandConfigDir
  );
}

console.log(results.join("\n"));
console.log(results.every((r) => r.startsWith("PASS")) ? "E2E: ALL PASS" : "E2E: FAILURES PRESENT");
} finally {
  rmSync(S, { recursive: true, force: true });
}
