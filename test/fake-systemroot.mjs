// Preloaded into every test subprocess (NODE_OPTIONS, set by test/setup.mjs).
// Node aborts at startup on Windows when SystemRoot is missing or points at a
// directory with no Windows in it, so a test that wants the CLI to look for
// System32 tools under a fake root starts its child with the real SystemRoot
// and AIAND_TEST_FAKE_SYSTEMROOT, which takes effect here, after startup.
if (process.env.AIAND_TEST_FAKE_SYSTEMROOT !== undefined) {
  process.env.SystemRoot = process.env.AIAND_TEST_FAKE_SYSTEMROOT;
  delete process.env.AIAND_TEST_FAKE_SYSTEMROOT;
}
