// Live DeepSeek Harness smoke: the only proof stubs cannot give —
// the real pinned `dsh` binary accepting the $DSH_HOME rows the
// adapter generates (cordis.patch.yml + .credentials.yaml) and a
// headless round-trip through the loopback gateway double. The
// rows are built by importing the same builders `aiand dsh on`
// uses (dist/agents/dsh/rows.js), so this script can never
// drift from the YAML the CLI actually writes.
//
// Run by CI after scripts/e2e.mjs (the build job installs the
// pinned @deepseek-ai/dsh). No real gateway, no key: the loopback
// double serves /v1/models and /v1/chat/completions, per the repo
// rule that CLI-error coverage drives through the mock gateway.
//
// Requires: dist/ built, `dsh` on PATH. Exits non-zero on any
// failure.
//
// Observed against dsh 0.2.0-rc.2 (this script is the record):
//     bare invocation against $DSH_HOME routed through the double.
//   - The credential ref is resolved per request: inherited
//     environment first, then $DSH_HOME/.credentials.yaml. The
//     smoke therefore sets AIAND_DSH_API_KEY="" — dsh reads a
//     blank value as absent, so the overlay's credential file
//     wins (an exported real key would outrank it and mask a
//     config-file regression).
//   - `headless` is the non-TTY profile: one piped task, then
//     exit. The task rides stdin.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Two catalog models the double serves: the default pins the
// slashed id in the seeded default-model row, the second proves
// the row's models: block carries more than one entry.
const SMOKE_MODELS = ["zai-org/glm-5.3", "other/model"].map((id) => ({
  id,
  name: id,
  object: "model",
  created: 1,
  owned_by: "aiand",
  provider: "aiand",
  context_window: 200000,
  capabilities: ["text"],
  reasoning_efforts: null,
  reasoning_effort_default: null,
  description: null,
  currency: "usd",
  input_per_1m: "0.60",
  output_per_1m: "2.40",
  cached_input_per_1m: null,
}));

// The session key the seeded credential file holds: the double below
// rejects any request that did not resolve it, so the round trip proves
// dsh sent the key `aiand dsh on` bakes, not just some nonempty header.
const SMOKE_KEY = "sk-e2e-dsh-smoke-key-00000000";

// Loopback gateway double in its own process (the dsh child
// blocks in execFileSync, so the double cannot live here). Echoes
// the request body's model: stdout proving `echo:<catalog id>`
// means dsh accepted the seeded rows, resolved the default model,
// and sent the wireModel through the gateway.
const DOUBLE = `import { createServer } from "node:http";
 const MODELS = ${JSON.stringify(SMOKE_MODELS)};
 const KEY = ${JSON.stringify(SMOKE_KEY)};
 const server = createServer((req, res) => {
   if (req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: MODELS }));
    return;
  }
 if (req.url === "/v1/chat/completions" && req.method === "POST") {
   if (req.headers.authorization !== "Bearer " + KEY) {
     res.writeHead(401, { "content-type": "application/json" });
     res.end(JSON.stringify({ error: { message: "bad or missing bearer key" } }));
     return;
   }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let model = "";
      let stream = false;
      try {
        const body = JSON.parse(raw);
        model = body.model ?? "";
        stream = body.stream === true;
      } catch {}
      const echo = "echo:" + model;
      if (stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          "data: " +
            JSON.stringify({
              id: "chatcmpl-smoke",
              object: "chat.completion.chunk",
              model,
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: echo },
                  finish_reason: null,
                },
              ],
            }) +
            "\\n\\n",
        );
        res.write(
          "data: " +
            JSON.stringify({
              id: "chatcmpl-smoke",
              object: "chat.completion.chunk",
              model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            }) +
            "\\n\\n",
        );
        res.end("data: [DONE]\\n\\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-smoke",
          object: "chat.completion",
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: echo },
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
  res.end(JSON.stringify({ error: "not found" }));
});
server.listen(0, "127.0.0.1", () => console.log("READY " + server.address().port));
`;

const S = mkdtempSync(join(tmpdir(), "aiand-dsh-smoke-"));
let doubleChild;
let failed = false;

function fail(message) {
  process.stderr.write(`FAIL ${message}\n`);
  failed = true;
}

