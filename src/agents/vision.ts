import type { Model } from "../api/models.js";

/**
 * Whether a catalog model accepts image input. A model is vision-capable when
 * its capability list contains "vision"; everything else is text-only.
 */
export function visionLabel(model: Model): "vision" | "text-only" {
  return model.capabilities.includes("vision") ? "vision" : "text-only";
}

/**
 * One stderr warning line naming the text-only models just wired. Empty list →
 * empty string (callers skip the line entirely).
 */
export function formatTextOnlyWarning(ids: string[]): string {
  if (ids.length === 0) return "";
  return `Text-only: ${ids.join(", ")} · Avoid images; recover with /rewind.`;
}