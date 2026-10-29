import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after, before, describe } from "node:test";
import {
  CLOSED_URL,
  cliEnv,
  FAKE_API_KEY,
  runCli,
  startMockGateway,
  withTestEnv,
} from "./helpers.mjs";

// Behavior-level coverage for the config, login, and whoami commands, driven
// through the built CLI. Every case gets its own AIAND_CONFIG_DIR/AIAND_HOME
// under one file-scoped temp dir, so stored settings never leak between tests.

const root = withTestEnv("aiand-clw-test-", () => {});
let counter = 0;

function fresh(overrides = {}) {
  const dir = join(root.dir, `case-${++counter}`);
  const cfg = join(dir, "cfg");
  mkdirSync(cfg, { recursive: true });
  mkdirSync(join(dir, "home"), { recursive: true });
  const env = cliEnv({
    AIAND_HOME: join(dir, "home"),
    AIAND_CONFIG_DIR: cfg,
    AIAND_KEY_STORAGE: "plaintext",
    CI: "1",
    NO_COLOR: "1",
    NO_UPDATE_CHECK: "1",
    AIAND_API_KEY: undefined,
    AIAND_BASE_URL: undefined,
    AIAND_AUTH_URL: undefined,
    AIAND_PROFILE: undefined,
    ...overrides,
  });
  return { env, cfg };
}

/** Seed a stored credential the way a login would leave it behind. */
function seedCredential(
  cfg,
  {
    profile = "default",
    origin = "paste",
    storage = "plaintext",
    expiresAt,
    user = { id: "u1", email: "dev@example.com" },
    org,
    token = "sk-stored-key",
  } = {},
) {
  const meta = { origin, storage, ...(expiresAt === undefined ? {} : { expires_at: expiresAt }) };
  if (user) meta.user = user;
  if (org) meta.org = org;
  writeFileSync(join(cfg, "credentials.json"), `${JSON.stringify({ [profile]: meta })}\n`);
  writeFileSync(
    join(cfg, "credentials-plaintext.json"),
    `${JSON.stringify({ [profile]: JSON.stringify({ access_token: token }) })}\n`,
  );
}

let gateway;
before(async () => {
  gateway = await startMockGateway();
});
after(() => gateway?.stop());

