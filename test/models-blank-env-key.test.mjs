import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { cliEnv, runCli, withTestEnv, writeConfigMarker } from "./helpers.mjs";

// A whitespace-only AIAND_API_KEY means "unset" everywhere (envApiKey), so
// `models` must fall back to the stored login rather than read it as a key.

const env = withTestEnv("aiand-models-blank-", () => {});

const seen = [];
let server;
let url;
before(async () => {
  server = createServer((req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization ?? null });
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

test("models sends the stored login when AIAND_API_KEY is only whitespace", async () => {
  const cfg = mkdtempSync(join(env.dir, "cfg-"));
  writeConfigMarker(cfg);
  writeFileSync(
    join(cfg, "credentials.json"),
    `${JSON.stringify({
      default: {
        origin: "paste",
        bound_to: { auth_url: url, api_url: url },
        storage: "plaintext",
        user: { id: "u1", email: "a@x.com" },
      },
    })}\n`,
  );
  writeFileSync(
    join(cfg, "credentials-plaintext.json"),
    `${JSON.stringify({ default: JSON.stringify({ access_token: "sk-stored" }) })}\n`,
  );
  const { code, stderr } = await runCli(["models", "--json"], {
    env: cliEnv({
      AIAND_CONFIG_DIR: cfg,
      AIAND_HOME: join(cfg, "home"),
      AIAND_KEY_STORAGE: "plaintext",
      AIAND_API_KEY: "   ",
      AIAND_BASE_URL: url,
      AIAND_AUTH_URL: undefined,
    }),
  });
  assert.equal(code, 0, stderr);
  assert.ok(
    seen.some((r) => r.authorization === "Bearer sk-stored"),
    `no request carried the stored key: ${JSON.stringify(seen)}`,
  );
});
