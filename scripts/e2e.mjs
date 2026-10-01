import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, "dist", "index.js");
const API_DOUBLE_START_TIMEOUT_MS = 15_000;
// What the installers stamp to mark a checkout and a launcher as their own.
const OWNERSHIP_MARKER = ".aiand-installer-owned";
const LAUNCHER_HEADER = "aiand launcher";
// A stand-in ~/.local/bin/aiand the installer recognizes as its own.
const FAKE_LAUNCHER = `#!/bin/sh\n# ${LAUNCHER_HEADER} (test stub)\nexec "${process.execPath}" "${DIST}" "$@"\n`;

// One model, shared by the seeded caches and the loopback double below so
// the two can never drift.
const E2E_MODEL = {
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
};
const E2E_API_MODELS = {
  "zai-org/glm-5.3": {
    id: "zai-org/glm-5.3",
    name: "GLM 5.3",
    attachment: false,
    reasoning: true,
    temperature: true,
    tool_call: true,
    cost: { input: 1, output: 4, cache_read: 0.3 },
    limit: { context: 200000, output: 32000 },
    modalities: { input: ["text"], output: ["text"] },
  },
};

// Seeded catalog cache: a fresh-hit fallback so `run-agent` never needs the
// network. Keyed to the loopback double's base URL (see tmpEnv).
function writeOfflineCatalog(cfgDir, baseUrl) {
  writeFileSync(
    join(cfgDir, "model-catalog.json"),
    JSON.stringify({ fetchedAt: Date.now(), baseUrl, models: [E2E_MODEL] }),
  );
}

// Seeded api.json cache: `opencode on` fetches /v1/api.json live-first and
// only reads this file when that fetch throws, so this is a failure fallback,
// not the offline source. The loopback double serves the live read.
function writeOfflineApiMap(cfgDir, baseUrl) {
  writeFileSync(
    join(cfgDir, "opencode-api.json"),
    JSON.stringify({ fetchedAt: Date.now(), baseUrl, models: E2E_API_MODELS }),
  );
}

