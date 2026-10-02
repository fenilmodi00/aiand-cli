// Real-binary smoke for the CodeAF adapter: the two behaviors unit
// and e2e stubs cannot show. Downloads the pinned CodeAF release
// (set CODEAF_BIN to a local build to skip the download; CI never
// may), checks it against the repo-pinned sha256 map first and the
// release's own checksums.txt second, and drives it through a
// loopback OpenAI-compatible double:
//   1. `aiand run-agent codeaf -- chat --once` — the throwaway
//      CODEAF_HOME overlay plus the repointed default service
//      launch the real binary, which prints the double's reply.
//   2. `aiand codeaf on` — the hand-written model_sources row in the
//      sandbox config drives the real `codeaf chat --once` binary to
//      the double with no CODEAF_BASE_URL (only the row can route
//      it), and `aiand codeaf off` removes the row again.
// The real ~/.codeaf is never touched: AIAND_HOME sandboxes the
// agent home, and every direct binary run carries CODEAF_HOME.
// Modeled on scripts/e2e.mjs; the double runs in its own process
// (like test/mock-gateway.mjs) because this runner blocks in
// execFileSync while the CLI child dials it.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, "dist", "index.js");
const DOUBLE_START_TIMEOUT_MS = 15_000;
// Cap per child call: a real binary that waits on a prompt or a
// dead endpoint must fail the smoke, not hang the job.
const CHILD_TIMEOUT_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
// The release the adapter's install hint pins; check-dist.mjs keeps
// ci.yml's CODEAF_VERSION in step with it. CODEAF_SHA256 is the
// repo-pinned digest map — the trusted anchor; checksums.txt is only
// a secondary match against the release's own list.
const { CODEAF_VERSION, CODEAF_SHA256 } = await import(
  pathToFileURL(join(ROOT, "dist", "agents", "codeaf", "adapter.js")).href
);

// What every chat-completions response carries; both checks assert
// the real binary printed it back.
const REPLY = "ready-from-the-smoke-double";
// The one model the double lists: the curated catalog default, so
// `on` and the launcher resolve it deterministically, unprompted.
const SMOKE_MODEL = {
  id: "zai-org/glm-5.3",
  name: "zai-org/glm-5.3",
  object: "model",
  created: 1,
  owned_by: "zai-org",
  provider: "zai-org",
  context_window: 200000,
  capabilities: ["text", "tool_calling"],
  reasoning_efforts: null,
  reasoning_effort_default: null,
  description: null,
  currency: "usd",
  input_per_1m: "0.60",
  output_per_1m: "2.40",
  cached_input_per_1m: null,
};

const OS_NAME = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform];
const ARCH_NAME = { x64: "amd64", arm64: "arm64" }[process.arch];
if (!OS_NAME || !ARCH_NAME) {
  console.error(`codeaf-smoke: no release asset for ${process.platform}/${process.arch}`);
  process.exit(1);
}
// Release assets are Go-style: codeaf-linux-amd64,
// codeaf-windows-arm64.exe, ...
const ASSET = `codeaf-${OS_NAME}-${ARCH_NAME}${process.platform === "win32" ? ".exe" : ""}`;

