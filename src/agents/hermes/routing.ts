import { CliError } from "../../cli/errors.js";
import { HERMES_PROVIDER_API_KEY_ENV, renderHermesEnv } from "./env.js";
import { buildHermesProviderFiles, HERMES_PROVIDER_ID } from "./plugin.js";
import {
  aiandBlockSpan,
  childValueIsMultiLine,
  commentSuffix,
  dropLoneFlowLine,
  isCommentLine,
  isSectionBodyLine,
  joinYamlLines,
  keepHeaderComment,
  keepLineComment,
  modelScalar,
  sectionRange,
  splitYamlLines,
  stripTrailingComment,
  unquoteYaml,
} from "./yaml.js";
import {
  hasFlowAiandBlock,
  hasLegacyAiandEntryLines,
  INVALID_CONFIG_HINT,
  legacyListHasAiand,
  legacyListSection,
  throwOnInlineSection,
  throwOnSequenceBody,
} from "./yaml-probes.js";

/**
 * Shared Hermes routing content: the pure builder enable() and the overlay
 * both write, so persistent wiring and throwaway sessions cannot drift. No
 * filesystem or snapshot access here — this module renders the config and
 * env routing bytes from bytes (the providers.aiand block and the top-level
 * model pin; the routing .env lives in env.ts, the generated provider plugin
 * in plugin.ts), and reads them back the same way probe() and off do.
 */
export { HERMES_PLUGIN_STAMP, HERMES_PROVIDER_ID, hermesReasoningLevels } from "./plugin.js";
export { INVALID_CONFIG_HINT } from "./yaml-probes.js";

/**
 * Ownership marker aiand stamps on its `providers.aiand` block so off can
 * tell its block from the user's. Hermes ignores unknown provider keys (one
 * log warning per process), so the stamp survives the config rewrites that
 * would drop a comment; the AddedState record backstops it when even the
 * stamp is gone.
 */
const HERMES_MARKER_KEY = "managed_by";
const HERMES_MARKER_VALUE = "aiand";

/** Recovery hint for a Hermes home that holds a block aiand must not touch. */
export const FOREIGN_BLOCK_HINT =
  "Remove or rename the foreign block by hand, then run aiand hermes on again.";

/** Recovery hint for a Hermes home whose legacy list names aiand. */
export const FOREIGN_LIST_HINT =
  "Remove or rename the foreign entry by hand, then run aiand hermes on again.";

/**
 * The one content builder for Hermes routing, used by both enable() and
 * sessionLaunch() so persistent wiring and the throwaway overlay cannot
 * drift. `envText`/`configText` are the existing file bytes ("" when the
 * file is missing); `model` is the pinned model, or undefined for native
 * (the provider block stays model-free). The top-level `model:` pin stays
 * with the caller — the overlay pins unconditionally through
 * pinHermesModel, while enable() applies its keep/set-aside policy there —
 * so this builder covers the provider block, the `.env`, and the plugin.
 * `reasoningLevels` rides the plugin so Hermes clamps user picks onto the
 * levels each model publishes rather than letting the engine default decide.
 */
export function buildHermesWrites({
  apiKey,
  baseUrl,
  model,
  reasoningLevels,
  envText,
  configText,
}: {
  apiKey: string;
  baseUrl: string;
  model: string | undefined;
  reasoningLevels: ReadonlyMap<string, readonly string[]>;
  envText: string;
  configText: string;
}): {
  env: string;
  config: string;
  initPy: string;
  pluginYaml: string;
  droppedEnvLines: string[];
} {
  const rendered = renderHermesEnv(envText, { apiKey, baseUrl });
  return {
    env: rendered.text,
    droppedEnvLines: rendered.droppedUserLines,
    config: pinHermesProvider(configText, baseUrl, model),
    ...buildHermesProviderFiles({ baseUrl, model, reasoningLevels }),
  };
}
/** One field of our `providers.aiand` block, unquoted, or undefined when absent. */
export function readProviderField(text: string, field: string): string | undefined {
  const lines = splitYamlLines(text).lines;
  const span = aiandBlockSpan(lines);
  if (!span) return undefined;
  const body = lines.slice(span.at + 1, span.end);
  const inner = body.slice(span.subAt + 1, span.subEnd);
  const pattern = new RegExp(`^${span.indent}  ${field}\\s*:\\s*(.+?)\\s*$`);
  // Trailing `#…` comments are not data: strip them before matching so a
  // `base_url: "…"  # note` line still reads as ours.
  const at = inner.findIndex((line) => pattern.test(stripTrailingComment(line)));
  if (at === -1) return undefined;
  // Like model fields: a multi-line value never reads as its header scalar.
  if (childValueIsMultiLine(inner, at, `${span.indent}  `)) return undefined;
  return unquoteYaml(pattern.exec(stripTrailingComment(inner[at]!))?.[1] ?? "");
}

