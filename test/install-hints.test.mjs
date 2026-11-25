import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { hermeticPath } from "./helpers.mjs";

const { ompInstallCommand, OMP_VERSION } = await import("../dist/agents/omp/install.js");
const { hermesInstallCommand, HERMES_COMMIT, HERMES_INSTALL_PS1_SHA256, HERMES_INSTALL_SHA256 } =
  await import("../dist/agents/hermes/install.js");

const UNIX = ["linux", "darwin"];

// The install hints must verify a download before it reaches PATH or runs.
describe("omp install hint", () => {
  for (const platform of UNIX) {
    test(`${platform}: downloads to a temp file and checks it before moving it onto PATH`, () => {
      const hint = ompInstallCommand(platform, "arm64");
      const verify = hint.indexOf(platform === "darwin" ? "shasum -a 256 -c -" : "sha256sum -c -");
      const move = hint.indexOf('mv "$t" ~/.local/bin/omp');
      assert.ok(verify > 0 && move > verify, hint);
      assert.match(hint, /^t="\$\(mktemp\)" && curl -fsSLo "\$t" /);
      assert.doesNotMatch(hint.slice(0, move), /~\/\.local\/bin\/omp/);
      assert.match(
        hint,
        new RegExp(`/v${OMP_VERSION.replace(/\./g, "\\.")}/omp-${platform}-arm64 `),
      );
    });
  }

  test("win32: plain PowerShell that hashes the temp file before Move-Item puts it on PATH", () => {
    const hint = ompInstallCommand("win32", "x64");
    const hash = hint.indexOf("Get-FileHash $t -Algorithm SHA256");
    const move = hint.indexOf("Move-Item -Force $t (Join-Path $d 'omp.exe')");
    assert.ok(hash > 0 && move > hash, hint);
    assert.match(hint, /-OutFile \$t;/);
    assert.ok(hint.indexOf("$d =") > hash, "the PATH directory is only named after the check");
    // Pasted at a PowerShell prompt: no nested powershell -Command, and no
    // double quotes for the outer shell to mangle or expand $vars inside.
    assert.doesNotMatch(hint, /powershell|"/);
  });
});

describe("hermes install hint", () => {
  for (const platform of UNIX) {
    test(`${platform}: runs the pinned installer only after its sha256 checks out`, () => {
      const hint = hermesInstallCommand(platform);
      assert.doesNotMatch(hint, /\|\s*bash/);
      const verify = hint.indexOf(`echo "${HERMES_INSTALL_SHA256}  $f" |`);
      const run = hint.indexOf(`bash "$f" --commit ${HERMES_COMMIT}`);
      assert.ok(verify > 0 && run > verify, hint);
      assert.ok(hint.includes(`/hermes-agent/${HERMES_COMMIT}/scripts/install.sh`), hint);
    });
  }

  test("win32 keeps the commit-pinned install.ps1", () => {
    const hint = hermesInstallCommand("win32");
    assert.ok(hint.includes(`/hermes-agent/${HERMES_COMMIT}/scripts/install.ps1`), hint);
    assert.ok(hint.includes(`-Commit ${HERMES_COMMIT}`), hint);
  });

  test("win32: runs the pinned install.ps1 only after its sha256 checks out", () => {
    const hint = hermesInstallCommand("win32");
    const download = hint.indexOf("Invoke-WebRequest");
    const verify = hint.indexOf(
      `(Get-FileHash $t -Algorithm SHA256).Hash -ne '${HERMES_INSTALL_PS1_SHA256}'`,
    );
    const refuse = hint.indexOf("throw 'hermes installer sha256 mismatch'");
    const run = hint.indexOf("[scriptblock]::Create(");
    assert.ok(download >= 0 && verify > download && refuse > verify && run > refuse, hint);
    assert.doesNotMatch(hint, /\biex\b|Invoke-Expression/i, "nothing is piped into iex unchecked");
    assert.match(hint, /Get-Content -Raw -Encoding UTF8 \$t/, "5.1 reads a BOM-less file as ANSI");
  });

  test("win32: every quote closes and it is pasteable at a PowerShell prompt", () => {
    const hint = hermesInstallCommand("win32");
    assert.doesNotMatch(hint, /"/, "no double quote for the outer shell to mangle");
    assert.equal((hint.match(/'/g) ?? []).length % 2, 0, `an unclosed single quote: ${hint}`);
    const pwsh = ["pwsh", "powershell.exe"]
      .map((cmd) => [cmd, spawnSync(cmd, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion"])])
      .find(([, probe]) => !probe.error && probe.status === 0)?.[0];
    if (!pwsh) {
      // Locally a missing host is a loud skip; CI ships pwsh and must not skip.
      assert.ok(!process.env.CI, "pwsh is required on CI to parse the Windows hint");
      console.warn("SKIP win32 hermes hint parse: no pwsh or powershell.exe on PATH");
      return;
    }
    const parse = spawnSync(
      pwsh,
      [
        "-NoProfile",
        "-Command",
        "$e = $null; $t = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:AIAND_HINT, [ref]$t, [ref]$e); $e | ForEach-Object { $_.Message }; if ($e.Count -gt 0) { exit 1 }",
      ],
      { encoding: "utf8", env: { ...process.env, AIAND_HINT: hint } },
    );
    assert.equal(parse.status, 0, `${parse.stdout}${parse.stderr}`);
  });
});

// Run the real hint with a curl that serves the wrong bytes: nothing may land
// on PATH and nothing downloaded may run.
describe("install hints against a tampered download", {
  skip: process.platform === "win32",
}, () => {
  const verifier = process.platform === "darwin" ? "shasum" : "sha256sum";
  const hasVerifier = spawnSync("sh", ["-c", `command -v ${verifier}`]).status === 0;

  function runHint(hint, payload) {
    const dir = mkdtempSync(join(tmpdir(), "aiand-hint-"));
    try {
      const home = join(dir, "home");
      const bin = join(dir, "bin");
      mkdirSync(home, { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(dir, "payload"), payload);
      // `curl -fsSLo <out> <url>`: copy the payload to <out>.
      writeFileSync(join(bin, "curl"), `#!/bin/sh\ncp "${join(dir, "payload")}" "$2"\n`);
      chmodSync(join(bin, "curl"), 0o755);
      const run = spawnSync("bash", ["-c", hint], {
        encoding: "utf8",
        env: { HOME: home, PATH: hermeticPath(bin, "/usr/bin", "/bin"), TMPDIR: dir },
      });
      return { run, home, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  test("omp: a binary that fails the check never reaches ~/.local/bin", {
    skip: !hasVerifier,
  }, () => {
    const { run, home, cleanup } = runHint(ompInstallCommand(), "#!/bin/sh\necho evil\n");
    try {
      assert.notEqual(run.status, 0);
      assert.equal(existsSync(join(home, ".local", "bin", "omp")), false);
    } finally {
      cleanup();
    }
  });

  test("hermes: an installer that fails the check never runs", { skip: !hasVerifier }, () => {
    const dir = mkdtempSync(join(tmpdir(), "aiand-hint-marker-"));
    const marker = join(dir, "ran");
    try {
      const { run, cleanup } = runHint(hermesInstallCommand(), `#!/bin/sh\ntouch "${marker}"\n`);
      try {
        assert.notEqual(run.status, 0);
        assert.equal(existsSync(marker), false);
      } finally {
        cleanup();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
