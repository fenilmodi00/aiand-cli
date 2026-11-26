/**
 * The OMP release the install hint pins (check-dist keeps ci.yml in step).
 * @public read from dist/ by scripts/check-dist.mjs
 */
export const OMP_VERSION = "18.4.4";

const BASE_URL = `https://github.com/can1357/oh-my-pi/releases/download/v${OMP_VERSION}`;

/**
 * The v18.4.4 assets are standalone executables (Bun `--compile`), so the
 * hint installs the binary itself instead of piping `omp.sh/install`, which
 * serves the main-branch script with no digest. sha256 for each asset, from
 * the release's SHA256SUMS.txt; refresh these when OMP_VERSION moves.
 */
const ASSET_SHA256: Record<string, string> = {
  "omp-darwin-arm64": "e76e02821242fb36844676a9dfb79fbe5fb069d93ef3bf62625ec339fe9d092b",
  "omp-darwin-x64": "18541fd15a7707195a9041b748f2b1d647f39514ad20d9c41df53044244deab5",
  "omp-linux-arm64": "602eefddc0fd87043f8f08d8628d72592e5802c003a05f203f1ecbc63a8fdd30",
  "omp-linux-x64": "24c830fceb0bd6884bf5bf2c7a2b7407bc23fafe655e924c695ef9be308e46f3",
  "omp-windows-arm64.exe": "5ccab44f345ef524c6f62c44160d4676349e02b915729f1a8f04f1ab279ab692",
  "omp-windows-x64.exe": "5644e5d7c7cddd851d79999dbc3b98363817178b33426b355a20fdcad41a3f54",
};

/**
 * The release asset for a platform, in the naming the release publishes
 * (omp-darwin-arm64, omp-linux-x64, omp-windows-x64.exe, ...).
 */
function ompReleaseAsset(platform: NodeJS.Platform, arch: string): string {
  const cpu = arch === "arm64" ? "arm64" : "x64";
  if (platform === "darwin") return `omp-darwin-${cpu}`;
  if (platform === "win32") return `omp-windows-${cpu}.exe`;
  return `omp-linux-${cpu}`;
}

/**
 * The install hint downloads the pinned asset to a temp file, verifies it
 * against the digest the release publishes, and only then moves it to omp's
 * own default location (`~/.local/bin/omp`), so an unverified binary never
 * sits on PATH. macOS has no `sha256sum` before Sequoia, so its verifier is
 * the Perl `shasum -a 256`. The Windows hint is plain PowerShell statements to
 * paste at a PowerShell prompt, the shell the Hermes hint already assumes.
 * Wrapping them in `powershell -Command "..."` broke on the nested quotes, and
 * the outer shell expanded `$d` first.
 */
export function ompInstallCommand(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const asset = ompReleaseAsset(platform, arch);
  const url = `${BASE_URL}/${asset}`;
  const digest = ASSET_SHA256[asset];
  // Every asset has a digest; guard the table against a future asset rename
  // rather than emitting a command that verifies nothing.
  if (digest === undefined) {
    return `Download ${url} and add it to your PATH`;
  }
  if (platform === "win32") {
    return [
      `$t = Join-Path $env:TEMP 'omp-${OMP_VERSION}.exe'`,
      `Invoke-WebRequest -UseBasicParsing '${url}' -OutFile $t`,
      `if ((Get-FileHash $t -Algorithm SHA256).Hash -ne '${digest}') { Remove-Item $t; throw 'omp sha256 mismatch' }`,
      `$d = Join-Path $env:USERPROFILE '.local\\bin'`,
      "New-Item -ItemType Directory -Force $d | Out-Null",
      "Move-Item -Force $t (Join-Path $d 'omp.exe')",
    ].join("; ");
  }
  const verifier = platform === "darwin" ? "shasum -a 256 -c -" : "sha256sum -c -";
  return `t="$(mktemp)" && curl -fsSLo "$t" ${url} && echo "${digest}  $t" | ${verifier} && chmod +x "$t" && mkdir -p ~/.local/bin && mv "$t" ~/.local/bin/omp`;
}

export const OMP_INSTALL = {
  command: ompInstallCommand(),
  url: "https://omp.sh",
};
