import { createTheme, type Theme } from "./theme.js";
import { normalizeBannerArt, renderBannerLine } from "./banner-render.js";
import { BANNER_ART } from "./banners/art.js";

function styledBannerLines(art: string, theme: Theme): string {
  return normalizeBannerArt(art)
    .split("\n")
    .map((line) => renderBannerLine(line, theme))
    .join("\n");
}

export function printBanner(options: { version?: string } = {}): void {
  const theme = createTheme(process.stdout);
  process.stdout.write(`${styledBannerLines(BANNER_ART, theme)}\n`);

  if (options.version) {
    process.stdout.write(`${theme.muted(`v${options.version}`)}\n`);
  }
}
