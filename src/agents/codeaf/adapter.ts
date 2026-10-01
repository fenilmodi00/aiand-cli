import { chmod, mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../../cli/errors.js";
import { agentHome, DEFAULT_BASE_URL, trimSlash, writeFileAtomic } from "../../config.js";
import { DEFAULT_FILE_MODE, existingFileMode, PRIVATE_FILE_MODE } from "../../fsutil.js";
import { resolveDefault } from "../catalog.js";
import { detectBinary } from "../detect.js";
import {
  asObject,
  jsoncDelete,
  jsoncSet,
  notValidJsonError,
  parseJsonc,
  readTextIfExists,
} from "../managed-file.js";
import {
  clearAddedState,
  discardSnapshot,
  fileCreatedByUs,
  getAddedState,
  hasSnapshot,
  recordAddedState,
} from "../snapshot.js";
import type {
  AgentAdapter,
  DetectResult,
  DisableResult,
  EnableInput,
  EnableResult,
  ProbeResult,
  SessionLaunchInput,
} from "../types.js";
import {
  aiandSourcesRow,
  CODEAF_MARKER_KEY,
  CODEAF_WRITTEN,
  type CodeafSourceRow,
  findOurs,
  foreignAiand,
  readRows,
  routableRow,
  withOurRow,
  withoutOurRow,
} from "./sources.js";

/** The adapter id (`aiand codeaf`), also the key for its snapshot state. */
const CODEAF_ID = "codeaf";
const CODEAF_BIN = "codeaf";

/**
 * The CodeAF release the install hint pins (check-dist keeps ci.yml
 * in step). @public read from dist/ by scripts/check-dist.mjs
 */
export const CODEAF_VERSION = "v0.5.1";

const CODEAF_INSTALL = {
  command: "curl -fsSL https://agentfield.ai/get/codeaf | bash",
  url: "https://agentfield.ai/docs/codeaf",
};

/**
 * CodeAF's state root: `$CODEAF_PROFILE_DIR` else `$CODEAF_HOME` else
 * `~/.codeaf` (CodeAF's own resolution order). The profile dir holds
 * the one settings+credentials file, config.json.
 */
function profileDir(): string {
  return process.env.CODEAF_PROFILE_DIR || process.env.CODEAF_HOME || join(agentHome(), ".codeaf");
}

function configPath(): string {
  return join(profileDir(), "config.json");
}

/** Recovery hint for a config.json that cannot be parsed or edited. */
const INVALID_CONFIG_HINT = "Fix it by hand, or delete it and run aiand codeaf on again.";

/** The model ref prefix that selects our `model_sources` row. */
const MODEL_PREFIX = `${CODEAF_WRITTEN}/`;

/** What enable() recorded so off can leave hand-edited values alone. */
type CodeafRecord = {
  path: string;
  /** The row `on` wrote, without the session key: added.json holds no secret. */
  source: CodeafSourceRow;
  model?: string;
  previousModel?: string;
  /** File mode before `on` locked it to 0600; disable() restores it. */
  previousMode?: number;
  created: boolean;
};

/** The row as added.json may hold it: never the session key. */
function withoutKey(row: CodeafSourceRow): CodeafSourceRow {
  const rest: CodeafSourceRow = { ...row };
  delete rest.key;
  return rest;
}

async function probe(): Promise<ProbeResult> {
  const path = configPath();
  const inactive: ProbeResult = { active: false, model: null };
  let rows: CodeafSourceRow[];
  let root: Record<string, unknown> | undefined;
  try {
    const text = await readTextIfExists(path);
    rows = readRows(text, path);
    root = asObject(parseJsonc(text));
  } catch {
    // A file mid-edit must not wedge `codeaf status`.
    return inactive;
  }
  const ours = findOurs(rows, (await getAddedState<CodeafRecord>(CODEAF_ID))?.source);
  // Active routing: our row plus an https or loopback-http address.
  // A foreign row merely named `aiand` has no marker and no recorded
  // proof, so it never reads active.
  if (ours === undefined || !routableRow(ours)) return inactive;
  const talk = root?.["model.talk"];
  return { active: true, model: typeof talk === "string" ? talk : null };
}

async function enableGuard({ force }: { force: boolean }): Promise<void> {
  const path = configPath();
  const record = await getAddedState<CodeafRecord>(CODEAF_ID);
  // Moving on would replace the snapshot that is the only copy of the
  // config at the old path.
  if (record != null && record.path !== path) {
    const rows = readRows(await readTextIfExists(record.path), record.path);
    if (findOurs(rows, record.source) !== undefined) {
      throw new CliError(`CodeAF is on at ${record.path}. Run aiand codeaf off first.`);
    }
  }
  if (force) return;
  const rows = readRows(await readTextIfExists(path), path);
  if (foreignAiand(rows, record?.source) === undefined) return;
  throw new CliError(`${path} already routes CodeAF somewhere ai& does not manage.`, {
    hint: "Pass --force to take it over, or use aiand run-agent codeaf.",
  });
}

async function enable(input: EnableInput): Promise<EnableResult> {
  const path = configPath();
  const raw = await readTextIfExists(path);
  // Only a missing file counts as created by us: a pre-existing empty
  // file belongs to the user, and `off` must never unlink it.
  let created = false;
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    created = true;
  }
  let current: Record<string, unknown> = {};
  if (raw.trim().length !== 0) {
    let parsed: unknown;
    try {
      parsed = parseJsonc(raw);
    } catch (error) {
      if (error instanceof SyntaxError) throw notValidJsonError(path, INVALID_CONFIG_HINT);
      throw error;
    }
    // Unlike the tolerant read, a non-object root can't take our edits.
    if (!asObject(parsed)) throw notValidJsonError(path, INVALID_CONFIG_HINT);
    current = parsed as Record<string, unknown>;
  }

  const prior = await getAddedState<CodeafRecord>(CODEAF_ID);
  // enableGuard already refused foreign rows; a pre-existing ours-row
  // (marker or recorded proof) means a re-`on` replaces it in place.
  const marked = findOurs(readRows(raw, path), prior?.source) !== undefined;
  // The row bakes the session key; CodeAF keeps this file 0600 itself.
  const row = aiandSourcesRow(input.apiKey, input.baseUrl);
  let text = withOurRow(raw, row, prior?.source, path);
  // The row as it now sits in the file: an append takes the next
  // order, not the builder's placeholder, and the record must match
  // the written shape or `off` would read the row as user-edited.
  const written = findOurs(readRows(text, path), prior?.source) ?? row;

  const warnings: string[] = [];
  const talk = current["model.talk"];
  const existingModel = typeof talk === "string" ? talk : "";
  // The prior on's model record is still live only when the file holds
  // exactly what it wrote; after an `off` or a hand edit the record is
  // stale and must not be carried forward.
  const priorModel = prior?.model;
  const priorLive = priorModel !== undefined && existingModel === priorModel;
  // `recorded` is what added.json carries after this run; `modelWritten`
  // is set only when this run wrote the model ref.
  let recorded: string | undefined;
  let modelWritten: string | undefined;
  let previousModel: string | undefined;
  if (input.model === "native") {
    // leave CodeAF's own default
    recorded = priorLive ? priorModel : undefined;
    previousModel = priorLive ? prior?.previousModel : undefined;
  } else if (existingModel && !input.pinModel) {
    if (!existingModel.startsWith(MODEL_PREFIX)) {
      warnings.push(`Left your existing model (${existingModel}). Pass --model to switch.`);
    }
    recorded = priorLive ? priorModel : undefined;
    previousModel = priorLive ? prior?.previousModel : undefined;
  } else {
    const nextModel = `${MODEL_PREFIX}${input.model}`;
    if (existingModel.startsWith(MODEL_PREFIX)) {
      // Already our ref: the restore target is what the prior on
      // recorded — never our own ref chained onto itself. A
      // hand-written our-ref with no record restores to nothing.
      previousModel = priorLive ? prior?.previousModel : undefined;
    } else {
      previousModel = existingModel || undefined;
    }
    text = jsoncSet(text, ["model.talk"], nextModel);
    recorded = nextModel;
    modelWritten = nextModel;
  }

  // A re-on finds the file at 0600 (our lock); carry the first on's
  // recorded mode so off still restores the user's original.
  const previousMode = prior?.previousMode ?? (await existingFileMode(path)) ?? DEFAULT_FILE_MODE;
  if (text !== raw) {
    await writeFileAtomic(path, text, { mode: PRIVATE_FILE_MODE });
  } else {
    // Unchanged bytes still re-tighten a loosened file: the baked
    // session key must stay 0600 for as long as it lives here.
    await chmod(path, PRIVATE_FILE_MODE);
  }
  await recordAddedState(CODEAF_ID, {
    path,
    source: withoutKey(written),
    model: recorded,
    previousModel,
    previousMode,
    // A file our prior on created is still ours when it still carries
    // our row (no `off` has stripped it since).
    created: created || (prior?.created === true && marked),
  });

  // Report the model now in effect: what this run wrote, else what the
  // file already had, else the requested default.
  const reportedModel = modelWritten ? modelWritten : existingModel ? existingModel : input.model;
  return {
    model: reportedModel,
    catalogModel: reportedModel.startsWith(MODEL_PREFIX)
      ? reportedModel.slice(MODEL_PREFIX.length)
      : undefined,
    filesWritten: [path],
    warnings,
  };
}

