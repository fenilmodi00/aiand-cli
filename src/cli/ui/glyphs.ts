/**
 * Glyph set for the ai& CLI surface: one mark per semantic state, a braille
 * spinner, and the status dot.
 */

/** One glyph per semantic state (status rows, results, section bullets). */
export const GLYPH = {
  ok: "\u2713", // ✓
  fail: "\u2717", // ✗
  pending: "\u21bb", // ↻
  warning: "\u0021", // !
  caution: "\u25b2", // ▲
  bullet: "\u00b7", // ·
  focusBar: "\u258c", // ▌
  prompt: "\u203a", // ›
  cursor: "\u258f", // ▏
  dot: "\u25cf", // ●
  up: "\u2191", // ↑
  down: "\u2193", // ↓
  ellipsis: "\u2026", // …
} as const;
