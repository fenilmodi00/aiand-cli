import assert from "node:assert/strict";
import test, { describe } from "node:test";

const { parse, float } = await import("../dist/cli/args.js");

describe("float validation", () => {
  test("float rejects Infinity and NaN, accepts finite", () => {
    const argvFor = (raw) =>
      raw.startsWith("-") ? [`--temperature=${raw}`] : ["--temperature", raw];
    for (const raw of ["Infinity", "-Infinity", "NaN"]) {
      const parsed = parse(argvFor(raw), { temperature: { type: "string" } });
      assert.throws(() => float(parsed, "temperature"), /must be a number/);
    }
    for (const [raw, expected] of [
      ["0.5", 0.5],
      ["1", 1],
      ["-3.14", -3.14],
    ]) {
      const parsed = parse(argvFor(raw), { temperature: { type: "string" } });
      assert.equal(float(parsed, "temperature"), expected);
    }
  });
});

describe("base-url set-time guards", () => {
  test("--base-url ending in /v1 refuses before it can double", () => {
    // Fuzz E4: adapters append /v1 themselves, so a suffixed URL is refused
    // at set time — the shared origin rule owns the message.
    const prev = process.env.AIAND_BASE_URL;
    delete process.env.AIAND_BASE_URL;
    try {
      for (const raw of ["https://api.aiand.com/v1", "https://api.aiand.com/v1/"]) {
        assert.throws(
          () => parse(["--base-url", raw]),
          (error) => {
            assert.equal(error.name, "CliError");
            assert.match(error.message, /origin without a path/);
            return true;
          },
        );
      }
      assert.equal(process.env.AIAND_BASE_URL, undefined, "a refused flag sets nothing");
    } finally {
      if (prev !== undefined) process.env.AIAND_BASE_URL = prev;
    }
  });

  test("--base-url with credentials refuses without echoing the secret", () => {
    // Fuzz E5.
    const prev = process.env.AIAND_BASE_URL;
    delete process.env.AIAND_BASE_URL;
    try {
      const fake = "fake-secret-xyz";
      try {
        parse(["--base-url", `https://user:${fake}@host.example/`]);
        assert.fail("must throw");
      } catch (error) {
        assert.equal(error.name, "CliError");
        assert.match(error.message, /must not embed credentials/);
        assert.ok(!`${error.message}${error.hint ?? ""}`.includes(fake), "no echo");
      }
      assert.equal(process.env.AIAND_BASE_URL, undefined, "a refused flag sets nothing");
    } finally {
      if (prev !== undefined) process.env.AIAND_BASE_URL = prev;
    }
  });
});
