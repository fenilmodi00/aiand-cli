// The loopback gateway double the Pi-family smokes share (pi-smoke,
// jouzu-smoke): one reasoning catalog model and a streaming
// chat-completions echo that reports the model and reasoning level it got.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// One catalog model the double serves; aiand pi on renders it into
// models.json and pi --list-models must list it back.
const SMOKE_MODEL = {
  id: "zai-org/glm-5.3",
  name: "GLM 5.3",
  object: "model",
  created: 1,
  owned_by: "zai-org",
  provider: "zai-org",
  context_window: 200000,
  max_output_tokens: 32768,
  capabilities: ["text", "vision", "tool_calling"],
  // Pi's default thinking level is medium. This model does not publish
  // medium, so Pi moves up to high. The double is lenient, but the shape
  // must stay honest: the request must not send medium.
  reasoning_efforts: ["low", "high", "max"],
  reasoning_effort_default: "max",
  description: null,
  currency: "usd",
  input_per_1m: "0.60",
  output_per_1m: "2.40",
  cached_input_per_1m: "0.10",
};

// Loopback gateway double in its own process (the CLI child blocks in
// execFileSync, so the double cannot live here). Serves the catalog and a
// chat-completions echo.
//
// Why bespoke instead of test/mock-gateway.mjs + withMockGateway: the smoke
// must prove the clamped level, so the catalog serves a reasoning model
// (reasoning_efforts low, high, max) the shared double has no equivalent of.
// And pi streams chat completions: this double serves
// the SSE chunk + [DONE] dialect pi's openai-completions path expects,
// while the shared double replies with a single JSON body.
const DOUBLE = `import { createServer } from "node:http";
const MODEL = ${JSON.stringify(SMOKE_MODEL)};
const server = createServer((req, res) => {
  if (req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [MODEL] }));
    return;
  }
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let model = "";
      let effort = "absent";
      try {
        const parsed = JSON.parse(raw);
        model = parsed.model ?? "";
        if (parsed.reasoning_effort != null) effort = String(parsed.reasoning_effort);
      } catch {}
      const content = "echo:" + model + ":effort=" + effort;
      const body = {
        id: "chatcmpl-smoke",
        object: "chat.completion",
        model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      // Pi streams: serve SSE the openai-completions dialect expects.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ ...body, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] }) + "\\n\\n");
      res.write("data: " + JSON.stringify({ ...body, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "\\n\\n");
      res.write("data: [DONE]\\n\\n");
      res.end();
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});
server.listen(0, "127.0.0.1", () => console.log("READY " + server.address().port));
`;

/**
 * Start the double in its own process under `dir` (the CLI child blocks in
 * execFileSync, so it cannot live in the caller). Resolves the child and its
 * base URL once it prints READY.
 */
export async function startSmokeDouble(dir) {
  // Start the double and wait for its READY line.
  writeFileSync(join(dir, "double.mjs"), DOUBLE);
  const doubleChild = spawn(process.execPath, [join(dir, "double.mjs")], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const baseUrl = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      // A child that never says READY must not outlive the caller, which
      // only learns of it once this resolves.
      doubleChild.kill();
      reject(new Error("smoke double did not start"));
    }, 15_000);
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

  return { child: doubleChild, baseUrl };
}
