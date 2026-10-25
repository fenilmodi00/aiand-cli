/**
 * Wall-clock helpers over IANA timezones (ticket #75).
 *
 * The dashboard's Today/Month periods and the heatmap's hour×day buckets are
 * wall-clock concepts: "today" is midnight in the display timezone, not in
 * UTC. These helpers convert a UTC instant to timezone wall-clock parts and
 * back (two offset iterations, so DST edges settle).
 */

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** `1`–`7`, Monday first (ISO weekday). */
  weekday: number;
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
      hour12: false,
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/** The timezone wall-clock parts of a UTC instant. */
export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  const hour = Number(parts.hour) % 24; // en-US can say "24" for midnight
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_INDEX[parts.weekday ?? ""] ?? 1,
  };
}

/** UTC ms of the timezone wall-clock instant matching `parts`. */
export function zonedToUtc(parts: ZonedParts, timeZone: string): number {
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  // Fixed-point on the wall-clock offset: one iteration corrects a plain
  // offset, the second settles instants landing across a DST transition.
  const offsetAt = (t: number): number => zonedAsUtc(zonedParts(t, timeZone)) - t;
  let utc = asUtc - offsetAt(asUtc);
  utc = asUtc - offsetAt(utc);
  return utc;
}

function zonedAsUtc(parts: ZonedParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

/** UTC ms of timezone midnight of the day containing `ms`. */
export function zonedDayStartUtc(ms: number, timeZone: string): number {
  return zonedToUtc({ ...zonedParts(ms, timeZone), hour: 0, minute: 0, second: 0 }, timeZone);
}

/** UTC ms of timezone midnight on the first of the month containing `ms`. */
export function zonedMonthStartUtc(ms: number, timeZone: string): number {
  const parts = zonedParts(ms, timeZone);
  return zonedToUtc({ ...parts, day: 1, hour: 0, minute: 0, second: 0 }, timeZone);
}

/** `YYYY-MM-DD` of an instant in a timezone. */
export function zonedDateKey(ms: number, timeZone: string): string {
  const { year, month, day } = zonedParts(ms, timeZone);
  return (
    `${String(year).padStart(4, "0")}-` +
    `${String(month).padStart(2, "0")}-` +
    `${String(day).padStart(2, "0")}`
  );
}

export { WEEKDAYS };
