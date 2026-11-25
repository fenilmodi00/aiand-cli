#!/usr/bin/env node
// Rewrites /etc/hosts and ~/.claude: run only inside the image, offline:
//   docker build -t aiand-claude-contract scripts/claude-contract
//   docker run --rm --network none -v "$PWD:/src:ro" -v /tmp/out:/out \
//     aiand-claude-contract node /src/scripts/claude-contract/run.mjs 2.1.318
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SETUP_ONLY = process.argv.includes("--setup-only");
const VERSION = process.argv.filter((a) => !a.startsWith("--"))[2] ?? "2.1.318";
const OUT = join(process.env.CONTRACT_OUT ?? "/out", VERSION);
const CLAUDE_BIN = `/opt/claude/${VERSION}/node_modules/.bin`;
const AIAND = "node /src/dist/index.js";
const HOME = "/root";
const SETTINGS = `${HOME}/.claude/settings.json`;
const LOG = join(OUT, "requests.jsonl");
const AIAND_URL = "http://127.0.0.1:8080";
const CATALOG = ["openai/gpt-5", "zai-org/glm-5.3", "deepseek-ai/deepseek-v4-flash"];

if (process.getuid?.() !== 0 || !existsSync("/opt/claude")) {
  console.error(
    "run.mjs runs only inside the aiand-claude-contract image (it rewrites /etc/hosts).",
  );
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
writeFileSync(LOG, "");

const sh = (cmd) => execFileSync("bash", ["-c", cmd], { encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const transcript = [];
const note = (line) => {
  transcript.push(line);
  console.log(line);
};

function contractEnv() {
  return {
    PATH: `${CLAUDE_BIN}:${process.env.PATH}`,
    HOME,
    TERM: "xterm-256color",
    NODE_EXTRA_CA_CERTS: "/certs/ca.pem",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    AIAND_API_KEY: "sk-aiand-mock",
    AIAND_BASE_URL: AIAND_URL,
    AIAND_NO_BROWSER: "1",
  };
}

function setup() {
  sh(`mkdir -p /certs && cd /certs &&
    openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=mock-ca -keyout ca.key -out ca.pem 2>/dev/null &&
    openssl req -newkey rsa:2048 -nodes -subj /CN=api.anthropic.com -keyout srv.key -out srv.csr 2>/dev/null &&
    printf 'subjectAltName=DNS:api.anthropic.com\\n' > ext.cnf &&
    openssl x509 -req -in srv.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 -extfile ext.cnf -out srv.pem 2>/dev/null &&
    grep -q api.anthropic.com /etc/hosts || echo '127.0.0.1 api.anthropic.com' >> /etc/hosts`);
  const gateway = "/src/test/mock-gateway.mjs";
  for (const [port, label, tls] of [
    [443, "anthropic", true],
    [8080, "aiand", false],
  ]) {
    const args = [gateway, "--port", String(port), "--label", label, "--log", LOG];
    if (tls) args.push("--cert", "/certs/srv.pem", "--key", "/certs/srv.key");
    spawn("node", args, { stdio: "ignore", detached: true }).unref();
  }
  mkdirSync(`${HOME}/.claude`, { recursive: true });
  const expiresAt = Date.now() + 86_400_000;
  writeFileSync(
    `${HOME}/.claude/.credentials.json`,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-mock",
        refreshToken: "sk-ant-ort01-mock",
        expiresAt,
        scopes: ["user:inference", "user:profile"],
        subscriptionType: "team",
      },
    }),
  );
  const projects = {};
  for (const name of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    mkdirSync(`/work/sess${name}`, { recursive: true });
    projects[`/work/sess${name}`] = { hasTrustDialogAccepted: true };
  }
  for (let i = 0; i < 20; i += 1) {
    mkdirSync(`/work/sessW${i}`, { recursive: true });
    projects[`/work/sessW${i}`] = { hasTrustDialogAccepted: true };
  }
  writeFileSync(
    `${HOME}/.claude.json`,
    JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", projects }),
  );
  writeFileSync(SETTINGS, `${JSON.stringify({ model: "opus" }, null, 2)}\n`);
  mkdirSync(`${HOME}/.config/aiand`, { recursive: true });
  const env = contractEnv();
  const exports = Object.entries(env)
    .map(([k, v]) => `export ${k}='${v}'`)
    .join("; ");
  writeFileSync("/root/.contract-env", `${exports}\n`);
}

