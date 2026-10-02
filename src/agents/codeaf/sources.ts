import { isDeepStrictEqual } from "node:util";
import { CliError } from "../../cli/errors.js";
import { DEFAULT_BASE_URL, isRoutableBaseUrl, trimSlash } from "../../config.js";
import { asObject, jsoncSet, notValidJsonError, parseJsonc } from "../managed-file.js";

/**
 * A `model_sources` row in CodeAF's config.json, as the Go side
 * persists it, plus our ownership marker field.
 */
export type CodeafSourceRow = {
  id: string;
  written: string;
  address?: string;
  key?: string;
  key_env?: string;
  order: number;
  [k: string]: unknown;
};

/**
 * Our row's id: a custom id that satisfies CodeAF's IsCustomID
 * without colliding with the plain `custom` id CodeAF itself mints
 * for a user's first hand-made connection.
 */
export const CODEAF_SOURCE_ID = "custom-aiand";

/** The service slug our model refs qualify: `aiand/<bare id>`. */
export const CODEAF_WRITTEN = "aiand";

/**
 * Ownership marker aiand stamps on the row. CodeAF's connection
 * editor drops unknown fields, so status also keeps a durable proof:
 * the recorded row shape (see isOurs).
 */
export const CODEAF_MARKER_KEY = "x-aiand";

/**
 * The `model_sources` rows in config text. A missing `model_sources`
 * (or a blank file) reads as `[]`; a non-object root is not a config
 * we can edit, and a `model_sources` that is present but not an array
 * is a shape CodeAF never writes — both refuse with the file named.
 */
export function readRows(text: string, path: string): CodeafSourceRow[] {
  if (!text.trim()) return [];
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw notValidJsonError(path);
    throw error;
  }
  const root = asObject(parsed);
  if (!root) throw notValidJsonError(path);
  const sources: unknown = root.model_sources;
  if (sources === undefined) return [];
  if (!Array.isArray(sources)) {
    throw new CliError(`${path} has a model_sources entry that is not an array.`, {
      hint: "Fix it by hand, or delete it and run aiand codeaf on again.",
    });
  }
  // Non-object entries are not rows; the whole-array rewrite below
  // would drop them, so they never reach the row list.
  return sources.flatMap((row) => {
    const object = asObject(row);
    return object === undefined ? [] : [object as CodeafSourceRow];
  });
}

/**
 * True when our marker stamps the row, or the recorded row shape
 * still proves it. The proof is the dropped-stamp pattern: after
 * CodeAF's own connection editor rewrote the file, the row we
 * recorded still identifies ours; a marker-less row the user
 * repointed at their own address reads not-ours.
 */
export function isOurs(row: CodeafSourceRow, record: CodeafSourceRow | null | undefined): boolean {
  if (row[CODEAF_MARKER_KEY] === true) return true;
  return (
    record != null &&
    row.id === record.id &&
    row.address === record.address &&
    row.written === CODEAF_WRITTEN
  );
}

/** Our `model_sources` row, when the file holds one we own. */
export function findOurs(
  rows: CodeafSourceRow[],
  record: CodeafSourceRow | null | undefined,
): CodeafSourceRow | undefined {
  return rows.find((row) => row.id === CODEAF_SOURCE_ID && isOurs(row, record));
}

/**
 * A `custom-aiand` row — or any row written as `aiand` — that ai&
 * does not own. A user's hand-made connection to the gateway mints
 * `written: "aiand"` too (SourceSlug of api.aiand.com), so both
 * spellings must trip the refusal.
 */
export function foreignAiand(
  rows: CodeafSourceRow[],
  record: CodeafSourceRow | null | undefined,
): CodeafSourceRow | undefined {
  return rows.find(
    (row) =>
      (row.id === CODEAF_SOURCE_ID ||
        // A hand-made row may omit `written`; it is still not ours.
        String(row.written ?? "").toLowerCase() === CODEAF_WRITTEN) &&
      !isOurs(row, record),
  );
}

/**
 * Our row in the file text: replaced in place, keeping its position
 * and order, when we already own one; else appended with the next
 * order. The whole `model_sources` array is replaced — the only way
 * jsoncSet can edit an array.
 */
export function withOurRow(
  text: string,
  row: CodeafSourceRow,
  record: CodeafSourceRow | null | undefined,
  path: string,
): string {
  const rows = readRows(text, path);
  const ours = findOurs(rows, record);
  let next: CodeafSourceRow[];
  if (ours === undefined) {
    // A hand-made row may omit `order`; a NaN max would serialize as
    // `null` into the appended row. Non-numeric orders count as 1.
    const order =
      rows.length === 0
        ? 1
        : Math.max(
            ...rows.map((existing) => (Number.isFinite(existing.order) ? existing.order : 1)),
          ) + 1;
    next = [...rows, { ...row, order }];
  } else {
    // Replace in place: the row keeps its position and its order.
    next = rows.map((existing) =>
      existing === ours ? { ...row, order: existing.order } : existing,
    );
  }
  return jsoncSet(text, ["model_sources"], next);
}

/**
 * Our row spliced out of the file text. `edited` is true when the row
 * was ours but no longer matches the recorded shape (minus key and
 * marker): the caller then strips only the key and marker from the row
 * and leaves the rest (opencode's edited-provider behavior).
 */
export function withoutOurRow(
  text: string,
  record: CodeafSourceRow | null | undefined,
  path: string,
): { text: string; removed: boolean; edited: boolean } {
  const rows = readRows(text, path);
  const ours = findOurs(rows, record);
  if (ours === undefined) return { text, removed: false, edited: false };
  const edited =
    record != null && !isDeepStrictEqual(withoutKeyAndMarker(ours), withoutKeyAndMarker(record));
  return {
    text: jsoncSet(
      text,
      ["model_sources"],
      rows.filter((row) => row !== ours),
    ),
    removed: true,
    edited,
  };
}

/** A row's identity: everything but the session key and our marker. */
function withoutKeyAndMarker(row: CodeafSourceRow): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...row };
  delete rest.key;
  delete rest[CODEAF_MARKER_KEY];
  return rest;
}

/** A row whose address is one ai& may route to: https, or loopback http. */
export function routableRow(row: CodeafSourceRow): boolean {
  return isRoutableBaseUrl(row.address);
}

/**
 * The row `on` writes. `key_env` stays unset: CodeAF's own writer
 * blanks `key` whenever `key_env` is set.
 */
export function aiandSourcesRow(apiKey: string, baseUrl: string): CodeafSourceRow {
  return {
    id: CODEAF_SOURCE_ID,
    written: CODEAF_WRITTEN,
    address: `${trimSlash(baseUrl) || DEFAULT_BASE_URL}/v1`,
    key: apiKey,
    order: 1,
    [CODEAF_MARKER_KEY]: true,
  };
}