async function disable(): Promise<DisableResult> {
  const record = await getAddedState<CodeafRecord>(CODEAF_ID);
  const path = record?.path ?? configPath();
  const raw = await readTextIfExists(path);
  if (!raw.trim()) {
    await clearAddedState(CODEAF_ID);
    return { stripped: false };
  }
  let rows: CodeafSourceRow[];
  try {
    rows = readRows(raw, path);
  } catch {
    // A file we cannot read as rows is not ours to strip.
    await clearAddedState(CODEAF_ID);
    return { stripped: false };
  }
  const ours = findOurs(rows, record?.source);
  if (ours === undefined) {
    await clearAddedState(CODEAF_ID);
    return { stripped: false };
  }

  const notes: string[] = [];
  // Subtract our row; an edited row keeps its non-key bytes, so only
  // the session key and our marker leave it.
  const { edited, text: spliced } = withoutOurRow(raw, record?.source, path);
  let text = spliced;
  if (edited) {
    notes.push("left the aiand connection because you edited it");
    const rest: CodeafSourceRow = { ...ours };
    delete rest.key;
    delete rest[CODEAF_MARKER_KEY];
    text = jsoncSet(
      raw,
      ["model_sources"],
      rows.map((row) => (row === ours ? rest : row)),
    );
  } else if (rows.length === 1) {
    // Ours was the only row: an emptied model_sources is our artifact,
    // so the key leaves too, the way off drops an emptied provider block.
    text = jsoncDelete(text, ["model_sources"]);
  }

  // The model.talk key is untouched by the row edits above.
  const live = parseJsonc(text) as Record<string, unknown>;
  const talk = live["model.talk"];
  const talkModel = typeof talk === "string" ? talk : "";
  // An unpinned pre-existing `aiand/…` model is the user's — `on`
  // left it (added.model unset) so `off` must leave it too. Do not
  // treat the prefix as ownership.
  if (record?.model) {
    if (talkModel === record.model) {
      if (record.previousModel) text = jsoncSet(text, ["model.talk"], record.previousModel);
      else text = jsoncDelete(text, ["model.talk"]);
    } else if (talkModel) {
      notes.push("left model because you edited it");
    }
  }

  // The file our prior on created is still ours to remove; a user's
  // file keeps its bytes and its mode.
  const created = record?.created === true || (await fileCreatedByUs(CODEAF_ID, path));
  if (text !== raw) {
    const next = parseJsonc(text) as Record<string, unknown>;
    const empty = Object.keys(next).length === 0;
    if (empty && created) {
      await unlink(path);
    } else {
      // The key left the file: hand back the mode the user had before on.
      await writeFileAtomic(path, text, {
        mode: record?.previousMode ?? DEFAULT_FILE_MODE,
      });
    }
  }

  // A snapshot of a file we created holds no user bytes; one of the
  // user's own file is their copy to restore.
  if (created) {
    await discardSnapshot(CODEAF_ID);
  } else if (await hasSnapshot(CODEAF_ID)) {
    notes.push("run aiand restore codeaf --force to bring back your previous config");
  }

  // Next `on` must record the current dest mode, not the first-on mode.
  await clearAddedState(CODEAF_ID);
  return { stripped: true, notes };
}