const tmux = (...args) => execFileSync("tmux", ["-L", "contract", ...args], { encoding: "utf8" });
const screen = (s) => tmux("capture-pane", "-p", "-t", s);

function open(name, command) {
  tmux(
    "new-session",
    "-d",
    "-s",
    name,
    "-x",
    "140",
    "-y",
    "50",
    "-c",
    `/work/sess${name}`,
    `bash --rcfile /root/.contract-env`,
  );
  type(name, command);
}

function type(name, text) {
  tmux("send-keys", "-t", name, "-l", text);
  tmux("send-keys", "-t", name, "Enter");
}

const key = (name, k) => tmux("send-keys", "-t", name, k);

async function waitScreen(name, pattern, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pattern.test(screen(name))) return true;
    await sleep(250);
  }
  note(`  (timeout waiting for ${pattern} in ${name})\n${screen(name)}`);
  return false;
}

function requests() {
  return readFileSync(LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Claude Code drops keys sent mid-redraw, so Enter waits until the text shows. */
async function submit(name, text) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sleep(700);
    tmux("send-keys", "-t", name, "-l", text);
    const end = Date.now() + 3000;
    while (Date.now() < end && !screen(name).includes(text)) await sleep(150);
    if (screen(name).includes(text)) {
      key(name, "Enter");
      return true;
    }
    key(name, "C-u");
  }
  note(`  (could not type ${text} into ${name})\n${screen(name)}`);
  return false;
}

async function ask(name, token, ms = 20_000) {
  await submit(name, `say ${token}`);
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = requests().find((r) => r.path.endsWith("/v1/messages") && r.prompt.includes(token));
    if (hit) return hit;
    await sleep(250);
  }
  note(`  (no request carried ${token})\n${screen(name)}`);
  return null;
}

async function pickModel(name, rowPattern, save) {
  await submit(name, "/model");
  await waitScreen(name, /Select model/);
  for (let i = 0; i < 30; i += 1) {
    const focused = screen(name)
      .split("\n")
      .find((line) => /❯\s+\d+\./.test(line));
    if (focused && rowPattern.test(focused)) break;
    key(name, "Down");
    await sleep(150);
  }
  key(name, save ? "Enter" : "s");
  // Claude Code confirms a switch once the conversation has history.
  if (await waitScreen(name, /Switch model\?|saved as your default|this session only/, 8000)) {
    for (let i = 0; i < 8 && /Switch model\?/.test(screen(name)); i += 1) {
      await sleep(500);
      key(name, "Enter");
    }
  }
  const done = await waitScreen(name, save ? /saved as your default/ : /this session only/, 8000);
  await sleep(500);
  return done;
}

const settings = () => JSON.parse(readFileSync(SETTINGS, "utf8"));

function check(id, what, pass, evidence, kind = "check") {
  results.push({ id, what, pass, evidence, kind });
  const tag = kind === "observe" ? (pass ? "SEEN" : "NOT SEEN") : pass ? "PASS" : "FAIL";
  note(`${tag} ${id} ${what}${evidence ? `  — ${JSON.stringify(evidence)}` : ""}`);
}

const observe = (id, what, seen, evidence) => check(id, what, seen, evidence, "observe");

const route = (r) => (r ? { gateway: r.label, model: r.model, session: r.cwd } : null);

