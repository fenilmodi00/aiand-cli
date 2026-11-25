// Shared fixtures for the installer tests: a loopback double standing in for
// the GitHub releases and the npm registry, npm-shaped tarballs of a stub CLI,
// and a runner for install.sh (bash) and install.ps1 (pwsh) in an isolated HOME.
//
// AIAND_TEST_INSTALLER_DIR points the runner at another directory holding
// install.sh and install.ps1. That is how a guard is removed from a scratch copy
// to see its test fail, without touching the real scripts.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

export const ROOT = join(import.meta.dirname, "..");
export const INSTALLER_DIR = process.env.AIAND_TEST_INSTALLER_DIR || ROOT;
export const OWNERSHIP_MARKER = ".aiand-installer-owned";

export const HAS_BASH = (() => {
  const probe = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" });
  return !probe.error && probe.status === 0 && (probe.stdout ?? "").includes("ok");
})();

export const PWSH = (() => {
  for (const cmd of ["pwsh", "powershell.exe"]) {
    const probe = spawnSync(cmd, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion"], {
      encoding: "utf8",
    });
    if (!probe.error && probe.status === 0) return cmd;
  }
  return null;
})();

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
export const sha512 = (buf) => `sha512-${createHash("sha512").update(buf).digest("base64")}`;

