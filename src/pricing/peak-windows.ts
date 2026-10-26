import { estimated, formatLabel } from "../obs/provenance.js";

/**
 * Peak / off-peak windows (feature catalog B9, ticket #81).
 *
 * A versioned per-model-family window table, applied as a pure GROUP BY over
 * the store's `created_at` rows: each request lands in `peak` or `off-peak`
 * by evaluating its UTC instant as wall-clock time in the window's own
 * timezone (SGT for GLM — the conversion is general and DST-safe, windows
 * never drift when the display `--timezone` differs). Money shares are
 * percentages of the gateway-billed cost (never token counts), so they sum
 * exactly to 100% of what was actually billed (CodeBurn's accounting).
 *
 * Never-guess: a model whose id matches no family is reported as
 * `unclassified`, never assigned a window by inference. Non-first-party
 * traffic (rows that carry route metadata saying so) is aggregated into an
 * explicit `routed` bucket — window semantics do not apply there; rows
 * without route metadata are first-party by definition (the store records
 * the account's own gateway rows only).
 *
 * The table ships as data with a per-entry source string so users can verify
 * it (`aiand usage --show-windows`). New vendors get an entry only when a
 * reviewed change can cite their pricing documentation.
 */

/** A daily peak window in the vendor's own timezone. */
export type PeakWindow = {
  /** Wall-clock start, `HH:MM` in `tz` (inclusive). */
  start: string;
  /** Wall-clock end, `HH:MM` in `tz` (exclusive; `end <= start` wraps midnight). */
  end: string;
  /** IANA timezone the window is fixed in. */
  tz: string;
  /** ISO weekdays (1=Mon..7=Sun) the window applies to; every day when omitted. */
  weekdays?: readonly number[];
};

/** One model family's window table entry, with its source citation. */
export type FamilyWindows = {
  family: string;
  /** Lowercase substring of a model id that maps it to this family. */
  match: string;
  windows: readonly PeakWindow[];
  source: string;
};

/** The versioned window table. Order matters: first matching family wins. */
export const PEAK_WINDOWS: readonly FamilyWindows[] = [
  {
    family: "glm",
    match: "glm",
    windows: [
      {
        start: "14:00",
        end: "18:00",
        tz: "Asia/Singapore",
        weekdays: [1, 2, 3, 4, 5],
      },
    ],
    source:
      "Z.ai devpack docs (docs.z.ai/devpack/overview): peak hours Mon-Fri 14:00-18:00 " +
      "SGT (UTC+8); verified 2026-10-25",
  },
  {
    family: "deepseek",
    match: "deepseek",
    windows: [{ start: "16:30", end: "00:30", tz: "UTC" }],
    source:
      "DeepSeek API pricing page: off-peak discount window 16:30-00:30 UTC " +
      "(historical discount; ended 2025-09-05)",
  },
];

/** The family of a model id, or null when no table entry matches (never guessed). */
export function familyOf(model: string): string | null {
  const id = model.toLowerCase();
  for (const family of PEAK_WINDOWS) {
    if (id.includes(family.match)) return family.family;
  }
  return null;
}

/** The windows for a model id, or null when the family is unclassified. */
export function windowsFor(model: string): readonly PeakWindow[] | null {
  const id = model.toLowerCase();
  for (const family of PEAK_WINDOWS) {
    if (id.includes(family.match)) return family.windows;
  }
  return null;
}

/** The family's citation string, or null. */
function windowsSource(model: string): string | null {
  const id = model.toLowerCase();
  for (const family of PEAK_WINDOWS) {
    if (id.includes(family.match)) return family.source;
  }
  return null;
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** A window as a display string: `Mon+Tue+Wed+Thu+Fri 14:00-18:00 Asia/Singapore`. */
export function windowLabel(window: PeakWindow): string {
  const days =
    window.weekdays === undefined || window.weekdays.length === 7
      ? "daily"
      : window.weekdays.map((day) => DAY_NAMES[day - 1] ?? `day${day}`).join("+");
  return `${days} ${window.start}-${window.end} ${window.tz}`;
}

// ---------------------------------------------------------------------------
// Wall-clock evaluation (general, DST-safe)
// ---------------------------------------------------------------------------

/** Minutes since midnight of an instant, as the wall clock reads in `tz`. */
export function wallMinutes(tz: string, ms: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  const hour = get("hour") === 24 ? 0 : get("hour"); // some ICU builds emit "24" for midnight
  return hour * 60 + get("minute");
}

/** ISO weekday (1=Mon..7=Sun) of an instant, as the wall clock reads in `tz`. */
export function wallWeekday(tz: string, ms: number): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(
    new Date(ms),
  );
  const index = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(name);
  return index >= 0 ? index + 1 : new Date(ms).getUTCDay() || 7;
}

