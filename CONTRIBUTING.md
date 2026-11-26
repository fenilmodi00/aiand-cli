# Contributing

Node 22+, TypeScript, plain `tsc`, zero runtime dependencies. Domain
vocabulary lives in [CONTEXT.md](CONTEXT.md); use its terms in code, docs,
and commit messages.

## Build from source

```bash
npm ci
npm run build
node dist/index.js --help    # or `npm link` to put `aiand` on PATH
```

The installers install verified npm releases
([ADR 1](docs/adr/0001-installers-verify-npm-release.md)), but they can
build from a checkout for development. Run one from inside a checkout
(`bash install.sh`), or point `AIAND_SOURCE` at a local path or
`https://github.com/aiandlabs/aiand-cli` (other remotes are refused), e.g.
`AIAND_SOURCE=$PWD bash install.sh`. Such a build is unverified, and the
installer labels it that way.

To run the CLI against a local gateway, point a profile at it. Base URLs must
be `https`, except `http` on loopback:

```bash
aiand config set api-url http://127.0.0.1:8080
aiand config set auth-url http://127.0.0.1:8080
```

## Checks

```bash
npm ci
npm run lint                        # tsc build + biome check + knip (unused code/deps)
npm run fix                         # apply Biome's safe fixes and formatting
npm test                            # builds, then node:test
npm run test:coverage               # same suite, fails below the coverage floor
npm run check:dist                  # asserts on the built binary
npm run check:public                # repository hygiene checks
node scripts/e2e.mjs                # agent-adapter and uninstall changes
node scripts/install-behavior.mjs   # install.sh / install.ps1 changes
```

`npm test` preloads `test/setup.mjs`, which keeps the run off your machine:
no browser opens, the OS keychain is stubbed out, and `fetch` to anything but
loopback fails as if offline. Run test files through
`npm test` (or `node --import ./test/setup.mjs --test <file>`), not bare
`node --test`.

## Live gateway runs

Two scripts talk to the real gateway with a real key and spend a few cents of
credit per run. Both keep every bit of state in a fresh temp directory and
stub the OS keychain, so they are safe on a workstation.

- `test/e2e-live.test.mjs` runs inside `npm test` when `AIAND_API_KEY` is set
  and `opencode` is on PATH: `aiand opencode on`, then a real `opencode run`.
- `scripts/sbx-test.mjs` is the full command matrix: pasted-key sign-in,
  `whoami`, `status`, `run`, `models`, `logs`, `usage`, `orgs`, `config`,
  logout, `on`/`status`/`off` for every agent, `restore --force`, `init`, and
  the `run-agent` launcher.

```bash
npm run build
export AIAND_API_KEY=sk-…
node scripts/sbx-test.mjs dist/index.js   # full live matrix
node scripts/sbx-test.mjs --smoke         # offline subset, no key or network
node scripts/sbx-test.mjs --plan          # list the checks and exit
```

To run the matrix in a throwaway box instead, copy `dist`, `package.json`,
`CHANGELOG.md`, and `scripts/sbx-test.mjs` in and run the same command, for
example `docker run --rm -e AIAND_API_KEY -v "$PWD:/work" -w /work node:22-slim
node scripts/sbx-test.mjs dist/index.js`. `scripts/contree-e2e.sh` does the
same in a ConTree microVM.

## CI