// Loopback gateway double, in its own process: `opencode on` fetches
// /v1/api.json live-first, so a seeded cache alone cannot keep this runner
// offline — and the double cannot live in this process, which blocks in
// execFileSync while the CLI child dials it. Serve both endpoints the CLI
// dials from 127.0.0.1 and point AIAND_BASE_URL at it. Loopback only, no
// live gateway, no outbound fetch. Resolves { child, baseUrl }; kill the
// child when done.
function startApiDouble(sandboxDir) {
  writeFileSync(
    join(sandboxDir, "api-double.mjs"),
    `import { createServer } from "node:http";
const E2E_MODEL = ${JSON.stringify(E2E_MODEL)};
const E2E_API_MODELS = ${JSON.stringify(E2E_API_MODELS)};
const server = createServer((req, res) => {
  if (req.url === "/v1/api.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ opencode: { models: E2E_API_MODELS } }));
  } else if (req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [E2E_MODEL] }));
  } else {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  }
});
server.listen(0, "127.0.0.1", () => {
  console.log("READY " + server.address().port);
});
`,
  );
  const child = spawn(process.execPath, [join(sandboxDir, "api-double.mjs")], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(
      () => reject(new Error("api double did not start")),
      API_DOUBLE_START_TIMEOUT_MS,
    );
    child.stdout.on("data", (chunk) => {
      buf += String(chunk);
      const ready = buf.match(/READY (\d+)/);
      if (ready) {
        clearTimeout(timer);
        child.stdout.removeAllListeners("data");
        resolve({ child, baseUrl: `http://127.0.0.1:${ready[1]}` });
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => reject(new Error(`api double exited before READY (code ${code})`)));
  });
}

// Env vars scrubbed so parent-machine state can never leak into the CLI's
// resolution — the same list scripts/sbx-test.mjs scrubs, plus the
// installer's own knobs (a dev shell exporting AIAND_DIR must not retarget
// the sandboxed uninstall below).
const SCRUB = [
  "XDG_CONFIG_HOME",
  "AIAND_PROFILE",
  "AIAND_BASE_URL",
  "AIAND_AUTH_URL",
  "AIAND_CONFIG_DIR",
  "AIAND_HOME",
  "AIAND_KEY_STORAGE",
  "AIAND_IDE_SECRET_PLAINTEXT",
  "OPENCODE_CONFIG_CONTENT",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "HERMES_HOME",
  "FORCE_COLOR",
  "STUB_EXIT",
  "AIAND_DIR",
  "AIAND_UNINSTALL_FORCE",
  "AIAND_SOURCE",
];

// Isolated sandbox: tmp dirs, a loopback gateway double, seeded caches, a
// stub opencode binary, and CLI helpers. Parent env scrubbed (see SCRUB);
// the only network is loopback to the double — no live gateway.
async function tmpEnv() {
  const S = mkdtempSync(join(tmpdir(), "aiand-e2e-"));
  const { child: apiDouble, baseUrl } = await startApiDouble(S);
  const home = join(S, "home");
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  const cfg = join(S, "cfg");
  mkdirSync(cfg, { recursive: true });
  const bin = join(S, "bin");
  mkdirSync(bin, { recursive: true });
  writeOfflineCatalog(cfg, baseUrl);
  writeOfflineApiMap(cfg, baseUrl);

  // Stub agent binaries: detection + session launch targets.
  for (const name of ["opencode", "claude", "codex", "hermes"]) {
    const stub = join(bin, name);
    writeFileSync(
      stub,
      '#!/bin/sh\nenv > "$AIAND_CAPTURE.env"\nprintf \'%s\\n\' "$@" > "$AIAND_CAPTURE.args"\nexit 42\n',
    );
    chmodSync(stub, 0o755);

    if (process.platform === "win32") {
      // spawn looks up PATHEXT, so a shebang file named after the agent is invisible.
      const stubJs = join(bin, `${name}-stub.cjs`);
      writeFileSync(
        stubJs,
        [
          "const fs = require('fs');",
          "const c = process.env.AIAND_CAPTURE;",
          "fs.writeFileSync(c + '.env', Object.entries(process.env).map(([k, v]) => k + '=' + v).join('\\n'));",
          "fs.writeFileSync(c + '.args', process.argv.slice(2).join('\\n') + '\\n');",
          "process.exit(42);",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(bin, `${name}.cmd`),
        `@echo off\r\n"${process.execPath}" "${stubJs}" %*\r\n`,
      );
    }
  }

  // Seed an original opencode.json with unrelated keys the adapter must keep.
  const configPath = join(home, ".config", "opencode", "opencode.json");
  writeFileSync(configPath, `${JSON.stringify({ theme: "dark" }, null, 2)}\n`);
  const BEFORE = readFileSync(configPath);

  const env = { ...process.env };
  for (const name of SCRUB) delete env[name];
  env.AIAND_HOME = home;
  env.AIAND_CONFIG_DIR = cfg;
  env.AIAND_API_KEY = "sk-e2e-test-key-0000000000000000000000";
  env.AIAND_BASE_URL = baseUrl;
  env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;

  return { S, cfg, bin, home, configPath, BEFORE, env, apiDouble, baseUrl };
}

const { S, cfg, bin, home, configPath, BEFORE, env, apiDouble, baseUrl } = await tmpEnv();

try {
  function cli(args) {
    // All call sites pass space-separated flags with no quoted values.
    return execFileSync(process.execPath, [DIST, ...args.split(" ")], { env, encoding: "utf8" });
  }

  function cliOrNull(args) {
    try {
      return {
        ok: true,
        out: execFileSync(process.execPath, [DIST, ...args.split(" ")], { env, encoding: "utf8" }),
        err: "",
      };
    } catch (error) {
      return { ok: false, out: "", err: String(error.stderr ?? error.message ?? "") };
    }
  }

  const results = [];
  function check(name, ok, detail = "") {
    results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) process.exitCode = 1;
  }

  // --- opencode on/off/status -------------------------------------------------
  const on = JSON.parse(cli("opencode on --json"));
  check("opencode on succeeds", on.state === "on" && on.agent === "opencode", JSON.stringify(on));

  const st = JSON.parse(cli("opencode status --json"));
  check("status: state on", st.state === "on", JSON.stringify(st));
  check("status: model reported", st.model !== null, String(st.model));

  const wired = JSON.parse(readFileSync(configPath, "utf8"));
  check("on keeps unrelated keys", wired.theme === "dark", JSON.stringify(Object.keys(wired)));
  check(
    "on routes provider.aiand at the loopback double",
    wired.provider?.aiand?.options?.baseURL === `${baseUrl}/v1`,
    String(wired.provider?.aiand?.options?.baseURL),
  );
  check(
    "on bakes the session key",
    wired.provider?.aiand?.options?.apiKey === "sk-e2e-test-key-0000000000000000000000",
  );

  cli("opencode off --json");
  const AFTER_OFF = readFileSync(configPath);
  check(
    "off restores opencode.json byte-identical when untouched",
    BEFORE.equals(AFTER_OFF),
    `before=${BEFORE.length}B after=${AFTER_OFF.length}B`,
  );
  check(
    "snapshot kept after off",
    existsSync(join(S, "cfg", "snapshots", "opencode", "latest.json")),
  );

  const st2 = JSON.parse(cli("opencode status --json"));
  check("status: off after teardown", st2.state === "off", JSON.stringify(st2));

  // Surgical edit path: `on` again, and confirm it keeps the first snapshot.
  cli("opencode on --json");
  const wiredAgain = JSON.parse(readFileSync(configPath, "utf8"));
  check("a second on wires the key again", wiredAgain.provider?.aiand?.options?.apiKey?.length > 0);
  cli("opencode off --json");
  check(
    "second off is byte-identical too",
    BEFORE.equals(readFileSync(configPath)),
    "surgical off is repeatable",
  );

  // Subtractive path: user edits the file while on; off must keep the edit.
  cli("opencode on --json");
  const edited = JSON.parse(readFileSync(configPath, "utf8"));
  edited.autoupdate = true;
  writeFileSync(configPath, `${JSON.stringify(edited, null, 2)}\n`);
  cli("opencode off --json");
  const afterEditOff = JSON.parse(readFileSync(configPath, "utf8"));
  check(
    "off after a user edit keeps the edit and drops our keys",
    afterEditOff.autoupdate === true &&
      afterEditOff.provider?.aiand === undefined &&
      afterEditOff["x-aiand"] === undefined,
    JSON.stringify(Object.keys(afterEditOff)),
  );

  // Break-glass restore refuses without --force, restores with it.
  const refused = cliOrNull("restore opencode");
  check("restore without --force fails", refused.ok === false, refused.err.split("\n")[0]);
  cli("opencode on --json");
  cli("restore opencode --force");
  check(
    "restore --force puts the first pre-wiring bytes back",
    BEFORE.equals(readFileSync(configPath)),
    "break-glass snapshot restore",
  );

  // --- claude on/off/status ---------------------------------------------------
  const claudePath = join(home, ".claude", "settings.json");
  mkdirSync(dirname(claudePath), { recursive: true });
  writeFileSync(claudePath, `${JSON.stringify({ theme: "dark", env: { KEEP: "1" } }, null, 2)}\n`);
  const CLAUDE_BEFORE = readFileSync(claudePath);

  const claudeOn = JSON.parse(cli("claude on --json"));
  check("claude on succeeds", claudeOn.state === "on", JSON.stringify(claudeOn));
  const claudeWired = JSON.parse(readFileSync(claudePath, "utf8"));
  check(
    "claude on routes ANTHROPIC_BASE_URL at the loopback double",
    claudeWired.env?.ANTHROPIC_BASE_URL === baseUrl,
    String(claudeWired.env?.ANTHROPIC_BASE_URL),
  );
  check(
    "claude on bakes the session key",
    claudeWired.env?.ANTHROPIC_AUTH_TOKEN === "sk-e2e-test-key-0000000000000000000000",
  );
  check("claude on keeps unrelated keys", claudeWired.env?.KEEP === "1");
  check(
    "claude on lists the catalog in the /model picker",
    claudeWired.modelPicker?.replaceBuiltInOptions === true &&
      (claudeWired.modelPicker?.options?.length ?? 0) > 0,
  );
  const claudeStatus = JSON.parse(cli("claude status --json"));
  check(
    "claude status: on with a model",
    claudeStatus.state === "on" && Boolean(claudeStatus.model),
  );
  cli("claude off --json");
  check(
    "claude off restores settings.json byte-identical when untouched",
    CLAUDE_BEFORE.equals(readFileSync(claudePath)),
  );
  cli("claude on --json");
  cli("restore claude --force");
  check(
    "restore claude --force puts the seed back",
    CLAUDE_BEFORE.equals(readFileSync(claudePath)),
  );

  // A second CLAUDE_CONFIG_DIR gets a snapshot of its own file, and restore
  // finds it from a shell that no longer sets the variable.
  const claudeB = join(S, "claude-b");
  mkdirSync(claudeB, { recursive: true });
  const claudeBPath = join(claudeB, "settings.json");
  writeFileSync(claudeBPath, '{"theme":"light"}\n');
  execFileSync(process.execPath, [DIST, "claude", "on", "--json"], {
    env: { ...env, CLAUDE_CONFIG_DIR: claudeB },
    encoding: "utf8",
  });
  cli("restore claude --force");
  check(
    "restore claude --force from another shell restores the wired CLAUDE_CONFIG_DIR",
    readFileSync(claudeBPath, "utf8") === '{"theme":"light"}\n',
  );

  // --- codex on/off/status ----------------------------------------------------
  // Codex runs `aiand key export` itself, so aiand must be on PATH for the profile to be on.
  const aiandLaunchers =
    process.platform === "win32"
      ? [[join(bin, "aiand.cmd"), `@echo off\r\n"${process.execPath}" "${DIST}" %*\r\n`]]
      : [[join(bin, "aiand"), `#!/bin/sh\nexec "${process.execPath}" "${DIST}" "$@"\n`]];
  for (const [path, body] of aiandLaunchers) writeFileSync(path, body, { mode: 0o755 });
  const codexPath = join(home, ".codex", "aiand.config.toml");
  const codexOn = JSON.parse(cli("codex on --json"));
  check("codex on succeeds", codexOn.state === "on", JSON.stringify(codexOn));
  const codexProfile = readFileSync(codexPath, "utf8");
  check(
    "codex on points the profile at the loopback double",
    codexProfile.includes(`base_url = "${baseUrl}/v1"`),
  );
  check(
    "codex on asks aiand for the key instead of writing it",
    /^command = "(?:aiand|.*\\\\aiand\.cmd)"$/m.test(codexProfile) &&
      !codexProfile.includes("sk-e2e-test-key-0000000000000000000000"),
  );
  const codexStatus = JSON.parse(cli("codex status --json"));
  check("codex status: on with a model", codexStatus.state === "on" && Boolean(codexStatus.model));
  cli("codex off --json");
  check("codex off removes the profile it created", !existsSync(codexPath));
  cli("codex on --json");
  cli("restore codex --force");
  check("restore codex --force removes a profile aiand created", !existsSync(codexPath));

  const handWritten =
    'model_provider = "aiand"\n\n[model_providers.aiand]\nbase_url = "https://api.aiand.com/v1"\n';
  writeFileSync(codexPath, handWritten);
  check("codex on refuses a profile it did not write", !cliOrNull("codex on --json").ok);
  cli("codex on --force --json");
  cli("codex off --json");
  cli("restore codex --force");
  check(
    "restore codex --force brings back the profile --force took over",
    existsSync(codexPath) && readFileSync(codexPath, "utf8") === handWritten,
  );
  for (const [path] of aiandLaunchers) rmSync(path);

  // --- hermes on/off/status ---------------------------------------------------
  // Hermes routes through ~/.hermes under the sandbox HOME (HERMES_HOME is
  // scrubbed above), so this section touches only hermes-owned files and no
  // other agent's fixtures.
  const hermesDir = join(home, ".hermes");
  const hermesConfig = join(hermesDir, "config.yaml");
  const hermesEnvFile = join(hermesDir, ".env");
  mkdirSync(hermesDir, { recursive: true });
  writeFileSync(hermesConfig, "theme: dark\n");
  const HERMES_BEFORE = readFileSync(hermesConfig);

  const hermesOn = JSON.parse(cli("hermes on --json"));
  check("hermes on succeeds", hermesOn.state === "on", JSON.stringify(hermesOn));
  const hermesWired = readFileSync(hermesConfig, "utf8");
  check("hermes on keeps unrelated keys", hermesWired.includes("theme: dark"));
  check(
    "hermes on stamps providers.aiand at the loopback double",
    hermesWired.includes('managed_by: "aiand"') &&
      hermesWired.includes(`base_url: "${baseUrl}/v1"`) &&
      hermesWired.includes('provider: "aiand"'),
    hermesWired.split("\n").slice(0, 12).join(" | "),
  );
  check(
    "hermes on bakes the session key into .env",
    readFileSync(hermesEnvFile, "utf8").includes(
      "AIAND_HERMES_API_KEY=sk-e2e-test-key-0000000000000000000000",
    ),
  );
  const hermesStatus = JSON.parse(cli("hermes status --json"));
  check(
    "hermes status: on with a model",
    hermesStatus.state === "on" && Boolean(hermesStatus.model),
    JSON.stringify(hermesStatus),
  );
  cli("hermes off --json");
  check(
    "hermes off restores config.yaml byte-identical when untouched",
    HERMES_BEFORE.equals(readFileSync(hermesConfig)),
  );
  check("hermes off removes a .env it created", !existsSync(hermesEnvFile));
  check(
    "hermes snapshot kept after off",
    existsSync(join(S, "cfg", "snapshots", "hermes", "latest.json")),
  );
  const hermesOffStatus = JSON.parse(cli("hermes status --json"));
  check("hermes status: off after teardown", hermesOffStatus.state === "off");

  // Idempotent re-on: a second `on` re-bakes the same routing,
  // and the second `off` is byte-identical too.
  cli("hermes on --json");
  check(
    "hermes re-on re-bakes the session key into .env",
    readFileSync(hermesEnvFile, "utf8").includes(
      "AIAND_HERMES_API_KEY=sk-e2e-test-key-0000000000000000000000",
    ),
  );
  check(
    "hermes re-on keeps providers.aiand stamped",
    readFileSync(hermesConfig, "utf8").includes('managed_by: "aiand"'),
  );
  cli("hermes off --json");
  check(
    "hermes second off is byte-identical too",
    HERMES_BEFORE.equals(readFileSync(hermesConfig)),
    "surgical off is repeatable",
  );

  // Subtractive path: the user edits a value `on` wrote; off
  // must keep the edit.
  cli("hermes on --json");
  const hermesEdited = readFileSync(hermesConfig, "utf8").replace(
    /^ {2}default: ".*"$/m,
    '  default: "user-own-model"',
  );
  writeFileSync(hermesConfig, hermesEdited);
  cli("hermes off --json");
  const hermesAfterEdit = readFileSync(hermesConfig, "utf8");
  check(
    "off after a user edit keeps the edited model default",
    hermesAfterEdit.includes('default: "user-own-model"') &&
      !hermesAfterEdit.includes("managed_by") &&
      !hermesAfterEdit.includes("providers:"),
    hermesAfterEdit.split("\n").slice(0, 8).join(" | "),
  );
  check("hermes off still removes a .env it created", !existsSync(hermesEnvFile));

  // Foreign-block refusal: an unstamped `aiand` block is never
  // overwritten — `on` refuses it (with or without --force) and
  // the file survives byte-identical; break-glass restore brings
  // the first pre-wiring bytes back.
  const hermesForeign = [
    "theme: dark",
    "providers:",
    "  aiand:",
    '    name: "aiand"',
    '    base_url: "https://example.invalid/v1"',
    '    api_key: "sk-user-foreign"',
  ].join("\n");
  writeFileSync(hermesConfig, hermesForeign);
  const hermesRefused = cliOrNull("hermes on --json");
  check(
    "hermes on refuses a foreign providers.aiand block",
    hermesRefused.ok === false && hermesRefused.err.includes("does not manage"),
    hermesRefused.err.split("\n")[0],
  );
  check(
    "the refusal leaves the foreign block byte-identical",
    readFileSync(hermesConfig, "utf8") === hermesForeign,
  );
  check(
    "hermes on --force also refuses a foreign block",
    cliOrNull("hermes on --force --json").ok === false,
  );
  cli("restore hermes --force");
  check(
    "restore hermes --force brings back the first pre-wiring bytes",
    readFileSync(hermesConfig, "utf8") === "theme: dark\n",
  );

  // --- run-agent hermes (offline: stub binary, cached catalog) ----------------
  const hermesCapture = join(S, "capture-hermes");
  const hermesConfigBefore = existsSync(hermesConfig) ? readFileSync(hermesConfig) : null;
  let hermesCode = 42;
  try {
    execFileSync(process.execPath, [DIST, "run-agent", "hermes", "--", "--version"], {
      env: { ...env, AIAND_CAPTURE: hermesCapture },
      encoding: "utf8",
    });
    hermesCode = 0;
  } catch (error) {
    hermesCode = error.status ?? 42;
  }
  check("run-agent hermes exits with the child code", hermesCode === 42, `code=${hermesCode}`);
  const hermesChildEnv = existsSync(`${hermesCapture}.env`)
    ? readFileSync(`${hermesCapture}.env`, "utf8")
    : "";
  const hermesOverlayLine = hermesChildEnv
    .split("\n")
    .find((line) => line.startsWith("HERMES_HOME="));
  const hermesOverlay = hermesOverlayLine?.slice("HERMES_HOME=".length);
  check(
    "run-agent hermes points HERMES_HOME at a throwaway overlay",
    Boolean(hermesOverlay) && hermesOverlay.includes("aiand-hermes-"),
    hermesOverlay ?? "missing",
  );
  const hermesArgs = existsSync(`${hermesCapture}.args`)
    ? readFileSync(`${hermesCapture}.args`, "utf8").split(/\r?\n/).filter(Boolean)
    : [];
  check(
    "run-agent hermes passes --provider aiand, then the passthrough",
    hermesArgs[0] === "--provider" &&
      hermesArgs[1] === "aiand" &&
      hermesArgs.at(-1) === "--version",
    hermesArgs.slice(0, 4).join(" "),
  );
  check(
    "run-agent hermes removes the throwaway overlay",
    Boolean(hermesOverlay) && !existsSync(hermesOverlay),
    hermesOverlay ?? "missing",
  );
  const hermesConfigAfter = existsSync(hermesConfig) ? readFileSync(hermesConfig) : null;
  check(
    "run-agent hermes leaves the real home as it was",
    (hermesConfigBefore === null && hermesConfigAfter === null) ||
      (hermesConfigBefore !== null &&
        hermesConfigAfter !== null &&
        hermesConfigBefore.equals(hermesConfigAfter)),
  );
  check(
    "run-agent hermes keeps the key out of the child env",
    !hermesChildEnv.includes("sk-e2e-test-key-0000000000000000000000"),
  );

  // --- credential storage -----------------------------------------------------
  const keyOut = cli("key export").trim();
  check(
    "key export prints the env session key",
    keyOut === "sk-e2e-test-key-0000000000000000000000",
    keyOut.slice(0, 12),
  );

  // --- run-agent launcher path (offline: stub binary, cached catalog) ---------
  const capture = join(S, "capture");
  const launchEnv = { ...env, AIAND_CAPTURE: capture };
  let launchCode = 42;
  try {
    execFileSync(process.execPath, [DIST, "run-agent", "opencode", "--", "--version"], {
      env: launchEnv,
      encoding: "utf8",
    });
    launchCode = 0;
  } catch (error) {
    launchCode = error.status ?? 42;
  }
  check("run-agent opencode exits with the child code", launchCode === 42, `code=${launchCode}`);
  const childEnv = existsSync(`${capture}.env`) ? readFileSync(`${capture}.env`, "utf8") : "";
  const configLine = childEnv
    .split("\n")
    .find((line) => line.startsWith("OPENCODE_CONFIG_CONTENT="));
  check(
    "run-agent injects OPENCODE_CONFIG_CONTENT",
    Boolean(configLine),
    configLine?.slice(0, 60) ?? "missing",
  );
  if (configLine) {
    const launched = JSON.parse(configLine.slice("OPENCODE_CONFIG_CONTENT=".length));
    check("launched config carries provider.aiand", Boolean(launched.provider?.aiand));
    check(
      "launched config references the key via {file:} substitution, not the env",
      /^\{file:.+\}$/.test(launched.provider?.aiand?.options?.apiKey ?? ""),
    );
  }

  const claudeCapture = join(S, "capture-claude");
  let claudeCode = 42;
  try {
    execFileSync(process.execPath, [DIST, "run-agent", "claude", "--", "--version"], {
      env: { ...env, AIAND_CAPTURE: claudeCapture },
      encoding: "utf8",
    });
    claudeCode = 0;
  } catch (error) {
    claudeCode = error.status ?? 42;
  }
  check("run-agent claude exits with the child code", claudeCode === 42, `code=${claudeCode}`);
  const claudeArgs = existsSync(`${claudeCapture}.args`)
    ? readFileSync(`${claudeCapture}.args`, "utf8").split(/\r?\n/)
    : [];
  check(
    "run-agent claude passes a --settings file, then the passthrough",
    claudeArgs[0] === "--settings" && claudeArgs[2] === "--version",
    claudeArgs.slice(0, 3).join(" "),
  );
  check(
    "run-agent claude removes the throwaway settings file",
    Boolean(claudeArgs[1]) && !existsSync(claudeArgs[1]),
  );
  const claudeChildEnv = existsSync(`${claudeCapture}.env`)
    ? readFileSync(`${claudeCapture}.env`, "utf8")
    : "";
  check(
    "run-agent claude keeps the key out of the child env",
    !claudeChildEnv.includes("sk-e2e-test-key-0000000000000000000000"),
  );

  const codexCapture = join(S, "capture-codex");
  const codexBefore = existsSync(codexPath) ? readFileSync(codexPath, "utf8") : null;
  let codexCode = 42;
  try {
    execFileSync(process.execPath, [DIST, "run-agent", "codex", "--", "--version"], {
      env: { ...env, AIAND_CAPTURE: codexCapture },
      encoding: "utf8",
    });
    codexCode = 0;
  } catch (error) {
    codexCode = error.status ?? 42;
  }
  check("run-agent codex exits with the child code", codexCode === 42, `code=${codexCode}`);
  const codexArgs = existsSync(`${codexCapture}.args`)
    ? readFileSync(`${codexCapture}.args`, "utf8").split(/\r?\n/).filter(Boolean)
    : [];
  check(
    "run-agent codex passes -c overrides, then the passthrough",
    codexArgs[0] === "-c" && codexArgs.at(-1) === "--version",
    codexArgs.slice(0, 2).join(" "),
  );
  check(
    "run-agent codex leaves the profile as it was and keeps the key out of argv",
    (existsSync(codexPath) ? readFileSync(codexPath, "utf8") : null) === codexBefore &&
      !codexArgs.join(" ").includes("sk-e2e-test-key"),
  );

  // Passthrough must reach the agent verbatim. On Windows the stub is a .cmd
  // shim run through cmd.exe, so shell metacharacters must stay literal.
  const tricky = [
    "--version",
    "a&b",
    "100%",
    "%PATH%",
    "x^y",
    'q"t',
    "sp ace",
    "(p)|<r>",
    "trail\\",
  ];
  const trickyCapture = join(S, "capture-tricky");
  try {
    execFileSync(process.execPath, [DIST, "run-agent", "opencode", "--", ...tricky], {
      env: { ...env, AIAND_CAPTURE: trickyCapture },
      encoding: "utf8",
    });
  } catch {
    // the stub exits 42
  }
  const trickyArgs = existsSync(`${trickyCapture}.args`)
    ? readFileSync(`${trickyCapture}.args`, "utf8")
        .replace(/\r?\n$/, "")
        .split(/\r?\n/)
    : null;
  check(
    "run-agent passes shell metacharacters through verbatim",
    JSON.stringify(trickyArgs?.slice(-tricky.length)) === JSON.stringify(tricky),
    JSON.stringify(trickyArgs),
  );

  // --- registry: exactly the shipped agents --------------------------------------
  const { AGENTS } = await import(pathToFileURL(join(ROOT, "dist", "agents", "registry.js")).href);
  const agentIds = AGENTS.map((row) => row.id).sort();
  check(
    "registry ships exactly claude, codex, hermes and opencode",
    JSON.stringify(agentIds) === JSON.stringify(["claude", "codex", "hermes", "opencode"]),
    JSON.stringify(agentIds),
  );

  // --- uninstall (offline: fake launcher + fake checkout) ---------------------
  if (process.platform !== "win32") {
    // Wire one agent, then run the real `install.sh uninstall` against the
    // sandbox HOME. The fake launcher delegates to this dist so `init --off`
    // exercises the real restore path; the fake checkout stands in for
    // ~/.aiand/cli. Asserts: agents restored byte-identical, launcher gone,
    // checkout gone, config dir still present.
    // Baseline for this section: whatever the config holds now (the subtractive
    // test above legitimately leaves a user edit in the file, so the invariant
    // is "back to this state", not the original seed).
    const UNINSTALL_BEFORE = readFileSync(configPath);
    cli("opencode on --json");
    const fakeCheckout = join(home, ".aiand", "cli");
    mkdirSync(fakeCheckout, { recursive: true });
    writeFileSync(
      join(fakeCheckout, "package.json"),
      JSON.stringify({ name: "@aiand/cli" }, null, 2),
    );
    const launcherDir = join(home, ".local", "bin");
    mkdirSync(launcherDir, { recursive: true });
    const fakeLauncher = join(launcherDir, "aiand");
    writeFileSync(fakeLauncher, FAKE_LAUNCHER);
    chmodSync(fakeLauncher, 0o755);
    const aiandConfigDir = join(home, ".config", "aiand");
    mkdirSync(aiandConfigDir, { recursive: true });
    writeFileSync(join(aiandConfigDir, "sentinel"), "keep");
    let uninstallOk = true;
    let uninstallDetail = "";
    try {
      uninstallDetail =
        execFileSync("bash", [join(ROOT, "install.sh"), "uninstall"], {
          // Scrub the installer's own knobs: an AIAND_DIR exported in the dev
          // shell would become the rm -rf target inside the sandboxed uninstall.
          env: {
            ...env,
            HOME: home,
            AIAND_DIR: undefined,
            AIAND_UNINSTALL_FORCE: undefined,
            AIAND_SOURCE: undefined,
          },
          encoding: "utf8",
        })
          .trim()
          .split("\n")
          .pop() ?? "";
    } catch (error) {
      uninstallOk = false;
      uninstallDetail = String(error.message ?? error).split("\n")[0];
    }
    check("uninstall exits zero", uninstallOk, uninstallDetail);
    check(
      "uninstall restores opencode.json byte-identical",
      UNINSTALL_BEFORE.equals(readFileSync(configPath)),
      `before=${UNINSTALL_BEFORE.length}B after=${readFileSync(configPath).length}B`,
    );
    check("uninstall removes the launcher", !existsSync(fakeLauncher), fakeLauncher);
    check("uninstall removes the checkout", !existsSync(fakeCheckout), fakeCheckout);
    check(
      "uninstall keeps profiles/credentials/snapshots",
      existsSync(join(aiandConfigDir, "sentinel")) && existsSync(cfg),
      aiandConfigDir,
    );

    const decoy = join(home, "Documents");
    mkdirSync(decoy, { recursive: true });
    writeFileSync(join(decoy, "keep.txt"), "keep");
    writeFileSync(fakeLauncher, FAKE_LAUNCHER);
    chmodSync(fakeLauncher, 0o755);
    let decoyRefused = false;
    let decoyDetail = "";
    try {
      execFileSync("bash", [join(ROOT, "install.sh"), "uninstall", "--force"], {
        env: {
          ...env,
          HOME: home,
          AIAND_DIR: decoy,
          AIAND_UNINSTALL_FORCE: undefined,
          AIAND_SOURCE: undefined,
        },
        encoding: "utf8",
      });
    } catch (error) {
      decoyDetail = String(error.stderr ?? error.message ?? error);
      decoyRefused = decoyDetail.includes("not an aiand checkout");
    }
    check("uninstall refuses a non-checkout AIAND_DIR", decoyRefused, decoyDetail.split("\n")[0]);
    check("uninstall left the non-checkout directory", existsSync(join(decoy, "keep.txt")), decoy);
    check(
      "uninstall left the launcher after refused decoy",
      existsSync(fakeLauncher),
      fakeLauncher,
    );

    const nestedDecoy = join(home, "NestedDecoy");
    mkdirSync(nestedDecoy, { recursive: true });
    writeFileSync(join(nestedDecoy, "keep.txt"), "keep");
    writeFileSync(
      join(nestedDecoy, "package.json"),
      JSON.stringify({ name: "other", metadata: { name: "@aiand/cli" } }, null, 2),
    );
    let nestedRefused = false;
    let nestedDetail = "";
    try {
      execFileSync("bash", [join(ROOT, "install.sh"), "uninstall", "--force"], {
        env: {
          ...env,
          HOME: home,
          AIAND_DIR: nestedDecoy,
          AIAND_UNINSTALL_FORCE: undefined,
          AIAND_SOURCE: undefined,
        },
        encoding: "utf8",
      });
    } catch (error) {
      nestedDetail = String(error.stderr ?? error.message ?? error);
      nestedRefused = nestedDetail.includes("not an aiand checkout");
    }
    check(
      "uninstall refuses nested-name decoy package.json",
      nestedRefused,
      nestedDetail.split("\n")[0],
    );
    check(
      "uninstall left the nested-name decoy directory",
      existsSync(join(nestedDecoy, "keep.txt")),
      nestedDecoy,
    );
    check(
      "uninstall left the launcher after nested-name decoy",
      existsSync(fakeLauncher),
      fakeLauncher,
    );

    // Hand-cloned checkout: a valid @aiand/cli package.json at a custom AIAND_DIR
    // but no installer ownership marker — package-name identity alone must never
    // authorize rm -rf on a directory the installer did not clone.
    const handCloned = join(home, "src", "aiand-cli");
    mkdirSync(handCloned, { recursive: true });
    writeFileSync(join(handCloned, "keep.txt"), "keep");
    writeFileSync(
      join(handCloned, "package.json"),
      JSON.stringify({ name: "@aiand/cli" }, null, 2),
    );
    writeFileSync(fakeLauncher, FAKE_LAUNCHER);
    chmodSync(fakeLauncher, 0o755);
    let handClonedRefused = false;
    let handClonedDetail = "";
    try {
      execFileSync("bash", [join(ROOT, "install.sh"), "uninstall", "--force"], {
        env: {
          ...env,
          HOME: home,
          AIAND_DIR: handCloned,
          AIAND_UNINSTALL_FORCE: undefined,
          AIAND_SOURCE: undefined,
        },
        encoding: "utf8",
      });
    } catch (error) {
      handClonedDetail = String(error.stderr ?? error.message ?? error);
      handClonedRefused = handClonedDetail.includes("not an installer-owned checkout");
    }
    check(
      "uninstall refuses a hand-cloned @aiand/cli checkout without the ownership marker",
      handClonedRefused,
      handClonedDetail.split("\n")[0],
    );
    check(
      "uninstall left the hand-cloned directory",
      existsSync(join(handCloned, "keep.txt")),
      handCloned,
    );
    check(
      "uninstall left the launcher after refused hand-clone",
      existsSync(fakeLauncher),
      fakeLauncher,
    );

    // Identity must not require `node` on PATH: the launcher bakes an absolute
    // Node path, so uninstall --force of a valid owned checkout still works
    // after nvm/fnm has dropped node from PATH.
    const noNodeCheckout = join(home, ".aiand", "cli");
    mkdirSync(noNodeCheckout, { recursive: true });
    writeFileSync(
      join(noNodeCheckout, "package.json"),
      JSON.stringify({ name: "@aiand/cli" }, null, 2),
    );
    writeFileSync(join(noNodeCheckout, OWNERSHIP_MARKER), "aiand-cli installer ownership marker\n");
    const slimBin = join(S, "no-node-bin");
    mkdirSync(slimBin, { recursive: true });
    const linkTool = (name) => {
      try {
        const src = execFileSync("/bin/bash", ["-lc", `command -v ${name}`], {
          encoding: "utf8",
        }).trim();
        if (src && existsSync(src) && name !== "node") {
          try {
            symlinkSync(src, join(slimBin, name));
          } catch {
            /* already linked */
          }
        }
      } catch {
        /* tool absent on this host */
      }
    };
    for (const name of ["bash", "rm", "rmdir", "dirname", "basename", "pwd"]) linkTool(name);
    let noNodeOk = true;
    let noNodeDetail = "";
    try {
      noNodeDetail =
        execFileSync("bash", [join(ROOT, "install.sh"), "uninstall", "--force"], {
          env: {
            ...env,
            HOME: home,
            PATH: slimBin,
            AIAND_DIR: undefined,
            AIAND_UNINSTALL_FORCE: undefined,
            AIAND_SOURCE: undefined,
          },
          encoding: "utf8",
        })
          .trim()
          .split("\n")
          .pop() ?? "";
    } catch (error) {
      noNodeOk = false;
      noNodeDetail = String(error.stderr ?? error.message ?? error);
    }
    check(
      "uninstall --force works when node is not on PATH",
      noNodeOk,
      noNodeDetail.split("\n")[0],
    );
    check(
      "uninstall without node removed the checkout",
      !existsSync(noNodeCheckout),
      noNodeCheckout,
    );

    // Local-checkout installs never create ~/.aiand/cli (the launcher points at
    // the repo), so uninstall must still remove the launcher when the checkout
    // is missing instead of refusing with an outside-HOME error.
    writeFileSync(fakeLauncher, FAKE_LAUNCHER);
    chmodSync(fakeLauncher, 0o755);
    let missingCheckoutOk = true;
    let missingCheckoutDetail = "";
    try {
      missingCheckoutDetail =
        execFileSync("bash", [join(ROOT, "install.sh"), "uninstall", "--force"], {
          env: {
            ...env,
            HOME: home,
            AIAND_DIR: undefined,
            AIAND_UNINSTALL_FORCE: undefined,
            AIAND_SOURCE: undefined,
          },
          encoding: "utf8",
        })
          .trim()
          .split("\n")
          .pop() ?? "";
    } catch (error) {
      missingCheckoutOk = false;
      missingCheckoutDetail = String(error.stderr ?? error.message ?? error).split("\n")[0];
    }
    check(
      "uninstall removes the launcher when the checkout is missing",
      missingCheckoutOk && !existsSync(fakeLauncher),
      missingCheckoutDetail,
    );
  } // posix install.sh uninstall coverage (win32: install.ps1 block below)

  // --- install.ps1 uninstall (Windows only; skipped on Linux CI) ---------------
  // Fake owned checkout plus aiand.cmd. Off-failure must abort without deleting;
  // a non-checkout AIAND_DIR and a hand-cloned checkout without the ownership
  // marker must refuse; --force then removes the .cmd launcher and the checkout.
  if (process.platform === "win32") {
    // install.ps1 refuses a foreign Launcher before clone/build/swap (mirrors
    // install.sh refuse_foreign_launcher at main() start). Isolated HOME under
    // S so the uninstall fixtures below keep their own state; the installer
    // copy forces the clone path (SCRIPT_DIR outside the checkout).
    {
      const isoHome = join(S, "ps1-foreign-home");
      const isoBin = join(isoHome, ".local", "bin");
      const isoCheckout = join(isoHome, ".aiand", "cli");
      mkdirSync(isoBin, { recursive: true });
      mkdirSync(isoCheckout, { recursive: true });
      const foreignCmd = join(isoBin, "aiand.cmd");
      const foreignBody = "@echo off\r\necho mine\r\n";
      writeFileSync(foreignCmd, foreignBody);
      const sentinel = join(isoCheckout, "sentinel-keep.txt");
      writeFileSync(sentinel, "keep\n");
      const foreignScriptDir = join(S, "ps1-foreign-scriptdir");
      mkdirSync(foreignScriptDir, { recursive: true });
      const foreignPs1 = join(foreignScriptDir, "install.ps1");
      copyFileSync(join(ROOT, "install.ps1"), foreignPs1);
      let installOk = true;
      let installErr = "";
      try {
        execFileSync(
          "powershell.exe",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", foreignPs1],
          {
            env: {
              ...env,
              HOME: isoHome,
              USERPROFILE: isoHome,
              AIAND_DIR: undefined,
              AIAND_UNINSTALL_FORCE: undefined,
              AIAND_SOURCE: ROOT,
            },
            encoding: "utf8",
          },
        );
      } catch (error) {
        installOk = false;
        installErr = String(error.stderr ?? error.message ?? error);
      }
      check("install.ps1 refuses a foreign aiand.cmd", installOk === false, `ok=${installOk}`);
      check(
        "install.ps1 foreign refusal names the launcher",
        installErr.includes("was not written by the aiand installer"),
        installErr.split("\n").find((l) => l.includes("Error")) ?? installErr.split("\n")[0] ?? "",
      );
      check(
        "install.ps1 foreign refusal leaves aiand.cmd byte-identical",
        existsSync(foreignCmd) && readFileSync(foreignCmd, "utf8") === foreignBody,
        foreignCmd,
      );
      check(
        "install.ps1 foreign refusal leaves the checkout untouched",
        existsSync(sentinel) && readFileSync(sentinel, "utf8") === "keep\n",
        sentinel,
      );
    }
    const launcherDir = join(home, ".local", "bin");
    mkdirSync(launcherDir, { recursive: true });
    const winCheckout = join(home, ".aiand", "cli");
    mkdirSync(winCheckout, { recursive: true });
    writeFileSync(
      join(winCheckout, "package.json"),
      JSON.stringify({ name: "@aiand/cli" }, null, 2),
    );
    writeFileSync(join(winCheckout, OWNERSHIP_MARKER), "aiand-cli installer ownership marker\n");
    const winCmd = join(launcherDir, "aiand.cmd");
    // The header marks it installer-written; exit 7 makes `init --off` fail.
    writeFileSync(winCmd, `@echo off\r\nREM ${LAUNCHER_HEADER} (test stub)\r\nexit /b 7\r\n`);
    const aiandConfigDir = join(home, ".config", "aiand");
    mkdirSync(aiandConfigDir, { recursive: true });
    writeFileSync(join(aiandConfigDir, "sentinel"), "keep");
    const winEnv = {
      ...env,
      HOME: home,
      USERPROFILE: home,
      AIAND_DIR: undefined,
      AIAND_UNINSTALL_FORCE: undefined,
      AIAND_SOURCE: undefined,
    };
    const runPs1 = (args, extraEnv = {}) => {
      try {
        const out = execFileSync(
          "powershell.exe",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "install.ps1"), ...args],
          { env: { ...winEnv, ...extraEnv }, encoding: "utf8" },
        );
        return { ok: true, out, err: "" };
      } catch (error) {
        return { ok: false, out: "", err: String(error.stderr ?? error.message ?? error) };
      }
    };

    const abort = runPs1(["uninstall"]);
    check(
      "install.ps1 uninstall aborts when off fails",
      abort.ok === false &&
        abort.err.includes("agent teardown failed") &&
        existsSync(winCheckout) &&
        existsSync(winCmd),
      abort.err.split("\n")[0],
    );

    const decoy = join(home, "Documents");
    mkdirSync(decoy, { recursive: true });
    writeFileSync(join(decoy, "keep.txt"), "keep");
    const decoyRun = runPs1(["uninstall", "--force"], { AIAND_DIR: decoy });
    check(
      "install.ps1 uninstall refuses a non-checkout AIAND_DIR",
      decoyRun.ok === false && decoyRun.err.includes("not an aiand checkout"),
      decoyRun.err.split("\n")[0],
    );
    check(
      "install.ps1 uninstall left the non-checkout directory",
      existsSync(join(decoy, "keep.txt")),
      decoy,
    );
    check(
      "install.ps1 uninstall left the launcher after refused decoy",
      existsSync(winCmd),
      winCmd,
    );

    const handCloned = join(home, "src", "aiand-cli");
    mkdirSync(handCloned, { recursive: true });
    writeFileSync(join(handCloned, "keep.txt"), "keep");
    writeFileSync(
      join(handCloned, "package.json"),
      JSON.stringify({ name: "@aiand/cli" }, null, 2),
    );
    const handRun = runPs1(["uninstall", "--force"], { AIAND_DIR: handCloned });
    check(
      "install.ps1 uninstall refuses a hand-cloned checkout without the ownership marker",
      handRun.ok === false && handRun.err.includes("not an installer-owned checkout"),
      handRun.err.split("\n")[0],
    );
    check(
      "install.ps1 uninstall left the hand-cloned directory",
      existsSync(join(handCloned, "keep.txt")),
      handCloned,
    );

    const outside = join(S, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "keep.txt"), "keep");
    const outsideRun = runPs1(["uninstall", "--force"], { AIAND_DIR: outside });
    check(
      "install.ps1 uninstall refuses a checkout outside HOME",
      outsideRun.ok === false && outsideRun.err.includes("outside"),
      outsideRun.err.split("\n")[0],
    );
    check(
      "install.ps1 uninstall left the outside-HOME directory",
      existsSync(join(outside, "keep.txt")),
      outside,
    );
    check(
      "install.ps1 uninstall left the owned checkout after refuses",
      existsSync(winCheckout),
      winCheckout,
    );

    const forced = runPs1(["uninstall", "--force"]);
    check(
      "install.ps1 uninstall --force exits zero",
      forced.ok,
      (forced.err || forced.out).trim().split("\n").pop() ?? "",
    );
    check("install.ps1 uninstall removes aiand.cmd", !existsSync(winCmd), winCmd);
    check("install.ps1 uninstall removes the checkout", !existsSync(winCheckout), winCheckout);
    check(
      "install.ps1 uninstall keeps profiles/credentials/snapshots",
      existsSync(join(aiandConfigDir, "sentinel")),
      aiandConfigDir,
    );
  }

  console.log(results.join("\n"));
  console.log(
    results.every((r) => r.startsWith("PASS")) ? "E2E: ALL PASS" : "E2E: FAILURES PRESENT",
  );
} finally {
  apiDouble.kill();
  rmSync(S, { recursive: true, force: true });
}
