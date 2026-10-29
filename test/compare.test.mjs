import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cliEnv, runCli, withTestEnv } from "./helpers.mjs";

/**
 * Ticket #129 — `aiand compare` task packs: add/tasks/validate + the
 * null-harness control. CLI tests run the built dist CLI under an isolated
 * AIAND_CONFIG_DIR; verify scripts are real `sh` scripts.
 */

const env = withTestEnv("compare", () => {});

function cfg(name) {
  const dir = join(env.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A task whose verify fails untouched and passes once a file exists. */
async function addPassingTask(cfgDir, id) {
  const add = await runCli(["compare", "add", id, "--verify", "sh -c 'test -f solved.txt'"], {
    env: cliEnv({ AIAND_CONFIG_DIR: cfgDir }),
  });
  assert.equal(add.code, 0, `add exits 0\n${add.stderr}`);
  writeFileSync(
    join(cfgDir, "tasks", id, "verify.sh"),
    "#!/bin/sh\nif [ -f solved.txt ]; then echo 'SCORE: 1'; exit 0; else echo 'not solved'; exit 1; fi\n",
  );
  return join(cfgDir, "tasks", id);
}

test("compare add scaffolds the task pack and registers in help", async () => {
  const dir = cfg("scaffold");
  const res = await runCli(["compare", "add", "fix-bug", "--verify", "npm test"], {
    env: cliEnv({ AIAND_CONFIG_DIR: dir }),
  });
  assert.equal(res.code, 0, res.stderr);
  const taskDir = join(dir, "tasks", "fix-bug");
  for (const part of ["instruction.md", "workspace", "verify.sh"]) {
    assert.ok(await import("node:fs").then((fs) => fs.existsSync(join(taskDir, part))), part);
  }
  const instruction = await import("node:fs").then((fs) =>
    fs.readFileSync(join(taskDir, "instruction.md"), "utf8"),
  );
  assert.match(instruction, /SCORE: <0\.\.1>/);
  assert.ok(!/verify\.sh/.test(instruction), "instruction never mentions the verify script");
  assert.ok(!/npm test/.test(instruction), "instruction does not leak the verify command");

  const help = await runCli(["compare", "--help"], { env: cliEnv({ AIAND_CONFIG_DIR: dir }) });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /compare add/);

  const topHelp = await runCli(["--help"], { env: cliEnv({ AIAND_CONFIG_DIR: dir }) });
  assert.equal(topHelp.code, 0);
  assert.match(topHelp.stdout, /compare/, "compare appears in the top-level command list");
});

test("compare tasks lists tasks; empty list is honest-empty with exit 0", async () => {
  const dir = cfg("tasks-empty");
  const empty = await runCli(["compare", "tasks"], { env: cliEnv({ AIAND_CONFIG_DIR: dir }) });
  assert.equal(empty.code, 0);
  assert.match(empty.stdout, /No task packs yet/);

  await addPassingTask(dir, "alpha");
  const listed = await runCli(["compare", "tasks"], { env: cliEnv({ AIAND_CONFIG_DIR: dir }) });
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, /alpha\s+unvalidated/);

  const asJson = await runCli(["compare", "tasks", "--json"], {
    env: cliEnv({ AIAND_CONFIG_DIR: dir }),
  });
  assert.equal(asJson.code, 0);
  assert.deepEqual(JSON.parse(asJson.stdout).tasks, [{ id: "alpha", status: "unvalidated" }]);
});

test("validate fail-before: verify passing untouched => invalid, non-zero exit", async () => {
  const dir = cfg("fail-before");
  const taskDir = await addPassingTask(dir, "trivial");
  // Verify that succeeds no matter what: trivially solvable task.
  writeFileSync(join(taskDir, "verify.sh"), "#!/bin/sh\nexit 0\n");
  const res = await runCli(["compare", "validate"], { env: cliEnv({ AIAND_CONFIG_DIR: dir }) });
  assert.notEqual(res.code, 0, "validation fails loudly");
  assert.match(res.stderr, /trivially solvable/);
  assert.match(res.stderr, /failed validation/);

  const asJson = await runCli(["compare", "validate", "--json"], {
    env: cliEnv({ AIAND_CONFIG_DIR: dir }),
  });
  assert.equal(asJson.code, 1);
  const parsed = JSON.parse(asJson.stdout);
  assert.equal(parsed.results[0].valid, false);
  assert.equal(parsed.results[0].nullHarness.ok, false);
  assert.ok(parsed.results[0].problems.some((p) => /trivially solvable/.test(p)));
});

test("validate end-to-end: fail-before ok, golden replay passes, tasks shows validated", async () => {
  const dir = cfg("golden");
  const taskDir = await addPassingTask(dir, "real");
  const golden = mkdtempSync(join(tmpdir(), "compare-golden-"));
  writeFileSync(join(golden, "solved.txt"), "done\n");

  const res = await runCli(["compare", "validate", "real", "--golden", golden], {
    env: cliEnv({ AIAND_CONFIG_DIR: dir }),
  });
  assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /fail-before:\s+✓/);
  assert.match(res.stdout, /null-harness:\s+✓ scores 0/);
  assert.match(res.stdout, /golden:\s+✓/);

  const listed = await runCli(["compare", "tasks", "--json"], {
    env: cliEnv({ AIAND_CONFIG_DIR: dir }),
  });
  assert.deepEqual(JSON.parse(listed.stdout).tasks, [{ id: "real", status: "validated" }]);
});

test("validate golden replay failing => invalid", async () => {
  const dir = cfg("golden-fail");
  await addPassingTask(dir, "broken");
  const golden = mkdtempSync(join(tmpdir(), "compare-golden-")); // no solved.txt
  const res = await runCli(["compare", "validate", "broken", "--golden", golden], {
    env: cliEnv({ AIAND_CONFIG_DIR: dir }),
  });
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /golden replay failed/);
});

test("validate malformed task: missing instruction/verify rejected", async () => {
  const dir = cfg("malformed");
  const taskDir = join(dir, "tasks", "hollow");
  mkdirSync(taskDir, { recursive: true }); // exists but empty
  const res = await runCli(["compare", "validate"], { env: cliEnv({ AIAND_CONFIG_DIR: dir }) });
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /missing instruction\.md, verify\.sh, workspace/);
});

test("validate rejects an instruction that mentions the verify script", async () => {
  const dir = cfg("leaky");
  await addPassingTask(dir, "leaky");
  const taskDir = join(dir, "tasks", "leaky");
  writeFileSync(join(taskDir, "instruction.md"), "Run verify.sh when done.\n");
  const res = await runCli(["compare", "validate"], { env: cliEnv({ AIAND_CONFIG_DIR: dir }) });
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /references the verify script/);
});

test("unknown subcommand errors with a hint; table stays an honest placeholder", async () => {
  const dir = cfg("dispatch");
  const unknown = await runCli(["compare", "bogus"], { env: cliEnv({ AIAND_CONFIG_DIR: dir }) });
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /Unknown subcommand/);

  const soon = await runCli(["compare", "table"], { env: cliEnv({ AIAND_CONFIG_DIR: dir }) });
  assert.notEqual(soon.code, 0);
  assert.match(soon.stderr, /not implemented yet/);
});
