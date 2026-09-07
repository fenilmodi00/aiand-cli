import { writeFileSync, readFileSync, existsSync, mkdirSync, cpSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, "dist", "index.js");
const S = join("/tmp", "aiand-e2e");
execSync(`rm -rf ${S}`);
const cursorStorage = join(S, "home", ".config", "Cursor", "User", "globalStorage");
mkdirSync(cursorStorage, { recursive: true });
mkdirSync(join(S, "cfg"), { recursive: true });
mkdirSync(join(S, "bin"), { recursive: true });
const db = join(cursorStorage, "state.vscdb");

// Offline catalog so this script does not need the live gateway.
writeFileSync(
  join(S, "cfg", "model-catalog.json"),
  JSON.stringify({
    fetchedAt: Date.now(),
    baseUrl: "https://api.aiand.com",
    models: [
      {
        id: "zai-org/glm-5.3",
        name: "GLM 5.3",
        object: "model",
        created: 1,
        owned_by: "zai-org",
        provider: "zai-org",
        context_window: 200000,
        capabilities: ["text", "vision", "tool_calling"],
        reasoning_efforts: null,
        reasoning_effort_default: null,
        description: null,
        currency: "usd",
        input_per_1m: "0.60",
        output_per_1m: "2.40",
        cached_input_per_1m: "0.10",
      },
    ],
  })
);

function dbScript(code) {
  const file = join(S, "probe.mjs");
  writeFileSync(
    file,
    `import { DatabaseSync } from "node:sqlite";\nconst db = new DatabaseSync(${JSON.stringify(db)});\n${code}\ndb.close();\n`
  );
  return execSync(`node ${file}`, { encoding: "utf8" }).trim();
}

dbScript(`
db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);");
const blob = JSON.stringify({
  someOtherField: 42,
  aiSettings: {
    modelConfig: { "cmd-k": { maxMode: true }, chat: { modelName: "claude-sonnet-4-6" } },
    userAddedModels: ["my-own-model"],
  },
});
db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser", blob);
db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("unrelated/row", "precious");
db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("cursorAuth/otherKey", "user-secret");
`);

const DB_BEFORE = readFileSync(db);

const env = {
  ...process.env,
  AIAND_HOME: join(S, "home"),
  AIAND_CONFIG_DIR: join(S, "cfg"),
  AIAND_API_KEY: "sk-e2e-test-key-0000000000000000000000",
  PATH: `${join(S, "bin")}:${process.env.PATH}`,
};

function cli(args) {
  return execSync(`node ${DIST} ${args}`, { env, encoding: "utf8" });
}

function cliOrNull(args) {
  try {
    return { ok: true, out: execSync(`node ${DIST} ${args}`, { env, encoding: "utf8" }), err: "" };
  } catch (error) {
    return { ok: false, out: "", err: String(error.stderr ?? error.message ?? "") };
  }
}

const results = [];
function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) process.exitCode = 1;
}

// Functional on/off uses --force when a real Cursor already owns the DB on
// this machine; the decoy block below still proves the non-force refusal.
let forceFlag = "";
{
  const probe = cliOrNull("cursor on --json");
  if (probe.ok) {
    const on = JSON.parse(probe.out);
    check("cursor on succeeds", on.state === "on" && on.agent === "cursor", JSON.stringify(on));
  } else if (/--force|will overwrite this config/.test(probe.err)) {
    forceFlag = " --force";
    const on = JSON.parse(cli(`cursor on${forceFlag} --json`));
    check(
      "cursor on succeeds (live Cursor; --force)",
      on.state === "on" && on.agent === "cursor",
      JSON.stringify(on)
    );
  } else {
    check("cursor on succeeds", false, probe.err.split("\n")[0]);
    console.log(results.join("\n"));
    process.exit(1);
  }
}

const st = JSON.parse(cli("cursor status --json"));
check("status: state on", st.state === "on", JSON.stringify(st));
check("status: model reported", st.model !== null, String(st.model));

const survivors = dbScript(`
const r = db.prepare("SELECT key FROM ItemTable WHERE key IN ('unrelated/row','cursorAuth/otherKey')").all();
console.log(JSON.stringify(r.map(x => x.key)));
`);
check(
  "unrelated rows survive on",
  survivors.includes("unrelated/row") && survivors.includes("cursorAuth/otherKey"),
  survivors
);
const blobText = dbScript(`
const r = db.prepare("SELECT value FROM ItemTable WHERE key='src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser'").get();
console.log(typeof r.value === "string" ? r.value : new TextDecoder().decode(r.value));
`);
const blobOn = JSON.parse(blobText);
check(
  "blob routed to ai&",
  blobOn.openAIBaseUrl === "https://api.aiand.com/v1" && blobOn.useOpenAIKey === true
);
check(
  "blob keeps unrelated fields + user modes",
  blobOn.someOtherField === 42 &&
    blobOn.aiSettings.modelConfig["cmd-k"].maxMode === true &&
    blobOn.aiSettings.userAddedModels.includes("my-own-model")
);

