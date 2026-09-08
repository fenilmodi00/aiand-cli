import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { KEY, type PromptInput, type PromptOutput } from "./select.js";

/**
 * Read a single line of visible (echoed) input from stdin. Used by `readSecret`
 * on the non-TTY / Windows path.
 */
export async function readLineVisible(prompt: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

/**
 * Read a secret from stdin, echoing a `*` mask per character on Unix TTYs so a
 * paste is visible (and a backspace erases one mask char) without revealing the
 * key. Non-TTY/Windows falls back to ordinary visible input. Ctrl-C exits 130.
 */
export async function readSecret(
  prompt: string,
  options: {
    allowEmpty?: boolean;
    /** Test seam: raw-mode input stream (defaults to the real stdin). */
    input?: PromptInput;
    /** Test seam: where the mask echo is written (defaults to stdout). */
    output?: PromptOutput;
  } = {},
): Promise<string> {
  const { allowEmpty = false, output = stdout } = options;
  const input: PromptInput = options.input ?? stdin;
  if (!input.isTTY || process.platform === "win32") {
    if (input.isTTY && process.platform === "win32") {
      output.write("Note: input is visible on Windows.\n");
    }
    const line = (
      await createInterface({
        // Unchecked cast: FakeInput tests satisfy the readline shape but not
        // the full ReadableStream surface.
        input: input as unknown as NodeJS.ReadableStream,
        output: output as unknown as NodeJS.WritableStream,
      }).question(prompt)
    ).trim();
    if (!allowEmpty && !line) throw new Error("Input required");
    return line;
  }

  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");

  let value = "";
  try {
    value = await new Promise<string>((resolve) => {
      const onData = (chunk: string) => {
        for (const char of chunk) {
          if (char === KEY.CTRL_C) {
            input.removeListener("data", onData);
            output.write("^C\n");
            process.exit(130);
          }
          if (char === "\r" || char === "\n") {
            input.removeListener("data", onData);
            resolve(value);
            return;
          }
          if (char === "\x7f" || char === "\b") {
            if (value) {
              value = value.slice(0, -1);
              output.write(String.fromCharCode(8, 32, 8)); // backspace-space-backspace: erase one mask char
            }
            continue;
          }
          value += char;
          output.write("*"); // mask echo: confirms a paste landed without showing the key
        }
      };
      input.on("data", onData);
    });
  } finally {
    input.setRawMode(false);
    input.pause();
    output.write("\n");
  }

  const trimmed = value.trim();
  if (!allowEmpty && !trimmed) throw new Error("Input required");
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
export async function confirm(message: string, options: { default?: boolean } = {}): Promise<boolean> {
  const fallback = options.default ?? false;
  if (!isInteractive()) return fallback;

  const hint = fallback ? "[Y/n] " : "[y/N] ";
  const answer = (await readLineVisible(`${message} ${hint}`)).trim().toLowerCase();
  if (answer === "") return fallback;
  return answer === "y" || answer === "yes";
}
