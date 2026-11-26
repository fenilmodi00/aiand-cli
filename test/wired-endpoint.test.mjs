import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";
import { cliEnv, FAKE_API_KEY, runCli, withEnv, withMockGateway } from "./helpers.mjs";

// A key is bound to the API origin that issued it, so switching the active
// profile (`config use`, or signing in to another profile) must bake it only
// into agents wired for that origin. `on` records the origin in wired.json;
// an agent wired before the record existed is judged by the base URL its own
// config bakes, never by the previously active profile.

const PROD = "https://api.aiand.com";
const STAGING = "https://staging.example.com";

function sandbox(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const env = cliEnv({
    AIAND_HOME: join(dir, "home"),
    AIAND_CONFIG_DIR: join(dir, "cfg"),
    AIAND_KEY_STORAGE: "plaintext",
    NO_UPDATE_CHECK: "1",
    CI: "1",
  });
  delete env.AIAND_API_KEY;
  delete env.AIAND_PROFILE;
  mkdirSync(join(dir, "cfg"), { recursive: true });
  const cfg = (name) => join(dir, "cfg", name);
  const opencode = join(dir, "home", ".config", "opencode", "opencode.json");
  return {
    dir,
    env,
    cfg,
    opencode,
    writeConfig: (profiles, active = "default") =>
      writeFileSync(cfg("config.json"), `${JSON.stringify({ profile: active, profiles })}\n`),
    // A stored credential for `name`, bound to `apiUrl` when given.
    writeCredential(name, key, apiUrl) {
      const bound_to = apiUrl ? { auth_url: apiUrl, api_url: apiUrl } : undefined;
      writeFileSync(
        cfg("credentials.json"),
        `${JSON.stringify({ [name]: { origin: "paste", storage: "plaintext", ...(bound_to && { bound_to }) } })}\n`,
      );
      writeFileSync(
        cfg("credentials-plaintext.json"),
        `${JSON.stringify({ [name]: JSON.stringify({ access_token: key }) })}\n`,
      );
    },
    wireOpencode(apiKey, baseURL = `${PROD}/v1`) {
      mkdirSync(join(dir, "home", ".config", "opencode"), { recursive: true });
      writeFileSync(
        opencode,
        `${JSON.stringify({
          provider: { aiand: { options: { baseURL, apiKey, "x-aiand": true } } },
          model: "aiand/m-default",
        })}\n`,
      );
    },
    recordWired: (apiUrl) =>
      writeFileSync(
        cfg("wired.json"),
        `${JSON.stringify({ opencode: { profile: "default", api_url: apiUrl } })}\n`,
      ),
    bakedKey: () => JSON.parse(readFileSync(opencode, "utf8")).provider.aiand.options.apiKey,
  };
}

