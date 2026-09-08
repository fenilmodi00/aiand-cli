import { type Theme } from "./theme.js";

const MARKUP_TAGS = ["spark", "burst", "core", "trail", "ember", "brand", "fuse"] as const;

const TAG_PATTERN = new RegExp(`\\{(/?)(${MARKUP_TAGS.join("|")})\\}`, "g");

/** Split keeps `{tag}`/`{/tag}` tokens as separate parts. */
const TAG_SPLIT = new RegExp(`(\\{/?(${MARKUP_TAGS.join("|")})\\})`, "u");

/** Strip {tag} markup for plain-text / NO_COLOR output. */
export function stripBannerMarkup(line: string): string {
  TAG_PATTERN.lastIndex = 0;
  return line.replace(TAG_PATTERN, "");
}

/**
 * Normalize pre-composed banner art into a flush-left block that keeps
 * relative indentation.
 *
 * A logo mark must keep column alignment across rows, so we only strip the
 * shared leading indent (visible spaces, skipping `{tag}` markup) rather than
 * centering each line on its own axis: the art file carries significant
 * leading spaces and re-centering would double-indent it.
 */
export function normalizeBannerArt(art: string): string {
  const rawLines = art.split("\n");
  const visibles = rawLines.map((line) => stripBannerMarkup(line).replace(/\s+$/u, ""));
  const leads = visibles.map((v) =>
    v.trim().length === 0 ? null : (v.match(/^ */)?.[0].length ?? 0)
  );
  const present = leads.filter((n): n is number => n !== null);
  const minLead = present.length === 0 ? 0 : Math.min(...present);

  return rawLines
    .map((line, i) => {
      const lead = leads[i];
      if (lead === null || lead === undefined) {
        return "";
      }
      return stripLeadingVisibleSpaces(line.replace(/\s+$/u, ""), minLead);
    })
    .join("\n");
}

/** Remove `count` visible leading spaces, leaving `{tag}` markup untouched. */
function stripLeadingVisibleSpaces(line: string, count: number): string {
  if (count <= 0) return line;
  let removed = 0;
  let i = 0;
  let out = "";
  while (i < line.length) {
    if (line[i] === "{") {
      const close = line.indexOf("}", i);
      if (close !== -1) {
        out += line.slice(i, close + 1);
        i = close + 1;
        continue;
      }
    }
    if (removed < count && line[i] === " ") {
      removed += 1;
      i += 1;
      continue;
    }
    return out + line.slice(i);
  }
  return out;
}

export function renderBannerLine(line: string, theme: Theme): string {
  const plain = stripBannerMarkup(line);
  if (!theme.color) {
    return plain;
  }
  let out = "";
  let inBrand = false;
  for (const part of line.split(TAG_SPLIT)) {
    if (part === "{brand}") {
      inBrand = true;
    } else if (part === "{/brand}") {
      inBrand = false;
    } else if (inBrand && part) {
      out += theme.brand(part);
    } else if (!TAG_SPLIT.test(part)) {
      out += part;
    }
  }
  return out;
}
