import { writeFileSync, readFileSync, existsSync, mkdirSync, cpSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = dirname(dirname(fileURLToPath(import.meta.url))) + "/dist/index.js";
const S = "/tmp/aiand-e2e";
execSync(`rm -rf ${S} && mkdir -p ${S}/home/.config/Cursor/User/globalStorage ${S}/cfg ${S}/bin`);
const db = join(S, "home/.config/Cursor/User/globalStorage/state.vscdb");

// Helper: run a node script against the DB without shell-quoting hazards.
function dbScript(code) {
  const file = join(S, "probe.mjs");
  writeFileSync(file, `import { DatabaseSync } from "node:sqlite";\nconst db = new DatabaseSync(${JSON.stringify(db)});\n${code}\ndb.close();\n`);
  return execSync(`node ${file}`, { encoding: "utf8" }).trim();
}

// --- Fixture DB with a realistic pre-aiand Cursor state -------------------
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
const CLONE = join(S, "before.vscdb");
cpSync(db, CLONE);

const env = {
  ...process.env,
  AIAND_HOME: `${S}/home`,
  AIAND_CONFIG_DIR: `${S}/cfg`,
  AIAND_API_KEY: "sk-e2e-test-key-0000000000000000000000",
  PATH: `${S}/bin:${process.env.PATH}`,
};

function cli(args) {
  return execSync(`node ${DIST} ${args}`, { env, encoding: "utf8" });
}

const results = [];
function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) process.exitCode = 1;
}

// --- 1. cursor on ----------------------------------------------------------
const on = JSON.parse(cli("cursor on --json"));
check("cursor on succeeds", on.state === "on" && on.agent === "cursor", JSON.stringify(on));

// --- 2. status reflects on + model -----------------------------------------
const st = JSON.parse(cli("cursor status --json"));
check("status: state on", st.state === "on", JSON.stringify(st));
check("status: model reported", st.model !== null, String(st.model));

// --- 3. routing landed; unrelated rows survive ----------------------------
const survivors = dbScript(`
const r = db.prepare("SELECT key FROM ItemTable WHERE key IN ('unrelated/row','cursorAuth/otherKey')").all();
console.log(JSON.stringify(r.map(x => x.key)));
`);
check("unrelated rows survive on", survivors.includes("unrelated/row") && survivors.includes("cursorAuth/otherKey"), survivors);
const blobText = dbScript(`
const r = db.prepare("SELECT value FROM ItemTable WHERE key='src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser'").get();
console.log(typeof r.value === "string" ? r.value : new TextDecoder().decode(r.value));
`);
const blobOn = JSON.parse(blobText);
check("blob routed to ai&", blobOn.openAIBaseUrl === "https://api.aiand.com/v1" && blobOn.useOpenAIKey === true);
check("blob keeps unrelated fields + user modes", blobOn.someOtherField === 42 && blobOn.aiSettings.modelConfig["cmd-k"].maxMode === true && blobOn.aiSettings.userAddedModels.includes("my-own-model"));

// --- 4. cursor off → byte-identical restore --------------------------------
cli("cursor off --json");
const DB_AFTER_OFF = readFileSync(db);
check("off restores DB byte-identical", DB_BEFORE.equals(DB_AFTER_OFF), `before=${DB_BEFORE.length}B after=${DB_AFTER_OFF.length}B`);
check("backup dir removed", !existsSync(`${S}/cfg/backups/cursor/latest.json`));

// --- 5. status honesty ------------------------------------------------------
const st2 = JSON.parse(cli("cursor status --json"));
check("status: off after teardown", st2.state === "off", JSON.stringify(st2));

// --- 6. forced-off strip path (no manifest, markers present) ---------------
cli("cursor on --json");
execSync(`rm -rf ${S}/cfg/backups`);
cli("cursor off --json");
const stripped = JSON.parse(dbScript(`
const r = db.prepare("SELECT value FROM ItemTable WHERE key='src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser'").get();
console.log(typeof r.value === "string" ? r.value : new TextDecoder().decode(r.value));
`));
check("forced-off strips routing", stripped.openAIBaseUrl === null && stripped.useOpenAIKey === false, JSON.stringify({ base: stripped.openAIBaseUrl, use: stripped.useOpenAIKey }));
check("forced-off preserves unrelated blob fields", stripped.someOtherField === 42 && stripped.aiSettings.modelConfig["cmd-k"].maxMode === true);
check("forced-off leaves non-aiand rows untouched",
  dbScript(`console.log(JSON.stringify(db.prepare("SELECT key FROM ItemTable WHERE key IN ('unrelated/row','cursorAuth/otherKey')").all().map(x => x.key)))`).includes("cursorAuth/otherKey"));

// --- 7. guard: on refuses while a Cursor-like process runs ------------------
// `exec -a` is a bash builtin: run via bash so /proc/<pid>/cmdline literally
// starts with "/cursor" and the guard's pgrep pattern matches exactly the
// way a real Cursor install would.
writeFileSync(`${S}/bin/cursor-runner`, "#!/bin/bash\nexec -a /cursor sleep 30\n");
execSync(`chmod +x ${S}/bin/cursor-runner`);
const decoy = spawn(`${S}/bin/cursor-runner`, [], { env, detached: true, stdio: "ignore" });
decoy.unref();
execSync("sleep 0.5");
let refused = false;
let refuseStderr = "";
try {
  cli("cursor on --json");
} catch (error) {
  refuseStderr = error.stderr.toString();
  refused = /--force|will overwrite this config/.test(refuseStderr);
}
check("on refuses while Cursor-like process runs (non-TTY)", refused, refuseStderr.split("\n")[0]);

out_force: {
  const forced = JSON.parse(cli("cursor on --force --json"));
  check("on --force proceeds past the guard", forced.state === "on", JSON.stringify(forced));
}
cli("cursor off --json");
check("final off restores the pristine bytes", DB_BEFORE.equals(readFileSync(db)));

// --- 8. codex/chatgpt guard smoke (linux: guard no-ops) ---------------------
const codexSt = JSON.parse(cli("codex status --json"));
check("codex status still works", codexSt.agent === "codex");

console.log(results.join("\n"));
console.log(results.every((r) => r.startsWith("PASS")) ? "E2E: ALL PASS" : "E2E: FAILURES PRESENT");