/** True when our ownership stamp sits on the `providers.aiand` block. */
export function hasHermesMarker(text: string): boolean {
  return readProviderField(text, HERMES_MARKER_KEY) === HERMES_MARKER_VALUE;
}

/** True when a `providers.aiand` block exists, marked or foreign — or a legacy list entry names aiand. */
export function hasProviderAiand(text: string): boolean {
  const { lines } = splitYamlLines(text);
  if (aiandBlockSpan(lines) !== null) return true;
  if (hasFlowAiandBlock(lines)) return true;
  return hasLegacyAiandEntryLines(lines);
}

/** True when a legacy `custom_providers:` list entry names aiand (never ours — aiand only writes the dict). */
export function hasLegacyAiandEntry(text: string): boolean {
  return hasLegacyAiandEntryLines(splitYamlLines(text).lines);
}

/** Refuse the write when a foreign legacy list entry names aiand (read-only). */
export function assertNoLegacyAiand(lines: string[]): void {
  const section = legacyListSection(lines);
  if (!section) return;
  if (legacyListHasAiand(lines, section.at, section.end)) {
    throw new CliError(
      "Hermes already has a custom_providers entry named aiand that ai& does not manage.",
      { hint: FOREIGN_LIST_HINT },
    );
  }
}

/** One field of the top-level `model:` mapping; `default` also reads a scalar section. */
export function readModelField(text: string, field: "provider" | "default"): string | undefined {
  if (field === "default") {
    const scalar = modelScalar(text);
    if (scalar !== undefined) return scalar === "" ? undefined : scalar;
  }
  const lines = splitYamlLines(text).lines;
  const section = sectionRange(lines, "model");
  if (!section) return undefined;
  const body = lines.slice(section.at + 1, section.end);
  const indent = /^(\s+)\S/.exec(body.find((line) => /^\s+\w/.test(line)) ?? "")?.[1] ?? "  ";
  // `model` is Hermes's alias for the model id — an alias or `default` line is ours to read.
  const pattern =
    field === "provider"
      ? new RegExp(`^${indent}provider\\s*:\\s*(.+?)\\s*$`)
      : new RegExp(`^${indent}(?:"?default"?|model)\\s*:\\s*(.+?)\\s*$`);
  // Trailing `#…` comments are not data: a `provider: aiand  # keep` line
  // still reads as ours.
  const at = body.findIndex((line) => pattern.test(stripTrailingComment(line)));
  if (at === -1) return undefined;
  // A multi-line value (block scalar, folded body) never reads as a scalar:
  // decoding its header line would misreport a user edit and strand the record.
  if (childValueIsMultiLine(body, at, indent)) return undefined;
  return unquoteYaml(pattern.exec(stripTrailingComment(body[at]!))?.[1] ?? "");
}

/** The `model:` body's own indent, taken from its first key-shaped line. */
function modelBodyIndent(body: string[]): string {
  return /^(\s+)\S/.exec(body.find((line) => /^\s+\w/.test(line)) ?? "")?.[1] ?? "  ";
}

/** The key pattern of one `model:` field, anchored at the body's indent. */
function modelFieldPattern(field: "provider" | "default" | "base_url", indent: string): RegExp {
  return field === "provider"
    ? new RegExp(`^${indent}provider\\s*:`)
    : field === "base_url"
      ? new RegExp(`^${indent}base_url\\s*:`)
      : new RegExp(`^${indent}(?:"?default"?|model)\\s*:`);
}

