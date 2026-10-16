import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const binName = "aiand";
const binPath = pkg.bin?.[binName];
assert.ok(binPath, `package.json must declare bin.${binName} (npm links the CLI from it)`);

const binUrl = new URL(`../${binPath}`, import.meta.url);
const stats = statSync(binUrl);
assert.ok(stats.isFile(), `${binPath} is missing — run npm run build`);

const firstLine = readFileSync(binUrl, "utf8").split("\n", 1)[0];
assert.equal(
  firstLine,
  "#!/usr/bin/env node",
  `${binPath} must start with a node shebang, got: ${firstLine}`,
);
assert.ok(stats.mode & 0o111, `${binPath} is not executable (mode ${stats.mode.toString(8)})`);

const reported = execFileSync(process.execPath, [fileURLToPath(binUrl), "--version"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}).trim();
assert.equal(
  reported,
  pkg.version,
  `${binName} --version printed "${reported}" but package.json says "${pkg.version}"`,
);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { COMMANDS } = await import(
  pathToFileURL(join(repoRoot, "dist", "commands", "index.js")).href
);
assert.ok(Array.isArray(COMMANDS), "dist/commands/index.js must export COMMANDS");
assert.ok(COMMANDS.length >= 15, `expected at least 15 commands, got ${COMMANDS.length}`);
for (const command of COMMANDS) {
  assert.ok(command.name, "each command needs a name");
  assert.ok(command.summary, `command ${command.name} needs a summary`);
  assert.equal(typeof command.run, "function", `command ${command.name} needs a run function`);
}

// CI installs a pinned OpenCode, Pi, omp, Copilot and dsh for the live
// tests; each must be the release the CLI's install hint names, or the
// two drift apart silently.
const { OPENCODE_VERSION } = await import(
  pathToFileURL(join(repoRoot, "dist", "agents", "opencode", "adapter.js")).href
);
const { PI_VERSION } = await import(
  pathToFileURL(join(repoRoot, "dist", "agents", "pi", "adapter.js")).href
);
const { OMP_VERSION, ASSET_SHA256 } = await import(
  pathToFileURL(join(repoRoot, "dist", "agents", "omp", "install.js")).href
);
const { COPILOT_VERSION } = await import(
  pathToFileURL(join(repoRoot, "dist", "agents", "copilot", "adapter.js")).href
);
const { DSH_VERSION } = await import(
  pathToFileURL(join(repoRoot, "dist", "agents", "dsh", "adapter.js")).href
);
const ciYml = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
// One entry per pinned agent install in ci.yml: `regex` captures the pin,
// `expected` is the version the adapter exports, `label` is the
// pin-not-found message, `message` builds the mismatch text from the pin.
const PINS = [
  {
    label: "ci.yml should install a pinned opencode-ai",
    regex: /opencode-ai@([0-9A-Za-z.+-]+)/g,
    expected: OPENCODE_VERSION,
    message: (pin) =>
      `ci.yml installs opencode-ai@${pin} but src/agents/opencode/adapter.ts pins ${OPENCODE_VERSION}`,
  },
  {
    label: "ci.yml should install a pinned pi-coding-agent",
    regex: /pi-coding-agent@([0-9A-Za-z.+-]+)/g,
    expected: PI_VERSION,
    message: (pin) =>
      `ci.yml installs pi-coding-agent@${pin} but src/agents/pi/adapter.ts pins ${PI_VERSION}`,
  },
  // omp installs as a pinned release asset (omp-linux-x64 /
  // omp-windows-x64.exe) from the vX.Y.Z release, digest-checked in
  // ci.yml. Each platform is checked separately so one losing its pin
  // can't hide behind the other's.
  {
    label: "ci.yml should install a pinned omp on Linux via the release asset",
    regex: /oh-my-pi\/releases\/download\/v([0-9.]+)\/omp-linux-x64/g,
    expected: OMP_VERSION,
    message: (pin) =>
      `ci.yml pins the omp-linux-x64 asset at v${pin} on Linux but src/agents/omp/install.ts pins ${OMP_VERSION}`,
  },
  {
    label: "ci.yml should install a pinned omp on Windows via the release asset",
    regex: /oh-my-pi\/releases\/download\/v([0-9.]+)\/omp-windows-x64\.exe/g,
    expected: OMP_VERSION,
    message: (pin) =>
      `ci.yml pins the omp-windows-x64.exe asset at v${pin} on Windows but src/agents/omp/install.ts pins ${OMP_VERSION}`,
  },
  {
    label: "ci.yml should install a pinned @github/copilot",
    regex: /@github\/copilot@([0-9A-Za-z.+-]+)/g,
    expected: COPILOT_VERSION,
    message: (pin) =>
      `ci.yml pins @github/copilot@${pin} but the install hint names ${COPILOT_VERSION}`,
  },
  {
    label: "ci.yml should install a pinned @deepseek-ai/dsh",
    regex: /@deepseek-ai\/dsh@([0-9A-Za-z.+-]+)/g,
    expected: DSH_VERSION,
    message: (pin) =>
      `ci.yml installs @deepseek-ai/dsh@${pin} but src/agents/dsh/adapter.ts pins ${DSH_VERSION}`,
  },
];
for (const { label, regex, expected, message } of PINS) {
  const pins = [...ciYml.matchAll(regex)].map((m) => m[1]);
  assert.ok(pins.length > 0, label);
  for (const pin of pins) {
    assert.equal(pin, expected, message(pin));
  }
}

