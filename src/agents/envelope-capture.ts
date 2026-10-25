import { readFileSync } from "node:fs";
import { configPath } from "../config.js";
import { insertEnvelope } from "../store/envelopes.js";
import { openStore, storePath } from "../store/index.js";
import { type EnvelopeV1, normalizeEnvelope } from "./envelope.js";

/**
 * Adapter-side envelope capture (ticket #78): the hook adapters and turn
 * integrations emit through. Opt-in, default OFF, metadata only.
 *
 * A recorder accumulates one turn's tool observations and flushes a single
 * normalized `aiand-envelope/v1` row into the local store. Capture is disabled
 * unless `envelopeCapture: true` appears in config.json or
 * `AIAND_ENVELOPE_CAPTURE=1` is set — a disabled recorder is a silent no-op,
 * so callers can create it unconditionally and never leak metadata when the
 * user has not opted in.
 *
 * No prompts, completions, or file contents pass through here: the API
 * surface is tool names, edit-target paths (hashed on normalization), the
 * project root (hashed), and the git branch name. Nothing else is accepted.
 */

/** config.json key for the opt-in (`aiand config.json` hand-edit for now). */
export const ENVELOPE_CAPTURE_CONFIG_KEY = "envelopeCapture";

/**
 * Whether capture is enabled: `AIAND_ENVELOPE_CAPTURE=1` OR the config.json
 * key `envelopeCapture: true`. Read fail-open — a missing or malformed config
 * means disabled. Env wins over config; both are opt-in, never default-on.
 */
export function envelopeCaptureEnabled(): boolean {
  const env = process.env.AIAND_ENVELOPE_CAPTURE;
  if (env === "1" || env === "true" || env === "yes") return true;
  if (env !== undefined && env !== "") return false;
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, unknown>;
    return raw?.[ENVELOPE_CAPTURE_CONFIG_KEY] === true;
  } catch {
    return false;
  }
}

export type EnvelopeRecorderOptions = {
  /** The harness id capturing the turn (adapter id, e.g. "opencode"). */
  agent: string;
  /** Model id in effect for the turn, when known. */
  model?: string | null;
  /** Masked api_key for request-row linkage, when known. */
  apiKey?: string | null;
  /** Derived session id for linkage, when known. */
  sessionId?: string | null;
};

type FlushResult =
  | { recorded: true; id: string; envelope: EnvelopeV1 }
  | { recorded: false; reason: "disabled" | "store" | "empty" };

/**
 * One turn's envelope recorder. Collect tool names / edit targets in call
 * order, then `flush()` once the turn ends. Safe to use when capture is
 * disabled — flush reports `{ recorded: false, reason: "disabled" }`.
 */
export type EnvelopeRecorder = {
  readonly enabled: boolean;
  /** A tool was used this turn — name only; arguments are never accepted. */
  tool(name: string): void;
  /** A file was edited this turn; full paths are hashed at flush time. */
  edit(target: string): void;
  /** Build the normalized envelope without writing anything. */
  build(observation?: { projectRoot?: string | null; gitBranch?: string | null }): EnvelopeV1;
  /** Write the envelope to the local store (no-op when disabled or empty). */
  flush(observation?: { projectRoot?: string | null; gitBranch?: string | null }): FlushResult;
};

export function createEnvelopeRecorder(options: EnvelopeRecorderOptions): EnvelopeRecorder {
  const tools: string[] = [];
  const editTargets: string[] = [];
  const enabled = envelopeCaptureEnabled();

  return {
    enabled,
    tool(name) {
      if (!enabled) return;
      const trimmed = name.trim();
      if (trimmed !== "" && !tools.includes(trimmed)) tools.push(trimmed);
    },
    edit(target) {
      if (!enabled) return;
      const trimmed = target.trim();
      if (trimmed !== "" && !editTargets.includes(trimmed)) editTargets.push(trimmed);
    },
    build(observation) {
      return normalizeEnvelope({
        tools,
        editTargets,
        projectRoot: observation?.projectRoot ?? null,
        gitBranch: observation?.gitBranch ?? null,
      });
    },
    flush(observation) {
      if (!enabled) return { recorded: false, reason: "disabled" };
      const envelope = this.build(observation);
      if (envelope.tools.length === 0 && envelope.edit_targets.length === 0) {
        return { recorded: false, reason: "empty" };
      }
      const opened = openStore(storePath());
      if (!opened.ok) return { recorded: false, reason: "store" };
      try {
        const id = insertEnvelope(opened.db, {
          envelope,
          agent: options.agent,
          model: options.model ?? null,
          apiKey: options.apiKey ?? null,
          sessionId: options.sessionId ?? null,
        });
        return { recorded: true, id, envelope };
      } catch {
        return { recorded: false, reason: "store" };
      } finally {
        try {
          opened.db.close();
        } catch {
          // already closed
        }
      }
    },
  };
}
