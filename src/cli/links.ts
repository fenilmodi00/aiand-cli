import { stdout } from "node:process";

const OSC8_OPEN = (url: string) => `\x1b]8;;${url}\x1b\\`;
const OSC8_CLOSE = "\x1b]8;;\x1b\\";

const KNOWN_SUPPORT = ["iTerm.app", "WezTerm", "vscode", "ghostty", "Hyper", "Tabby"];

type LinkOptions = {
  stream?: NodeJS.WriteStream;
  env?: NodeJS.ProcessEnv;
};

/**
 * Whether this stream will emit OSC 8 hyperlinks. An allowlist rather than a
 * capability query: terminals that do not understand OSC 8 may render the raw
 * escape bytes, so only emit it where support is known. FORCE_HYPERLINK
 * overrides both ways (the de-facto convention; "" and "0" mean off).
 *
 * Options are test seams mirroring ambient stream/env values.
 */
export function hyperlinksEnabled({
  stream = stdout,
  env = process.env,
}: LinkOptions = {}): boolean {
  if (env.FORCE_HYPERLINK !== undefined) {
    return env.FORCE_HYPERLINK !== "" && env.FORCE_HYPERLINK !== "0";
  }
  if (!stream.isTTY) {
    return false;
  }
  if (env.TERM === "xterm-kitty" || env.TERM === "alacritty") {
    return true;
  }
  if (env.WT_SESSION || env.KONSOLE_VERSION) {
    return true;
  }
  const vte = Number.parseInt(env.VTE_VERSION ?? "", 10);
  if (Number.isInteger(vte) && vte >= 5000) {
    return true;
  }
  return KNOWN_SUPPORT.includes(env.TERM_PROGRAM ?? "");
}

/**
 * Wrap a URL in an OSC 8 hyperlink where the stream supports it; otherwise
 * return the URL unchanged so copy/paste and unsupported terminals lose
 * nothing.
 */
export function link(url: string, options: LinkOptions = {}): string {
  return hyperlinksEnabled(options)
    ? `${OSC8_OPEN(url)}${url}${OSC8_CLOSE}`
    : url;
}