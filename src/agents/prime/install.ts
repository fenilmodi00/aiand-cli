/**
 * The Prime Agent release the install hint pins (check-dist keeps ci.yml in
 * step).
 * @public read from dist/ by scripts/check-dist.mjs
 */
export const PRIME_VERSION = "0.9.8";

const RELEASE_URL = `https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v${PRIME_VERSION}`;

/**
 * The v0.9.8 platform assets are tarballs holding the `prime-agent` binary at
 * their root. sha256 per `<platform>-<arch>`, from the release's SHA256SUMS;
 * refresh these when PRIME_VERSION moves. Windows has no asset under v0.9.8
 * (the release ships untested Windows builds), so its hint names the official
 * installer.
 */
const ASSET_SHA256: Record<string, string> = {
  "darwin-arm64": "078c9abd519978ef27f6404367e37a2981267db47f1b95b60940ea7fe6ead8b9",
  "darwin-x64": "0ddac4fa06eb47043f661bee8da8d16d9a7d740a09adb8269d12bf3a76ded87a",
  "linux-arm64": "88a98ceff22d56f9a28ad8c41f38857f6586165f06761641f2190b0d5f8e4626",
  "linux-x64": "83fb09129bf78e3e60268212cd70932166591b15188caa70c1b0efbcc76235e2",
};

/**
 * The hint downloads the pinned tarball, verifies it against the digest the
 * release publishes, extracts it under ~/.local/share, and links the binary
 * into ~/.local/bin. The official `app.primeintellect.ai/install.sh` is never
 * named: it serves the main-branch script with no digest (the shape the
 * maintainer rejected on the sibling adapters). macOS has no `sha256sum`
 * before Sequoia, so its verifier is the Perl `shasum -a 256`.
 */
function primeInstallCommand(): string {
  if (process.platform === "win32") {
    return "irm https://app.primeintellect.ai/prime-agent/install.ps1 | iex";
  }
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const key = `${platform}-${arch}`;
  const digest = ASSET_SHA256[key];
  const asset = `prime-agent-${PRIME_VERSION}-${key}.tar.gz`;
  if (digest === undefined) {
    return `Download ${RELEASE_URL} and extract prime-agent`;
  }
  const verifier = process.platform === "darwin" ? "shasum -a 256 -c -" : "sha256sum -c -";
  return `mkdir -p ~/.local/share/prime-agent ~/.local/bin && curl -fsSLo /tmp/prime-agent.tgz ${RELEASE_URL}/${asset} && echo "${digest}  /tmp/prime-agent.tgz" | ${verifier} && tar -xzf /tmp/prime-agent.tgz -C ~/.local/share/prime-agent && ln -sfn ~/.local/share/prime-agent/prime-agent ~/.local/bin/prime-agent && rm /tmp/prime-agent.tgz`;
}

export const PRIME_INSTALL = {
  command: primeInstallCommand(),
  url: "https://github.com/PrimeIntellect-ai/prime-agent",
};
