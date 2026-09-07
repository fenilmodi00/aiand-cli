import { createTheme } from "./theme.js";
import { normalizeBannerArt, renderBannerLine } from "./banner-render.js";
import { BANNER_ART } from "./banners/art.js";

export function loadBannerArt(): string {
  return BANNER_ART;
}

function styledBannerLines(art: string): string {
  const theme = createTheme(process.stdout);
  return normalizeBannerArt(art)
    .split("\n")
    .map((line) => renderBannerLine(line, theme))
    .join("\n");
}

export type PrintBannerOptions = {
  version?: string;
  /** Write nothing — quiet/success flows. */
  successOnly?: boolean;
};

export function printBanner(options: PrintBannerOptions = {}): void {
  if (!options.successOnly) {
    const art = loadBannerArt();
    process.stdout.write(`${styledBannerLines(art)}\n`);

    if (options.version) {
      const theme = createTheme(process.stdout);
      process.stdout.write(`${theme.muted(`v${options.version}`)}\n`);
    }
  }
}
