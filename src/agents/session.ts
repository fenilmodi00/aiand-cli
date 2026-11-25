import { recordAgentKey } from "../api/agent-keys.js";
import type { Model } from "../api/models.js";
import { requireSessionKey } from "../auth/session.js";
import { CliError } from "../cli/errors.js";
import { resolveProfile } from "../config.js";
import { getCatalog, resolveDefault, servedModelId, validateCatalogModel } from "./catalog.js";
import { agentBaseEnv, runAgentBinary, takeFlagValues } from "./launch.js";
import { STALE_OVERLAY_MS, sweepOverlays } from "./overlays.js";
import type { AgentAdapter } from "./types.js";

/**
 * The one session-launch path shared by `aiand run-agent` and
 * `aiand <agent> [on] --session`: resolve the session, lift the adapter's own
 * model flags out of the passthrough, validate them against the live catalog,
 * sweep stale overlays, build the child env, spawn, and clean up. Callers own
 * their capability refusals and the bare-open install offer, so each command
 * keeps its own check order and wording.
 */

/** `--fast-model` is for adapters with a separate fast model; elsewhere --model sets every model. */
export function assertFastModelFlag(adapter: AgentAdapter): void {
  if (adapter.fastModelFlag) return;
  throw new CliError(`${adapter.label} has no separate fast model.`, {
    hint: "--model sets every model it uses.",
  });
}

/** The model flags a session takes from parsed options and the agent's passthrough. */
type SessionModelOptions = {
  model?: string;
  fastModel?: string;
  passthrough?: readonly string[];
};

/**
 * The session's models, with the agent's own model flag in the passthrough
 * counted as --model: left there, an adapter that owns the flag would drop
 * it, and one that does not would pass it to an agent whose other model
 * slots stay on our defaults. A value the agent resolves itself
 * (Claude Code's `opus`) stays in the passthrough.
 */
function launchModels(
  adapter: AgentAdapter,
  catalog: Model[],
  split: SessionModelOptions,
): { model: string | undefined; fastModel: string | undefined; passthrough: string[] } {
  const flags = adapter.launchModelFlags ?? [];
  const owned = adapter.fastModelFlag ? [...flags, "--fast-model"] : flags;
  const passthrough = split.passthrough ?? [];
  // An empty inline value would otherwise drop out and leave the default model.
  for (const token of passthrough) {
    const flag = owned.find((name) => token === `${name}=`);
    if (flag !== undefined) throw new CliError(`${flag} needs a value.`);
  }
  const keep = (value: string): boolean => adapter.passesLaunchModel?.(value) === true;
  const lifted = takeFlagValues(passthrough, flags, keep);
  const fast = adapter.fastModelFlag
    ? takeFlagValues(lifted.rest, ["--fast-model"])
    : { values: [], rest: lifted.rest };
  const pick = (given: string | undefined, values: string[], flag: string): string | undefined => {
    let chosen = given;
    for (const value of values.map((v) => servedModelId(catalog, v))) {
      if (chosen !== undefined && chosen !== value) {
        throw new CliError(`${flag} was given twice: ${chosen} and ${value}.`, {
          hint: `Pass ${flag} once.`,
        });
      }
      chosen = value;
    }
    return chosen;
  };
  return {
    model: pick(split.model, lifted.values, "--model"),
    fastModel: pick(split.fastModel, fast.values, "--fast-model"),
    passthrough: fast.rest,
  };
}

/**
 * Run one adapter-owned session. The caller has already refused adapters it
 * cannot launch and checked the binary is present; this resolves the session,
 * builds the ephemeral launch, spawns the agent, and cleans up. Returns the
 * model the session was pinned to: an explicit/lifted --model, else the
 * catalog default.
 */
export async function launchAgentSession(
  adapter: AgentAdapter,
  launch: NonNullable<AgentAdapter["sessionLaunch"]>,
  opts: SessionModelOptions & { profile?: string } = {},
): Promise<string> {
  if (opts.fastModel !== undefined) assertFastModelFlag(adapter);

  const session = await requireSessionKey(opts.profile);

  const profile = resolveProfile(opts.profile);
  const baseUrl = profile.apiUrl;
  const catalog = await getCatalog(baseUrl);
  const models = launchModels(adapter, catalog, opts);

  // --model is validated against the live catalog; without it the adapter
  // picks, with the profile default on hand for adapters that need one.
  // Adapters that opt in via allowUnpinnedModel read the literal "native"
  // as "leave the model unpinned"; every other adapter keeps the ordinary
  // catalog-membership error for it.
  const unpinned = models.model === "native" && adapter.allowUnpinnedModel === true;
  if (models.model !== undefined && !unpinned) validateCatalogModel(catalog, models.model);
  if (models.fastModel !== undefined) {
    validateCatalogModel(catalog, models.fastModel, "--fast-model");
  }

  // A session killed before its cleanup leaves its key in tmp. Sweeping
  // here, where overlays are made, keeps that cost off every other command
  // (Codex runs `aiand key export` on each request). Only a day-old overlay
  // whose aiand process is gone qualifies, so a parallel launch is safe.
  await sweepOverlays({ minAgeMs: STALE_OVERLAY_MS }).catch(() => {});

  const resolved = await launch({
    apiKey: session.key,
    model: models.model,
    ...(models.fastModel !== undefined ? { fastModel: models.fastModel } : {}),
    profileModel: profile.model,
    profileName: profile.name,
    catalog,
    baseUrl,
  });

  // Attribute this session's requests to the agent, not aiand-cli: without
  // it the sync sweep self-records the same session key and every request the
  // agent makes is credited to aiand-cli. Best-effort: attribution must never
  // break a launch.
  await recordAgentKey(adapter.id, session.key).catch(() => {});

  // Child env = inherited, plus the adapter's own injection.
  // The adapter's own injection carries the key; a leaked AIAND_API_KEY would hand it to every process the agent spawns.
  const env = agentBaseEnv(adapter);
  // Adapters that route outside the child env list the inherited names that
  // would shadow that routing; the launcher drops them so its own injection wins.
  for (const k of adapter.shadowEnv ?? []) delete env[k];
  Object.assign(env, resolved.env);

  // The adapter may own routing flags in the passthrough (e.g. Pi's
  // --provider/--model/--api-key): drop the user's `--flag value` and
  // `--flag=value` forms so the injected routing cannot be overridden.
  // Everything else passes verbatim. A value is only consumed when it is
  // not itself a flag, so `--model --print` keeps --print and a trailing
  // `--model` eats nothing.
  const ownedFlags = resolved.stripPassthroughFlags ?? [];
  const passthrough: string[] = [];
  for (let i = 0; i < models.passthrough.length; i += 1) {
    const token = models.passthrough[i]!;
    if (ownedFlags.includes(token)) {
      // `--flag value`: the value is the next token, when present and not
      // itself a flag.
      const next = models.passthrough[i + 1];
      if (next !== undefined && !next.startsWith("-")) i += 1;
      continue;
    }
    if (ownedFlags.some((flag) => token.startsWith(`${flag}=`))) continue;
    passthrough.push(token);
  }

  await runAgentBinary(adapter, [...(resolved.args ?? []), ...passthrough], env, resolved.cleanup);
  return models.model ?? resolveDefault(catalog, profile.model);
}