// The live matrix installs a pinned Hermes the same way; every `--commit`
// pin in ci.yml or scripts/contree-e2e.sh must match
// src/agents/hermes/install.ts or the copies drift apart silently. The
// user-facing install hint carries the same pin, so a missing binary never
// installs unaudited bytes. The pin is imported here rather than beside the
// version PINS above: the hash lives outside src/agents/hermes/adapter.ts,
// and the cross-file sweep below reads surfaces PINS has no entry for.
const { HERMES_COMMIT, HERMES_INSTALL_SHA256 } = await import(
  pathToFileURL(join(repoRoot, "dist", "agents", "hermes", "install.js")).href
);
const hermesPinFiles = [
  [".github/workflows/ci.yml", ciYml],
  ["scripts/contree-e2e.sh", readFileSync(join(repoRoot, "scripts", "contree-e2e.sh"), "utf8")],
];
const hermesPins = hermesPinFiles.flatMap(([file, text]) =>
  [...text.matchAll(/--commit ([0-9a-f]{7,40})/g)].map((m) => [file, m[1]]),
);
assert.ok(
  hermesPins.length > 0,
  "ci.yml or scripts/contree-e2e.sh should install a Hermes pinned with --commit",
);
for (const [file, pin] of hermesPins) {
  assert.equal(
    pin,
    HERMES_COMMIT,
    `${file} installs hermes --commit ${pin} but src/agents/hermes/install.ts pins ${HERMES_COMMIT}`,
  );
}
// The same installer is checked by digest before it runs, in both files: a
// stale literal passes sha256sum only as long as the downloaded bytes match,
// so the digest drifts from HERMES_INSTALL_SHA256 whenever the pinned commit
// moves and nobody re-records it.
const hermesDigests = hermesPinFiles.flatMap(([file, text]) =>
  [...text.matchAll(/echo "([0-9a-f]{64})\s+\S*install\.sh"\s*\|\s*sha256sum -c/g)].map((m) => [
    file,
    m[1],
  ]),
);
assert.ok(
  hermesDigests.length > 0,
  "ci.yml or scripts/contree-e2e.sh should verify the hermes installer with its sha256",
);
for (const [file, digest] of hermesDigests) {
  assert.equal(
    digest,
    HERMES_INSTALL_SHA256,
    `${file} verifies the hermes installer against ${digest} but src/agents/hermes/install.ts pins ${HERMES_INSTALL_SHA256}`,
  );
}
const { hermesAdapter } = await import(
  pathToFileURL(join(repoRoot, "dist", "agents", "hermes", "adapter.js")).href
);
assert.ok(
  hermesAdapter.install.command.includes(`--commit ${HERMES_COMMIT}`),
  `the hermes install hint must carry --commit ${HERMES_COMMIT}, got: ${hermesAdapter.install.command}`,
);