describe("config use holds the rebake to the wired endpoint", () => {
  test("an agent wired for another origin keeps its key and is told how to move it", async () => {
    const box = sandbox("aiand-wired-use-");
    try {
      box.writeConfig({ default: {}, work: { apiUrl: STAGING, authUrl: STAGING } });
      box.writeCredential("work", "sk-work", STAGING);
      box.wireOpencode("sk-default");
      const r = await runCli(["config", "use", "work"], { env: box.env });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(
        box.bakedKey(),
        "sk-default",
        "the staging key was not baked into a prod config",
      );
      assert.match(r.stderr, /\[opencode\] Wired to https:\/\/api\.aiand\.com/);
      assert.match(r.stderr, /bound to https:\/\/staging\.example\.com/);
      assert.match(r.stderr, /aiand --profile work opencode on/);
      assert.doesNotMatch(r.stderr, /sk-work/);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  test("the recorded origin decides, not the previously active profile", async () => {
    const box = sandbox("aiand-wired-record-");
    try {
      // default is prod, but opencode was wired for staging: switching to a
      // staging-bound profile is a match, so the key is swapped.
      box.writeConfig({ default: {}, work: { apiUrl: STAGING, authUrl: STAGING } });
      box.writeCredential("work", "sk-work", STAGING);
      box.wireOpencode("sk-old", `${STAGING}/v1`);
      box.recordWired(`${STAGING}/`);
      const r = await runCli(["config", "use", "work"], { env: box.env });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(box.bakedKey(), "sk-work");
      assert.match(r.stderr, /Key refreshed/);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  test("an agent wired before the record existed is judged by the base URL its config bakes", async () => {
    const box = sandbox("aiand-wired-legacy-");
    try {
      // default was staging, so a staging-bound target matches without a record.
      box.writeConfig({
        default: { apiUrl: STAGING, authUrl: STAGING },
        work: { apiUrl: STAGING, authUrl: STAGING },
      });
      box.writeCredential("work", "sk-work", STAGING);
      box.wireOpencode("sk-old", `${STAGING}/v1`);
      const r = await runCli(["config", "use", "work"], { env: box.env });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(box.bakedKey(), "sk-work");
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  test("an unrecorded agent wired for staging is not given a prod key because the previous profile was prod", async () => {
    const box = sandbox("aiand-wired-unrecorded-");
    try {
      // Pre-0.8: `AIAND_BASE_URL=staging aiand opencode on` left no record. The
      // previous profile and the target are both prod, so the old rule said "match".
      box.writeConfig({ default: {}, other: {} });
      box.writeCredential("other", "sk-prod", PROD);
      box.wireOpencode("sk-staging", `${STAGING}/v1`);
      const r = await runCli(["config", "use", "other"], { env: box.env });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(
        box.bakedKey(),
        "sk-staging",
        "the prod key was not baked into a staging config",
      );
      assert.match(r.stderr, /\[opencode\] Wired to https:\/\/staging\.example\.com/);
      assert.match(r.stderr, /aiand --profile other opencode on/);
      assert.doesNotMatch(r.stderr, /sk-prod/);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  test("a corrupt wired.json does not make an unrecorded agent safe to rebake", async () => {
    const box = sandbox("aiand-wired-corrupt-");
    try {
      box.writeConfig({ default: {}, other: {} });
      box.writeCredential("other", "sk-prod", PROD);
      box.wireOpencode("sk-staging", `${STAGING}/v1`);
      writeFileSync(box.cfg("wired.json"), "{ not json");
      const r = await runCli(["config", "use", "other"], { env: box.env });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(box.bakedKey(), "sk-staging");
      assert.match(r.stderr, /Wired to https:\/\/staging\.example\.com/);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  test("the config's own base URL outranks a stale record", async () => {
    const box = sandbox("aiand-wired-stale-record-");
    try {
      // The record says prod; the user has since repointed the config at staging.
      box.writeConfig({ default: {}, other: {} });
      box.writeCredential("other", "sk-prod", PROD);
      box.wireOpencode("sk-staging", `${STAGING}/v1`);
      box.recordWired(PROD);
      const r = await runCli(["config", "use", "other"], { env: box.env });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(box.bakedKey(), "sk-staging");
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  test("an agent that is off produces no note for a mismatched profile", async () => {
    const box = sandbox("aiand-wired-off-");
    try {
      box.writeConfig({ default: {}, work: { apiUrl: STAGING, authUrl: STAGING } });
      box.writeCredential("work", "sk-work", STAGING);
      box.recordWired(PROD);
      const r = await runCli(["config", "use", "work"], { env: box.env });
      assert.equal(r.code, 0, r.stderr);
      assert.doesNotMatch(r.stderr, /Wired to/);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });
});

describe("sign-in to another profile holds the rebake to the wired endpoint", () => {
  test("a paste login to a profile on another origin leaves wired agents alone", async () => {
    await withMockGateway(async ({ url }) => {
      const box = sandbox("aiand-wired-login-");
      try {
        box.writeConfig({ default: {}, stg: { apiUrl: url, authUrl: url } });
        box.wireOpencode("sk-default");
        box.recordWired(PROD);
        const r = await runCli(["login", "--with-token", "--profile", "stg"], {
          env: box.env,
          input: `${FAKE_API_KEY}\n`,
        });
        assert.equal(r.code, 0, r.stderr);
        assert.equal(box.bakedKey(), "sk-default");
        assert.match(r.stderr, /\[opencode\] Wired to https:\/\/api\.aiand\.com/);
        assert.match(r.stderr, /aiand --profile stg opencode on/);
      } finally {
        rmSync(box.dir, { recursive: true, force: true });
      }
    });
  });

  test("a paste login to a profile on the wired origin still rebakes", async () => {
    await withMockGateway(async ({ url }) => {
      const box = sandbox("aiand-wired-login-same-");
      try {
        box.writeConfig({ default: {}, stg: { apiUrl: url, authUrl: url } });
        box.wireOpencode("sk-default", `${url}/v1`);
        box.recordWired(url);
        const r = await runCli(["login", "--with-token", "--profile", "stg"], {
          env: box.env,
          input: `${FAKE_API_KEY}\n`,
        });
        assert.equal(r.code, 0, r.stderr);
        assert.equal(box.bakedKey(), FAKE_API_KEY);
      } finally {
        rmSync(box.dir, { recursive: true, force: true });
      }
    });
  });
});

describe("wired.json bookkeeping", () => {
  test("on records the profile's API origin and off forgets it", async () => {
    await withMockGateway(async ({ url }) => {
      const box = sandbox("aiand-wired-track-");
      try {
        box.writeConfig({ default: {} });
        const { agentOn, agentOff } = await import("../dist/agents/setup.js");
        const { AGENTS, registerAgent } = await import("../dist/agents/registry.js");
        const marker = join(box.dir, "fixture-state");
        registerAgent({
          id: "__wired_fixture__",
          label: "Wired Fixture",
          bin: "__wired_fixture__",
          install: { command: "", url: "" },
          detect: () => ({ installed: true, path: marker }),
          managedFiles: () => [marker],
          probe: async () => ({ active: false, model: null }),
          enable: async () => ({ model: "fixture", filesWritten: [marker] }),
          disable: async () => ({ stripped: true }),
        });
        const adapter = AGENTS.find((a) => a.id === "__wired_fixture__");
        await withEnv(
          {
            AIAND_CONFIG_DIR: box.cfg(""),
            AIAND_HOME: join(box.dir, "home"),
            AIAND_API_KEY: FAKE_API_KEY,
            AIAND_BASE_URL: `${url}/`,
          },
          async () => {
            await agentOn(adapter, {});
            const wired = JSON.parse(readFileSync(box.cfg("wired.json"), "utf8"));
            assert.equal(wired.__wired_fixture__.api_url, url);
            assert.equal(wired.__wired_fixture__.profile, "default");

            await agentOff(adapter);
            assert.deepEqual(JSON.parse(readFileSync(box.cfg("wired.json"), "utf8")), {});
          },
        );
      } finally {
        rmSync(box.dir, { recursive: true, force: true });
      }
    });
  });
});