describe("config", () => {
  test("--help prints usage and exits 0", async () => {
    const { env } = fresh();
    const r = await runCli(["config", "--help"], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /aiand config/);
    assert.match(r.stdout, /Settable keys/);
  });

  test("unknown subcommand fails with a hint", async () => {
    const { env } = fresh();
    const r = await runCli(["config", "nope"], { env });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /Unknown subcommand "nope"/);
    assert.match(r.stderr, /config --help/);
  });

  test("no subcommand shows the resolved profile (text and JSON)", async () => {
    const { env } = fresh();
    const text = await runCli(["config"], { env });
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /profile\s+default/);
    assert.match(text.stdout, /signed in\s+no/);

    const asJson = await runCli(["config", "--json"], { env });
    assert.equal(asJson.code, 0, asJson.stderr);
    const shown = JSON.parse(asJson.stdout);
    assert.equal(shown.name, "default");
    assert.equal(shown.signed_in, false);
    assert.match(shown.config_path, /config\.json$/);
  });

  test("shows signed in when a credential exists", async () => {
    const { env, cfg } = fresh();
    seedCredential(cfg);
    const text = await runCli(["config"], { env });
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /signed in\s+yes/);
  });

  test("path prints both file locations, text and JSON", async () => {
    const { env } = fresh();
    const text = await runCli(["config", "path"], { env });
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /config\s+.*config\.json/);
    assert.match(text.stdout, /credentials\s+.*credentials\.json/);

    const asJson = await runCli(["config", "path", "--json"], { env });
    assert.equal(asJson.code, 0, asJson.stderr);
    const paths = JSON.parse(asJson.stdout);
    assert.match(paths.config, /config\.json$/);
    assert.match(paths.credentials, /credentials\.json$/);
  });

  test("set requires both a key and a value", async () => {
    const { env } = fresh();
    const r = await runCli(["config", "set", "model"], { env });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /Both a key and a value are required/);
  });

  test("set model persists as the profile default", async () => {
    const { env } = fresh();
    const set = await runCli(["config", "set", "model", "zai-org/glm-5.3", "--json"], { env });
    assert.equal(set.code, 0, set.stderr);
    assert.deepEqual(JSON.parse(set.stdout), {
      profile: "default",
      key: "model",
      value: "zai-org/glm-5.3",
    });

    const show = await runCli(["config", "--json"], { env });
    assert.equal(JSON.parse(show.stdout).model, "zai-org/glm-5.3");
  });

  test("set api-url validates https and refuses a /v1 suffix", async () => {
    const { env } = fresh();
    const ok = await runCli(["config", "set", "api-url", "https://api.example.test"], { env });
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /Set api-url = https:\/\/api\.example\.test on profile "default"/);

    const shown = await runCli(["config", "--json"], { env });
    assert.equal(JSON.parse(shown.stdout).apiUrl, "https://api.example.test");

    const insecure = await runCli(["config", "set", "api-url", "http://plain.example"], { env });
    assert.equal(insecure.code, 1, insecure.stderr);
    assert.match(insecure.stderr, /https/i);

    const v1 = await runCli(["config", "set", "api-url", "https://api.example.test/v1"], { env });
    assert.equal(v1.code, 1, v1.stderr);
    assert.match(v1.stderr, /v1/i);
  });

  test("set auth-url persists separately from the API url", async () => {
    const { env } = fresh();
    const r = await runCli(["config", "set", "auth-url", "https://auth.example.test"], { env });
    assert.equal(r.code, 0, r.stderr);
    const shown = JSON.parse((await runCli(["config", "--json"], { env })).stdout);
    assert.equal(shown.authUrl, "https://auth.example.test");
  });

  test("set rejects unknown keys", async () => {
    const { env } = fresh();
    const r = await runCli(["config", "set", "theme", "dark"], { env });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /"theme" is not a settable key/);
  });

  test("get rejects keys other than budget", async () => {
    const { env } = fresh();
    const r = await runCli(["config", "get", "model"], { env });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /"model" is not a gettable key/);
  });

  test("get budget lists unset keys and JSON shape", async () => {
    const { env } = fresh();
    const text = await runCli(["config", "get", "budget"], { env });
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /budget\.monthly\s+not set/);
    assert.match(text.stdout, /budget\.warn-pct/);

    const asJson = await runCli(["config", "get", "budget", "--json"], { env });
    assert.equal(asJson.code, 0, asJson.stderr);
    const budget = JSON.parse(asJson.stdout);
    assert.equal(budget.monthly, null);
    assert.deepEqual(budget.harness, {});
  });

  test("budget: monthly, per-harness, and warn-pct", async () => {
    const { env } = fresh();
    const monthly = await runCli(["config", "set", "budget.monthly", "100", "--json"], { env });
    assert.equal(monthly.code, 0, monthly.stderr);
    const monthlyBody = JSON.parse(monthly.stdout);
    assert.equal(monthlyBody.value, 100);
    assert.equal(monthlyBody.key, "budget.monthly");

    const monthlyText = await runCli(["config", "set", "budget.monthly", "120"], { env });
    assert.equal(monthlyText.code, 0, monthlyText.stderr);
    assert.match(monthlyText.stdout, /Set budget\.monthly = 120/);

    const harness = await runCli(["config", "set", "budget.harness.claude", "5", "--json"], {
      env,
    });
    assert.equal(harness.code, 0, harness.stderr);
    assert.deepEqual(JSON.parse(harness.stdout), {
      key: "budget.harness.claude",
      value: 5,
    });

    const warn = await runCli(["config", "set", "budget.warn-pct", "70.4"], { env });
    assert.equal(warn.code, 0, warn.stderr);
    assert.match(warn.stdout, /Set budget\.warn-pct = 70\./);

    const shown = JSON.parse((await runCli(["config", "get", "budget", "--json"], { env })).stdout);
    assert.equal(shown.monthly, 120);
    assert.equal(shown.harness.claude, 5);
    assert.equal(shown.warn_pct, 70);
  });

  test("budget rejects non-numbers and unknown budget keys", async () => {
    const { env } = fresh();
    const bad = await runCli(["config", "set", "budget.monthly", "lots"], { env });
    assert.equal(bad.code, 1, bad.stderr);
    assert.match(bad.stderr, /must be a number/);

    const unknown = await runCli(["config", "set", "budget.nope", "1"], { env });
    assert.equal(unknown.code, 1, unknown.stderr);
    assert.match(unknown.stderr, /not a settable budget key/);
  });

  test("unset requires a key and only accepts unsettable ones", async () => {
    const { env } = fresh();
    const missing = await runCli(["config", "unset"], { env });
    assert.equal(missing.code, 1, missing.stderr);
    assert.match(missing.stderr, /A key is required/);

    const notUnsettable = await runCli(["config", "unset", "model"], { env });
    assert.equal(notUnsettable.code, 1, notUnsettable.stderr);
    assert.match(notUnsettable.stderr, /not an unsettable key/);
  });

  test("unset removes budget settings", async () => {
    const { env } = fresh();
    await runCli(["config", "set", "budget.monthly", "100"], { env });

    const budget = await runCli(["config", "unset", "budget.monthly", "--json"], { env });
    assert.equal(budget.code, 0, budget.stderr);
    assert.deepEqual(JSON.parse(budget.stdout), { key: "budget.monthly", removed: true });

    const budgetText = await runCli(["config", "set", "budget.monthly", "50"], { env });
    assert.equal(budgetText.code, 0, budgetText.stderr);
    const removedText = await runCli(["config", "unset", "budget.monthly"], { env });
    assert.equal(removedText.code, 0, removedText.stderr);
    assert.match(removedText.stdout, /Unset budget\.monthly\./);
  });

  test("profiles lists every profile with its sign-in state", async () => {
    const { env, cfg } = fresh();
    seedCredential(cfg);
    const text = await runCli(["config", "profiles"], { env });
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /\*\s+default\s+signed in/);

    const asJson = await runCli(["config", "profiles", "--json"], { env });
    assert.equal(asJson.code, 0, asJson.stderr);
    assert.deepEqual(JSON.parse(asJson.stdout), [
      { name: "default", active: true, signed_in: true },
    ]);
  });

  test("profiles marks a signed-out profile", async () => {
    const { env } = fresh();
    const text = await runCli(["config", "profiles"], { env });
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /signed out/);
  });

  test("use switches the active profile and creates it on demand", async () => {
    const { env, cfg } = fresh();
    const missing = await runCli(["config", "use"], { env });
    assert.equal(missing.code, 1, missing.stderr);
    assert.match(missing.stderr, /Which profile/);

    const unsafe = await runCli(["config", "use", "__proto__"], { env });
    assert.equal(unsafe.code, 1, unsafe.stderr);
    assert.match(unsafe.stderr, /is not allowed/);

    const switched = await runCli(["config", "use", "work", "--json"], { env });
    assert.equal(switched.code, 0, switched.stderr);
    assert.deepEqual(JSON.parse(switched.stdout), { profile: "work" });

    const shown = JSON.parse((await runCli(["config", "--json"], { env })).stdout);
    assert.equal(shown.name, "work");

    const text = await runCli(["config", "use", "default"], { env });
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /Using profile "default"/);

    // A stored credential on the target is rebaked (no agents here, so the
    // command still succeeds and writes the switch).
    seedCredential(cfg, { profile: "work", token: "sk-work-key" });
    const withCred = await runCli(["config", "use", "work"], { env });
    assert.equal(withCred.code, 0, withCred.stderr);
    assert.match(withCred.stdout, /Using profile "work"/);
  });
});

