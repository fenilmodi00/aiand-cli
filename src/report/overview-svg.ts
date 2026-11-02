import { AIAND_LOGO_LIGHT } from "./aiand-logo.js";
import type { ReportData } from "./data.js";
import { isOverviewHeading, type OverviewView, renderOverviewText } from "./overview.js";

export type OverviewSvgResult = { svg: string; width: number; height: number };

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

const WIDTH = 980;
const TITLE_H = 54;
const PAD_X = 30;
const PAD_TOP = 22;
const PAD_BOTTOM = 26;
const BODY_BASELINE = 12;
const LINE_H = 21;
const CHAR_W = 8.4;
const LOGO_X_INSET = 146;
const LOGO_Y_OFFSET = 16;
const LOGO_SCALE = 0.088;
const FONT =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Cascadia Mono', 'Liberation Mono', monospace";

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function classify(line: string): { color: string; bold: boolean } {
  if (line.startsWith("ai& overview")) return { color: "#ffffff", bold: true };
  if (isOverviewHeading(line)) {
    return { color: "#ef2635", bold: true };
  }
  if (/^(cost:|note:|---|Update available)/.test(line) || line.includes("avg tok/s")) {
    return { color: "#8b949e", bold: false };
  }
  return { color: "#c9d1d9", bold: false };
}

function hasBarSegment(line: string): boolean {
  const segment = line
    .trim()
    .split(/\s{2,}/)
    .find((part) => /[█·]/.test(part));
  return segment !== undefined && /^[█·]+$/.test(segment);
}

function bodyLine(line: string, i: number): string {
  const { color, bold } = classify(line);
  const weight = bold ? ' font-weight="700"' : "";
  const y = TITLE_H + PAD_TOP + i * LINE_H + BODY_BASELINE;
  const content = esc(line);
  if (hasBarSegment(line)) {
    // Split runs of filled/empty bar chars into tspans; keep plain runs unstyled.
    const parts = line.split(/([█·]+)/).filter((p) => p !== "");
    const tspans = parts
      .map((p) => {
        const fill = p.includes("█") ? "#3fb950" : p.includes("·") ? "#30363d" : null;
        const t = `<tspan xml:space="preserve"${fill ? ` fill="${fill}"` : ""}>${esc(p)}</tspan>`;
        return t;
      })
      .join("");
    return `<text x="${PAD_X}" y="${y}" font-size="15"${weight} fill="${color}">${tspans}</text>`;
  }
  return `<text x="${PAD_X}" y="${y}" font-size="15" xml:space="preserve"${weight} fill="${color}">${content}</text>`;
}

export function renderOverviewSvg(data: ReportData, view: OverviewView): OverviewSvgResult {
  const text = renderOverviewText(data, view).replace(ANSI_RE, "");
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const maxLen = lines.reduce((m, l) => Math.max(m, l.length), 0);
  const width = Math.max(WIDTH, Math.ceil(maxLen * CHAR_W + PAD_X * 2));
  const height = TITLE_H + PAD_TOP + lines.length * LINE_H + PAD_BOTTOM;

  const body = lines.map(bodyLine).join("\n");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}">
<rect x="0" y="0" width="${width}" height="${height}" rx="12" fill="#0d1117"/>
<clipPath id="win"><rect x="0" y="0" width="${width}" height="${height}" rx="12"/></clipPath>
<g clip-path="url(#win)">
<rect x="0" y="0" width="${width}" height="${TITLE_H}" fill="#161b22"/>
<line x1="0" y1="${TITLE_H}" x2="${width}" y2="${TITLE_H}" stroke="#30363d" stroke-width="1"/>
<circle cx="20" cy="27" r="6" fill="#ff5f57"/>
<circle cx="40" cy="27" r="6" fill="#febc2e"/>
<circle cx="60" cy="27" r="6" fill="#28c840"/>
<text x="${width / 2}" y="32" text-anchor="middle" font-size="14" fill="#8b949e">ai&amp; overview</text>
${body}
<g transform="translate(${width - LOGO_X_INSET}, ${TITLE_H + LOGO_Y_OFFSET}) scale(${LOGO_SCALE})">${AIAND_LOGO_LIGHT}</g>
</g>
</svg>`;

  return { svg, width, height };
}