// The installers run on the user's machine, where dist/ is not built yet, so
// their agent-summary hints are literal command lines in the shell script and
// the PowerShell script. They carry the same pins as the adapters; check-dist
// is the only gate that runs where both exist.
const installSh = readFileSync(join(repoRoot, "install.sh"), "utf8");
const installPs1 = readFileSync(join(repoRoot, "install.ps1"), "utf8");
// One entry per agent whose installer hint names a pinned version: `regex`
// captures the pin from the hint command, `expected` is the version the
// adapter exports. The hint must exist in both installers or the pin has no
// downstream to trip on.
const INSTALLER_PINS = [
  {
    label:
      "install.sh / install.ps1 should hint a pinned opencode-ai, and both scripts must carry the hint",
    regex: /npm install -g opencode-ai@([0-9A-Za-z.+-]+)/g,
    expected: OPENCODE_VERSION,
    message: (pin, script) =>
      `${script} hints opencode-ai@${pin} but src/agents/opencode/adapter.ts pins ${OPENCODE_VERSION}`,
  },
  {
    label:
      "install.sh / install.ps1 should hint a pinned pi-coding-agent, and both scripts must carry the hint",
    regex: /npm install -g --ignore-scripts @earendil-works\/pi-coding-agent@([0-9A-Za-z.+-]+)/g,
    expected: PI_VERSION,
    message: (pin, script) =>
      `${script} hints pi-coding-agent@${pin} but src/agents/pi/adapter.ts pins ${PI_VERSION}`,
  },
  {
    label:
      "install.sh / install.ps1 should hint a pinned omp release asset, and both scripts must carry the hint",
    // The hint names the asset, so the version rides the release URL rather
    // than a package@version pair. install.ps1 interpolates `$asset`, so its
    // URL ends `download/v18.4.4/$asset`; this regex pins the release the URL
    // names and the asset loop below matches the assets by their own spelling.
    regex: /oh-my-pi\/releases\/download\/v([0-9A-Za-z.+-]+)\//g,
    expected: OMP_VERSION,
    message: (pin, script) =>
      `${script} hints the omp release asset at v${pin} but src/agents/omp/install.ts pins ${OMP_VERSION}`,
  },
  {
    label:
      "install.sh / install.ps1 should hint a pinned @deepseek-ai/dsh, and both scripts must carry the hint",
    // dsh pins a release tag like the other npm-installed agents: the hint must
    // stay the adapter's own install.command, `--ignore-scripts` included.
    regex: /npm install -g --ignore-scripts @deepseek-ai\/dsh@([0-9A-Za-z.+-]+)/g,
    expected: DSH_VERSION,
    message: (pin, script) =>
      `${script} hints @deepseek-ai/dsh@${pin} but src/agents/dsh/adapter.ts pins ${DSH_VERSION}`,
  },
  {
    label:
      "install.sh / install.ps1 should hint a pinned @github/copilot, and both scripts must carry the hint",
    // No `--ignore-scripts`: the adapter's own install.command omits it, and
    // the installer hint must stay the command a user can also run by hand.
    regex: /npm install -g @github\/copilot@([0-9A-Za-z.+-]+)/g,
    expected: COPILOT_VERSION,
    message: (pin, script) =>
      `${script} hints @github/copilot@${pin} but src/agents/copilot/adapter.ts pins ${COPILOT_VERSION}`,
  },
  {
    label:
      "install.sh / install.ps1 should hint the pinned Hermes commit, and both scripts must carry the hint",
    // Hermes pins a commit, not a semver: the hint is the same
    // `curl | bash -s -- --commit <sha>` line ci.yml and contree-e2e.sh run,
    // so the pin below is the one imported from dist/agents/hermes/install.js.
    // PowerShell spells the same flag `-Commit`, so both forms are matched.
    regex: /-{1,2}[Cc]ommit ([0-9a-f]{7,40})/g,
    expected: HERMES_COMMIT,
    message: (pin, script) =>
      `${script} hints hermes --commit ${pin} but src/agents/hermes/install.ts pins ${HERMES_COMMIT}`,
  },
];
// claude and codex hints are unpinned upstream commands (npm tracks latest),
// so they carry no version pin to drift. Only the versioned hints are gated
// here.
for (const { label, regex, expected, message } of INSTALLER_PINS) {
  for (const [script, text] of [
    ["install.sh", installSh],
    ["install.ps1", installPs1],
  ]) {
    const pins = [...text.matchAll(regex)].map((m) => m[1]);
    assert.ok(pins.length > 0, `${label}: none in ${script}`);
    for (const pin of pins) {
      assert.equal(pin, expected, message(pin, script));
    }
  }
}