// Settings parity alone cannot prove that stock Claude Code reads the
// hint. Compare the window it reports in modelUsage with the HTTP catalog.
async function contextParity() {
  note("\n# Context parity: API catalog → aiand startup hint → Claude Code modelUsage");
  const baseUrl = `${AIAND_URL}/stub/context-catalog`;
  const { data: catalog } = await (await fetch(`${baseUrl}/v1/models`)).json();
  for (const model of catalog) {
    try {
      const stdout = execFileSync(
        process.execPath,
        [
          "/src/dist/index.js",
          "--base-url",
          baseUrl,
          "claude",
          "--model",
          model.id,
          "-p",
          "say context parity",
          "--output-format",
          "json",
          "--max-turns",
          "1",
        ],
        { encoding: "utf8", cwd: "/work/sessA", env: contractEnv(), timeout: 45_000 },
      );
      writeFileSync(join(OUT, `context-${catalog.indexOf(model)}.json`), stdout);
      const result = JSON.parse(stdout);
      const usage =
        result.modelUsage?.[model.id] ?? result.modelUsage?.[model.id.replace(/\[1m\]$/i, "")];
      check(
        `context.${model.id}`,
        "Claude Code's reported context window equals API context_window",
        !result.is_error && usage?.contextWindow === model.context_window,
        { model: model.id, expected: model.context_window, modelUsage: result.modelUsage },
      );
    } catch (error) {
      check(
        `context.${model.id}`,
        "Claude Code reports the API context window",
        false,
        String(error),
      );
    }
  }
}

async function sideBySide() {
  note("\n# Scenario 1: A plain claude, B aiand claude, C plain claude");
  open("A", "claude");
  const a1 = await ask("A", "A1");
  check("S1.1", "A (plain claude) reaches Anthropic", a1?.label === "anthropic", route(a1));

  open("B", `${AIAND} claude`);
  await waitScreen("B", /API Usage Billing/);
  check(
    "S1.2",
    "starting B wired nothing into settings.json",
    settings().env === undefined,
    settings(),
  );

  // 2.1.311 rewrites opus to opus[1m] at start.
  const userDefault = settings().model;
  const saved = await pickModel("B", /deepseek-ai\/deepseek-v4-flash/, true);
  await sleep(1500);
  check(
    "S1.4",
    "B's /model save (Enter), which Claude Code reports as saved, leaves the user's default as it was",
    saved && settings().model === userDefault,
    { claudeSaidSaved: saved, before: userDefault, model: settings().model },
  );
  const b1 = await ask("B", "B1");
  check(
    "S1.5",
    "B reaches ai& on the model it picked",
    b1?.label === "aiand" && b1?.model === "deepseek-ai/deepseek-v4-flash",
    route(b1),
  );

  open("C", "claude");
  const c1 = await ask("C", "C1");
  check(
    "S1.6",
    "C (plain claude, started while B runs) reaches Anthropic on an Anthropic model",
    c1?.label === "anthropic" && !CATALOG.includes(c1?.model),
    route(c1),
  );
  const a2 = await ask("A", "A2");
  check("S1.7", "A still reaches Anthropic", a2?.label === "anthropic", route(a2));

  key("B", "C-c");
  await sleep(400);
  const aliveAfterOne = sh("pgrep -f 'dist/index.js claude' || true").trim() !== "";
  check("S1.8", "one Ctrl+C in B leaves aiand running", aliveAfterOne, null);
  key("B", "C-c");
  await sleep(300);
  key("B", "C-c");
  for (let i = 0; i < 40 && sh("pgrep -f 'dist/index.js claude' || true").trim(); i += 1) {
    await sleep(250);
  }
  const overlays = sh("ls -d /tmp/aiand-claude-* 2>/dev/null || true").trim();
  check("S1.9", "B's exit removes its overlay", overlays === "", { overlays });
  for (const s of ["A", "C"]) type(s, "/exit");
  await sleep(1500);
}

