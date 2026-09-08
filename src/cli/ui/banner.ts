import { createTheme } from "./theme.js";
import { normalizeBannerArt, renderBannerLine } from "./banner-render.js";
import { BANNER_ART } from "./banners/art.js";

function styledBannerLines(art: string): string {
  const theme = createTheme(process.stdout);
  return normalizeBannerArt(art)
    .split("\n")
    .map((line) => renderBannerLine(line, theme))
    .join("\n");
}

export function printBanner(options: { version?: string } = {}): void {
  process.stdout.write(`${styledBannerLines(BANNER_ART)}\n`);

  if (options.version) {
    const theme = createTheme(process.stdout);
    process.stdout.write(`${theme.muted(`v${options.version}`)}\n`);
  }
}
