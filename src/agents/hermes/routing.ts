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

/** The raw source line of one `model:` field, so off can hand back the exact bytes. */
export function modelFieldLine(text: string, field: "provider" | "default"): string | undefined {
  const lines = splitYamlLines(text).lines;
  const section = sectionRange(lines, "model");
  if (!section) return undefined;
  const body = lines.slice(section.at + 1, section.end);
  const indent = /^(\s+)\S/.exec(body.find((line) => /^\s+\w/.test(line)) ?? "")?.[1] ?? "  ";
  const pattern =
    field === "provider"
      ? new RegExp(`^${indent}provider\\s*:`)
      : new RegExp(`^${indent}(?:"?default"?|model)\\s*:`);
  return body.find((line) => pattern.test(line));
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
    // trailing newline of its own.
    return joinYamlLines([...lines, ...gap, "providers:", ...entry("  ")], false, eol);
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
    return joinYamlLines(
      [...lines.slice(0, span.at), ...lines.slice(span.end)],
      trailingNewline,
      eol,
    );
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
function dropModelBaseUrl(body: string[], indent: string): boolean {
  const key = new RegExp(`^${indent}base_url\\s*:`);
  let dropped = false;
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
    const comment = commentSuffix(line).trim();
    body.splice(i, 1, ...(comment === "" ? [] : [`${indent}${comment}`]));
    dropped = true;
  }
  return dropped;
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
  const section = sectionRange(lines, "model");
  if (!section) return text;
  const body = lines.slice(section.at + 1, section.end);
  const indent = /^(\s+)\S/.exec(body.find((line) => /^\s+\w/.test(line)) ?? "")?.[1] ?? "  ";
  const providerKey = new RegExp(`^${indent}provider\\s*:`);
  const at = body.findIndex((line) => providerKey.test(line));
  if (at !== -1) {
    if (
      unquoteYaml(stripTrailingComment(body[at]!.replace(providerKey, ""))) === HERMES_PROVIDER_ID
    )
      return text;
    body[at] = keepLineComment(`${indent}provider: ${HERMES_PROVIDER_ID}`, body[at]!);
  } else {
    body.unshift(`${indent}provider: ${HERMES_PROVIDER_ID}`);
  }
  // The provider line stands after the idempotence check: a config already
  // routing through aiand is left byte-identical, so a base_url our own
  // drop removed never reappears on a second `on`.
  dropModelBaseUrl(body, indent);
  // The header becomes the bare `model:` key: a scalar sentinel left
  // standing in front of the mapping would not parse.
  return joinYamlLines(
    [
      ...lines.slice(0, section.at),
      keepHeaderComment("model", lines[section.at]!),
      ...body,
      ...lines.slice(section.end),
    ],
    trailingNewline,
    eol,
  );
}
/** Put one recorded `model:` line back (or delete the field when none was recorded). */
export function restoreHermesModelLine(
  text: string,
  field: "provider" | "default",
  recorded: string | undefined,
): string {
  const { lines, trailingNewline, eol } = splitYamlLines(text);
  throwOnInlineSection(lines, "model");
  const section = sectionRange(lines, "model");
  if (!section) return text;
  const body = lines.slice(section.at + 1, section.end);
  const indent = /^(\s+)\S/.exec(body.find((line) => /^\s+\w/.test(line)) ?? "")?.[1] ?? "  ";
  const pattern =
    field === "provider"
      ? new RegExp(`^${indent}provider\\s*:`)
      : new RegExp(`^${indent}(?:"?default"?|model)\\s*:`);
  const at = body.findIndex((line) => pattern.test(line));
  // Replacing or deleting a multi-line value's header alone strands its
  // body (block scalar, folded body) — refuse instead.
  if (at !== -1 && childValueIsMultiLine(body, at, indent)) {
    throw new CliError(`config.yaml has a multi-line \`model.${field}\` value ai& does not edit.`, {
      hint: INVALID_CONFIG_HINT,
    });
  }
  if (recorded !== undefined) {
    if (at !== -1) {
      body[at] = recorded;
    } else if (field === "default") {
      // Beside the provider line, where pinHermesModel puts it.
      const providerKey = new RegExp(`^${indent}provider\\s*:`);
      const providerAt = body.findIndex((line) => providerKey.test(line));
      body.splice(providerAt !== -1 ? providerAt + 1 : body.length, 0, recorded);
    } else {
      // First, where pinHermesModel puts the provider line.
      body.unshift(recorded);
    }
    // The header is the bare `model:` key: a scalar sentinel left standing
    // in front of the restored mapping would not parse.
    return joinYamlLines(
      [
        ...lines.slice(0, section.at),
        keepHeaderComment("model", lines[section.at]!),
        ...body,
        ...lines.slice(section.end),
      ],
      trailingNewline,
      eol,
    );
  }
  if (at === -1) return text;
  body.splice(at, 1);
  if (body.every((line) => line.trim() === "")) {
    // Our lines were the section's whole body: drop the bare header too.
    return joinYamlLines(
      [...lines.slice(0, section.at), ...lines.slice(section.end)],
      trailingNewline,
      eol,
    );
  }
  return joinYamlLines(
    [
      ...lines.slice(0, section.at),
      keepHeaderComment("model", lines[section.at]!),
      ...body,
      ...lines.slice(section.end),
    ],
    trailingNewline,
    eol,
  );
}
