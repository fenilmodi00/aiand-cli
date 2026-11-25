// Preloaded by `npm test` (node --import) in the runner process before any
// test file spawns, so every test file and every CLI subprocess inherits it.
// Keeps a test run off the developer's machine:
// - AIAND_NO_BROWSER=1: device/browser sign-in never launches a real browser.
// - AIAND_CLAUDE_RELOAD_MS=0: `aiand claude off` skips its wait for running sessions.
// - SSH_* cleared: a run from an SSH shell still exercises browser sign-in.
// - Stub `security` / `secret-tool` first on PATH, exiting 1: the keychain
//   probe and the logout sweep (deleteSecret clears every tier) never reach
//   the real login keychain. Tests that exercise the keychain plant their own
//   stub ahead of this one; hermetic PATHs are built with hermeticPath() in
//   test/helpers.mjs, which always includes AIAND_TEST_STUB_BIN.
// - No PowerShell stub: the DPAPI tier spawns powershell.exe by absolute
//   path under SystemRoot and only on win32. Tests drive it with a fake
//   SystemRoot (plantWindowsTools in test/helpers.mjs; on Windows its .exe
//   stubs are copies of the launcher this file compiles, test/win-stub-launcher.mjs);
//   on a real Windows run DPAPI writes only into the test's own AIAND_CONFIG_DIR.
// - CLAUDE_CONFIG_DIR unset: the Claude Code adapter honours it, so a
//   developer's own setting would point tests at their real settings.json.
// - CODEX_HOME unset: the same for the Codex adapter and its profile file.
// - HERMES_HOME unset: the Hermes adapter honours it, so a developer's own
//   setting would point tests at their real ~/.hermes instead of the temp home.
// - PI_CODING_AGENT_DIR / PI_CODING_AGENT_SESSION_DIR unset: the Pi adapter
//   honours them, so a developer's own setting would point tests at their
//   real Pi config and session history.
// - JOUZU_HOME unset: the Jouzu adapter honours it, so a developer's own
//   setting would point tests at their real Jouzu config.
// - PI_CONFIG_DIR / XDG_DATA_HOME unset: the OMP adapter honours them
//   (config-root rename, XDG-migrated session dir), same reason.
// - COPILOT_HOME / COPILOT_PROVIDERS_CONFIG / COPILOT_MODEL /
//   COPILOT_OFFLINE unset: the Copilot CLI and app adapters honour them,
//   so a developer's own setting would point tests at their real ~/.copilot.
// - FORCE_COLOR unset: it overrides NO_COLOR and forces ANSI on non-TTY
//   streams, flipping the color and table assertions.
// - AIAND_HOME pointed at a temp dir (never the developer's real home):
//   local-usage scans ~/.omp and ~/.pi session dirs through it; a real home
//   makes every report-family CLI subprocess take seconds (#155 slowdown).
//   The temp home is removed on exit like the stub dir above.
// - test/net-guard.mjs: fetch to anything but loopback fails like an offline
//   machine. It is imported here for the test file's own process (NODE_OPTIONS
//   is set too late to reach it: `node --test` runs this file inside each test
//   file's process) and put on NODE_OPTIONS for the CLI children it spawns.
// - test/fake-systemroot.mjs on NODE_OPTIONS: lets a child see a fake
//   SystemRoot on Windows, where node cannot start with one.
// - TMPDIR/TMP/TEMP point at one fresh dir per run: logout and the launcher
//   sweep stale session overlays out of os.tmpdir(), and a test run must
//   only ever sweep its own.
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildLauncher } from "./win-stub-launcher.mjs";

if (!process.env.AIAND_TEST_TMPDIR) {
  // On Windows tmpdir() can be an 8.3 short path (C:\Users\ADMINI~1\...) while
  // the CLI reports realpaths in long form, so tests that compare paths
  // would never match; start from the long form.
  const root = process.platform === "win32" ? realpathSync.native(tmpdir()) : tmpdir();
  const scratch = mkdtempSync(join(root, "aiand-test-tmp-"));
  process.env.AIAND_TEST_TMPDIR = scratch;
  process.env.TMPDIR = scratch;
  process.env.TMP = scratch;
  process.env.TEMP = scratch;
  process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
}

if (!process.env.AIAND_TEST_STUB_BIN) {
  const bin = mkdtempSync(join(tmpdir(), "aiand-test-stubs-"));
  // security/secret-tool exit 1 so keychain tiers never reach the real login
  // keychain. pgrep exits 1 and tasklist prints nothing: both are "the app is
  // not running", so no test ever probes the host for a live Copilot app
  // process. Tests that want it running plant a matching stub ahead of this.
  for (const tool of ["security", "secret-tool", "pgrep"]) {
    writeFileSync(join(bin, tool), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bin, tool), 0o755);
  }
  writeFileSync(join(bin, "tasklist"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "tasklist"), 0o755);
  if (process.platform === "win32") {
    // A shebang file named `tasklist` is invisible to spawn on Windows
    // (PATHEXT); mirror them as .cmd so the real tasklist never runs.
    writeFileSync(join(bin, "pgrep.cmd"), "@echo off\r\nexit /b 1\r\n");
    writeFileSync(join(bin, "tasklist.cmd"), "@echo off\r\nexit /b 0\r\n");
    // The launcher plantWindowsTools copies in place of a System32 .exe.
    const launcher = buildLauncher(bin);
    if (launcher) process.env.AIAND_TEST_EXE_LAUNCHER = launcher;
  }
  process.env.AIAND_TEST_STUB_BIN = bin;
  process.env.PATH = process.env.PATH ? `${bin}${delimiter}${process.env.PATH}` : bin;
  process.on("exit", () => rmSync(bin, { recursive: true, force: true }));
}
process.env.AIAND_NO_BROWSER = "1";
// --share never reaches the real clipboard (tests only exercise the save paths).
process.env.AIAND_NO_CLIPBOARD = "1";
process.env.AIAND_CLAUDE_RELOAD_MS = "0";
// AIAND_HOME must not resolve to the real home: local-usage scans the real
// ~/.omp and ~/.pi session dirs through it (951MB here), which makes every
// report-family CLI subprocess take seconds (#155 test-suite slowdown).
let tempHome = null;
if (!process.env.AIAND_HOME) {
  tempHome = join(tmpdir(), `aiand-test-home-${process.pid}`);
  process.env.AIAND_HOME = tempHome;
}
process.on("exit", () => {
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
});
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
delete process.env.HERMES_HOME;
delete process.env.JOUZU_HOME;
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.PI_CODING_AGENT_SESSION_DIR;
delete process.env.PI_CONFIG_DIR;
delete process.env.XDG_DATA_HOME;
delete process.env.COPILOT_HOME;
delete process.env.COPILOT_PROVIDERS_CONFIG;
delete process.env.COPILOT_MODEL;
delete process.env.COPILOT_OFFLINE;
delete process.env.FORCE_COLOR;
for (const name of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]) delete process.env[name];

await import("./net-guard.mjs");

for (const preload of ["net-guard.mjs", "fake-systemroot.mjs"]) {
  const guard = `--import=${pathToFileURL(join(import.meta.dirname, preload)).href}`;
  if (!(process.env.NODE_OPTIONS ?? "").includes(guard)) {
    process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, guard].filter(Boolean).join(" ");
  }
}
