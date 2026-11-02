import { isDeepStrictEqual } from "node:util";
import { modelLabel, type Model } from "../../api/models.js";
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

const TOKENS_PER_K = 1024;

function contextLabel(tokens: number): string {
  if (!(tokens > 0)) return "";
  const k = Math.round(tokens / TOKENS_PER_K);
  return k >= TOKENS_PER_K ? ` · ${Math.round(k / TOKENS_PER_K)}M context` : ` · ${k}K context`;
}

export function buildModelPicker(catalog: Model[]): ModelPicker {
  return {
    options: catalog.map((model) => ({
      model: model.id,
      label: modelLabel(model.id),
      description: `ai& · ${visionLabel(model)}${contextLabel(model.context_window)}`,
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