cli(`cursor off${forceFlag} --json`);
const DB_AFTER_OFF = readFileSync(db);
check(
  "off restores DB byte-identical",
  DB_BEFORE.equals(DB_AFTER_OFF),
  `before=${DB_BEFORE.length}B after=${DB_AFTER_OFF.length}B`
);
check("backup dir removed", !existsSync(join(S, "cfg", "backups", "cursor", "latest.json")));

const st2 = JSON.parse(cli("cursor status --json"));
check("status: off after teardown", st2.state === "off", JSON.stringify(st2));

cli(`cursor on${forceFlag} --json`);
execSync(`rm -rf ${join(S, "cfg", "backups")}`);
cli(`cursor off${forceFlag} --json`);
const stripped = JSON.parse(
  dbScript(`
const r = db.prepare("SELECT value FROM ItemTable WHERE key='src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser'").get();
console.log(typeof r.value === "string" ? r.value : new TextDecoder().decode(r.value));
`)
);
check(
  "forced-off strips routing",
  stripped.openAIBaseUrl === null && stripped.useOpenAIKey === false,
  JSON.stringify({ base: stripped.openAIBaseUrl, use: stripped.useOpenAIKey })
);
check(
  "forced-off preserves unrelated blob fields",
  stripped.someOtherField === 42 && stripped.aiSettings.modelConfig["cmd-k"].maxMode === true
);
check(
  "forced-off leaves non-aiand rows untouched",
  dbScript(
    `console.log(JSON.stringify(db.prepare("SELECT key FROM ItemTable WHERE key IN ('unrelated/row','cursorAuth/otherKey')").all().map(x => x.key)))`
  ).includes("cursorAuth/otherKey")
);

writeFileSync(join(S, "bin", "cursor-runner"), "#!/bin/bash\nexec -a /cursor sleep 30\n");
execSync(`chmod +x ${join(S, "bin", "cursor-runner")}`);
const decoy = spawn(join(S, "bin", "cursor-runner"), [], { env, detached: true, stdio: "ignore" });
decoy.unref();
execSync("sleep 0.5");
let refused = false;
let refuseStderr = "";
{
  const attempt = cliOrNull("cursor on --json");
  refuseStderr = attempt.err;
  refused = /--force|will overwrite this config/.test(refuseStderr);
}
check("on refuses while Cursor-like process runs (non-TTY)", refused, refuseStderr.split("\n")[0]);

{
  const forced = JSON.parse(cli("cursor on --force --json"));
  check("on --force proceeds past the guard", forced.state === "on", JSON.stringify(forced));
}
try {
  process.kill(-decoy.pid, "SIGTERM");
} catch {
  try {
    process.kill(decoy.pid, "SIGTERM");
  } catch {
    // Decoy may already have exited.
  }
}
execSync("sleep 0.3");
cli(`cursor off${forceFlag || " --force"} --json`);
const finalStatus = JSON.parse(cli("cursor status --json"));
check("final off leaves status off", finalStatus.state === "off", JSON.stringify(finalStatus));
check(
  "final off leaves non-aiand rows untouched",
  dbScript(
    `console.log(JSON.stringify(db.prepare("SELECT key FROM ItemTable WHERE key IN ('unrelated/row','cursorAuth/otherKey')").all().map(x => x.key)))`
  ).includes("cursorAuth/otherKey")
);

const codexSt = JSON.parse(cli("codex status --json"));
check("codex status still works", codexSt.agent === "codex");

const { AGENTS } = await import(join(ROOT, "dist", "agents", "registry.js"));
const agentIds = AGENTS.map((row) => row.id).sort();
const expected = [
  "claude",
  "codex",
  "cursor",
  "deepseek",
  "grok",
  "hermes",
  "opencode",
  "pi",
  "prime",
  "vscode",
].sort();
check(
  "registry lists every phase 2–4 agent",
  JSON.stringify(agentIds) === JSON.stringify(expected),
  JSON.stringify(agentIds)
);

console.log(results.join("\n"));
console.log(results.every((r) => r.startsWith("PASS")) ? "E2E: ALL PASS" : "E2E: FAILURES PRESENT");