function parseHm(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`invalid HH:MM window bound: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Whether an instant falls inside one of the windows (evaluated in the window's tz). */
export function inWindows(ms: number, windows: readonly PeakWindow[]): boolean {
  for (const window of windows) {
    if (window.weekdays !== undefined && !window.weekdays.includes(wallWeekday(window.tz, ms))) {
      continue;
    }
    const start = parseHm(window.start);
    const end = parseHm(window.end);
    const minutes = wallMinutes(window.tz, ms);
    const inRange =
      start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
    if (inRange) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The split — shares of gateway-billed cost, per model
// ---------------------------------------------------------------------------

/** A store row shaped for the split; `route` is future route metadata. */
export type PeakRow = {
  model: string;
  created_at: string;
  cost_value: number | null;
  currency: string | null;
  /** Route/provenance marker; absent, null or "direct" = first-party. */
  route?: string | null;
};

type Costs = Record<string, number>;

/** Per-bucket totals: request count plus per-currency gateway-cost sums. */
type PeakBucketTotals = { requests: number; costs: Costs };

type PeakModelRow = {
  model: string;
  /** Table family ("glm", "deepseek") or null when unclassified. */
  family: string | null;
  /** Human window label, or null. */
  windows: string | null;
  source: string | null;
  peak: PeakBucketTotals;
  offPeak: PeakBucketTotals;
  /** All of the model's cost when `family === null` (never guessed otherwise). */
  unclassified: PeakBucketTotals;
  /** Per-currency share of billed cost: peak + off-peak === 100 exactly. */
  shares: Record<string, { peak: number; offPeak: number }>;
};

export type PeakSplit = {
  models: PeakModelRow[];
  /** Non-first-party rows, aggregated apart (window semantics do not apply). */
  routed: PeakBucketTotals;
  provenance: string;
};

function emptyBucket(): PeakBucketTotals {
  return { requests: 0, costs: {} };
}

function addCost(bucket: PeakBucketTotals, currency: string, value: number): void {
  // #89: same casefold as the usage-report accumulator so a stored "USD"
  // can't split the gateway's "usd" peak/off-peak lane.
  const key = currency.toLowerCase();
  bucket.costs[key] = (bucket.costs[key] ?? 0) + value;
}

function addRow(bucket: PeakBucketTotals, row: PeakRow): void {
  bucket.requests += 1;
  if (row.cost_value !== null) {
    addCost(bucket, row.currency ?? "", row.cost_value);
  }
}

function isFirstParty(row: PeakRow): boolean {
  return row.route === undefined || row.route === null || row.route === "direct";
}

/**
 * The pure split: GROUP BY model over the rows, bucketing each by the window
 * table. Shares are computed per currency as rounded `peak` and
 * `100 - peak`, so they always sum to exactly 100 (no rounding drift).
 */
export function splitPeakOffPeak(rows: readonly PeakRow[]): PeakSplit {
  const byModel = new Map<string, PeakModelRow>();
  const routed = emptyBucket();

  for (const row of rows) {
    if (!isFirstParty(row)) {
      addRow(routed, row);
      continue;
    }
    const existing = byModel.get(row.model);
    const entry =
      existing ??
      ({
        model: row.model,
        family: familyOf(row.model),
        windows: null,
        source: null,
        peak: emptyBucket(),
        offPeak: emptyBucket(),
        unclassified: emptyBucket(),
        shares: {},
      } satisfies PeakModelRow);
    if (!existing) byModel.set(row.model, entry);

    if (entry.family === null) {
      addRow(entry.unclassified, row);
    } else {
      const ms = Date.parse(row.created_at);
      const windows = windowsFor(row.model) ?? [];
      entry.windows = windows.map(windowLabel).join(", ");
      entry.source = windowsSource(row.model);
      addRow(inWindows(ms, windows) ? entry.peak : entry.offPeak, row);
    }
  }

  for (const entry of byModel.values()) {
    if (entry.family === null) continue;
    for (const currency of Object.keys(entry.peak.costs)) {
      entry.shares[currency] = { peak: 0, offPeak: 0 };
    }
    for (const currency of new Set([
      ...Object.keys(entry.peak.costs),
      ...Object.keys(entry.offPeak.costs),
    ])) {
      const total = (entry.peak.costs[currency] ?? 0) + (entry.offPeak.costs[currency] ?? 0);
      if (total <= 0) continue;
      const peak = Math.round(((entry.peak.costs[currency] ?? 0) / total) * 1000) / 10;
      entry.shares[currency] = { peak, offPeak: Math.round((100 - peak) * 10) / 10 };
    }
  }

  return {
    models: [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model)),
    routed,
    provenance: formatLabel(
      estimated("peak-window table applied to stored created_at timestamps and gateway costs"),
    ),
  };
}