/**
 * One `model:` field plus the spot it occupied: the raw line, its index
 * inside the section body (the indexing restoreHermesModelLine splices by)
 * and the body's indent. The pin drops and rewrites lines, so the body the
 * restore sees is not the body the capture saw — the recorded index is a
 * position to clamp, never an identity to trust.
 */
export type ModelFieldSpot = { line: string; at: number; indent: string };

/** One `model:` field with the spot it stood at; undefined when no section or field matched. */
export function modelFieldLineAt(
  text: string,
  field: "provider" | "default" | "base_url",
): ModelFieldSpot | undefined {
  const section = modelSection(splitYamlLines(text).lines);
  const at = section?.body.findIndex((line) => modelFieldPattern(field, section.indent).test(line));
  if (section === undefined || at === undefined || at === -1) return undefined;
  return { line: section.body[at]!, at, indent: section.indent };
}

/** The raw source line of one `model:` field, so off can hand back the exact bytes. */
export function modelFieldLine(
  text: string,
  field: "provider" | "default" | "base_url",
): string | undefined {
  return modelFieldLineAt(text, field)?.line;
}

/** The `model.base_url` spot on drops and off hands back, when the section holds one. */
export function modelBaseUrlSpot(text: string): ModelFieldSpot | undefined {
  return modelFieldLineAt(text, "base_url");
}

/** The `model:` body plus the indent it is written at, when the section is a mapping. */
function modelSection(
  lines: string[],
): { at: number; end: number; body: string[]; indent: string } | undefined {
  const section = sectionRange(lines, "model");
  if (!section) return undefined;
  const body = lines.slice(section.at + 1, section.end);
  return { ...section, body, indent: modelBodyIndent(body) };
}

/** Rejoin a file around a rewritten `model:` body: the header stays the bare `model:` key. */
function rejoinModel(
  lines: string[],
  span: { at: number; end: number },
  body: string[],
  trailingNewline: boolean,
  eol: string,
): string {
  return joinYamlLines(
    [
      ...lines.slice(0, span.at),
      keepHeaderComment("model", lines[span.at]!),
      ...body,
      ...lines.slice(span.end),
    ],
    trailingNewline,
    eol,
  );
}

/**
 * Drop a stale `model.base_url` in one pass, reporting the spot it stood at
 * beside the rewritten text, so the caller can record exactly what off has
 * to put back (and only then: `dropped` false means nothing changed and the
 * text comes back byte-identical).
 */
export function dropStaleModelBaseUrl(text: string): {
  text: string;
  dropped: boolean;
  spot: ModelFieldSpot | undefined;
} {
  const { lines, trailingNewline, eol } = splitYamlLines(text);
  const empty = { text, dropped: false, spot: undefined };
  throwOnInlineSection(lines, "model");
  const section = modelSection(lines);
  if (!section) return empty;
  const report = dropModelBaseUrl(section.body, section.indent);
  if (!report.dropped) return empty;
  return {
    text: rejoinModel(lines, section, section.body, trailingNewline, eol),
    dropped: true,
    spot: report.spot,
  };
}
/**
 * Upsert the `providers.aiand` block of a hermes config: the connection
 * fields always, the model list only when a model is pinned (`native`
 * leaves the provider model-free, so Hermes's own default decides).
 * Hermes seeds no `providers:` key of its own, but a user one is rewritten
 * where it stands; other providers and unrelated keys stay put. `native`
 * is the only case with an empty model list — a pinned launch always names
 * exactly the routed model. The ownership stamp rides last: Hermes ignores
 * the unknown key, and off uses it to tell its block from the user's.
 */
