// Pure YAML-shape detection for the Hermes routing, split from routing.ts by
// responsibility (the repo's 650-line module gate): the probes that decide
// whether a config.yaml shape is safe to edit, and refuse with the shared
// hint when it is not. These read shapes only — nothing here writes — and the
// line surgery those guards protect lives in routing.ts and yaml.ts.
import { CliError } from "../../cli/errors.js";
import { HERMES_PROVIDER_ID } from "./plugin.js";
import {
  inlineSectionValue,
  isCommentLine,
  listSectionEnd,
  parseListEntries,
  splitListItems,
  stripTrailingComment,
  unquoteYaml,
} from "./yaml.js";

/** Recovery hint for a config.yaml shape aiand cannot splice without corrupting. */
export const INVALID_CONFIG_HINT =
  "Fix config.yaml by hand, or delete it and run aiand hermes on again.";

/**
 * A mapping section whose body is sequence-shaped (`- item` or a lone `[]`)
 * cannot take our mapping splice: refuse with the shared hint instead of
 * emitting invalid YAML.
 */
export function throwOnSequenceBody(body: string[], section: "providers" | "model"): void {
  const first = body.find((line) => line.trim() !== "" && !isCommentLine(line));
  if (first === undefined) return;
  const code = stripTrailingComment(first).trim();
  if (code === "[]" || code === "-" || code.startsWith("- ")) {
    throw new CliError(`config.yaml has a sequence \`${section}:\` value ai& does not edit.`, {
      hint: INVALID_CONFIG_HINT,
    });
  }
}

/**
 * Refuse the shape a bare-header splice would silently destroy: a header
 * carrying an inline flow map (`providers: {openrouter: …}`) holds every
 * sibling inside the value's own lines, and an anchor (`providers: &base`)
 * names a mapping body our splice never rewrites — treating either as a
 * scalar section drops the flow map's providers, or strands a duplicated
 * block beside a now-duplicate one. Neither is ours to edit: the by-hand
 * hint names the file and the command to retry with.
 */
export function throwOnInlineSection(lines: string[], section: "providers" | "model"): void {
  const at = lines.findIndex((line) => new RegExp(`^${section}\\s*:`).test(line));
  if (at === -1) return;
  const value = inlineSectionValue(lines[at]!, section);
  // PyYAML's empty-container dump (`{}`, and a lone `{}` body line) is the
  // "no children" sentinel the splice already rewrites to a bare header; a
  // populated flow map holds siblings the splice cannot express, so only
  // those refuse.
  if (value !== "" && value !== "{}") {
    throw new CliError(`config.yaml has an inline \`${section}:\` value ai& does not edit.`, {
      hint: INVALID_CONFIG_HINT,
    });
  }
}

/**
 * A flow-map `providers:` body holding an `aiand` key
 * (`providers: {aiand: {…}}`): Hermes reads it exactly like the block form,
 * so probe and the foreign refusal must too — never splice a second block
 * beside the one the flow map already carries.
 */
export function hasFlowAiandBlock(lines: string[]): boolean {
  const at = lines.findIndex((line) => /^providers\s*:/.test(line));
  if (at === -1) return false;
  const value = inlineSectionValue(lines[at]!, "providers");
  if (!value.startsWith("{")) return false;
  // Flatten nested containers away first: only a key at the flow map's own
  // level counts, so another provider's own `config: {aiand: …}` never
  // reads as ours.
  let flat = value.slice(1, -1);
  while (/\{[^{}]*\}/.test(flat)) flat = flat.replace(/\{[^{}]*\}/g, "");
  return /(?:^|,)\s*aiand\s*:/.test(flat);
}

/**
 * A legacy `custom_providers:` list entry naming aiand. Upstream once read
 * the list; aiand only ever writes the dict, so an entry is always foreign:
 * it counts as presence (probe stays honest) and refuses the dict write
 * (pin never splices a duplicate beside it). Entries may key the provider
 * by `name:` or `id:` (no bundled example pins the shape, so both read), or
 * name it as a plain string (`- aiand`, bare or quoted); only the dash-line
 * remainder and the item's own level count, so a model nested deeper can
 * never false-positive.
 */
export function legacyListHasAiand(lines: string[], at: number, end: number): boolean {
  return splitListItems(lines, at, end).some((item) => {
    const keyed = parseListEntries(item);
    const nested = keyed.filter((entry) => entry.isHeader && entry.indent !== "");
    const level =
      nested.length === 0
        ? null
        : nested.reduce(
            (min, entry) => (entry.indent.length < min.length ? entry.indent : min),
            nested[0]!.indent,
          );
    return keyed.some((entry) => {
      if (entry.isHeader) {
        if (entry.indent !== "" && entry.indent !== level) return false;
        if (entry.key !== "name" && entry.key !== "id") return false;
        const value = entry.rest.trim();
        if (value === "" || value.startsWith("{") || value.startsWith("[")) return false;
        return unquoteYaml(value) === HERMES_PROVIDER_ID;
      }
      // A plain-string item (`- aiand`, bare or quoted) names the provider
      // directly — no name:/id: key to match.
      return entry.indent === "" && unquoteYaml(entry.text) === HERMES_PROVIDER_ID;
    });
  });
}

export function hasLegacyAiandEntryLines(lines: string[]): boolean {
  const section = legacyListSection(lines);
  if (!section) return false;
  return legacyListHasAiand(lines, section.at, section.end);
}

/**
 * The `custom_providers:` section range for the legacy scan: the header plus
 * a list-aware body (a block sequence may sit at the header's own column,
 * which PyYAML writes by default — see listSectionEnd).
 */
export function legacyListSection(lines: string[]): { at: number; end: number } | null {
  const at = lines.findIndex((line) => /^custom_providers\s*:/.test(line));
  if (at === -1) return null;
  assertCustomProvidersHeader(lines[at]!);
  return { at, end: listSectionEnd(lines, at) };
}

/** A top-level `custom_providers:` header must carry no inline value for us to read it. */
function assertCustomProvidersHeader(line: string): void {
  if (/^custom_providers\s*:\s*\S/.test(stripTrailingComment(line))) {
    throw new CliError("config.yaml has a `custom_providers:` entry ai& does not edit.", {
      hint: INVALID_CONFIG_HINT,
    });
  }
}
