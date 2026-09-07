/** ai& brand — banner art and truecolor theme (from aiand.com). */
export const BRAND = {
  red: "#C70007",
  glow: "#D84D51",
  deep: "#7B0004",
  mid: "#A30006",
  rose: "#B19A9C",
} as const;

/** Semantic terminal roles — mapped in theme.ts to ANSI slots, not hex literals. */
export const SEMANTIC = {
  interactive: "cyan",
  success: "cyan",
  muted: "muted",
  spend: "orange",
} as const;
