import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const spawnEnv = await import("../dist/cli/spawn-env.js");
const { NO_CWD_EXE_VAR, childEnv, protectProcessEnv, withNoCwdExeSearch } = spawnEnv;

// The end-to-end proof for Windows is scripts/e2e.mjs on windows-latest, which
// runs a real npm-style shim from a repo holding a planted node.cmd.

test("Windows children get the switch that keeps the current directory out of program lookups", () => {
  assert.equal(NO_CWD_EXE_VAR, "NoDefaultCurrentDirectoryInExePath");
  assert.equal(childEnv({ PATH: "C:\\bin" }, "win32")[NO_CWD_EXE_VAR], "1");
});

test("the switch overrides a caller's value, whatever the case of the name", () => {
  const env = withNoCwdExeSearch(
    { nodefaultcurrentdirectoryinexepath: "0", NoDefaultCurrentDirectoryInExePath: "" },
    "win32",
  );
  assert.deepEqual(Object.entries(env), [[NO_CWD_EXE_VAR, "1"]]);
});

test("other platforms get their environment back untouched", () => {
  const env = { PATH: "/usr/bin" };
  assert.equal(childEnv(env, "linux"), env);
  assert.equal(childEnv(env, "darwin")[NO_CWD_EXE_VAR], undefined);
});

test("childEnv does not mutate the environment it was given", () => {
  const env = { PATH: "C:\\bin" };
  childEnv(env, "win32");
  assert.deepEqual(env, { PATH: "C:\\bin" });
});

test("protectProcessEnv sets the switch on this process on Windows only", () => {
  const win = {};
  protectProcessEnv(win, "win32");
  assert.equal(win[NO_CWD_EXE_VAR], "1");
  const posix = {};
  protectProcessEnv(posix, "linux");
  assert.deepEqual(posix, {});
});

const { absolutePathOnly, systemToolEnv } = spawnEnv;

test("a POSIX PATH keeps only its absolute entries", () => {
  assert.equal(
    absolutePathOnly(":.:bin:./bin:../x:/usr/bin::/opt/aiand/bin:", "linux"),
    "/usr/bin:/opt/aiand/bin",
  );
  assert.equal(absolutePathOnly("/usr/local/bin:/usr/bin", "darwin"), "/usr/local/bin:/usr/bin");
});

test("a POSIX PATH with no absolute entry falls back to the system dirs, never an empty PATH", () => {
  // execvp reads an empty PATH as the current directory.
  for (const path of ["", ".", ":", "bin:.", undefined]) {
    assert.equal(absolutePathOnly(path, "linux"), "/usr/bin:/bin:/usr/sbin:/sbin");
  }
});

test("a Windows PATH is left to the Windows lookup, which has its own walk", () => {
  assert.equal(absolutePathOnly(".;C:\\bin", "win32"), ".;C:\\bin");
});

test("a system tool never sees the CLI's own secrets", () => {
  const env = systemToolEnv(
    {
      PATH: "/usr/bin",
      AIAND_API_KEY: "sk-secret",
      aiand_api_key: "sk-secret-lower",
      AIAND_SECRET_STORE_MASTER_KEY: "00".repeat(32),
      HOME: "/home/me",
    },
    "linux",
  );
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/me" });
});

