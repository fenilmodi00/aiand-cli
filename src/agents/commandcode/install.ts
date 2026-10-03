/**
 * The Command Code release the install hint pins (check-dist
 * keeps ci.yml in step).
 * @public read from dist/ by scripts/check-dist.mjs
 */
export const COMMANDCODE_VERSION = "1.74.0";

/** The install hint Command Code's own quickstart gives, pinned. */
export const COMMANDCODE_INSTALL = {
  command: `npm install -g command-code@${COMMANDCODE_VERSION}`,
  url: "https://commandcode.ai/docs",
};