// The omp hints download a binary, so each names an asset *and* the digest
// the installer verifies it against. An asset name or digest that disagrees
// with the table in src/agents/omp/install.ts would install unverified bytes,
// or refuse a current release: check every asset the installers name, per asset.
const { AGENTS } = await import(
  pathToFileURL(join(repoRoot, "dist", "agents", "registry.js")).href
);
// The ids the installers probe for the summary: every adapter that resolves
// to a PATH binary, minus copilot-app (a GUI, so no single binary). Derived
// here rather than kept by hand so a newly shipped agent that simply does not
// appear in the summary fails the gate instead of passing silently.
const summaryIds = AGENTS.filter(
  (a) => a.id !== "copilot-app" && typeof a.bin === "string" && a.bin.length > 0,
).map((a) => a.id);
assert.ok(summaryIds.length > 0, "the registry should resolve at least one PATH agent");
for (const [script, text] of [
  ["install.sh", installSh],
  ["install.ps1", installPs1],
]) {
  // install.sh probes with a literal `for id in …` list; install.ps1 keeps the
  // order in a `$order = @(...)` array.
  const probed =
    script === "install.sh"
      ? (/for id in ([^;]+); do/.exec(text) ?? [])[1]?.trim().split(/\s+/)
      : ((/\$order = @\(([^)]*)\)/.exec(text) ?? [])[1] ?? "")
          .split(",")
          .map((id) => id.trim().replaceAll("'", ""))
          .filter(Boolean);
  assert.deepEqual(
    [...probed].sort(),
    [...summaryIds].sort(),
    `${script} probes [${probed?.join(" ")}] but the registry's PATH agents are [${summaryIds.join(" ")}]`,
  );
}

