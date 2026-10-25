/**
 * Inline SVG chart helper (feature catalog F1, ticket #76) — CacheLane's
 * `charts.ts` approach: hand-rolled polylines, no chart library, no external
 * resources, deterministic output (the HTML snapshot test pins the shape).
 */

type ChartSeries = {
  label: string;
  /** One value per x category; null skips the point (gap, not zero). */
  points: (number | null)[];
  color: string;
};

export type ChartOptions = {
  width?: number;
  height?: number;
  series: ChartSeries[];
  /** One label per x category (dates); thinned to fit the axis. */
  xLabels: string[];
  yLabel: string;
  /** Formats a y tick (e.g. `$12.50`). */
  formatY: (value: number) => string;
};

export const CHART_COLORS = [
  "#4f8ef7",
  "#f75f5f",
  "#39b26a",
  "#e0a63a",
  "#9a6ff0",
  "#5bc8d8",
] as const;

const PAD = { top: 10, right: 12, bottom: 28, left: 56 };
const TICKS = 4;

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A line chart with labeled axes and a legend, as an inline `<svg>` string.
 * Never throws for data reasons: no points renders an empty-plot note box.
 */
export function lineChart(options: ChartOptions): string {
  const width = options.width ?? 640;
  const height = options.height ?? 240;
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const xCount = Math.max(1, options.xLabels.length);
  const xAt = (i: number): number =>
    PAD.left + (xCount === 1 ? plotW / 2 : (i / (xCount - 1)) * plotW);

  const flat = options.series.flatMap((s) => s.points.filter((p): p is number => p !== null));
  const yMax = Math.max(0, ...flat);
  const yTop = yMax === 0 ? 1 : yMax;
  const yAt = (value: number): number => PAD.top + plotH - (value / yTop) * plotH;

  const parts: string[] = [];
  parts.push(
    `<svg class="chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
      `role="img" aria-label="${esc(options.yLabel)} line chart">`,
  );

  // plot frame + y ticks
  parts.push(
    `<rect x="${PAD.left}" y="${PAD.top}" width="${plotW}" height="${plotH}" class="plot-bg"/>`,
  );
  for (let t = 0; t <= TICKS; t++) {
    const value = (yTop / TICKS) * t;
    const y = yAt(value);
    parts.push(
      `<line x1="${PAD.left}" y1="${y}" x2="${width - PAD.right}" y2="${y}" class="grid"/>`,
    );
    parts.push(
      `<text x="${PAD.left - 6}" y="${y + 4}" text-anchor="end" class="axis">` +
        `${esc(options.formatY(value))}</text>`,
    );
  }

  // x labels — thinned so adjacent labels never overlap
  const labelBudget = Math.max(1, Math.floor(plotW / 72));
  const step = Math.ceil(xCount / labelBudget);
  for (let i = 0; i < xCount; i += step) {
    parts.push(
      `<text x="${xAt(i)}" y="${height - PAD.bottom + 16}" text-anchor="middle" class="axis">` +
        `${esc(options.xLabels[i] ?? "")}</text>`,
    );
  }

  // series polylines
  if (flat.length === 0) {
    parts.push(
      `<text x="${PAD.left + plotW / 2}" y="${PAD.top + plotH / 2}" text-anchor="middle" ` +
        `class="axis">no data</text>`,
    );
  }
  for (const series of options.series) {
    const segments: string[][] = [];
    let current: string[] = [];
    series.points.forEach((point, i) => {
      if (point === null) {
        if (current.length > 0) segments.push(current);
        current = [];
        return;
      }
      current.push(`${xAt(i).toFixed(2)},${yAt(point).toFixed(2)}`);
    });
    if (current.length > 0) segments.push(current);
    for (const segment of segments) {
      parts.push(
        `<polyline points="${segment.join(" ")}" fill="none" stroke="${series.color}" ` +
          `stroke-width="2" stroke-linejoin="round"/>`,
      );
    }
  }
  parts.push("</svg>");

  // legend
  if (options.series.length > 0) {
    parts.push(`<div class="legend">`);
    for (const series of options.series) {
      parts.push(
        `<span class="legend-item"><span class="swatch" style="background:${series.color}"></span>` +
          `${esc(series.label)}</span>`,
      );
    }
    parts.push(`</div>`);
  }
  return parts.join("");
}
