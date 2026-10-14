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

describe("base-url guard at parse time", () => {
  test("a /v1-suffixed --base-url is refused before the env is set", () => {
    const previous = process.env.AIAND_BASE_URL;
    delete process.env.AIAND_BASE_URL;
    try {
      assert.throws(() => parse(["--base-url", "http://127.0.0.1:1234/v1"]), {
        name: "CliError",
        message: /must not end in "\/v1"/,
      });
      assert.equal(process.env.AIAND_BASE_URL, undefined, "the env was never repointed");
    } finally {
      if (previous === undefined) delete process.env.AIAND_BASE_URL;
      else process.env.AIAND_BASE_URL = previous;
    }
  });

  test("an origin --base-url still lands in the env", () => {
    const previous = process.env.AIAND_BASE_URL;
    try {
      parse(["--base-url", "https://api.aiand.com"]);
      assert.equal(process.env.AIAND_BASE_URL, "https://api.aiand.com");
    } finally {
      if (previous === undefined) delete process.env.AIAND_BASE_URL;
      else process.env.AIAND_BASE_URL = previous;
    }
  });
});
