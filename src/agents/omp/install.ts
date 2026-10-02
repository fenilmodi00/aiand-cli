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
 * The release asset for this platform, in the naming the release publishes
 * (omp-darwin-arm64, omp-linux-x64, omp-windows-x64.exe, ...).
 */
function ompReleaseAsset(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "darwin") return `omp-darwin-${arch}`;
  if (process.platform === "win32") return `omp-windows-${arch}.exe`;
  return `omp-linux-${arch}`;
}

/**
 * The install hint downloads the pinned v18.4.4 asset, verifies it against
 * the digest the release publishes, marks it executable, and leaves it at
 * omp's own default location (`~/.local/bin/omp`). macOS has no `sha256sum`
 * before Sequoia, so its verifier is the Perl `shasum -a 256`.
 */
function ompInstallCommand(): string {
  const asset = ompReleaseAsset();
  const url = `${BASE_URL}/${asset}`;
  const digest = ASSET_SHA256[asset];
  // Every asset has a digest; guard the table against a future asset rename
  // rather than emitting a command that verifies nothing.
  if (digest === undefined) {
    return `Download ${url} and add it to your PATH`;
  }
  if (process.platform === "win32") {
    return `powershell -Command "$d = Join-Path $env:USERPROFILE '.local\\bin'; New-Item -ItemType Directory -Force $d | Out-Null; Invoke-WebRequest ${url} -OutFile "$d\\omp.exe"; if ((Get-FileHash "$d\\omp.exe" -Algorithm SHA256).Hash -ne '${digest}') { throw 'sha256 mismatch' }"`;
  }
  const verifier = process.platform === "darwin" ? "shasum -a 256 -c -" : "sha256sum -c -";
  return `mkdir -p ~/.local/bin && curl -fsSLo ~/.local/bin/omp ${url} && cd ~/.local/bin && echo "${digest}  omp" | ${verifier} && chmod +x omp`;
}

export const OMP_INSTALL = {
  command: ompInstallCommand(),
  url: "https://omp.sh",
};
