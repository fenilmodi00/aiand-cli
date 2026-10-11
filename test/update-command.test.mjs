import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { cliEnv, withTestEnv } from "./helpers.mjs";

const { detectInstallKind } = await import("../dist/housekeeping/update.js");
const { VERSION } = await import("../dist/api/client.js");

// The command runs in a child so the registry fetch can be stubbed
// (a child's globalThis.fetch cannot be patched from here) and so argv[1]
// can name the install that "launched" it. Nothing reaches the network.
const RUN_UPDATE = fileURLToPath(new URL("../dist/commands/update.js", import.meta.url));
const registryStub = (version) =>
  `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify({ version }))}, ` +
  `{ status: 200, headers: { "Content-Type": "application/json" } });`;

withTestEnv("aiand-update-cmd-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  mkdirSync(process.env.AIAND_HOME, { recursive: true });
  mkdirSync(process.env.AIAND_CONFIG_DIR, { recursive: true });
});

/** A version string safely above the local one (same part count). */
const newerVersion = (version) => {
  const [major, minor, patch] = version.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
};

/** A real file, so detectInstallKind's realpath() resolves instead of throwing. */
const realFile = (path) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "");
  return path;
};

/**
 * `aiand update <args>` in a child whose registry answers `version` and
 * whose launched entry point is `entry` (a plain source checkout when the
 * entry lives outside every install prefix). Resolves the child's exit code
 * plus `ERR:<message>` on stderr when the command threw.
 */
async function runUpdate(args, { entry, version = VERSION }) {
  const script = `${registryStub(version)}
const { run } = await import(${JSON.stringify(pathToFileURL(RUN_UPDATE).href)});
try {
  await run(${JSON.stringify(args)});
} catch (error) {
  process.stderr.write("ERR:" + (error?.message ?? String(error)) + "\\n");
  for (const line of (error?.hint ?? "").split("\\n")) {
    process.stderr.write("HINT:" + line + "\\n");
  }
  process.exit(error?.exitCode ?? 1);
}
process.exit(process.exitCode ?? 0);
`;
  let result;
  try {
    result = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", script, entry],
      { env: cliEnv({ AIAND_DIR: undefined }) },
    );
  } catch (error) {
    // promisify rejects a nonzero exit; the child already printed the reason.
    const failed = error;
    result = { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
  return {
    code: result.code ?? 0,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.stderr.match(/^ERR:(.*)$/m)?.[1],
    hint: result.stderr
      .split("\n")
      .filter((line) => line.startsWith("HINT:"))
      .join(" "),
  };
}

describe("detectInstallKind", () => {
  const previousArgv = process.argv[1];
  test.afterEach(() => {
    process.argv[1] = previousArgv;
  });

  test("an npm global prefix is npm", () => {
    process.argv[1] = realFile(
      join(mkdtempSync(join(tmpdir(), "aiand-npm-")), "lib/node_modules/@aiand/cli/dist/index.js"),
    );
    assert.equal(detectInstallKind().kind, "npm");
  });

  test("the launcher checkout is installer, with the install.sh root", () => {
    const root = mkdtempSync(join(tmpdir(), "aiand-inst-"));
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "@aiand/cli" })}\n`);
    process.argv[1] = realFile(join(root, "dist", "index.js"));
    const previousAiandDir = process.env.AIAND_DIR;
    process.env.AIAND_DIR = root;
    try {
      assert.deepEqual(detectInstallKind(), { kind: "installer", root });
    } finally {
      if (previousAiandDir === undefined) delete process.env.AIAND_DIR;
      else process.env.AIAND_DIR = previousAiandDir;
    }
  });

  test("anything else is a source checkout", () => {
    const outside = realFile(join(mkdtempSync(join(tmpdir(), "aiand-src-")), "dist/index.js"));
    process.argv[1] = outside;
    assert.equal(detectInstallKind().kind, "source");
  });
});

describe("aiand update --check", () => {
  test("--check --json prints current/latest/installKind and exits 0 when current", async () => {
    const entry = realFile(join(mkdtempSync(join(tmpdir(), "aiand-src-")), "dist/index.js"));
    const { code, stdout } = await runUpdate(["--check", "--json"], { entry });
    assert.equal(code, 0);
    const payload = JSON.parse(stdout);
    assert.equal(payload.current, VERSION);
    assert.equal(payload.latest, VERSION);
    assert.equal(payload.installKind, "source");
  });

  test("--check exits 1 with a clear message when a newer version exists", async () => {
    const entry = realFile(join(mkdtempSync(join(tmpdir(), "aiand-src-")), "dist/index.js"));
    const latest = newerVersion(VERSION);
    const { code, stdout } = await runUpdate(["--check"], { entry, version: latest });
    assert.equal(code, 1);
    assert.match(stdout, new RegExp(`v${VERSION}`));
    assert.match(stdout, new RegExp(`v${latest}`));
  });
});

describe("aiand update on a source checkout", () => {
  test("refuses politely with the npm hint and never mutates anything", async () => {
    const entry = realFile(join(mkdtempSync(join(tmpdir(), "aiand-src-")), "dist/index.js"));
    const { code, error, hint } = await runUpdate([], {
      entry,
      version: newerVersion(VERSION),
    });
    // The source checkout is refused before any install child runs: exit
    // 127 (EXIT.NOT_FOUND) with the hand-run npm command, and no installer
    // or npm process was ever spawned.
    assert.equal(code, 127);
    assert.match(error ?? "", /not made by the installer or npm/);
    assert.match(hint ?? "", /source checkout/);
    assert.match(hint ?? "", /npm install -g @aiand\/cli/);
  });
});

describe("aiand update --yes", () => {
  test("--yes is accepted as a flag and reaches the install step", async () => {
    // `--yes` used to be read from the parsed flags but never declared, so
    // parseArgs rejected it with "Unknown option" before any upgrade ran.
    // This test only proves the flag parses and the flow proceeds past the
    // confirmation: the install child itself needs a real npm/install.sh,
    // which the hermetic test env does not provide.
    const entry = realFile(
      join(mkdtempSync(join(tmpdir(), "aiand-npm-")), "lib/node_modules/@aiand/cli/dist/index.js"),
    );
    const { code, stdout, stderr } = await runUpdate(["--yes"], {
      entry,
      version: newerVersion(VERSION),
    });
    assert.doesNotMatch(stderr, /Unknown option/);
    assert.match(stdout, /→/);
    // Past the confirmation: the flow got as far as running the install
    // child, which cannot succeed without a real npm on PATH.
    assert.equal(code, 1);
  });
});

describe("aiand update --help", () => {
  test("documents its flags", async () => {
    const entry = realFile(join(mkdtempSync(join(tmpdir(), "aiand-src-")), "dist/index.js"));
    const { code, stdout } = await runUpdate(["--help"], { entry });
    assert.equal(code, 0);
    assert.match(stdout, /--check/);
    assert.match(stdout, /--yes/);
    assert.match(stdout, /--json/);
  });
});
