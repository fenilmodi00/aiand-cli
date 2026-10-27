import { createHash } from "node:crypto";
import { resolve } from "node:path";

/**
 * The adapter envelope (feature catalog C3/C5/B4, ticket #78).
 *
 * A compact per-request metadata header the adapters can capture and forward:
 * tool names, edit targets, project root, git branch. Privacy posture, pinned
 * by the schema and its tests: METADATA ONLY — no prompts, completions, file
 * contents, or full file paths, ever. Edit targets are stored as
 * `<basename>#<hash16>` (sha256 of the full path, first 16 hex chars), so a
 * re-edit of the same file is detectable while the tree layout stays private.
 * `project_root_id` is the same hash of the resolved project root — a stable,
 * pseudonymous project key, never the path itself.
 *
 * Versioning: `ENVELOPE_SCHEMA_VERSION` is recorded per row. Unknown fields
 * are dropped by `normalizeEnvelope` (forward-compatible), so a future schema
 * bump does not strand stored rows.
 *
 * Size bound: an envelope must fit in the 2 KiB class so it stays compact in
 * the store. `normalizeEnvelope` enforces the caps deterministically (ordered
 * truncation, never reordering), and `envelopeFits` verifies the serialized
 * size.
 */

export const ENVELOPE_SCHEMA_VERSION = "aiand-envelope/v1";

/** Deterministic truncation caps that keep the serialized envelope ≤ 2 KiB. */
const ENVELOPE_MAX_TOOLS = 32;
const ENVELOPE_MAX_EDIT_TARGETS = 16;
export const ENVELOPE_MAX_BYTES = 2048;

/** A normalized `aiand-envelope/v1` record. Unknown input fields are dropped. */
export type EnvelopeV1 = {
  schema_version: typeof ENVELOPE_SCHEMA_VERSION;
  /** Ordered tool names used this turn — names only, never arguments. */
  tools: string[];
  /** Files edited this turn, as `<basename>#<hash16>` (never a full path). */
  edit_targets: string[];
  /** Stable pseudonymous id of the project root (hash, first 16 hex). */
  project_root_id: string | null;
  /** Current git branch, null on detached HEAD / outside a repo / unknown. */
  git_branch: string | null;
};

/**
 * The logical signals one turn produced, before normalization. Adapters map
 * their own tool-call stream onto this; `edit()` may carry a full local path —
 * normalization hashes it away immediately.
 */
export type TurnObservation = {
  tools?: readonly string[];
  /** Edit targets as observed. Full paths are allowed HERE and hashed below. */
  editTargets?: readonly string[];
  projectRoot?: string | null;
  gitBranch?: string | null;
};

/** sha256 hex, first 16 chars — the pseudonymous id shape for paths. */
export function hashPath(path: string): string {
  return createHash("sha256").update(resolve(path)).digest("hex").slice(0, 16);
}

/**
 * An edit target as the envelope stores it: `<basename>#<hash16>` of the
 * resolved full path. A bare token with no path separators keeps its exact
 * form. Both `/` and `\\` count as separators on every platform, so a
 * win32-shaped path captured on POSIX still hashes (and never leaks its
 * backslashes) — the privacy invariant is platform-independent.
 */
export function editTargetToken(observed: string): string {
  if (!observed.includes("/") && !observed.includes("\\")) return observed;
  const base = observed.slice(Math.max(observed.lastIndexOf("/"), observed.lastIndexOf("\\")) + 1);
  return `${base}#${hashPath(observed)}`;
}

/** The pseudonymous project-root id: hash of the resolved root, first 16 hex. */
export function projectRootId(root: string): string {
  return hashPath(root);
}

function cleanToolNames(tools: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const tool of tools ?? []) {
    if (typeof tool !== "string") continue;
    const name = tool.trim();
    if (name !== "" && !out.includes(name)) out.push(name);
  }
  return out;
}

function cleanEditTargets(targets: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const target of targets ?? []) {
    if (typeof target !== "string") continue;
    const token = editTargetToken(target.trim());
    if (token !== "" && !out.includes(token)) out.push(token);
  }
  return out;
}