describe("login", () => {
  test("--help prints usage", async () => {
    const { env } = fresh();
    const r = await runCli(["login", "--help"], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /aiand login/);
  });

  test("an env key is the session: prose and --json", async () => {
    const { env } = fresh({ AIAND_API_KEY: FAKE_API_KEY });
    const text = await runCli(["login"], { env });
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /AIAND_API_KEY is set/);

    const asJson = await runCli(["login", "--json"], { env });
    assert.equal(asJson.code, 0, asJson.stderr);
    assert.deepEqual(JSON.parse(asJson.stdout), {
      profile: "default",
      source: "AIAND_API_KEY",
    });
  });

  test("an existing session refuses without --force in a non-interactive run", async () => {
    const { env, cfg } = fresh();
    seedCredential(cfg, { user: { id: "u1", email: "already@example.com" } });
    const r = await runCli(["login"], { env });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /Profile "default" is already signed in/);
    assert.match(r.stderr, /login --force/);
  });

  test("--force retries the device flow even when signed in", async () => {
    const { env, cfg } = fresh({ AIAND_BASE_URL: gateway.url });
    seedCredential(cfg);
    const r = await runCli(["login", "--force"], { env });
    assert.equal(r.code, 1, r.stderr);
    // The mock gateway has no device-code endpoint, and non-interactive runs
    // keep the original error instead of prompting.
    assert.match(r.stderr, /Could not start a device login/);
  });

  test("paste login with --with-token stores the key", async () => {
    const { env, cfg } = fresh({ AIAND_BASE_URL: gateway.url });
    const r = await runCli(["login", "--with-token"], {
      env,
      input: "sk-pasted-test-key\n",
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Signed in with a pasted key/);
    assert.match(r.stdout, /happy@example\.com/);

    const credentials = JSON.parse(readFileSync(join(cfg, "credentials.json"), "utf8"));
    assert.equal(credentials.default.origin, "paste");
    assert.equal(credentials.default.user.email, "happy@example.com");
  });

  test("paste login --json prints only the JSON result", async () => {
    const { env } = fresh({ AIAND_BASE_URL: gateway.url });
    const r = await runCli(["login", "--with-token", "--json"], {
      env,
      input: "sk-pasted-test-key",
    });
    assert.equal(r.code, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.profile, "default");
    assert.equal(result.source, "pasted-key");
    assert.equal(result.storage, "plaintext");
  });

  test("multiple orgs without a picker picks the first and says so", async () => {
    const { env } = fresh({ AIAND_BASE_URL: `${gateway.url}/stub/two-orgs` });
    const r = await runCli(["login", "--with-token", "--json"], {
      env,
      input: "sk-pasted-test-key",
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /multiple organizations; using First Org/);
  });

  test("a rejected key fails with the gateway's message", async () => {
    const { env } = fresh({ AIAND_BASE_URL: `${gateway.url}/stub/401` });
    const r = await runCli(["login", "--with-token"], {
      env,
      input: "sk-rejected-key",
    });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /That key was rejected/);
  });

  test("keys must start with sk-", async () => {
    const { env } = fresh({ AIAND_BASE_URL: gateway.url });
    const r = await runCli(["login", "--with-token"], { env, input: "not-a-key\n" });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /Keys start with "sk-"/);
  });

  test("only a single-line key is accepted", async () => {
    const { env } = fresh({ AIAND_BASE_URL: gateway.url });
    const r = await runCli(["login", "--with-token"], {
      env,
      input: "sk-first-line\nsecond line\n",
    });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /Pipe a single-line key/);
  });

  test("--profile stores the pasted session under that profile", async () => {
    const { env, cfg } = fresh({ AIAND_BASE_URL: gateway.url });
    const r = await runCli(["login", "--with-token", "--profile", "work", "--json"], {
      env,
      input: "sk-work-pasted-key",
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).profile, "work");
    const stored = JSON.parse(readFileSync(join(cfg, "credentials.json"), "utf8"));
    assert.ok(stored.work);
    const config = JSON.parse(readFileSync(join(cfg, "config.json"), "utf8"));
    assert.equal(config.profile, "work");
  });
});