The coverage floor (`--test-coverage-*` in `package.json`'s `test:coverage`)
sits just under the current numbers, measured without `AIAND_API_KEY`. Raise it
when coverage goes up; never lower it to land a change.

- `build`: lint, `npm run test:coverage`, `scripts/e2e.mjs`, `scripts/pi-smoke.mjs`
  (a real pinned Pi validating the config aiand generates and a headless
  `--print` round-trip through the loopback double — the schema-drift
  tripwire for Pi's pre-1.0 models.json), `scripts/omp-smoke.mjs` (the same
  round-trip for Oh My Pi's YAML), `scripts/copilot-smoke.mjs` (a real pinned
  Copilot CLI accepting the providers.json `on` generates and a headless `-p`
  round-trip, including provider-qualified selection of a slashed catalog
  id), the offline `sbx-test.mjs --smoke`, `check:dist`, and `check:public`.
  This job holds no key.
- `live-opencode`: `test/e2e-live.test.mjs`, a real pinned OpenCode routed
  through the gateway with the `AIAND_API_KEY` secret. It runs on pushes to
  main and on pull requests from branches of this repository.
- `live`: the full `sbx-test.mjs` matrix against the real gateway, on the same
  events. Fork pull requests get no secrets and skip it.
- `installer` / `installer-windows`: a real install into an isolated home on
  Ubuntu and Windows, `scripts/install-behavior.mjs`, and uninstall.
- `npm audit` (daily, not per PR): advisories and registry signatures for the
  installed toolchain.

A job that holds the key runs no third-party install code that it doesn't
need, and ci.yml says, at each such step, why the code that does run there
is acceptable. Keep it that way when adding a step.

Within a job there is no boundary between a step and the next. On a hosted
runner, code that runs in one step (the Hermes installer and the packages it
pulls, the pinned `opencode-ai`) has passwordless sudo, a writable tool
cache and readable `/proc/*/environ`, so no arrangement of step file commands
(`GITHUB_ENV`, `GITHUB_PATH`, `BASH_ENV`) or step-level `env:` keeps a later
step's key from it. What bounds the damage is what the job holds: the
`AIAND_API_KEY` secret is a CI-only key with low credit that is cheap to
revoke, no other secret is in a job that holds it, and `GITHUB_TOKEN` is
read-only. Keep those three true, and don't describe a step arrangement as
protecting the key.

Security reports go through GitHub Security Advisories; see `SECURITY.md`.

## Credit

Every outside contribution gets credit: code, bug reports, testing, and ideas
all count. You're listed in [THANKS.md](THANKS.md) after your first merged PR,
and changelog entries for your work end with `(#<pr>, thanks @<handle>)`.

Maintainers: add first-time contributors to THANKS.md when merging. Keep them
as commit authors; if you rework their change, add a `Co-authored-by:`
trailer, and credit a bug report with `Reported-by:`.

## Releasing

Merges to main never publish; a pushed `v<version>` tag does. Changes land
with a `CHANGELOG.md` entry under `## [Unreleased]`; released sections are
never edited.

```bash
npm run release -- prepare patch   # or minor, major, x.y.z
# review and merge the release/v<version> PR, wait for CI on main
npm run release -- tag
```

`prepare` runs from an up-to-date main: it bumps `package.json`, turns
`[Unreleased]` into `[<version>] - <date>` with a fresh empty `[Unreleased]`
above, runs the checks, and opens the PR. `tag` refuses unless main is clean,
at `origin/main`, and has a successful CI run, then pushes the tag.

`publish.yml` checks the same things again (tag matches `package.json`, commit
on main with a successful CI run, version not yet on npm), packs the tarball
once, publishes exactly that tarball to npm, waits until npm serves the same
sha512, and creates the GitHub release with that version's changelog section
as its notes and `SHA256SUMS`, `install.sh`, and `install.ps1` as assets. The
installers refuse a release with no `SHA256SUMS`, so don't create or edit a
release by hand.

If a run dies after `npm publish` (npm slow to serve the version, or the
release step failing), re-run the workflow. A version already on npm with no
complete GitHub release resumes: it publishes nothing, requires npm to serve
the very tarball the first run packed (sha512), waits up to about ten minutes
for that, and creates the release. Those bytes are not re-packed: the first run
uploads the tarball to the draft release, tagged with its commit, before it
publishes, and a resume downloads it from there. Only a resume reuses it: a
first run always packs from the tagged checkout, and if the draft release
already holds a tarball of that name it has to be byte-identical to that pack,
or the run stops and says so. (Delete the asset from the draft release, after
finding out who attached it, to go on.) The release is published only when the
draft holds exactly the tarball, `SHA256SUMS`, `install.sh` and `install.ps1`;
any other asset on it stops the run before anything is published, and the
error names what to remove with `gh release delete-asset`. The workflow also pins an exact
Node version, so a later run packs on the same toolchain; bump it deliberately.
A tag moved after the publish stops the run. It stops, as before, once the release exists
with its `SHA256SUMS`.

### Settings outside the repository

The publish job runs in the GitHub environment `release`. The installers'
two-party check (npm and the GitHub release,
[ADR 1](docs/adr/0001-installers-verify-npm-release.md)) only holds when these
are set, and none of them can be set from a file in this repository. Someone
with admin rights sets them once:

- [ ] GitHub, Settings, Environments, `release`: required reviewers (not only
      the person who pushes the tag); deployment branches and tags: selected
      tags, pattern `v*`, no branches.
- [ ] npm, `@aiand/cli`, Settings, Trusted Publisher: repository
      `aiandlabs/aiand-cli`, workflow `publish.yml`, environment `release`.
      Then, under Publishing access, choose "Require two-factor
      authentication and disallow tokens", and delete the `NPM_TOKEN` secret.
- [ ] GitHub, Settings, Rules, Rulesets: a tag ruleset on `v*` that restricts
      creation, update, and deletion to the release maintainers and blocks
      force pushes.
- [ ] A branch rule on `main` that requires a pull request.

Until they are set, anyone with write access to the repository can publish by
pushing a commit and a tag, and the installers cannot tell the result from a
real release.

The README one-liners fetch `install.sh` and `install.ps1` from the latest
release's assets, and update notices read npm's latest version while
`install.sh update` installs the latest GitHub release. Both agree once the
release exists, so don't leave a gap between the `npm publish` and the
release.

Release checklist for a change to `install.sh`, `install.ps1`, or the release
helper embedded in them:

- Cut a release immediately after merging. The one-liners fetch the
  installers from the latest release's assets, and an installer installs only
  a release that carries a `SHA256SUMS`. Between the merge and that release a
  one-liner runs the previous script, or, before any release carries the new
  assets (0.8.0 is the first), answers 404 or "no published release was
  found". The installer's message and the README point at
  `npm install -g @aiand/cli` meanwhile.
- Don't merge one you can't release the same day.