export function pinHermesProvider(
  text: string,
  baseUrl: string,
  model: string | undefined,
): string {
  const entry = (indent: string) => [
    `${indent}aiand:`,
    `${indent}  name: aiand`,
    `${indent}  base_url: ${JSON.stringify(baseUrl)}`,
    `${indent}  key_env: ${HERMES_PROVIDER_API_KEY_ENV}`,
    `${indent}  transport: chat_completions`,
    ...(model === undefined
      ? []
      : [
          `${indent}  default_model: ${JSON.stringify(model)}`,
          `${indent}  models: ${JSON.stringify([model])}`,
        ]),
    `${indent}  discover_models: false`,
    `${indent}  ${HERMES_MARKER_KEY}: ${JSON.stringify(HERMES_MARKER_VALUE)}`,
  ];
  const { lines, trailingNewline, eol } = splitYamlLines(text);
  // A legacy list entry naming aiand is never ours to splice beside: refuse
  // with the entry-specific hint instead of writing a duplicate dict block.
  assertNoLegacyAiand(lines);
  throwOnInlineSection(lines, "providers");
  const at = lines.findIndex((line) => /^providers\s*:/.test(line));
  if (at === -1) {
    const gap = lines.length > 0 && lines[lines.length - 1]!.trim() !== "" ? [""] : [];
    // Appended, like before: the join adds separators only, never a
    // trailing newline of its own — so it must remember whether the file
    // already ended one, or an unterminated file gains a newline here and
    // never round-trips.
    return joinYamlLines([...lines, ...gap, "providers:", ...entry("  ")], trailingNewline, eol);
  }
  // An inline empty dict (`providers: {}`, PyYAML's empty-dict dump) means
  // "no children": strip it to the bare header so the splice adds the
  // block instead of writing invalid YAML beside the flow value. An inline
  // empty sequence (`providers: []`) is a real empty sequence, not a mapping
  // with no children — refuse with the shared hint (omp yaml.ts:522 policy).
  const inlineFlow = /^providers\s*:\s*(\{\}|\[\])\s*(#.*)?$/.exec(lines[at]!);
  if (inlineFlow?.[1] === "[]") {
    throw new CliError("config.yaml has a sequence `providers:` value ai& does not edit.", {
      hint: INVALID_CONFIG_HINT,
    });
  }
  if (inlineFlow) {
    lines[at] = keepHeaderComment("providers", lines[at]!);
  }
  // The scalar form carries no body; a mapping's runs to the next column-0
  // line, blank lines and comments included (then minus the trailing blanks).
  const scalar = /^providers\s*:\s*\S/.test(stripTrailingComment(lines[at]!));
  let end = at + 1;
  if (!scalar) {
    while (end < lines.length && isSectionBodyLine(lines[end]!)) end += 1;
  }
  if (!scalar && dropLoneFlowLine(lines, at, end)) {
    // The dropped flow line is gone: re-run the body scan on the shortened
    // lines so the splice lands inside the live range, not past it.
    end = at + 1;
    while (end < lines.length && isSectionBodyLine(lines[end]!)) end += 1;
  }
  while (end > at + 1 && lines[end - 1]!.trim() === "") end -= 1;
  const body = scalar ? [] : lines.slice(at + 1, end);
  // A sequence body (`- item`, a lone `[]`) cannot take a mapping splice.
  if (!scalar) throwOnSequenceBody(body, "providers");
  const header = keepHeaderComment("providers", lines[at]!);
  const indent = /^(\s+)\S/.exec(body.find((line) => /^\s+\S/.test(line)) ?? "")?.[1] ?? "  ";
  // Anchored to the section indent, so a deeper `aiand:` nested inside
  // another provider's own config can never match.
  const providerKey = new RegExp(`^${indent}aiand\\s*:`);
  const subAt = body.findIndex((line) => providerKey.test(line));
  if (subAt === -1)
    return joinYamlLines(
      [...lines.slice(0, at), header, ...body, ...entry(indent), ...lines.slice(end)],
      trailingNewline,
      eol,
    );
  // The block's body runs while lines stay more indented than its own key.
  let subEnd = subAt + 1;
  while (
    subEnd < body.length &&
    (body[subEnd]!.trim() === "" ||
      body[subEnd]!.startsWith(`${indent} `) ||
      isCommentLine(body[subEnd]!))
  )
    subEnd += 1;
  return joinYamlLines(
    [
      ...lines.slice(0, at),
      header,
      ...body.slice(0, subAt),
      ...entry(indent),
      ...body.slice(subEnd),
      ...lines.slice(end),
    ],
    trailingNewline,
    eol,
  );
}
/**
 * Remove our `providers.aiand` block again, dropping the `providers:` map
 * with it when nothing else is left. The exact inverse of
 * pinHermesProvider for a file enable() wrote and nobody touched since.
 */
export function stripHermesProvider(text: string): string {
  const { lines, trailingNewline, eol } = splitYamlLines(text);
  const span = aiandBlockSpan(lines);
  if (!span) return text;
  // The header loses its anchor in the rewrite below: `&base` would strand
  // every `*base` alias in the file. Refuse the by-hand fix instead.
  throwOnInlineSection(lines, "providers");
  const body = [
    ...lines.slice(span.at + 1, span.at + 1 + span.subAt),
    ...lines.slice(span.at + 1 + span.subEnd, span.end),
  ];
  if (body.every((line) => line.trim() === "")) {
    // The append path inserts exactly one blank separator before
    // `providers:`; it leaves with the block, so an unterminated file
    // round-trips to its own bytes instead of a stray blank line (bug #6).
    const head = span.at > 0 && lines[span.at - 1]!.trim() === "" ? span.at - 1 : span.at;
    return joinYamlLines([...lines.slice(0, head), ...lines.slice(span.end)], trailingNewline, eol);
  }
  return joinYamlLines(
    [
      ...lines.slice(0, span.at),
      keepHeaderComment("providers", lines[span.at]!),
      ...body,
      ...lines.slice(span.end),
    ],
    trailingNewline,
    eol,
  );
}
/**
 * Drop a `model.base_url` line from a `model:` body about to route through
 * aiand: Hermes's `_api_key_provider_runtime` prefers `model.base_url` over
 * the provider's own endpoint whenever the config's provider matches, so a
 * fresh install's OpenRouter line sends the ai& key there (401 "Missing
 * Authentication header"). The line's trailing comment survives as its own
 * line at the same indent — the note named the endpoint that must not be
 * used, and dropping the whole line would drop it. Returns whether one was
 * found, so the callers can stay byte-identical when there is nothing to do.
 */
function dropModelBaseUrl(
  body: string[],
  indent: string,
): { dropped: boolean; spot: ModelFieldSpot | undefined } {
  const key = new RegExp(`^${indent}base_url\\s*:`);
  let dropped = false;
  let spot: ModelFieldSpot | undefined;
  // Backwards, so a splice never shifts the index of a line still to visit.
  for (let i = body.length - 1; i >= 0; i -= 1) {
    const line = body[i]!;
    if (!key.test(line)) continue;
    // Dropping a block scalar's header would strand its body as invalid
    // YAML: refuse the same way the default pin does.
    if (childValueIsMultiLine(body, i, indent)) {
      throw new CliError("config.yaml has a multi-line `model.base_url` value ai& does not edit.", {
        hint: INVALID_CONFIG_HINT,
      });
    }
    spot = { line, at: i, indent };
    const comment = commentSuffix(line).trim();
    body.splice(i, 1, ...(comment === "" ? [] : [`${indent}${comment}`]));
    dropped = true;
  }
  return { dropped, spot };
}
/**
 * Rewrite (or add) the top-level `model:` mapping of a hermes config:
 * `provider: aiand` always, the pinned model as `default` only when one
 * is given. Indentation follows the section's own keys; the body-less scalar
 * form (`model: ""`, a fresh install's sentinel) is replaced by the mapping.
 * Hermes accepts `model` as an alias for the model id — an alias or
 * `default` line is rewritten to `default`, the key we own.
 */
export function pinHermesModel(text: string, model: string | undefined): string {
  const { lines, trailingNewline, eol } = splitYamlLines(text);
  const pinned = model === undefined ? null : `default: ${JSON.stringify(model)}`;
  throwOnInlineSection(lines, "model");
  const at = lines.findIndex((line) => /^model\s*:/.test(line));
  if (at === -1) {
    const block = ["model:", "  provider: aiand", ...(pinned ? [`  ${pinned}`] : [])];
    return joinYamlLines([...block, ...lines], trailingNewline, eol);
  }
  // An inline empty dict (`model: {}`, PyYAML's empty-dict dump) takes the
  // pinned provider without leaving a stale flow value beside the mapping.
  // An inline empty sequence (`model: []`) is refused like providers:.
  const inlineFlow = /^model\s*:\s*(\{\}|\[\])\s*(#.*)?$/.exec(lines[at]!);
  if (inlineFlow?.[1] === "[]") {
    throw new CliError("config.yaml has a sequence `model:` value ai& does not edit.", {
      hint: INVALID_CONFIG_HINT,
    });
  }
  if (inlineFlow) {
    lines[at] = keepHeaderComment("model", lines[at]!);
  }
  // The scalar form carries no body; a mapping's runs to the next column-0
  // line, blank lines and comments included (then minus the trailing blanks).
  const scalar = /^model\s*:\s*\S/.test(stripTrailingComment(lines[at]!));
  let end = at + 1;
  if (!scalar) {
    while (end < lines.length && isSectionBodyLine(lines[end]!)) end += 1;
  }
  if (!scalar && dropLoneFlowLine(lines, at, end)) {
    end = at + 1;
    while (end < lines.length && isSectionBodyLine(lines[end]!)) end += 1;
  }
  while (end > at + 1 && lines[end - 1]!.trim() === "") end -= 1;
  const body = scalar ? [] : lines.slice(at + 1, end);
  if (!scalar) throwOnSequenceBody(body, "model");
  const header = keepHeaderComment("model", lines[at]!);
  const indent = /^(\s+)\S/.exec(body.find((line) => /^\s+\w/.test(line)) ?? "")?.[1] ?? "  ";
  const providerKey = new RegExp(`^${indent}provider\\s*:`);
  const modelKey = new RegExp(`^${indent}(?:"?default"?|model)\\s*:`);
  const modelIdx = body.findIndex((line) => modelKey.test(line));
  // Splicing the header line alone would strand a multi-line value's body
  // (block scalar, folded body) as invalid YAML — refuse instead.
  // A delete over a multi-line default refuses the same way.
  if (modelIdx !== -1 && childValueIsMultiLine(body, modelIdx, indent)) {
    throw new CliError("config.yaml has a multi-line `model.default` value ai& does not edit.", {
      hint: INVALID_CONFIG_HINT,
    });
  }
  // The dropped default's trailing comment rides onto the fresh pinned line
  // so a `default: u  # keep` pin keeps its note.
  const droppedDefault = pinned !== null ? body.find((line) => modelKey.test(line)) : undefined;
  const defaultSuffix = droppedDefault ? commentSuffix(droppedDefault) : "";
  dropModelBaseUrl(body, indent);
  const out: string[] = [];
  let providerAt = -1;
  for (const line of body) {
    if (providerKey.test(line)) {
      out.push(keepLineComment(`${indent}provider: aiand`, line));
      providerAt = out.length - 1;
    } else if (!(pinned !== null && modelKey.test(line))) {
      out.push(line); // dropped: rewritten after the provider line
    }
  }
  if (providerAt === -1) {
    out.unshift(`${indent}provider: aiand`);
    providerAt = 0;
  }
  if (pinned !== null) {
    const fresh = `${indent}${pinned}`;
    out.splice(providerAt + 1, 0, defaultSuffix ? `${fresh}${defaultSuffix}` : fresh);
  }
  // The header becomes the bare `model:` key: a scalar value left standing
  // in front of the mapping would not parse.
  return joinYamlLines(
    [...lines.slice(0, at), header, ...out, ...lines.slice(end)],
    trailingNewline,
    eol,
  );
}
/**
 * Route one `model:` field through aiand without touching the other, for
 * the keeps the overlay never performs: a kept servable default stays
 * byte-identical while its provider flips. Values already routing stay put.
 */
export function setHermesModelProvider(text: string): string {
  const { lines, trailingNewline, eol } = splitYamlLines(text);
  throwOnInlineSection(lines, "model");
  const section = modelSection(lines);
  if (!section) return text;
  const { body, indent } = section;
  const providerKey = modelFieldPattern("provider", indent);
  const at = body.findIndex((line) => providerKey.test(line));
  const alreadyRouted =
    at !== -1 &&
    unquoteYaml(stripTrailingComment(body[at]!.replace(providerKey, ""))) === HERMES_PROVIDER_ID;
  if (!alreadyRouted) {
    if (at !== -1) {
      body[at] = keepLineComment(`${indent}provider: ${HERMES_PROVIDER_ID}`, body[at]!);
    } else {
      body.unshift(`${indent}provider: ${HERMES_PROVIDER_ID}`);
    }
  }
  // The drop runs before the idempotent return: a provider already reading
  // `aiand` still rides the user's own `model.base_url`, so leaving it in
  // place keeps the endpoint hijack — and recording a restore target for a
  // line nobody dropped makes `off` claim the user edited it.
  const dropped = dropModelBaseUrl(body, indent);
  if (alreadyRouted && !dropped.dropped) return text;
  return rejoinModel(lines, section, body, trailingNewline, eol);
}
/** Put one recorded `model:` line back (or delete the field when none was recorded). */
export function restoreHermesModelLine(
  text: string,
  field: "provider" | "default" | "base_url",
  spot: ModelFieldSpot | string | undefined,
): string {
  const { lines, trailingNewline, eol } = splitYamlLines(text);
  throwOnInlineSection(lines, "model");
  const section = modelSection(lines);
  // A raw line is the legacy string form: it keeps the old positional
  // heuristics, so callers that never captured a spot still restore.
  const recorded = typeof spot === "string" ? undefined : spot;
  const line = typeof spot === "string" ? spot : recorded?.line;
  // No section left to restore into: a base_url-only body is emptied by the
  // default and provider restores first, so the header is gone by the time
  // the last line comes back (bug #1) — recreate it rather than lose the line.
  if (!section) {
    if (line === undefined) return text;
    return joinYamlLines(["model:", line, ...lines], trailingNewline, eol);
  }
  const { body, indent } = section;
  const pattern = modelFieldPattern(field, indent);
  const at = body.findIndex((candidate) => pattern.test(candidate));
  // Replacing or deleting a multi-line value's header alone strands its
  // body (block scalar, folded body) — refuse instead.
  if (at !== -1 && childValueIsMultiLine(body, at, indent)) {
    throw new CliError(`config.yaml has a multi-line \`model.${field}\` value ai& does not edit.`, {
      hint: INVALID_CONFIG_HINT,
    });
  }
  if (line === undefined) {
    if (at === -1) return text;
    body.splice(at, 1);
    // Our lines were the section's whole body: drop the bare header too.
    if (body.every((candidate) => candidate.trim() === "")) {
      return joinYamlLines(
        [...lines.slice(0, section.at), ...lines.slice(section.end)],
        trailingNewline,
        eol,
      );
    }
    return rejoinModel(lines, section, body, trailingNewline, eol);
  }
  if (at !== -1) {
    // The field is back (the user's own, or a second restore): the recorded
    // line takes that slot, never a second key beside it.
    body.splice(at, 1);
  }
  // The drop and the pins shifted the body, so the recorded index is a
  // position to clamp, never an identity to trust.
  const anchor =
    recorded === undefined ? undefined : Math.min(Math.max(recorded.at, 0), body.length);
  if (recorded !== undefined && anchor !== undefined) {
    // A drop that carried a trailing comment left a lone `${indent}# note`
    // placeholder: the recorded line (comment once) takes that slot, so the
    // note never comes back twice (bug #3). The pins can shift the
    // placeholder off its index — scan for it, and fall back to the clamped
    // position only when the user replaced it with their own base_url.
    const note = commentSuffix(recorded.line).trim();
    const holder = note === "" ? -1 : body.indexOf(`${recorded.indent}${note}`);
    // A pure insert never eats the neighbour now standing at the anchor.
    body.splice(holder === -1 ? anchor : holder, holder === -1 ? 0 : 1, line);
  } else if (field === "default") {
    // Beside the provider line, where pinHermesModel puts it.
    const providerAt = body.findIndex((candidate) =>
      modelFieldPattern("provider", indent).test(candidate),
    );
    body.splice(providerAt !== -1 ? providerAt + 1 : body.length, 0, line);
  } else if (field === "base_url") {
    // Last, after the fields pinHermesModel writes in front of it, so the
    // section's own key order survives the round trip.
    body.push(line);
  } else {
    // First, where pinHermesModel puts the provider line.
    body.unshift(line);
  }
  return rejoinModel(lines, section, body, trailingNewline, eol);
}
