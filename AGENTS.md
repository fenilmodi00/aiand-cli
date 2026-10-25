# @aiand/cli

The ai& command line interface. Node 22+, TypeScript, plain `tsc`, zero runtime
dependencies (enforced by `scripts/check-dist.mjs`).

## Verification

`npm run lint && npm test && npm run check:dist && npm run check:public` before handing over any change (`npm run lint` builds with tsc, then runs Biome and knip for unused files, exports, and dependencies; knip follows the tests' `dist/` imports back to `src/`, so it needs the build; `npm run fix` applies Biome's safe fixes and formatting) (`npm test` builds first via `pretest`). CI runs the suite as `npm run test:coverage`, which fails below the coverage floor in `package.json`; raise the floor when coverage rises, never lower it to land a change. Agent-adapter changes also run `node scripts/e2e.mjs`; installer changes also run `node scripts/install-behavior.mjs`.

## Conventions

Tests isolate with `AIAND_HOME`/`AIAND_CONFIG_DIR`, never the real home.
`npm test` preloads `test/setup.mjs` (`AIAND_NO_BROWSER=1`, stub
`security`/`secret-tool` first on PATH, and `test/net-guard.mjs` on
`NODE_OPTIONS`) so no test opens a browser, touches the OS keychain, or
reaches a non-loopback host. Run test files through it, build hermetic PATHs
with `hermeticPath()` from `test/helpers.mjs`, and point offline base URLs at
`CLOSED_URL` or `withMockGateway`. Only `test/e2e-live.test.mjs` opts out of
the network guard (`AIAND_TEST_ALLOW_NETWORK=1`).

CLI-error coverage: `test/mock-gateway.mjs` (loopback HTTP double) plus
`withMockGateway` in `test/helpers.mjs` drive the built CLI against scripted
429/401/happy-path responses — extend those before adding live-gateway
coverage. `install.sh` / `install.ps1` uninstall stay covered in `scripts/e2e.mjs`
(`install.ps1` uninstall only on win32, run by the `installer-windows` job) and
`scripts/install-behavior.mjs`. The `installer-windows` job is the
full PS1 install path on `windows-latest`: local-checkout `npm ci` + build,
`aiand.cmd` and Git Bash shim `--version`, then `uninstall --force`, then
`scripts/e2e.mjs`. Do not run `install.ps1`
install against a Linux checkout — Windows `npm ci` would replace
`node_modules`. Its rm -rf target must stay canonicalized and HOME-bounded.

Publishing (`publish.yml`) runs only on a pushed `v<version>` tag matching `package.json`, on a main commit that passed CI; merges never publish.

Dependencies are reviewed code: devDependencies stay exact-pinned (`.npmrc`
sets `save-exact`; `check:dist` fails on a range), `npm ci` runs with
`--ignore-scripts` in CI and the installers, and workflow actions are pinned
to a commit SHA with the version in a comment. A new dependency with an
install script needs an explicit reason in the PR. A release must be 7 days
old before we take it: `min-release-age` in `.npmrc` (npm 11.10+, which
`devEngines` warns about) and Dependabot's `cooldown` say the same.

Changelog: every user-visible change adds an entry under `## [Unreleased]` in
`CHANGELOG.md` (Added / Changed / Fixed / Removed). Released sections are
immutable. Releases go through `npm run release` (see CONTRIBUTING.md), never
a hand-edited version.

Git: several agent sessions may share this checkout. Stage explicit paths
(`git add <path>`), never `git add -A` / `git add .`; never `git reset --hard`,
`git checkout .`, `git clean`, `git stash`, or `--no-verify`. A regression test
for a GitHub issue carries a `// #<number>` comment naming it.

Issues live as GitHub issues on aiandlabs/aiand-cli, managed via the `gh` CLI.
Domain vocabulary, agent-wiring rules, and ADR locations: `CONTEXT.md` at the repo root — use its words exactly.