async function globalOnOff() {
  note("\n# Scenario 2: global on/off while a plain claude runs");
  open("D", "claude");
  const d1 = await ask("D", "D1");
  check(
    "S2.1",
    "D (plain claude) reaches Anthropic before on",
    d1?.label === "anthropic",
    route(d1),
  );

  const on = sh(`. /root/.contract-env; ${AIAND} claude on 2>&1`);
  note(on.trim());
  check(
    "S2.2",
    "on warns that running sessions switch",
    /they now send requests to ai&/.test(on),
    null,
  );
  await sleep(1500);
  const d2 = await ask("D", "D2");
  check(
    "S2.3",
    "observed: D, running before on, now reaches ai& (Claude Code re-applies env live)",
    d2?.label === "aiand",
    route(d2),
  );
  open("E", "claude");
  const e1 = await ask("E", "E1");
  check("S2.4", "E (new plain claude after on) reaches ai&", e1?.label === "aiand", route(e1));

  const off = sh(`. /root/.contract-env; ${AIAND} claude off 2>&1`);
  note(off.trim());
  check("S2.5", "off says running sessions switch back", /switch back too/.test(off), null);
  await sleep(1500);
  const d3 = await ask("D", "D3");
  check(
    "S2.6",
    "D, still running, is back on Anthropic and its own model after off",
    d3?.label === "anthropic" && !CATALOG.includes(d3?.model),
    route(d3),
  );
  open("F", "claude");
  const f1 = await ask("F", "F1");
  check(
    "S2.7",
    "F (new plain claude after off) reaches Anthropic",
    f1?.label === "anthropic",
    route(f1),
  );
  for (const s of ["D", "E", "F"]) type(s, "/exit");
  await sleep(1500);
}

async function claudeCodeBehaviour() {
  note("\n# Scenario 3: Claude Code's own behaviour, no aiand involved");
  open("H", "claude");
  await waitScreen("H", /Claude Team/);
  const original = settings().model;
  const hSaved = await pickModel("H", /Sonnet/, true);
  check(
    "S3.6",
    "/model + Enter writes the pick to the user's settings.json model",
    hSaved && /sonnet/i.test(String(settings().model)),
    { claudeSaidSaved: hSaved, model: settings().model },
  );
  writeFileSync(SETTINGS, JSON.stringify({ ...settings(), model: original }, null, 2));
  type("H", "/exit");
  await sleep(1000);

  open("G", "claude");
  const g1 = await ask("G", "G1");
  check("S3.1", "G reaches Anthropic", g1?.label === "anthropic", route(g1));
  const withEnv = {
    ...settings(),
    env: { ANTHROPIC_BASE_URL: AIAND_URL, ANTHROPIC_AUTH_TOKEN: "sk-x" },
  };
  writeFileSync(SETTINGS, JSON.stringify(withEnv, null, 2));
  await sleep(2000);
  const g2 = await ask("G", "G2");
  check(
    "S3.2",
    "an env block added to settings.json reaches the running session",
    g2?.label === "aiand",
    route(g2),
  );
  const { env: _drop, ...without } = settings();
  writeFileSync(SETTINGS, JSON.stringify(without, null, 2));
  await sleep(2000);
  const g3 = await ask("G", "G3");
  check("S3.3", "removing it does not take it back", g3?.label === "aiand", route(g3));
  writeFileSync(
    SETTINGS,
    JSON.stringify(
      { ...without, env: { ANTHROPIC_BASE_URL: "", ANTHROPIC_AUTH_TOKEN: "" } },
      null,
      2,
    ),
  );
  await sleep(2000);
  const g4 = await ask("G", "G4");
  observe(
    "S3.4",
    "blanking the keys instead sends the running session back to Anthropic",
    g4?.label === "anthropic",
    route(g4),
  );
  writeFileSync(SETTINGS, JSON.stringify(without, null, 2));

  const before = settings().model;
  writeFileSync(SETTINGS, JSON.stringify({ ...settings(), model: "haiku" }, null, 2));
  await sleep(2000);
  const g5 = await ask("G", "G5");
  check(
    "S3.5",
    "a model setting changed mid-session does not move the running session",
    g5?.model === g1?.model,
    { before: g1?.model, after: g5?.model },
  );
  writeFileSync(SETTINGS, JSON.stringify({ ...settings(), model: before }, null, 2));
  type("G", "/exit");
  await sleep(1000);
}