test("a system tool's PATH is cleaned under whatever name the platform spells it", () => {
  assert.equal(systemToolEnv({ Path: ".;C:\\bin" }, "win32").Path, ".;C:\\bin");
  assert.equal(systemToolEnv({ Path: ".:/bin" }, "linux").Path, "/bin");
  assert.equal(systemToolEnv({}, "linux").PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
});

test("a Windows system tool gets the switch, and its secrets are stripped too", () => {
  const env = systemToolEnv({ PATH: "C:\\bin", AIAND_API_KEY: "sk-secret" }, "win32");
  assert.deepEqual(env, { PATH: "C:\\bin", [NO_CWD_EXE_VAR]: "1" });
});

test("systemToolEnv does not mutate the environment it was given", () => {
  const env = { PATH: ".:/bin", AIAND_API_KEY: "sk-secret" };
  systemToolEnv(env, "linux");
  assert.deepEqual(env, { PATH: ".:/bin", AIAND_API_KEY: "sk-secret" });
});

// POSIX end to end: a planted tool in the current directory, reachable only
// through an empty, `.` or relative PATH entry, must not run in place of the
// system one.
const posixOnly = { skip: process.platform === "win32" };

async function inRepo(fn) {
  const root = mkdtempSync(join(tmpdir(), "aiand-posix-cwd-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  try {
    return await fn({ root, repo, marker: join(root, "planted-ran") });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const plant = (repo, marker, name) => {
  const path = join(repo, name);
  writeFileSync(path, `#!/bin/sh\necho "$0" >> "${marker}"\nexit 1\n`);
  chmodSync(path, 0o755);
};

// A PATH whose relative entries all lead into `repo`, then the real tools.
const relativePaths = ["", ".", "./", "bin"];

function runDetect(repo, path, expression) {
  const dist = pathToFileURL(join(import.meta.dirname, "..", "dist")).href;
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(dist)} + "/${expression.module}");\n${expression.code}`,
    ],
    { cwd: repo, env: { ...process.env, PATH: path, AIAND_NO_BROWSER: "" }, encoding: "utf8" },
  );
}

test(
  "agent detection never runs a `which` planted in the current directory",
  posixOnly,
  async () => {
    await inRepo(({ repo, marker }) => {
      mkdirSync(join(repo, "bin"));
      for (const entry of relativePaths) {
        for (const where of [repo, join(repo, "bin")]) plant(where, marker, "which");
        const path = [entry, "/usr/bin", "/bin"].join(delimiter);
        const probe = runDetect(repo, path, {
          module: "agents/detect.js",
          code: 'process.stdout.write(String(m.findOnPath("sh")));',
        });
        assert.equal(probe.status, 0, probe.stderr);
        assert.equal(existsSync(marker), false, `planted which ran with PATH entry "${entry}"`);
        assert.match(probe.stdout, /^\/.*\/sh$/);
      }
    });
  },
);

test(
  "the browser opener never runs an `open`/`xdg-open` planted in the current directory",
  posixOnly,
  async () => {
    await inRepo(async ({ root, repo, marker }) => {
      mkdirSync(join(repo, "bin"));
      // The real opener is replaced by a stub in an absolute directory, so no browser opens.
      const stubs = join(root, "stubs");
      mkdirSync(stubs);
      const opener = process.platform === "darwin" ? "open" : "xdg-open";
      const ran = join(root, "stub-ran");
      writeFileSync(join(stubs, opener), `#!/bin/sh\necho "$@" >> "${ran}"\nexit 0\n`);
      chmodSync(join(stubs, opener), 0o755);
      for (const entry of relativePaths) {
        rmSync(ran, { force: true });
        for (const where of [repo, join(repo, "bin")]) plant(where, marker, opener);
        const probe = runDetect(repo, [entry, stubs, "/usr/bin", "/bin"].join(delimiter), {
          module: "cli/browser.js",
          code: 'process.stdout.write(String(await m.openBrowser("http://127.0.0.1:9/")));',
        });
        assert.equal(probe.status, 0, probe.stderr);
        assert.equal(existsSync(marker), false, `planted opener ran with PATH entry "${entry}"`);
        assert.equal(
          existsSync(ran),
          true,
          `the stub opener did not run with PATH entry "${entry}"`,
        );
      }
    });
  },
);

const { scrubAgentEnv, MASTER_KEY_VAR } = spawnEnv;

test("scrubAgentEnv drops the API key and the store master key, and keeps the rest", () => {
  const env = {
    AIAND_API_KEY: "sk-x",
    [MASTER_KEY_VAR]: "ab".repeat(32),
    PATH: "/usr/bin",
    HOME: "/home/me",
  };
  assert.deepEqual(scrubAgentEnv(env, "linux"), { PATH: "/usr/bin", HOME: "/home/me" });
  assert.ok("AIAND_API_KEY" in env, "the caller's env is not mutated");
});

test("scrubAgentEnv keeps what a child of the agent still needs", () => {
  const env = { AIAND_API_KEY: "sk-x", [MASTER_KEY_VAR]: "ab".repeat(32) };
  assert.deepEqual(scrubAgentEnv(env, "linux", { keep: [MASTER_KEY_VAR] }), {
    [MASTER_KEY_VAR]: "ab".repeat(32),
  });
});

test("on Windows the secrets go whatever the case of their names", () => {
  const env = {
    aiand_api_key: "sk-x",
    Aiand_Secret_Store_Master_Key: "ab".repeat(32),
    Path: "C:\\bin",
  };
  assert.deepEqual(scrubAgentEnv(env, "win32"), { Path: "C:\\bin" });
  assert.deepEqual(scrubAgentEnv(env, "linux"), env, "POSIX names are case-sensitive");
});

test("on Windows `keep` matches names case-insensitively too", () => {
  const env = { Aiand_Secret_Store_Master_Key: "ab".repeat(32), AIAND_API_KEY: "sk-x" };
  assert.deepEqual(scrubAgentEnv(env, "win32", { keep: [MASTER_KEY_VAR] }), {
    Aiand_Secret_Store_Master_Key: "ab".repeat(32),
  });
});

const { agentPathEnv } = spawnEnv;

test("agentPathEnv keeps absolute PATH entries only, on POSIX and Windows", () => {
  const posix = agentPathEnv(
    { PATH: "/opt/bin::.:bin:node_modules/.bin:/usr/bin", HOME: "/h" },
    "linux",
  );
  assert.deepEqual(posix, { PATH: "/opt/bin:/usr/bin", HOME: "/h" });
  const win = agentPathEnv({ Path: "C:\\tools;.;bin;;\\\\srv\\share;node_modules\\.bin" }, "win32");
  assert.deepEqual(win, { Path: "C:\\tools;\\\\srv\\share" });
});

test("agentPathEnv falls back to the system directories when no entry is absolute", () => {
  assert.equal(agentPathEnv({ PATH: ".:bin" }, "linux").PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(agentPathEnv({}, "linux").PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
});
