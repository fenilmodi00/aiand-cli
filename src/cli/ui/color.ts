/**
 * Single color-enable policy for the UI layer. Honors NO_COLOR, FORCE_COLOR,
 * TERM=dumb, and TTY — per no-color.org and common Node/chalk conventions.
 * `NO_COLOR=""` still allows color (legacy interactive flows relied on this).
 */
export function colorsEnabled(
  stream: { isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") {
    return true;
  }
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") {
    return false;
  }
  if (env.TERM === "dumb") {
    return false;
  }
  return Boolean(stream && stream.isTTY);
}

/** Alias kept for theme/banner callers. */
export function isColorEnabled(stream: { isTTY?: boolean } = process.stdout): boolean {
  return colorsEnabled(stream);
}