async function refreshKey(input: { apiKey: string; previousKey?: string }): Promise<boolean> {
  const path = configPath();
  // Marker/record-gated like disable(): a marked row with an unusable
  // address still holds our baked key and must be swapped. A foreign
  // row (no marker, no recorded proof) keeps its own key untouched.
  let rows: CodeafSourceRow[];
  try {
    rows = readRows(await readTextIfExists(path), path);
  } catch {
    return false;
  }
  const record = await getAddedState<CodeafRecord>(CODEAF_ID);
  const ours = findOurs(rows, record?.source);
  if (ours === undefined) return false;
  // A same-key no-op still counts as touched: an idempotent rebake
  // reports refreshed.
  if (ours.key === input.apiKey) return true;
  // A rotation swaps only the key it replaced: a config baked from
  // another profile keeps routing to that profile's org.
  if (input.previousKey !== undefined && ours.key !== input.previousKey) return false;

  const raw = await readTextIfExists(path);
  // Replace our row in place, keeping its position and order.
  const row: CodeafSourceRow = { ...ours, key: input.apiKey };
  await writeFileAtomic(path, withOurRow(raw, row, record?.source, path), {
    mode: PRIVATE_FILE_MODE,
  });
  // Rebake swaps only the key literal; refresh AddedState so disable()
  // does not treat the new key as a user edit.
  if (record != null) {
    await recordAddedState(CODEAF_ID, {
      ...record,
      source: withoutKey(row),
    });
  }
  return true;
}

