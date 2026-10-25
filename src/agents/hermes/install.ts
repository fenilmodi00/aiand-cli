/**
 * The Hermes Agent install pin and hint. Kept apart from adapter.ts so the
 * release pin has one home: check-dist reads HERMES_COMMIT and
 * HERMES_INSTALL_SHA256 from dist/agents/hermes/install.js (the module path
 * the scripts and docs cite) and compares them against the pins in ci.yml and
 * scripts/contree-e2e.sh. Neither the pin nor the digest lives in adapter.ts.
 */

/**
 * The Hermes Agent commit the live matrix installs and the user-facing
 * install hint pins: the installer is `curl … | bash -s -- --commit <sha>`,
 * so the pin is a commit, not a semver.
 * @public read from dist/ by scripts/check-dist.mjs
 */
export const HERMES_COMMIT = "666f313d1d3abd8077291ba464cf0a10f1a6157f";

/**
 * The sha256 of the Hermes installer script (scripts/install.sh) at
 * HERMES_COMMIT: CI and scripts/contree-e2e.sh download it from
 * raw.githubusercontent.com at the pinned commit and verify it with
 * `sha256sum -c` before running it. The pin and the digest move together;
 * @public read from dist/ by scripts/check-dist.mjs
 */
export const HERMES_INSTALL_SHA256 =
  "0fbf2969c12b9ef9c90b81519814865faa9ee4e22056e2a9a4d0b1d5e59966e8";

/**
 * The Hermes Agent install, per platform: the Unix one-liner mirrors what
 * ci.yml runs (pinned by HERMES_COMMIT, which check-dist keeps in step with
 * the pin in ci.yml and contree-e2e.sh). A Windows shell cannot run a
 * `curl | bash` line, so win32 gets the same script under iex — the installer
 * detects that host and reports through $LASTEXITCODE instead of exiting the
 * caller's window — with the pin as a parameter. The url is the docs page.
 */
export const HERMES_INSTALL = {
  command:
    process.platform === "win32"
      ? `iex "& { $(irm https://raw.githubusercontent.com/NousResearch/hermes-agent/${HERMES_COMMIT}/scripts/install.ps1) } -Commit ${HERMES_COMMIT} -NonInteractive -SkipBrowser -SkipComputerUse`
      : `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --commit ${HERMES_COMMIT}`,
  url: "https://hermes-agent.nousresearch.com/docs/",
};
