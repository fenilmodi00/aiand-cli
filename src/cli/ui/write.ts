import { createTheme } from "./theme.js";
import { fail, ok, warn as uiWarn } from "./style.js";

const stdoutTheme = createTheme(process.stdout);

function writeLine(stream: NodeJS.WriteStream, message: string): void {
  stream.write(`${message}\n`);
}

export function blank(): void {
  process.stdout.write("\n");
}

export function section(title: string): void {
  blank();
  writeLine(process.stdout, stdoutTheme.heading(title));
}

export function info(message: string): void {
  const { symbols, muted } = stdoutTheme;
  writeLine(process.stdout, `${muted(symbols.info)} ${message}`);
}

export function success(message: string): void {
  writeLine(process.stdout, ok(message));
}

export function warn(message: string): void {
  writeLine(process.stderr, uiWarn(message));
}

export function error(message: string): void {
  writeLine(process.stderr, fail(`Error: ${message}`));
}