function cleanBranch(branch: string | null | undefined): string | null {
  if (typeof branch !== "string") return null;
  const trimmed = branch.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Normalize a turn observation into the versioned schema: dedupe (order
 * preserved), hash edit targets and the project root, drop unknown fields,
 * apply the deterministic truncation caps. Pure and idempotent — feeding an
 * already-normalized envelope back in returns the same envelope.
 */
export function normalizeEnvelope(observation: TurnObservation): EnvelopeV1 {
  // Already-normalized envelopes (schema field names) are accepted too, so
  // normalize(parse(json)) is the identity — the idempotency the tests pin.
  const targets = observation.editTargets ?? (observation as EnvelopeV1).edit_targets;
  const raw: EnvelopeV1 = {
    schema_version: ENVELOPE_SCHEMA_VERSION,
    tools: cleanToolNames(observation.tools).slice(0, ENVELOPE_MAX_TOOLS),
    edit_targets: cleanEditTargets(targets).slice(0, ENVELOPE_MAX_EDIT_TARGETS),
    project_root_id:
      typeof observation.projectRoot === "string" && observation.projectRoot.trim() !== ""
        ? projectRootId(observation.projectRoot)
        : null,
    git_branch: cleanBranch(observation.gitBranch),
  };
  return shrinkToFit(raw);
}

/**
 * Drop trailing tools/edit targets (ordered truncation, schema caps first)
 * until the serialized envelope fits the 2 KiB bound. Deterministic: the same
 * input always yields the same output. Returns the input unchanged when it
 * already fits.
 */
function shrinkToFit(envelope: EnvelopeV1): EnvelopeV1 {
  let current = envelope;
  while (!envelopeFits(current) && (current.tools.length > 0 || current.edit_targets.length > 0)) {
    if (current.tools.length >= current.edit_targets.length && current.tools.length > 0) {
      current = { ...current, tools: current.tools.slice(0, -1) };
    } else if (current.edit_targets.length > 0) {
      current = { ...current, edit_targets: current.edit_targets.slice(0, -1) };
    } else {
      current = { ...current, tools: current.tools.slice(0, -1) };
    }
  }
  return current;
}

/** True when the canonical JSON serialization stays within the 2 KiB bound. */
export function envelopeFits(envelope: EnvelopeV1): boolean {
  return Buffer.byteLength(envelopeJson(envelope), "utf8") <= ENVELOPE_MAX_BYTES;
}

/** The canonical compact JSON body of the envelope. */
export function envelopeJson(envelope: EnvelopeV1): string {
  return JSON.stringify(envelope);
}

/** Structural check: is this value a recognizable `aiand-envelope/v1` record? */
function isEnvelopeV1(value: unknown): value is EnvelopeV1 {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schema_version === ENVELOPE_SCHEMA_VERSION &&
    Array.isArray(record.tools) &&
    Array.isArray(record.edit_targets) &&
    (record.project_root_id === null || typeof record.project_root_id === "string") &&
    (record.git_branch === null || typeof record.git_branch === "string")
  );
}

/**
 * Parse a stored envelope JSON string; null when not recognizable.
 * Unknown fields are DROPPED on read (the v1 forward-compatibility contract),
 * so a richer future schema version still reads as a valid v1 record.
 */
export function parseEnvelope(json: string): EnvelopeV1 | null {
  try {
    const value: unknown = JSON.parse(json);
    if (!isEnvelopeV1(value)) return null;
    const record = value as Record<string, unknown>;
    return {
      schema_version: ENVELOPE_SCHEMA_VERSION,
      tools: (record.tools as unknown[]).filter((v): v is string => typeof v === "string"),
      edit_targets: (record.edit_targets as unknown[]).filter(
        (v): v is string => typeof v === "string",
      ),
      project_root_id: typeof record.project_root_id === "string" ? record.project_root_id : null,
      git_branch: typeof record.git_branch === "string" ? record.git_branch : null,
    };
  } catch {
    return null;
  }
}