const ompAssets = new Set();
for (const [script, text, assetRe, sumRe] of [
  // install.sh: `asset=omp-linux-x64;      sum=<digest>` in a case arm.
  [
    "install.sh",
    installSh,
    /asset=(omp-[0-9A-Za-z-]+);/g,
    /asset=(omp-[0-9A-Za-z-]+);\s+sum=([0-9a-f]{64})/g,
  ],
  // install.ps1: `$asset = 'omp-windows-x64.exe'; $sum = '<digest>'`.
  [
    "install.ps1",
    installPs1,
    /\$asset = '(omp-[0-9A-Za-z-]+(?:\.exe)?)';/g,
    /\$asset = '(omp-[0-9A-Za-z-]+(?:\.exe)?)';\s*\$sum = '([0-9a-f]{64})'/g,
  ],
]) {
  const named = [...text.matchAll(assetRe)].map((m) => m[1]);
  assert.ok(named.length > 0, `${script} should name the omp release assets it downloads`);
  for (const asset of named) ompAssets.add(asset);
  const sums = [...text.matchAll(sumRe)];
  assert.ok(sums.length === named.length, `${script} should pair every omp asset with its sha256`);
  for (const [, asset, sum] of sums) {
    assert.equal(
      sum,
      ASSET_SHA256[asset],
      `${script} verifies ${asset} against ${sum} but src/agents/omp/install.ts pins ${ASSET_SHA256[asset]}`,
    );
  }
}
for (const asset of ompAssets) {
  assert.ok(
    asset in ASSET_SHA256,
    `the installers hint omp asset ${asset}, which has no digest in src/agents/omp/install.ts`,
  );
}
// Each installer's printed omp command must be the adapter's own command for
// the platform it prints it on, rendered byte for byte. The per-asset checks
// above see only names and digests: they cannot catch a case arm pointing at
// the other architecture's asset, nor a dropped `mkdir`/`chmod`, because
// those leave every asset name and digest intact. The adapter renders the
// command per platform, so the expected text is exact for each arm.
const renderOmpFor = (platform, arch) => {
  // The module resolves its platform at import time, so each arm renders in
  // its own node process with process.platform/arch shadowed first.
  const script =
    `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });` +
    `Object.defineProperty(process, "arch", { value: ${JSON.stringify(arch)} });` +
    `const { OMP_INSTALL } = await import(${JSON.stringify(fileURLToPath(pathToFileURL(join(repoRoot, "dist", "agents", "omp", "install.js")).href))});` +
    "console.log(OMP_INSTALL.command);";
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
  }).trim();
};
// The full arm table: each installer names the asset its own platform
// detection reaches, so a arm that names the wrong one fails even when its
// digest is right (the per-asset loop above would pass it).
const OMP_ARMS = [
  ["linux", "x64", "omp-linux-x64", "Linux", "x86_64"],
  ["linux", "arm64", "omp-linux-arm64", "Linux", "aarch64"],
  ["darwin", "x64", "omp-darwin-x64", "Darwin", "x86_64"],
  ["darwin", "arm64", "omp-darwin-arm64", "Darwin", "arm64"],
  ["win32", "x64", "omp-windows-x64.exe", "windows", "AMD64"],
  ["win32", "arm64", "omp-windows-arm64.exe", "windows", "ARM64"],
];
for (const [platform, arch, asset, shell, machine] of OMP_ARMS) {
  const expected = renderOmpFor(platform, arch);
  assert.ok(
    expected.includes(`/${asset}`),
    `${asset} is not what src/agents/omp/install.ts exports for ${platform}/${arch}: ${expected}`,
  );
  if (platform === "win32") {
    // install.ps1 escapes the command inside a double-quoted PS string, so its
    // source bytes are not the command the user runs: the hint is rendered
    // through pwsh (the host's own, or Windows PowerShell) with the
    // architecture env answers set, and compared to the adapter's render.
    const hintStart = installPs1.indexOf("function Get-AgentInstallHint");
    const hintEnd = installPs1.indexOf("\n}\n", hintStart) + 3;
    assert.ok(hintStart !== -1 && installPs1.slice(hintStart, hintEnd).endsWith("}\n"));
    let pwsh = "";
    for (const host of ["pwsh", "powershell"]) {
      const probe = spawnSync(host, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion"], {
        encoding: "utf8",
      });
      if (!probe.error && probe.status === 0) {
        pwsh = host;
        break;
      }
    }
    if (pwsh === "") {
      console.log("win32 omp-hint render skipped (no pwsh/powershell installed)");
      continue;
    }
    const dir = mkdtempSync(join(repoRoot, ".omp-arm-"));
    try {
      const script = join(dir, "omp-hint.ps1");
      writeFileSync(
        script,
        `$env:PROCESSOR_ARCHITECTURE = ${JSON.stringify(machine)}\n` +
          `$env:PROCESSOR_ARCHITEW6432 = ''\n` +
          `${installPs1.slice(hintStart, hintEnd)}\n` +
          `Get-AgentInstallHint -Id 'omp'\n`,
      );
      // PROCESSOR_ARCHITECTURE is a PowerShell automatic variable: it cannot
      // be handed in through the child environment, so the script sets it
      // before the hint renders. ARCHITEW6432 is also cleared because the
      // hint reads it whenever the first is empty.
      const rendered = execFileSync(
        pwsh,
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `. '${script.replace(/'/g, "''")}'`,
        ],
        { encoding: "utf8" },
      ).trim();
      assert.equal(
        rendered,
        expected,
        `install.ps1 must print the adapter's own ${arch} command: ${expected}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    continue;
  }
  // install.sh resolves the asset from `uname`, so the adapter's host-resolved
  // command is compared against the installer actually rendering it: source
  // text cannot compare because the shell interpolates `${asset}`/`${sum}`.
  // The whole function is sliced out by name so its `case` stays balanced and
  // main() never runs.
  const hintStart = installSh.indexOf("agent_install_hint() {");
  const hintEnd = installSh.indexOf("\n}\n", hintStart) + 3;
  assert.ok(hintStart !== -1 && installSh.slice(hintStart, hintEnd).endsWith("}\n"));
  const dir = mkdtempSync(join(repoRoot, ".omp-arm-"));
  try {
    writeFileSync(
      join(dir, "uname"),
      `#!/bin/sh\ncase "$1" in\n -s) echo ${shell} ;;\n -m) echo ${machine} ;;\nesac\n`,
    );
    chmodSync(join(dir, "uname"), 0o755);
    const rendered = execFileSync(
      "bash",
      ["-c", `${installSh.slice(hintStart, hintEnd)}\nagent_install_hint omp\n`],
      { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` } },
    ).trim();
    assert.equal(
      rendered,
      expected,
      `install.sh must render the adapter's own ${platform}/${arch} omp command: ${expected}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
assert.ok(
  installSh.includes("mkdir -p ~/.local/bin") && installSh.includes("chmod +x omp"),
  "install.sh's omp hint must create ~/.local/bin and mark the binary executable",
);
assert.ok(
  installPs1.includes("New-Item -ItemType Directory -Force `$d") &&
    installPs1.includes("Invoke-WebRequest") &&
    installPs1.includes("-OutFile " + "`" + '"' + "`" + "$d\\omp.exe" + "`" + '"'),
  "install.ps1's omp hint must create ~/.local/bin and download the asset",
);
// An unverified omp download is the bug this whole gate exists for, so assert
// no installer prints a bare curl/irm of the release asset: install.sh must
// always pair the URL with a digest check, install.ps1 with Get-FileHash.
for (const [script, text] of [
  ["install.sh", installSh],
  ["install.ps1", installPs1],
]) {
  const pointers = [...text.matchAll(/oh-my-pi\/releases\/download/g)].length;
  assert.ok(pointers > 0, `${script} should point at the omp release asset`);
  const verifies =
    script === "install.sh"
      ? (text.match(/oh-my-pi\/releases\/download/g) ?? []).length <=
        (text.match(/sha256sum -c|shasum -a 256 -c|\$\{havesum\} -c/g) ?? []).length
      : text.includes("Get-FileHash") && text.includes("-Algorithm SHA256");
  assert.ok(verifies, `${script} downloads an omp release asset without verifying its sha256`);
}

// install.ps1's Hermes hint runs the pinned installer through irm, so the
// raw.githubusercontent URL carries the commit too — the `-Commit` flag above
// only reads the switch, never the URL it downloads from.
for (const [, urlCommit] of installPs1.matchAll(
  /raw\.githubusercontent\.com\/NousResearch\/hermes-agent\/([0-9a-f]{7,40})\//g,
)) {
  assert.equal(
    urlCommit,
    HERMES_COMMIT,
    `install.ps1 fetches the hermes installer at ${urlCommit} but src/agents/hermes/install.ts pins ${HERMES_COMMIT}`,
  );
}

const runtimeDeps = Object.keys(pkg.dependencies ?? {});
assert.deepEqual(
  runtimeDeps,
  [],
  `the CLI ships no runtime dependencies; found: ${runtimeDeps.join(", ")}`,
);

// Exact versions only: a range lets a fresh install pick up a release nobody
// reviewed. `.npmrc` sets save-exact so `npm install <pkg>` pins by default.
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ranged = Object.entries(pkg.devDependencies ?? {}).filter(([, v]) => !EXACT_VERSION.test(v));
assert.deepEqual(
  ranged,
  [],
  `pin devDependencies to exact versions; found: ${ranged.map(([n, v]) => `${n}@${v}`).join(", ")}`,
);

console.log(`check-dist ok: ${binName} v${pkg.version}, 0 runtime deps`);