export function tarEntry(name, body = Buffer.alloc(0), { type = "0", mode = 0o644 } = {}) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header.write(type, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

/** Source of a stub CLI that answers --version from package.json and --help. */
export function stubCliSource({ printVersion, helpExit = 0 } = {}) {
  return [
    'const fs = require("fs");',
    'const path = require("path");',
    'const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));',
    "const arg = process.argv[2];",
    `if (arg === "--version") console.log(${printVersion === undefined ? "pkg.version" : JSON.stringify(printVersion)});`,
    `else if (arg === "--help") { console.log("aiand test stub"); process.exit(${helpExit}); }`,
    "else process.exit(1);",
    "",
  ].join("\n");
}

/**
 * An npm-shaped tarball (everything under package/) of a runnable stub CLI.
 * `name` and `pkgVersion` set what its package.json says; `cli` is the stub's
 * source (see stubCliSource).
 */
export function stubTarball(version, extra = [], { name = "@aiand/cli", pkgVersion, cli } = {}) {
  return gzipSync(
    Buffer.concat([
      tarEntry(
        "package/package.json",
        Buffer.from(JSON.stringify({ name, version: pkgVersion ?? version })),
      ),
      tarEntry("package/dist/index.js", Buffer.from(cli ?? stubCliSource()), { mode: 0o755 }),
      ...extra,
      Buffer.alloc(1024),
    ]),
  );
}

/**
 * The double: serves files from a fixture tree. `<path>.status` answers with
 * that status, `<path>.redirect` with a 302 to the URL inside, `<path>.stream`
 * streams that many MiB of filler in 1 MiB chunks with no content-length (and
 * `streamed` counts what was written), `<path>.declare` announces that many MiB
 * in content-length and then stalls. Everything else is a file or a 404.
 */
export async function startReleaseDouble(root) {
  const double = { root, streamed: 0, base: "", close: () => {} };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = join(root, rel);
    if (!file.startsWith(root)) return void res.writeHead(400).end();
    const exists = (path) => Boolean(statSync(path, { throwIfNoEntry: false }));
    if (exists(`${file}.status`)) {
      return void res.writeHead(Number(readUtf8(`${file}.status`))).end("refused");
    }
    if (exists(`${file}.redirect`)) {
      return void res.writeHead(302, { location: readUtf8(`${file}.redirect`).trim() }).end();
    }
    if (exists(`${file}.declare`)) {
      // Announces a body of that many MiB, sends a little of it, then stalls.
      res.writeHead(200, { "content-length": Number(readUtf8(`${file}.declare`)) * 1024 * 1024 });
      res.write(Buffer.alloc(1024, 7));
      return;
    }
    if (exists(`${file}.stream`)) {
      const mib = Number(readUtf8(`${file}.stream`));
      res.writeHead(200);
      const chunk = Buffer.alloc(1024 * 1024, 7);
      let sent = 0;
      const pump = () => {
        while (sent < mib) {
          sent += 1;
          double.streamed += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      res.on("error", () => {});
      return void pump();
    }
    const stat = statSync(file, { throwIfNoEntry: false });
    if (!stat || stat.isDirectory()) return void res.writeHead(404).end("not found");
    res.writeHead(200).end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  double.base = `http://127.0.0.1:${server.address().port}`;
  double.close = () => {
    server.closeAllConnections();
    server.close();
    rmSync(root, { recursive: true, force: true });
  };
  return double;
}

const readUtf8 = (path) => readFileSync(path, "utf8");

export async function newReleaseDouble() {
  return startReleaseDouble(mkdtempSync(join(tmpdir(), "aiand-release-double-")));
}

/**
 * Publish `version` to the double: the npm manifest and tarball plus the GitHub
 * release's SHA256SUMS. `served` replaces the tarball bytes npm hands out,
 * `npmIntegrityOf` and `sumsOf` pick which bytes each channel vouches for,
 * `manifest` is merged over npm's manifest (a `dist` object is merged too), and
 * `sums` replaces the SHA256SUMS text.
 */
export function publishToDouble(
  double,
  version,
  { tarball, served, npmIntegrityOf, sumsOf, manifest = {}, sums } = {},
) {
  const real = tarball ?? stubTarball(version);
  const npmDir = join(double.root, "npm", "@aiand", "cli");
  mkdirSync(join(npmDir, "-"), { recursive: true });
  writeFileSync(join(npmDir, "-", `cli-${version}.tgz`), served ?? real);
  const { dist = {}, ...rest } = manifest;
  writeFileSync(
    join(npmDir, version),
    JSON.stringify({
      name: "@aiand/cli",
      version,
      ...rest,
      dist: {
        integrity: sha512(npmIntegrityOf ?? real),
        tarball: `${double.base}/npm/@aiand/cli/-/cli-${version}.tgz`,
        ...dist,
      },
    }),
  );
  const relDir = join(double.root, "rel", "download", `v${version}`);
  mkdirSync(relDir, { recursive: true });
  writeFileSync(
    join(relDir, "SHA256SUMS"),
    sums ?? `${sha256(sumsOf ?? real)}  aiand-cli-${version}.tgz\n${"0".repeat(64)}  install.sh\n`,
  );
}

/** A throwaway directory; `cleanup` removes it. */
export function caseDir() {
  const dir = mkdtempSync(join(tmpdir(), "aiand-installer-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** An installer-owned release install of `version` at `dir` (no .git). */
export function seedInstall(dir, version) {
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@aiand/cli", version }));
  writeFileSync(join(dir, "dist", "index.js"), stubCliSource());
  writeFileSync(join(dir, OWNERSHIP_MARKER), "aiand-cli installer ownership marker\n");
}

export function git(cwd, ...args) {
  return execFileSync(
    "git",
    [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/**
 * An installer-owned git checkout of a stub CLI at `dir`, cloned from a repo of
 * its own so its branch has an upstream (the way the installer's own clone does).
 */
export function seedCheckout(dir, version) {
  const parent = dirname(dir);
  const origin = join(parent, "origin-work");
  mkdirSync(join(origin, "dist"), { recursive: true });
  writeFileSync(join(origin, "package.json"), JSON.stringify({ name: "@aiand/cli", version }));
  writeFileSync(join(origin, "dist", "index.js"), stubCliSource());
  git(origin, "init", "-q");
  git(origin, "add", "-A");
  git(origin, "commit", "-qm", "seed");
  git(parent, "clone", "-q", origin, dir);
  writeFileSync(join(dir, OWNERSHIP_MARKER), "aiand-cli installer ownership marker\n");
}

/** Where installer scripts under test are copied: not an @aiand/cli checkout. */
function copiedInstaller(dir, kind) {
  const scriptDir = join(dir, "scriptdir");
  mkdirSync(scriptDir, { recursive: true });
  const name = kind === "sh" ? "install.sh" : "install.ps1";
  copyFileSync(join(INSTALLER_DIR, name), join(scriptDir, name));
  return join(scriptDir, name);
}

/**
 * Run an installer (`sh` is install.sh under bash, `ps1` is install.ps1 under
 * pwsh) with an isolated HOME. Resolves to { status, signal, stdout, stderr }.
 */
export function runInstaller(kind, dir, { args = [], env = {}, path, timeoutMs = 120_000 } = {}) {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const installer = copiedInstaller(dir, kind);
  const childEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AIAND_NO_MODIFY_PATH: "1",
    AIAND_NO_BROWSER: "1",
    // These cases are main's release-path guards: a verified release installs
    // into ~/.aiand/cli as `aiand`. Unset, cli-v2's install.sh would take its
    // side-by-side preview path instead (~/.aiand/cli-v2, `aiand-v2`, a clone
    // of the fork's branch). An explicit override in `env` still wins.
    AIAND_V2_SIDEBYSIDE: "0",
    ...env,
  };
  for (const key of [
    "AIAND_API_KEY",
    "AIAND_DIR",
    "AIAND_SOURCE",
    "AIAND_VERSION",
    "AIAND_SKIP_BUILD",
    "AIAND_UNINSTALL_FORCE",
  ]) {
    if (env[key] === undefined) delete childEnv[key];
  }
  if (path) childEnv.PATH = path;
  const [cmd, argv] =
    kind === "sh"
      ? ["bash", [installer, ...args]]
      : [PWSH, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer, ...args]];
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, home });
    });
  });
}

/** Names under ~/.aiand that a finished installer must not leave behind. */
export function leftovers(home) {
  const aiandDir = join(home, ".aiand");
  let names = [];
  try {
    names = readdirSync(aiandDir);
  } catch {
    // no ~/.aiand at all: nothing left behind
  }
  return names.filter((name) => name.startsWith(".cli-staging-") || name.includes(".prev-"));
}
