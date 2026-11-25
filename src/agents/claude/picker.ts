import { isDeepStrictEqual } from "node:util";
import type { Model } from "../../api/models.js";
import { visionLabel } from "../catalog.js";
import { jsoncDelete, jsoncSet } from "../managed-file.js";

/**
 * Claude Code's gateway model discovery keeps only ids containing "claude" or
 * "anthropic", so ai&'s models never reach its /model picker on their own;
 * the `modelPicker` setting lists them instead.
 */
const PICKER_KEY = "modelPicker";

type PickerRow = { model: string; label: string; description: string };
export type ModelPicker = { options: PickerRow[]; replaceBuiltInOptions: boolean };

/** Picker labels describe the published window, independently of the startup hint. */
function contextLabel(tokens: number): string {
  if (!Number.isSafeInteger(tokens) || tokens <= 0) return "";
  if (tokens >= 1_000_000) {
    return ` · ${Number((tokens / (tokens % 1000 === 0 ? 1_000_000 : 1_048_576)).toFixed(2))}M context`;
  }
  const k = tokens % 1000 === 0 ? tokens / 1000 : Math.round(tokens / 1024);
  return ` · ${k}K context`;
}

export function buildModelPicker(catalog: Model[]): ModelPicker {
  return {
    options: catalog.map((model) => ({
      model: model.id,
      label: model.name || model.id,
      description: `ai&${contextLabel(model.context_window)}${visionLabel(model) === "text-only" ? " · text only" : ""}`,
    })),
    // The built-in Opus, Sonnet and Haiku rows would run ai&'s slot models
    // under Anthropic names, so the picker shows only ai&'s own.
    replaceBuiltInOptions: true,
  };
}

export function applyModelPicker(
  text: string,
  current: unknown,
  recorded: unknown,
  picker: ModelPicker,
): { text: string; recorded?: unknown; warning?: string } {
  if (current === undefined || (recorded !== undefined && isDeepStrictEqual(current, recorded))) {
    return { text: jsoncSet(text, [PICKER_KEY], picker), recorded: picker };
  }
  if (recorded !== undefined) {
    return { text, recorded, warning: "Left modelPicker because you edited it." };
  }
  return {
    text,
    warning:
      "Kept your own modelPicker, so /model does not list ai& models; remove it and run aiand claude on again to list them.",
  };
}

export function stripModelPicker(
  text: string,
  current: unknown,
  recorded: unknown,
): { text: string; note?: string } {
  if (recorded === undefined || current === undefined) return { text };
  if (isDeepStrictEqual(current, recorded)) return { text: jsoncDelete(text, [PICKER_KEY]) };
  return { text, note: "left modelPicker because you edited it" };
}
