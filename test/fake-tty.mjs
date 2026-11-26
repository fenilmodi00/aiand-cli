// Preloaded (node --import) into a CLI child to make it believe stdout and
// stderr are a terminal, so tests can exercise TTY-only paths through a pipe.
// AIAND_TEST_FAKE_TTY_STDIN=1 does the same for stdin, with a no-op
// setRawMode so readline's terminal mode accepts the pipe.
for (const stream of [process.stdout, process.stderr]) {
  Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
}
if (process.env.AIAND_TEST_FAKE_TTY_STDIN === "1") {
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  process.stdin.setRawMode = () => process.stdin;
}
