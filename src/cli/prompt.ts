import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

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
export async function readSecret(prompt: string, options: { allowEmpty?: boolean } = {}): Promise<string> {
  const allowEmpty = options.allowEmpty ?? false;
  if (!stdin.isTTY || process.platform === "win32") {
    if (stdin.isTTY && process.platform === "win32") {
      stdout.write("Note: input is visible on Windows.\n");
    }
    const line = (await readLineVisible(prompt)).trim();
    if (!allowEmpty && !line) throw new Error("Input required");
    return line;
  }

  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  let value = "";
  try {
    value = await new Promise<string>((resolve) => {
      const onData = (chunk: string) => {
        for (const char of chunk) {
          if (char === "") {
            stdin.removeListener("data", onData);
            stdout.write("^C\n");
            process.exit(130);
          }
          if (char === "\r" || char === "\n") {
            stdin.removeListener("data", onData);
            resolve(value);
            return;
          }
          if (char === "" || char === "\b") {
            if (value) {
              value = value.slice(0, -1);
              stdout.write(String.fromCharCode(8, 32, 8)); // backspace-space-backspace: erase one mask char
            }
            continue;
          }
          value += char;
          stdout.write("*"); // mask echo: confirms a paste landed without showing the key
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    stdout.write("\n");
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
