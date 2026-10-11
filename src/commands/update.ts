import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../api/client.js";
import { bool, parse } from "../cli/args.js";
import { CliError, EXIT } from "../cli/errors.js";
import { out, style } from "../cli/output.js";
import { confirm } from "../cli/prompt.js";
import {
  compareVersions,
  detectInstallKind,
  fetchLatestVersion,
  type InstallKind,
  launchedEntry,
  runInstallScript,
} from "../housekeeping/update.js";

/** The package the registry and npm installs are asked for. */
const PACKAGE = "@aiand/cli";

/** One-line hints per install kind, so an upgrade never dead-ends. */
const MANUAL: Record<InstallKind["kind"], string> = {
  installer: "bash ~/.aiand/cli/install.sh",
  npm: `npm install -g ${PACKAGE}`,
  source: `npm install -g ${PACKAGE}`,
};

export const help = `${style.bold("aiand update")} -- update ai& to the latest version

Usage
  aiand update [options]

Options
  --check    report the latest version and exit; 1 when one is available
  --yes      skip the confirmation when an upgrade is found
  --json     machine-readable output
  -h, --help show this help

\`aiand update\` upgrades the install that is running: the installer script
for a launcher install, npm for a global npm install. A source checkout is
never modified by this command.`;

/**
 * Upgrade this install. The check is always a live registry read (never the
 * background cache), and the install child always runs with inherited stdio
 * and without AIAND_API_KEY, so an installer never inherits the session key.
 */
export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    check: { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);
  const checkOnly = bool(parsed, "check");
  const json = bool(parsed, "json");

  const install = detectInstallKind();
  const latest = await fetchLatestVersion().catch((cause: Error) => {
    throw new CliError(`Could not reach the npm registry: ${cause.message}`, {
      hint: `Check your connection, or update by hand:\n${MANUAL[install.kind]}`,
    });
  });

  const upToDate = compareVersions(latest, VERSION) <= 0;
  if (json) {
    out(JSON.stringify({ current: VERSION, latest, installKind: install.kind, upToDate }));
  } else if (upToDate) {
    out(`${style.bold("ai&")} ${style.dim(`v${VERSION}`)} is up to date.`);
  } else {
    out(`${style.bold("ai&")} v${VERSION} → ${style.bold(`v${latest}`)}`);
  }

  if (checkOnly || upToDate) {
    // --check exits 1 exactly when work is available, so a wrapper can gate
    // on it; the terminal path prints why an upgrade is not possible.
    process.exitCode = upToDate ? 0 : 1;
    return;
  }

  if (install.kind === "source") {
    throw new CliError("This ai& install was not made by the installer or npm.", {
      exitCode: EXIT.NOT_FOUND,
      hint: `It looks like a source checkout, which \`aiand update\` never modifies.\nUpdate it yourself with: ${MANUAL.source}`,
    });
  }

  // --yes is the explicit skip; a non-TTY confirm() returns its default, so
  // `aiand update </dev/null` upgrades rather than hanging on a prompt.
  if (!bool(parsed, "yes")) {
    const answer = await confirm(`Update ai& to v${latest} now?`, { default: true });
    if (!answer) throw new CliError("Cancelled.", { exitCode: EXIT.INTERRUPTED });
  }

  await applyUpdate(install, latest);
}

/** Run the install path for `kind`, then re-verify the running version. */
async function applyUpdate(install: InstallKind, latest: string): Promise<void> {
  const script = install.kind === "installer" ? join(install.root ?? "", "install.sh") : null;
  if (install.kind === "installer" && !existsSync(script as string)) {
    // A launcher checkout with no install.sh (deleted, or a partial copy):
    // fall back to the npm path rather than failing, and say so.
    out(style.dim(`${script} is missing; updating with npm instead.`));
    install = { kind: "npm" };
  }
  const failed = (what: string): CliError =>
    new CliError(`Update failed: ${what}.`, {
      hint: `Run it yourself with: ${MANUAL[install.kind]}`,
    });

  // AIAND_NO_MODIFY_PATH: the installer's job here is a new build, so it
  // must never edit shell rc files the way a first install does.
  const status = await runInstallScript(
    install.kind === "installer" ? "bash" : "npm",
    install.kind === "installer" ? [script as string] : ["install", "-g", `${PACKAGE}@${latest}`],
    { AIAND_NO_MODIFY_PATH: "1" },
  ).catch((cause: Error) => {
    throw failed(cause.message);
  });
  if (status !== 0) throw failed(status === null ? "signal" : `exit ${status}`);

  // Re-verify through the entry point the user actually launched, so a PATH
  // shadow (an older npm prefix, a stale launcher) cannot pass silently.
  const before = VERSION;
  const after = probeVersion();
  if (compareVersions(after, latest) < 0) {
    throw new CliError(`Updated to v${latest}, but ai& still reports v${after}.`, {
      exitCode: EXIT.NOT_FOUND,
      hint: `Another ai& is shadowing this one on PATH.\nRun it yourself with: ${MANUAL[install.kind]}`,
    });
  }
  out(
    `${style.bold("ai&")} ${before === after ? "" : `v${before} → `}v${after} ${style.dim("(up to date)")}`,
  );
}

/**
 * The version of the install the user actually launched, read from the
 * package.json beside the running entry: a PATH shadow (an older npm prefix,
 * a stale launcher) cannot pass the re-verify below.
 */
function probeVersion(): string {
  const entry = launchedEntry();
  let source: string;
  try {
    source = readFileSync(join(entry, "..", "..", "package.json"), "utf8");
  } catch {
    // A dev checkout with no package.json beside the entry: fall back to the
    // version this process was built with rather than reporting a regression.
    return VERSION;
  }
  const parsed = JSON.parse(source) as { version?: string };
  return typeof parsed.version === "string" ? parsed.version : VERSION;
}
