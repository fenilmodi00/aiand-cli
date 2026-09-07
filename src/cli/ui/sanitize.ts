/**
 * Strip terminal escapes and control characters from untrusted text before
 * writing it to a TTY (session titles, prompts, model ids, etc.).
 */
export function sanitize(text: unknown): string {
  return String(text ?? "")
    .replace(/\][^\u0007]*(?:\u0007|\\)?/g, "")
    .replace(/\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[@-Z\\-_]/g, "")
    .replace(/[─\b\x0e-\x1f\x7f-\x9f]/g, "");
}