describe("whoami", () => {
  const FUTURE = 1893456000; // 2030-01-01T00:00:00Z

  test("--help prints usage", async () => {
    const { env } = fresh();
    const r = await runCli(["whoami", "--help"], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /aiand whoami/);
  });

  test("a stray positional is a usage error", async () => {
    const { env } = fresh();
    const r = await runCli(["whoami", "nope"], { env });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Unknown argument "nope"/);
  });

  test("signed out exits 2 with the login hint", async () => {
    const { env } = fresh();
    const r = await runCli(["whoami"], { env });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /Not logged in/);
    assert.match(r.stderr, /aiand login/);
  });

  test("signed out with --local exits 2 too", async () => {
    const { env } = fresh();
    const r = await runCli(["whoami", "--local"], { env });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /Not logged in/);
  });

  test("an unreachable gateway fails loudly instead of printing cached data", async () => {
    const { env, cfg } = fresh({ AIAND_BASE_URL: CLOSED_URL });
    seedCredential(cfg, { expiresAt: FUTURE });
    const r = await runCli(["whoami"], { env });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /Could not reach/);
  });

  test("a stored key prints the verified identity", async () => {
    const { env, cfg } = fresh({ AIAND_BASE_URL: gateway.url });
    seedCredential(cfg, { expiresAt: FUTURE });
    const r = await runCli(["whoami"], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /happy@example\.com/);
    assert.match(r.stdout, /Happy Org/);
    assert.match(r.stdout, /pasted key/);
    assert.match(r.stdout, /plaintext file/);
    assert.match(r.stdout, /rotated automatically/);
  });

  test("--json carries the identity, masked key, and source", async () => {
    const { env, cfg } = fresh({ AIAND_BASE_URL: gateway.url });
    seedCredential(cfg, { expiresAt: FUTURE });
    const r = await runCli(["whoami", "--json"], { env });
    assert.equal(r.code, 0, r.stderr);
    const identity = JSON.parse(r.stdout);
    assert.equal(identity.profile, "default");
    assert.equal(identity.api_url, gateway.url);
    assert.equal(identity.user.email, "happy@example.com");
    assert.equal(identity.org.name, "Happy Org");
    assert.equal(identity.source, "pasted-key");
    assert.equal(identity.storage, "plaintext");
    assert.equal(identity.key_expires_at, "2030-01-01T00:00:00.000Z");
    assert.match(identity.key, /^sk-/);
    assert.ok(!r.stdout.includes("sk-stored-key"));
  });

  test("--local reads the cached identity without touching the network", async () => {
    const { env, cfg } = fresh({ AIAND_BASE_URL: CLOSED_URL });
    seedCredential(cfg, {
      user: { id: "u1", email: "cached@example.com" },
      org: { id: "org_1", name: "Cached Org" },
    });
    const r = await runCli(["whoami", "--local"], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /cached@example\.com/);
    assert.match(r.stdout, /Cached Org/);
    assert.match(r.stdout, /never \(pasted key\)/);
  });

  test("--local reports an unknown expiry for a device credential without one", async () => {
    const { env, cfg } = fresh({ AIAND_BASE_URL: CLOSED_URL });
    seedCredential(cfg, { origin: "device" });
    const r = await runCli(["whoami", "--local"], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /device login/);
    assert.match(r.stdout, /unknown/);
  });

  test("an env key reports AIAND_API_KEY as the source, text and JSON", async () => {
    const { env } = fresh({ AIAND_API_KEY: FAKE_API_KEY, AIAND_BASE_URL: gateway.url });
    const asJson = await runCli(["whoami", "--json"], { env });
    assert.equal(asJson.code, 0, asJson.stderr);
    const identity = JSON.parse(asJson.stdout);
    assert.equal(identity.source, "AIAND_API_KEY");
    assert.equal(identity.storage, null);
    assert.equal(identity.key_expires_at, null);

    const text = await runCli(["whoami"], { env });
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /from AIAND_API_KEY/);
    assert.doesNotMatch(text.stdout, /rotated automatically/);
  });

  test("--local with an env key reports no cached identity", async () => {
    const { env } = fresh({ AIAND_API_KEY: FAKE_API_KEY, AIAND_BASE_URL: CLOSED_URL });
    const r = await runCli(["whoami", "--local"], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /unknown/);
    assert.match(r.stdout, /none/);
    assert.match(r.stdout, /from AIAND_API_KEY/);
  });

  test("--profile inspects another profile", async () => {
    const { env, cfg } = fresh({ AIAND_BASE_URL: gateway.url });
    seedCredential(cfg, { profile: "work", expiresAt: FUTURE });
    const r = await runCli(["whoami", "--profile", "work", "--json"], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).profile, "work");
  });
});