try {
  writeFileSync(join(S, "double.mjs"), DOUBLE);
  doubleChild = spawn(process.execPath, [join(S, "double.mjs")], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const baseUrl = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("smoke double did not start")), 15_000);
    doubleChild.stdout.on("data", (chunk) => {
      buf += String(chunk);
      const ready = buf.match(/READY (\d+)/);
      if (ready) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${ready[1]}`);
      }
    });
    doubleChild.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const home = join(S, "home");
  const dshHome = join(S, "dsh-home");
  mkdirSync(home, { recursive: true });
  mkdirSync(dshHome, { recursive: true });
  // The exact rows `aiand dsh on` writes, from the same builders —
  // no hand-copied YAML. The default row pins the first catalog
  // model, which is what a fresh session starts on.
  const { buildDshLlmRow, buildDshDefaultRow, buildDshCredentials } = await import(
    pathToFileURL(join(ROOT, "dist", "agents", "dsh", "rows.js")).href
  );
  writeFileSync(
    join(dshHome, "cordis.patch.yml"),
    [
      buildDshLlmRow(`${baseUrl}/v1`, SMOKE_MODELS),
      buildDshDefaultRow("aiand", SMOKE_MODELS[0].id, true),
      "",
    ].join("\n"),
  );
  // 0600 is not cosmetic: dsh's credentials-local refuses a key file
  // readable beyond its owner, and this is the mode `aiand dsh on` writes.
  writeFileSync(join(dshHome, ".credentials.yaml"), buildDshCredentials("", SMOKE_KEY), {
    mode: 0o600,
  });

  // The real dsh, never a stub: it reads the rows above from
  // $DSH_HOME. Scrub the launcher's own knobs (a dev shell
  // exporting DSH_HOME must not retarget the run) and any
  // inherited aiand env (AIAND_DSH_API_KEY is then set blank on
  // purpose — see the header: the credential file must win).
  const env = { ...process.env, HOME: home, DSH_HOME: dshHome };
  for (const name of [
    "AIAND_API_KEY",
    "AIAND_BASE_URL",
    "AIAND_AUTH_URL",
    "AIAND_HOME",
    "AIAND_CONFIG_DIR",
    "AIAND_PROFILE",
    "AIAND_KEY_STORAGE",
    "AIAND_IDE_SECRET_PLAINTEXT",
    "DSH_HOME",
    "AIAND_DSH_API_KEY",
  ]) {
    delete env[name];
  }
  env.DSH_HOME = dshHome;
  env.AIAND_DSH_API_KEY = "";

  // Headless round-trip: the piped task answers through the
  // gateway double, and the echoed wireModel proves the seeded
  // rows routed the default catalog id. CI=1 implies dsh's
  // no-auto-update default; NO_COLOR keeps the reply parseable.
  const printed = execFileSync("dsh", ["--profile", "headless"], {
    env: { ...env, NO_COLOR: "1", CI: "1" },
    input: "hi",
    encoding: "utf8",
    timeout: 180_000,
    cwd: home,
  });
  if (printed.includes(`echo:${SMOKE_MODELS[0].id}`)) {
    process.stdout.write("PASS dsh headless routes the catalog default through the gateway\n");
  } else {
    fail(`dsh headless round-trip did not echo the catalog id:\n${printed}`);
  }

  // The seeded home is the smoke's own: assert it is still there
  // (dsh must not have rewritten the patch layer out from under
  // the next reader) and that no key leaked into the patch file.
  if (!existsSync(join(dshHome, "cordis.patch.yml"))) {
    fail("dsh removed the seeded cordis.patch.yml");
  } else if (existsSync(join(dshHome, ".credentials.yaml"))) {
    const patch = readFileSync(join(dshHome, "cordis.patch.yml"), "utf8");
    if (patch.includes(SMOKE_KEY)) {
      fail("the session key leaked into cordis.patch.yml");
    } else {
      process.stdout.write("PASS dsh keeps the key out of the patch layer\n");
    }
  } else {
    fail("dsh removed the seeded .credentials.yaml");
  }
} catch (error) {
  fail(String(error.stderr ?? error.message ?? error));
} finally {
  doubleChild?.kill();
  rmSync(S, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