const panePid = (name) => tmux("display", "-p", "-t", name, "#{pane_pid}").trim();
const childOf = (pid) => sh(`pgrep -P ${pid} || true`).trim().split("\n")[0];
const readRaw = () => readFileSync(SETTINGS, "utf8");
const modelIn = (raw) => /"model"\s*:\s*"([^"]*)"/.exec(raw)?.[1] ?? null;
const resetSettings = (text = `${JSON.stringify({ model: "opus" }, null, 2)}\n`) => {
  sh(`rm -f ${SETTINGS}`);
  writeFileSync(SETTINGS, text);
};

async function aiandSessionWithPick(name) {
  open(name, `${AIAND} claude`);
  await waitScreen(name, /API Usage Billing/);
  return pickModel(name, /deepseek-ai\/deepseek-v4-flash/, true);
}

async function faults() {
  note("\n# Scenario 5: failure modes");

  resetSettings();
  const overlays = () => Number(sh("ls -d /tmp/aiand-claude-* 2>/dev/null | wc -l").trim());
  const before = overlays();
  open("P", `${AIAND} claude`);
  await waitScreen("P", /API Usage Billing/);
  const pAiand = childOf(panePid("P"));
  const pClaude = childOf(pAiand);
  sh(`kill -9 ${pAiand}`);
  await sleep(1500);
  const orphan = sh(`ps -o ppid=,stat= -p ${pClaude} || true`).trim();
  observe(
    "F1.1",
    "kill -9 of aiand: claude lives on, orphaned in the background; its overlay stays",
    /^1\s+[^+\s]*$/.test(orphan) && overlays() === before + 1,
    { claude: orphan, overlaysAdded: overlays() - before },
  );
  sh(`kill -9 ${pClaude} || true`);
  resetSettings(`${JSON.stringify({ model: "deepseek-ai/deepseek-v4-flash" }, null, 2)}\n`);
  open("Q", `${AIAND} claude`);
  await waitScreen("Q", /API Usage Billing/);
  await submit("Q", "/exit");
  for (let i = 0; i < 40 && sh(`pgrep -P ${panePid("Q")} || true`).trim(); i += 1) await sleep(250);
  check(
    "F1.2",
    "the next aiand claude session removes such a leftover ai& default when it ends",
    modelIn(readRaw()) === null,
    { settings: readRaw().trim() },
  );

  resetSettings();
  const rBefore = overlays();
  const rSaved = await aiandSessionWithPick("R");
  const rAiand = childOf(panePid("R"));
  const rClaude = childOf(rAiand);
  sh(`kill -9 ${rClaude}`);
  for (let i = 0; i < 40 && sh(`kill -0 ${rAiand} 2>/dev/null && echo up || true`).trim(); i += 1)
    await sleep(250);
  type("R", "echo EXIT=$?");
  await waitScreen("R", /EXIT=\d+/, 5000);
  const rExit = /EXIT=(\d+)/.exec(screen("R"))?.[1];
  check(
    "F2",
    "kill -9 of claude: aiand exits 137, removes its overlay, default is opus",
    rSaved && rExit === "137" && modelIn(readRaw()) === "opus" && overlays() === rBefore,
    { exit: rExit, model: modelIn(readRaw()), overlaysAdded: overlays() - rBefore },
  );

  resetSettings();
  open("S", `${AIAND} claude`);
  await waitScreen("S", /API Usage Billing/);
  const writer = spawn(
    "node",
    [
      "-e",
      `
    const fs = require("fs"); let n = 0; const end = Date.now() + 6000;
    (function loop() {
      if (Date.now() > end) { fs.writeFileSync("/tmp/writer-last", String(n)); return; }
      try { const s = JSON.parse(fs.readFileSync("${SETTINGS}", "utf8")); s.n = ++n; fs.writeFileSync("${SETTINGS}.w", JSON.stringify(s)); fs.renameSync("${SETTINGS}.w", "${SETTINGS}"); } catch {}
      setTimeout(loop, 5);
    })();`,
    ],
    { stdio: "ignore" },
  );
  const sSaved = await pickModel("S", /deepseek-ai\/deepseek-v4-flash/, true);
  await new Promise((r) => writer.on("exit", r));
  await sleep(1500);
  const final = JSON.parse(readRaw());
  observe(
    "F3",
    "a racing writer: the ai& pick is still put back, the writer's last value survives",
    sSaved &&
      final.model === "opus" &&
      String(final.n) === readFileSync("/tmp/writer-last", "utf8"),
    { model: final.model, n: final.n, writerLast: readFileSync("/tmp/writer-last", "utf8") },
  );
  type("S", "/exit");
  await sleep(1500);

  sh(
    `mkdir -p /dotfiles && printf '{\n  "model": "opus"\n}\n' > /dotfiles/claude.json && rm -f ${SETTINGS} && ln -s /dotfiles/claude.json ${SETTINGS}`,
  );
  const tSaved = await aiandSessionWithPick("T");
  await sleep(1500);
  const stillLink = sh(`test -L ${SETTINGS} && echo yes || echo no`).trim();
  check(
    "F4",
    "symlinked settings.json: the link survives and the pick is put back in the dotfiles file while the session runs",
    tSaved &&
      stillLink === "yes" &&
      modelIn(readFileSync("/dotfiles/claude.json", "utf8")) === "opus",
    {
      stillLink,
      dotfiles: modelIn(readFileSync("/dotfiles/claude.json", "utf8")),
      linkPath: modelIn(readRaw()),
    },
  );
  type("T", "/exit");
  await sleep(1500);

  resetSettings();
  sh(`chmod 444 ${SETTINGS}`);
  const uSaved = await aiandSessionWithPick("U");
  await sleep(1500);
  observe("F5", "read-only settings.json: what Claude Code's save and the put-back leave", true, {
    claudeSaidSaved: uSaved,
    model: modelIn(readRaw()),
    mode: sh(`stat -c %a ${SETTINGS}`).trim(),
  });
  type("U", "/exit");
  await sleep(1500);

  resetSettings('// my settings\n{\n  // keep this comment\n  "model": "opus"\n}\n');
  const vSaved = await aiandSessionWithPick("V");
  await sleep(1500);
  observe("F6", "JSONC settings.json: comments after Claude Code's save and the put-back", true, {
    claudeSaidSaved: vSaved,
    model: modelIn(readRaw()),
    commentsLeft: (readRaw().match(/\/\//g) ?? []).length,
    file: readRaw(),
  });
  type("V", "/exit");
  await sleep(1500);

  resetSettings();
  sh(
    `mkdir -p /work/sessW/.claude && echo '{"model":"sonnet","env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com"}}' > /work/sessW/.claude/settings.json`,
  );
  open("W", `${AIAND} claude`);
  const w1 = await ask("W", "W1");
  check(
    "F7",
    "project settings routing elsewhere: aiand claude still reaches ai&",
    w1?.label === "aiand" && CATALOG.includes(w1?.model),
    route(w1),
  );
  type("W", "/exit");
  await sleep(1500);

  sh(
    `mkdir -p /etc/claude-code && echo '{"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com"}}' > /etc/claude-code/managed-settings.json`,
  );
  open("X", `${AIAND} claude`);
  const x1 = await ask("X", "X1");
  observe(
    "F8",
    "managed settings routing elsewhere win over aiand claude",
    x1?.label === "anthropic",
    route(x1),
  );
  type("X", "/exit");
  sh("rm -f /etc/claude-code/managed-settings.json");
  await sleep(1500);

  resetSettings();
  const ySaved = await aiandSessionWithPick("Y");
  const sdk = sh(
    `. /root/.contract-env; cd /work/sessZ && timeout 60 claude -p --model claude-opus-5-5 "say Z1" 2>&1 || true`,
  );
  const z1 = requests().find((r) => r.prompt.includes("Z1"));
  check(
    "F9",
    "a claude -p host started beside an aiand claude session reaches Anthropic",
    ySaved && z1?.label === "anthropic",
    { ...route(z1), output: sdk.trim().slice(0, 80) },
  );
  type("Y", "/exit");
  await sleep(1500);
  resetSettings();
}

async function emptyThenDelete() {
  note("\n# Scenario 6 (experiment): empty a key, then delete it");
  resetSettings();
  open("L", "claude");
  const steps = [];
  const aiandEnv = {
    ANTHROPIC_BASE_URL: AIAND_URL,
    ANTHROPIC_AUTH_TOKEN: "sk-x",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "zai-org/glm-5.3",
  };
  for (const [step, env] of [
    ["start", undefined],
    ["keys set", aiandEnv],
    ["keys empty", Object.fromEntries(Object.keys(aiandEnv).map((k) => [k, ""]))],
    ["keys deleted", undefined],
  ]) {
    const { env: _old, ...rest } = settings();
    writeFileSync(`${SETTINGS}.tmp`, JSON.stringify(env ? { ...rest, env } : rest, null, 2));
    sh(`mv ${SETTINGS}.tmp ${SETTINGS}`);
    await sleep(2500);
    steps.push([step, route(await ask("L", `L${steps.length}`))]);
  }
  observe(
    "S6",
    "a running session after: start, keys set, keys emptied, keys deleted",
    true,
    steps,
  );
  type("L", "/exit");
  await sleep(1000);

  const waits = (process.env.CONTRACT_WAITS ?? "1000,3000,8000").split(",").map(Number);
  for (const [i, wait] of waits.entries()) {
    const name = `W${i}`;
    resetSettings();
    open(name, "claude");
    await ask(name, `${name}a`);
    const write = (env) => {
      const { env: _old, ...rest } = settings();
      writeFileSync(`${SETTINGS}.tmp`, JSON.stringify(env ? { ...rest, env } : rest, null, 2));
      sh(`mv ${SETTINGS}.tmp ${SETTINGS}`);
    };
    write(aiandEnv);
    await sleep(2500);
    const set = await ask(name, `${name}b`);
    write(Object.fromEntries(Object.keys(aiandEnv).map((k) => [k, ""])));
    await sleep(wait);
    write(undefined);
    await sleep(2500);
    const after = await ask(name, `${name}c`);
    observe(
      `S6.${wait}`,
      `emptied, ${wait}ms with no request, then deleted: back on Anthropic`,
      set?.label === "aiand" && after?.label === "anthropic",
      { set: route(set), after: route(after) },
    );
    type(name, "/exit");
    await sleep(1000);
  }
}

setup();
await sleep(1000);
if (SETUP_ONLY) process.exit(0);
note(`Claude Code ${sh(`${CLAUDE_BIN}/claude --version`).trim()}`);
try {
  if (!process.env.CONTRACT_ONLY_EXPERIMENTS) await contextParity();
  if (!process.env.CONTRACT_ONLY_EXPERIMENTS && !process.env.CONTRACT_CONTEXT_ONLY)
    await sideBySide();
  if (!process.env.CONTRACT_ONLY_EXPERIMENTS && !process.env.CONTRACT_CONTEXT_ONLY)
    await globalOnOff();
  if (!process.env.CONTRACT_ONLY_EXPERIMENTS && !process.env.CONTRACT_CONTEXT_ONLY)
    await claudeCodeBehaviour();
  if (!process.env.CONTRACT_ONLY_EXPERIMENTS && !process.env.CONTRACT_CONTEXT_ONLY) await faults();
  if (process.env.CONTRACT_EXPERIMENTS) await emptyThenDelete();
} finally {
  if (!process.env.CONTRACT_CONTEXT_ONLY) tmux("kill-server");
}
const failed = results.filter((r) => !r.pass && r.kind === "check");
writeFileSync(join(OUT, "results.json"), JSON.stringify({ version: VERSION, results }, null, 2));
appendFileSync(join(OUT, "transcript.txt"), `${transcript.join("\n")}\n`);
const checks = results.filter((r) => r.kind === "check").length;
note(`\n${checks - failed.length}/${checks} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);