// Loopback OpenAI-compatible double, in its own process: serves
// /v1/models and /v1/chat/completions — plain JSON when the request
// body has no "stream":true, SSE chunks ending `data: [DONE]` when
// it does. Resolves { child, baseUrl }; kill the child when done.
function startApiDouble(sandboxDir) {
  writeFileSync(
    join(sandboxDir, "codeaf-double.mjs"),
    `import { createServer } from "node:http";
const REPLY = ${JSON.stringify(REPLY)};
const MODEL = ${JSON.stringify(SMOKE_MODEL)};
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [MODEL] }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    readBody(req).then((raw) => {
      if (res.writableEnded) return;
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        body = {};
      }
      if (body.stream) {
        // SSE: one content chunk, a finish chunk, then the sentinel.
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta, finishReason = null) =>
          "data: " +
          JSON.stringify({
            id: "chatcmpl-smoke",
            object: "chat.completion.chunk",
            model: body.model ?? "",
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          }) +
          "\\n\\n";
        res.write(chunk({ role: "assistant", content: REPLY }));
        res.write(chunk({}, "stop"));
        res.end("data: [DONE]\\n\\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-smoke",
          object: "chat.completion",
          model: body.model ?? "",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: REPLY },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found", path: url.pathname }));
});
server.listen(0, "127.0.0.1", () => {
  console.log("READY " + server.address().port);
});
`,
  );
  const child = spawn(process.execPath, [join(sandboxDir, "codeaf-double.mjs")], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(
      () => reject(new Error("api double did not start")),
      DOUBLE_START_TIMEOUT_MS,
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

async function fetchReleaseAsset(url) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`download failed (${response.status} ${response.statusText}): ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** The pinned release binary in `binDir`, or a copy of
 * CODEAF_BIN when set (a local build). The release path checks the
 * repo-pinned sha256 first and the release's own checksums.txt
 * second; either way the binary ends up 0755 in `binDir`, which the
 * sandbox puts on PATH — the launcher spawns the bare name
 * "codeaf". */
async function resolveCodeafBin(binDir) {
  const binPath = join(binDir, process.platform === "win32" ? "codeaf.exe" : "codeaf");
  if (process.env.CODEAF_BIN) {
    // A local override skips every verification; in CI that would
    // silently drop the supply-chain leg the job exists for.
    if (process.env.GITHUB_ACTIONS) {
      throw new Error("CODEAF_BIN must not override the pinned release in CI");
    }
    copyFileSync(process.env.CODEAF_BIN, binPath);
    chmodSync(binPath, 0o755);
    return binPath;
  }
  const base = `https://github.com/Agent-Field/codeaf/releases/download/${CODEAF_VERSION}`;
  const checksums = (await fetchReleaseAsset(`${base}/checksums.txt`)).toString("utf8");
  const bytes = await fetchReleaseAsset(`${base}/${ASSET}`);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const pinned = CODEAF_SHA256[ASSET];
  if (!pinned) {
    throw new Error(`no repo-pinned sha256 for ${ASSET} (bump CODEAF_SHA256 with CODEAF_VERSION)`);
  }
  if (digest !== pinned) {
    throw new Error(
      `sha256 mismatch for ${ASSET}: the download hashes to ${digest}, the repo pins ${pinned}`,
    );
  }
  // Secondary: the release's own list must agree with the pinned
  // digest (sha256sum format "<hex>  <file>"; tolerate the reverse).
  const listed = checksums
    .split(/\r?\n/)
    .filter((line) => line.includes(ASSET))
    .map((line) => line.match(/[0-9a-f]{64}/i)?.[0]?.toLowerCase() ?? "")
    .filter(Boolean);
  if (listed.length !== 1 || listed[0] !== pinned) {
    throw new Error(
      `checksum mismatch for ${ASSET}: checksums.txt lists ${listed.join(", ") || "no hash"}, ` +
        `the repo pins ${pinned}`,
    );
  }
  writeFileSync(binPath, bytes);
  chmodSync(binPath, 0o755);
  return binPath;
}

// Env vars scrubbed so parent-machine state can never leak into the
// sandboxed runs — the e2e list plus the CodeAF/OpenRouter knobs a
// dev shell might carry (an inherited OPENROUTER_API_KEY would beat
// the launcher's overlay file and send the wrong key to the double).
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
  "CODEAF_HOME",
  "CODEAF_PROFILE_DIR",
  "CODEAF_BASE_URL",
  "CODEAF_MODEL",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "AFORGE_HOME",
  "FORCE_COLOR",
  "STUB_EXIT",
  "AIAND_DIR",
  "AIAND_UNINSTALL_FORCE",
  "AIAND_SOURCE",
];

const S = mkdtempSync(join(tmpdir(), "aiand-codeaf-smoke-"));
const { child: apiDouble, baseUrl } = await startApiDouble(S);

try {
  const home = join(S, "home");
  const cfg = join(S, "cfg");
  const binDir = join(S, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(cfg, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const codeafBin = await resolveCodeafBin(binDir);

  const env = { ...process.env };
  for (const name of SCRUB) delete env[name];
  env.AIAND_HOME = home;
  env.AIAND_CONFIG_DIR = cfg;
  env.AIAND_API_KEY = "sk-smoke-codeaf-key-000000000000000000";
  env.AIAND_BASE_URL = baseUrl;
  env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;

  // The real user's ~/.codeaf/config.json, byte-snapped so the end
  // of the run can prove the smoke never touched it.
  const realCodeafConfig = join(homedir(), ".codeaf", "config.json");
  const realCodeafBefore = existsSync(realCodeafConfig) ? readFileSync(realCodeafConfig) : null;

  const results = [];
  function check(name, ok, detail = "") {
    results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) process.exitCode = 1;
  }

  function cli(args) {
    // All call sites pass space-separated flags with no quoted values.
    return execFileSync(process.execPath, [DIST, ...args.split(" ")], {
      env,
      encoding: "utf8",
      timeout: CHILD_TIMEOUT_MS,
    });
  }

  // The launcher's overlay lives in tmpdir under this prefix (the
  // adapter's sessionLaunch); snap the listing to prove cleanup.
  const overlayDirs = () =>
    readdirSync(tmpdir()).filter((name) => name.startsWith("aiand-codeaf-"));

  // --- check 1: run-agent launches the real binary through the
  // throwaway CODEAF_HOME overlay --------------------------------------
  const overlaysBefore = overlayDirs();
  let launchCode = 1;
  let launchOut = "";
  let launchErr = "";
  try {
    launchOut = execFileSync(
      process.execPath,
      [DIST, "run-agent", "codeaf", "--", "chat", "--once", "Reply with the word ready"],
      {
        env,
        // stdin ignored: the headless door must not wait on a pipe.
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        timeout: CHILD_TIMEOUT_MS,
      },
    );
    launchCode = 0;
  } catch (error) {
    launchCode = error.status ?? 1;
    launchOut = String(error.stdout ?? "");
    launchErr = String(error.stderr ?? "");
  }
  check(
    "run-agent codeaf -- chat --once exits 0",
    launchCode === 0,
    `code=${launchCode}${launchErr ? ` ${launchErr.split("\n")[0]}` : ""}`,
  );
  check(
    "run-agent codeaf prints the double's reply",
    launchOut.includes(REPLY),
    launchOut.split("\n").filter(Boolean).slice(-3).join(" | ") || "(no output)",
  );
  const leftoverOverlays = overlayDirs().filter((name) => !overlaysBefore.includes(name));
  check(
    "run-agent cleans up its CODEAF_HOME overlay",
    leftoverOverlays.length === 0,
    leftoverOverlays.join(", "),
  );

  // --- check 2: the hand-written row drives the real binary ----------
  const codeafConfigPath = join(home, ".codeaf", "config.json");
  let onOut = "";
  try {
    onOut = cli("codeaf on --json");
  } catch (error) {
    // A non-zero exit must print a FAIL line, not a raw stack.
    onOut = String(error.stdout ?? error.message);
  }
  let on;
  try {
    on = JSON.parse(onOut);
  } catch {
    on = undefined;
  }
  check(
    "codeaf on succeeds",
    on?.state === "on" && on?.agent === "codeaf",
    on === undefined ? onOut : JSON.stringify(on),
  );

  const wired = existsSync(codeafConfigPath)
    ? JSON.parse(readFileSync(codeafConfigPath, "utf8"))
    : {};
  const row = wired.model_sources?.find((entry) => entry.id === "custom-aiand");
  check(
    "on writes the custom-aiand source row",
    row?.written === "aiand" &&
      row?.address === `${baseUrl}/v1` &&
      typeof row?.key === "string" &&
      row.key.length > 0 &&
      row?.["x-aiand"] === true,
    JSON.stringify(row),
  );
  check(
    "on pins the catalog model behind the aiand prefix",
    wired["model.talk"] === `aiand/${SMOKE_MODEL.id}`,
    String(wired["model.talk"]),
  );
  // The row carries the session key; the root api_key would feed the
  // default service — the leak the adapter must never write.
  check("on never writes the root api_key", !("api_key" in wired), "root api_key present");

  // The real binary, pointed at the same CODEAF_HOME `on` wrote —
  // no CODEAF_BASE_URL, so only the hand-written row can route it.
  let codeafCode = 1;
  let codeafOut = "";
  let codeafErr = "";
  try {
    codeafOut = execFileSync(codeafBin, ["chat", "--once", "Reply with the word ready"], {
      env: { ...env, CODEAF_HOME: join(home, ".codeaf") },
      // stdin ignored: the headless door must not wait on a pipe.
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: CHILD_TIMEOUT_MS,
    });
    codeafCode = 0;
  } catch (error) {
    codeafCode = error.status ?? 1;
    codeafOut = String(error.stdout ?? "");
    codeafErr = String(error.stderr ?? "");
  }
  check(
    "real codeaf chat --once exits 0",
    codeafCode === 0,
    `code=${codeafCode}${codeafErr ? ` ${codeafErr.split("\n")[0]}` : ""}`,
  );
  check(
    "real codeaf replies through the wired row",
    codeafOut.includes(REPLY),
    codeafOut.split("\n").filter(Boolean).slice(-3).join(" | ") || "(no output)",
  );

  cli("codeaf off --json");
  const afterOff = existsSync(codeafConfigPath) ? readFileSync(codeafConfigPath, "utf8") : null;
  check(
    "off removes the custom-aiand row",
    afterOff === null ||
      !JSON.parse(afterOff).model_sources?.some((entry) => entry.id === "custom-aiand"),
    afterOff ?? "(config removed)",
  );

  const realCodeafAfter = existsSync(realCodeafConfig) ? readFileSync(realCodeafConfig) : null;
  check(
    "the real ~/.codeaf is untouched",
    (realCodeafBefore === null && realCodeafAfter === null) ||
      (realCodeafBefore !== null &&
        realCodeafAfter !== null &&
        realCodeafBefore.equals(realCodeafAfter)),
    realCodeafConfig,
  );

  console.log(results.join("\n"));
  console.log(
    results.every((r) => r.startsWith("PASS"))
      ? "CODEAF SMOKE: ALL PASS"
      : "CODEAF SMOKE: FAILURES PRESENT",
  );
} finally {
  apiDouble.kill();
  rmSync(S, { recursive: true, force: true });
}
