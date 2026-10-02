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
  for (const tool of ["security", "secret-tool"]) {
    writeFileSync(join(bin, tool), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bin, tool), 0o755);
  }
  process.env.AIAND_TEST_STUB_BIN = bin;
  process.env.PATH = process.env.PATH ? `${bin}${delimiter}${process.env.PATH}` : bin;
  process.on("exit", () => rmSync(bin, { recursive: true, force: true }));
}
process.env.AIAND_NO_BROWSER = "1";
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.PI_CODING_AGENT_SESSION_DIR;
delete process.env.PI_CONFIG_DIR;
delete process.env.XDG_DATA_HOME;
delete process.env.COPILOT_HOME;
delete process.env.COPILOT_PROVIDERS_CONFIG;
delete process.env.COPILOT_MODEL;
delete process.env.COPILOT_OFFLINE;
delete process.env.FORCE_COLOR;

const guard = `--import=${pathToFileURL(join(import.meta.dirname, "net-guard.mjs")).href}`;
if (!(process.env.NODE_OPTIONS ?? "").includes(guard)) {
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, guard].filter(Boolean).join(" ");
}
