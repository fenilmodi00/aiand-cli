# 2. Claude Code's auto-mode safety checks run on the fast model, on Claude Code's own requests

Status: accepted, 2026-11

## Context

Auto mode is Claude Code's default permission mode (v2.1.283 or later, for
interactive terminal and VS Code sessions). Before most tool calls, Claude
Code asks a model whether the action is safe. There are two ways to run
these safety checks:

- **Server-side checks.** Anthropic's API runs the checks as part of the
  session's own model requests. The client asks for them with the
  `safeguards` request field and reads `safeguard_results` in the response.
- **Claude Code's own requests.** Claude Code sends a separate classifier
  request. By default it goes to the model in `ANTHROPIC_DEFAULT_SONNET_MODEL`,
  or the session model if that one is unavailable.

The ai& gateway serves no Claude models, so it cannot produce server-side
results. Claude Code 2.1.328 and 2.1.329 asked for them anyway, fell back to
their own requests, and showed this notice in every gateway session: "an
upcoming release removes this fallback. In sessions like this one, each
checked action will then be asked about or denied."

`aiand claude` puts the main model (Kimi K3 first) in the Sonnet slot, so the
classifier requests ran on it. Each one sent about 30,000 input tokens and got
no prompt-cache hit. In our recorded harness tests on 20 and 21 November 2026, the
checks cost $1.39 against $0.18 of coding work (GLM 5.3) and $0.19 against
$0.10 (Kimi K3.1 Pro): 7× and 1.9×.

Claude Code's documentation (code.claude.com/docs/en/permission-modes and
/auto-mode-classifier-billing, read 21 November 2026) gives two controls:

- `CLAUDE_CODE_AUTO_MODE_MODEL` (v2.1.302 or later) takes a full model ID and
  runs the classifier on it. Claude Code ignores it for some Claude models;
  if the provider cannot serve the model, every checked action is denied.
- `CLAUDE_CODE_AUTO_MODE_SERVER=0` makes Claude Code always use its own
  classifier requests and stops the notice. The page calls it "a temporary
  setting" that "may be removed in a later release".

We considered three options for when the fallback goes away:

1. Do nothing. Every checked action would be asked about or denied, which
   makes auto mode unusable on ai&.
2. Make `acceptEdits` the default permission mode. File edits go through and
   every shell command is asked about. That works, but it changes how Claude
   Code behaves on ai& compared with Anthropic.
3. Keep auto mode, with `CLAUDE_CODE_AUTO_MODE_SERVER=0`.

## Decision

`aiand claude` (the Launcher's settings file) and `aiand claude on` (the env
block in `settings.json`) write:

- `CLAUDE_CODE_AUTO_MODE_MODEL`: the fast model, the same one as the `haiku`
  slot (`deepseek-ai/deepseek-v4.1-flash-1017` first), or the main model when
  the catalog has no fast model. A value the user set that the catalog serves
  is kept (unless `--model` is passed), and one it cannot serve is replaced.
  `off` hands back a value it replaced.
- `CLAUDE_CODE_AUTO_MODE_SERVER=0` (option 3). The checks always run on
  Claude Code's own requests, so removing the fallback for server-side checks
  does not affect ai& sessions.

`off` removes both values like every other key `on` owns.

## Consequences

- Safety checks are billed at the fast model's price rather than the main
  model's. Status: we did not measure the cost after the change. Done when a
  recorded `aiand claude` session spends no more than about 20% of its coding
  cost on checks.
- Status: we did not measure how well a non-Claude model judges risky
  actions. Claude Code documents auto mode only for Claude models on the
  clouds where it checks the model. A weak classifier blocks safe actions,
  which costs time, or allows risky ones, which is the risk that matters.
- Claude Code versions before 2.1.302 ignore `CLAUDE_CODE_AUTO_MODE_MODEL` and
  keep running the checks on the Sonnet slot.
- If Claude Code drops `CLAUDE_CODE_AUTO_MODE_SERVER` and asks for server-side
  checks again, `aiand claude` moves to option 2: it writes
  `permissions.defaultMode: "acceptEdits"`, and leaves alone a `defaultMode`
  the user set.
- The safety-check requests get no prompt-cache hits on the gateway. That is
  a gateway issue, separate from this decision.
