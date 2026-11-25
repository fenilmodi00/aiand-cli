/**
 * Scrub credentials out of text bound for the terminal: error reasons that
 * echo a request (undici quotes a rejected header value whole), server error
 * bodies, and crash stacks. A quoted Bearer value goes first, so a key split
 * by a line break loses its tail too.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\/\/[^/@\s]+@/g, "//[redacted]@")
    .replace(/(["'])Bearer\s[^"']*\1/gi, "$1Bearer [redacted]$1")
    .replace(/Bearer\s+(?!\[redacted\])\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "sk-[redacted]");
}

const PRINTABLE_KEY = /^[\x21-\x7e]+$/;

export const INVALID_KEY_MESSAGE =
  "API key contains invalid characters (check for a line break or space)";

/** True for a key that can ride an Authorization header verbatim. */
export const isValidKeyShape = (key: string): boolean => PRINTABLE_KEY.test(key);
