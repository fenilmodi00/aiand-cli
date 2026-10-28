import { stderr, stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { CliError, cancelled, EXIT } from "./errors.js";
import { withoutSpinner } from "./output.js";
import { KEY, type PromptInput, type PromptOutput } from "./select.js";

/**
 * Read a single line of visible (echoed) input from stdin. Used by `readSecret`
 * on the non-TTY / Windows path. Prompt chrome goes to stderr so `--json`
 * stdout stays pure.
 */
export async function readLineVisible(
  prompt: string,
  options: { input?: PromptInput; output?: PromptOutput } = {},
): Promise<string> {
  // Unchecked casts: FakeInput tests satisfy the readline shape but not the
  // full stream surface. try/finally: a leaked interface keeps stdin open
  // after a paste login and hangs the process.
  const rl = createInterface({
    input: (options.input ?? stdin) as unknown as NodeJS.ReadableStream,
    output: (options.output ?? stderr) as unknown as NodeJS.WritableStream,
  });
  try {
    return await withoutSpinner(() => rl.question(prompt));
  } catch (error) {
    if ((error as Error).name === "AbortError") throw cancelled();
    throw error;
  } finally {
    rl.close();
  }
}

/**
 * Read a secret from stdin, echoing a `*` mask per character on Unix TTYs so a
 * paste is visible (and a backspace erases one mask char) without revealing the
 * key. Non-TTY/Windows falls back to ordinary visible input. Ctrl-C exits 130.
 * Prompt and mask go to stderr so `--json` stdout stays pure.
 */
export async function readSecret(
  prompt: string,
  options: {
    allowEmpty?: boolean;
    /** Test seam: raw-mode input stream (defaults to the real stdin). */
    input?: PromptInput;
    /** Test seam: where the mask echo is written (defaults to stderr). */
    output?: PromptOutput;
  } = {},
): Promise<string> {
  const { allowEmpty = false, output = stderr } = options;
  const input: PromptInput = options.input ?? stdin;
  if (!input.isTTY || process.platform === "win32") {
    if (input.isTTY && process.platform === "win32") {
      output.write("Note: input is visible on Windows.\n");
    }
    const line = (await readLineVisible(prompt, { input, output })).trim();
    if (!allowEmpty && !line)
      throw new CliError("Input required.", { exitCode: EXIT.NOT_SIGNED_IN });
    return line;
  }

  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");

  let value = "";
  // Escape state persists across chunks so a CSI split over two writes is
  // still swallowed as one sequence (same shape as select.ts createKeyParser).
  let pendingEsc = false;
  let inEscape = false;
  try {
    value = await withoutSpinner(
      () =>
        new Promise<string>((resolve, reject) => {
          const stop = () => {
            input.removeListener("data", onData);
            input.removeListener("end", onEnd);
          };
          const onEnd = () => {
            stop();
            reject(
              new CliError("Input ended.", {
                hint: "This prompt needs an interactive terminal.",
              }),
            );
          };
          const onData = (chunk: string) => {
            for (const char of chunk) {
              if (char === KEY.CTRL_C) {
                stop();
                output.write("^C\n");
                reject(cancelled());
                return;
              }
              if (char === KEY.ENTER_CR || char === KEY.ENTER_LF) {
                stop();
                resolve(value);
                return;
              }
              if (inEscape) {
                const code = char.codePointAt(0) ?? 0;
                if (code >= 0x40 && code <= 0x7e) {
                  inEscape = false;
                  pendingEsc = false;
                  continue;
                }
                if (code >= 0x20 && code <= 0x3f) {
                  continue;
                }
                inEscape = false;
                pendingEsc = false;
              }
              if (pendingEsc) {
                if (char === "[" || char === "O") {
                  inEscape = true;
                  continue;
                }
                pendingEsc = false;
                if (char === KEY.ESC) {
                  pendingEsc = true;
                  continue;
                }
              } else if (char === KEY.ESC) {
                pendingEsc = true;
                continue;
              }
              if (char === KEY.BACKSPACE_DEL || char === KEY.BACKSPACE_BS) {
                if (value) {
                  value = value.slice(0, -1);
                  output.write(String.fromCharCode(8, 32, 8)); // backspace-space-backspace: erase one mask char
                }
                continue;
              }
              const code = char.codePointAt(0) ?? 0;
              if (code < 0x20 || (code >= 0x80 && code <= 0x9f)) {
                continue; // C0/C1 controls (Tab, Ctrl-D, etc.) are not key material
              }
              value += char;
              output.write("*"); // mask echo: confirms a paste landed without showing the key
            }
          };
          input.on("data", onData);
          input.on("end", onEnd);
        }),
    );
  } finally {
    input.setRawMode(false);
    output.write("\n");
  }

  const trimmed = value.trim();
  if (!allowEmpty && !trimmed)
    throw new CliError("Input required.", { exitCode: EXIT.NOT_SIGNED_IN });
  return trimmed;
}

/**
 * Whether this CLI can ask the user anything interactively. Prompts keyed on
 * this return their default instead of hanging in CI and pipes.
 */
export function isInteractive(): boolean {
  return stdin.isTTY === true && stdout.isTTY === true;
}

/**
 * Ask a yes/no question. Non-TTY returns the default instead of hanging, so
 * CI gets deterministic behavior for every interactive gate.
 */
export async function confirm(
  message: string,
  options: {
    default?: boolean;
    /** Test seam: input stream (defaults to stdin). */
    input?: PromptInput;
    /** Test seam: output stream (defaults to stderr via readLineVisible). */
    output?: PromptOutput;
  } = {},
): Promise<boolean> {
  const fallback = options.default ?? false;
  const input = options.input ?? stdin;
  const interactive = options.input ? input.isTTY : isInteractive();
  if (!interactive) return fallback;

  const hint = fallback ? "[Y/n] " : "[y/N] ";
  const answer = (await readLineVisible(`${message} ${hint}`, options)).trim().toLowerCase();
  if (answer === "") return fallback;
  return answer === "y" || answer === "yes";
}
