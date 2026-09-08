import { RESET, type Theme } from "./theme.js";

const MARKUP_TAGS = ["spark", "burst", "core", "trail", "ember", "brand", "fuse"] as const;
type MarkupTag = (typeof MARKUP_TAGS)[number];

const TAG_PATTERN = new RegExp(`\\{(/?)(${MARKUP_TAGS.join("|")})\\}`, "g");

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

type BannerNode = string | { tag: MarkupTag; children: BannerNode[] };

function parseBannerMarkup(line: string): BannerNode[] {
  const root: BannerNode[] = [];
  const stack: BannerNode[][] = [root];
  TAG_PATTERN.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_PATTERN.exec(line)) !== null) {
    const closing = match[1];
    const tag = match[2] as MarkupTag;
    const text = line.slice(cursor, match.index);
    if (text) {
      stack[stack.length - 1]!.push(text);
    }
    cursor = match.index + match[0].length;

    if (!closing) {
      const node: BannerNode = { tag, children: [] };
      stack[stack.length - 1]!.push(node);
      stack.push(node.children);
    } else if (stack.length > 1) {
      stack.pop();
    }
  }
  const rest = line.slice(cursor);
  if (rest) {
    stack[stack.length - 1]!.push(rest);
  }
  return root;
}

/**
 * Render nested markup. After each child closes (RESET), reopen the parent
 * open sequence so outer colors survive nested spans — zero-dep ansis stand-in.
 */
function renderBannerNodes(
  nodes: BannerNode[],
  opens: Record<string, string>,
  parentOpen: string | null
): string {
  return nodes
    .map((node) => {
      if (typeof node === "string") {
        return node;
      }
      const open = opens[node.tag] ?? "";
      const inner = renderBannerNodes(node.children, opens, open || parentOpen);
      if (!open) {
        return inner;
      }
      const close = parentOpen ? `${RESET}${parentOpen}` : RESET;
      const coreClose =
        node.tag === "core"
          ? parentOpen
            ? `\x1b[22m${RESET}${parentOpen}`
            : `\x1b[22m${RESET}`
          : close;
      const fuseClose =
        node.tag === "fuse"
          ? parentOpen
            ? `\x1b[22m${parentOpen}`
            : `\x1b[22m`
          : coreClose;
      const end = node.tag === "fuse" ? fuseClose : node.tag === "core" ? coreClose : close;
      return `${open}${inner}${end}`;
    })
    .join("");
}

export function renderBannerLine(line: string, theme: Theme): string {
  if (!theme.color) {
    return stripBannerMarkup(line);
  }

  const styles: Record<string, (text: string) => string> = {
    spark: theme.spark,
    burst: theme.burst,
    core: theme.core,
    trail: theme.trail,
    ember: theme.ember,
    brand: theme.brand,
    fuse: theme.muted,
  };

  if (Object.keys(theme.opens).length > 0) {
    return renderBannerNodes(parseBannerMarkup(line), theme.opens, null);
  }

  return renderBannerNodesFallback(parseBannerMarkup(line), styles);
}

function renderBannerNodesFallback(
  nodes: BannerNode[],
  styles: Record<string, (text: string) => string>
): string {
  return nodes
    .map((node) => {
      if (typeof node === "string") {
        return node;
      }
      const inner = renderBannerNodesFallback(node.children, styles);
      const style = styles[node.tag];
      return style ? style(inner) : inner;
    })
    .join("");
}
