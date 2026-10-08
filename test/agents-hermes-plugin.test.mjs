import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";
import { buildHermesWrites } from "../dist/agents/hermes/routing.js";

// The generated Hermes model-provider plugin is Python the agent itself
// imports and interprets: its hooks drive the real session, so the test
// renders the file and runs it under a real python3 with the upstream
// modules stubbed — nothing here is asserted by string matching. The stubbed
// clamp_effort reproduces upstream's semantics (snap down to the nearest
// weaker supported level, never escalate; unknown requested names and empty
// sets pass through), so the plugin's wiring is what the checks exercise.
export const PLUGIN_HARNESS = `import sys, types, importlib.util

EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh", "max"]

def clamp_effort(effort, supported):
    if not supported:
        return effort
    supported = list(supported)
    if effort not in EFFORT_ORDER:
        return effort
    rank = EFFORT_ORDER.index(effort)
    weaker = [s for s in supported if s in EFFORT_ORDER and EFFORT_ORDER.index(s) <= rank]
    if weaker:
        return max(weaker, key=lambda s: EFFORT_ORDER.index(s))
    return min(supported, key=lambda s: EFFORT_ORDER.index(s) if s in EFFORT_ORDER else 0)

agent_pkg = types.ModuleType("agent")
reasoning = types.ModuleType("agent.reasoning_effort")
reasoning.clamp_effort = clamp_effort
agent_pkg.reasoning_effort = reasoning
sys.modules["agent"] = agent_pkg
sys.modules["agent.reasoning_effort"] = reasoning

registered = []
providers_pkg = types.ModuleType("providers")

def register_provider(provider):
    registered.append(provider)

providers_pkg.register_provider = register_provider
base = types.ModuleType("providers.base")

class ProviderProfile:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)

base.ProviderProfile = ProviderProfile
providers_pkg.base = base
sys.modules["providers"] = providers_pkg
sys.modules["providers.base"] = base

spec = importlib.util.spec_from_file_location("aiand_plugin_under_test", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
provider = module.aiand

count = 0

def ok(condition, label):
    global count
    if not condition:
        print("FAIL: " + label)
        sys.exit(1)
    count += 1

# prepare_messages: list return, tool-role name drop, empty passthrough.
out = provider.prepare_messages([{"role": "user", "content": "hi"}])
ok(isinstance(out, list) and out[0]["content"] == "hi", "prepare_messages returns a list")
out = provider.prepare_messages([
    {"role": "tool", "name": "f", "content": "c"},
    {"role": "assistant", "name": "keep", "content": "a"},
])
ok("name" not in out[0] and out[1].get("name") == "keep", "tool-role name dropped, others kept")
ok(provider.prepare_messages([]) == [], "empty message list passthrough")

# supported_reasoning_efforts.
ok(
    provider.supported_reasoning_efforts("zai-org/glm-5.3") == ["low", "high", "max"],
    "supported levels for a published model",
)
ok(provider.supported_reasoning_efforts("nope/model") is None, "no levels for an unknown model")

# default_reasoning_config: the weakest published level, never the engine default.
ok(
    provider.default_reasoning_config("zai-org/glm-5.3") == {"enabled": True, "effort": "low"},
    "default is the weakest published level",
)
ok(provider.default_reasoning_config("nope/model") is None, "no default for an unknown model")
ok(provider.default_reasoning_config(None) is None, "no default without a model")

# build_api_kwargs_extras: clamp a requested effort onto the model's levels.
def extras(reasoning_config=None, model=None):
    return provider.build_api_kwargs_extras(reasoning_config=reasoning_config, model=model)[1]

ok(extras(model="zai-org/glm-5.3") == {}, "unset level rides no override")
ok(extras(None, "zai-org/glm-5.3") == {}, "no reasoning config rides no override")
ok(extras({"effort": "medium"}, "zai-org/glm-5.3") == {"reasoning_effort": "low"}, "medium clamps to low")
ok(extras({"effort": "high"}, "zai-org/glm-5.3") == {"reasoning_effort": "high"}, "high stays high")
ok(extras({"effort": "max"}, "zai-org/glm-5.3") == {"reasoning_effort": "max"}, "max stays max")
ok(extras({"effort": "xhigh"}, "zai-org/glm-5.3") == {"reasoning_effort": "high"}, "xhigh clamps to high")
ok(
    extras({"enabled": False, "effort": "high"}, "zai-org/glm-5.3") == {"reasoning_effort": "none"},
    "disabled effort sends none",
)
ok(extras({"effort": "medium"}, "nope/model") == {}, "unknown model rides no override")
ok(extras(None, "nope/model") == {}, "unknown model with no config rides no override")
ok(
    extras({"effort": "medium"}, "other/model") == {"reasoning_effort": "low"},
    "a second published model clamps too",
)
ok(
    extras({"effort": "ultra"}, "zai-org/glm-5.3") == {"reasoning_effort": "ultra"},
    "an unknown level name passes through",
)

# Construction pins.
ok(provider.name == "aiand" and provider.api_mode == "chat_completions", "provider id and mode")
ok(provider.base_url == "https://api.aiand.com/v1", "provider base url")
ok(
    tuple(provider.env_vars) == ("AIAND_HERMES_API_KEY", "AIAND_HERMES_BASE_URL"),
    "env vars pin",
)
ok(tuple(provider.fallback_models) == ("zai-org/glm-5.3",), "fallback models pin")
ok(len(registered) == 1 and registered[0] is provider, "registered exactly once under aiand")

print("ALL PASS (%d checks)" % count)
`;

const probe = spawnSync("python3", ["--version"], { encoding: "utf8" });
const skipReason = probe.error || probe.status !== 0 ? "python3 is not available" : false;

describe("hermes provider plugin: python execution", { skip: skipReason }, () => {
  test("the rendered plugin clamps reasoning onto the catalog's levels", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiand-hermes-plugin-"));
    try {
      const writes = buildHermesWrites({
        apiKey: "sk-test-plugin",
        baseUrl: "https://api.aiand.com/v1",
        model: "zai-org/glm-5.3",
        reasoningLevels: new Map([
          ["zai-org/glm-5.3", ["low", "high", "max"]],
          ["other/model", ["low", "high"]],
        ]),
        envText: "",
        configText: "",
      });
      const pluginPath = join(dir, "plugin_under_test.py");
      writeFileSync(pluginPath, writes.initPy);
      const run = spawnSync("python3", ["-c", PLUGIN_HARNESS, pluginPath], {
        encoding: "utf8",
      });
      assert.equal(run.status, 0, run.stderr || run.stdout);
      assert.match(run.stdout, /ALL PASS/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