async function sessionLaunch(input: SessionLaunchInput) {
  // Works with no prior `on`: the whole state rides in a throwaway
  // CODEAF_HOME. The key stays out of the child env (every process
  // the agent spawns would inherit it): it goes to a throwaway 0600
  // config.json the agent reads itself, and `cleanup` removes the
  // directory after the child exits.
  const model = input.model ?? resolveDefault(input.catalog, input.profileModel);
  const dir = await mkdtemp(join(tmpdir(), "aiand-codeaf-"));
  await writeFile(
    join(dir, "config.json"),
    `${JSON.stringify({ api_key: input.apiKey, "model.talk": model }, null, 2)}\n`,
    {
      mode: PRIVATE_FILE_MODE,
    },
  );
  return {
    env: {
      CODEAF_HOME: dir,
      // Repoints the default (OpenRouter) service at the gateway —
      // CodeAF's designed seam for exactly this.
      CODEAF_BASE_URL: `${trimSlash(input.baseUrl ?? "") || DEFAULT_BASE_URL}/v1`,
      // Empty strings neutralize an inherited key that would otherwise
      // beat the overlay file and send the user's OpenRouter key to
      // our gateway; CODEAF_MODEL is empty so env-beats-file falls
      // through to the overlay's model.talk.
      OPENROUTER_API_KEY: "",
      OPENAI_API_KEY: "",
      CODEAF_MODEL: "",
      CODEAF_NO_UPDATE_CHECK: "1",
      CODEAF_TELEMETRY: "off",
    },
    // No args: passthrough stays verbatim (`aiand run-agent codeaf`
    // opens the chat; `-- chat --once "…"` is the headless door).
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export const codeafAdapter: AgentAdapter = {
  id: CODEAF_ID,
  label: "CodeAF",
  bin: CODEAF_BIN,
  install: CODEAF_INSTALL,
  detect(): DetectResult {
    return detectBinary(CODEAF_BIN);
  },
  managedFiles(): string[] {
    return [configPath()];
  },
  probe,
  enableGuard,
  enable,
  disable,
  refreshKey,
  sessionLaunch,
};
