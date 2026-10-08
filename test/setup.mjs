// Preloaded by `npm test` (node --import) in the runner process before any
// test file spawns, so every test file and every CLI subprocess inherits it.
// Keeps a test run off the developer's machine:
// - AIAND_NO_BROWSER=1: device/browser sign-in never launches a real browser.
// - Stub `security` / `secret-tool` first on PATH, exiting 1: the keychain
//   probe and the logout sweep (deleteSecret clears every tier) never reach
//   the real login keychain. Tests that exercise the keychain plant their own
//   stub ahead of this one; hermetic PATHs are built with hermeticPath() in
//   test/helpers.mjs, which always includes AIAND_TEST_STUB_BIN.
// - CLAUDE_CONFIG_DIR unset: the Claude Code adapter honours it, so a
//   developer's own setting would point tests at their real settings.json.
// - CODEX_HOME unset: the same for the Codex adapter and its profile file.
// - HERMES_HOME unset: the Hermes adapter honours it, so a developer's own
//   setting would point tests at their real ~/.hermes instead of the temp home.
// - PI_CODING_AGENT_DIR / PI_CODING_AGENT_SESSION_DIR unset: the Pi adapter
//   honours them, so a developer's own setting would point tests at their
//   real Pi config and session history.
// - PI_CONFIG_DIR / XDG_DATA_HOME unset: the OMP adapter honours them
//   (config-root rename, XDG-migrated session dir), same reason.
// - COPILOT_HOME / COPILOT_PROVIDERS_CONFIG / COPILOT_MODEL /
//   COPILOT_OFFLINE unset: the Copilot CLI and app adapters honour them,
//   so a developer's own setting would point tests at their real ~/.copilot.
// - FORCE_COLOR unset: it overrides NO_COLOR and forces ANSI on non-TTY
//   streams, flipping the color and table assertions.
// - test/net-guard.mjs on NODE_OPTIONS: fetch to anything but loopback fails
//   like an offline machine, in test files and CLI children alike.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

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
  }
  process.env.AIAND_TEST_STUB_BIN = bin;
  process.env.PATH = process.env.PATH ? `${bin}${delimiter}${process.env.PATH}` : bin;
  process.on("exit", () => rmSync(bin, { recursive: true, force: true }));
}
process.env.AIAND_NO_BROWSER = "1";
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
delete process.env.HERMES_HOME;
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.PI_CODING_AGENT_SESSION_DIR;
delete process.env.PI_CONFIG_DIR;
delete process.env.XDG_DATA_HOME;
delete process.env.COPILOT_HOME;
delete process.env.COPILOT_PROVIDERS_CONFIG;
delete process.env.COPILOT_MODEL;
delete process.env.COPILOT_OFFLINE;
delete process.env.HERMES_HOME;
delete process.env.FORCE_COLOR;

const guard = `--import=${pathToFileURL(join(import.meta.dirname, "net-guard.mjs")).href}`;
if (!(process.env.NODE_OPTIONS ?? "").includes(guard)) {
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, guard].filter(Boolean).join(" ");
}
