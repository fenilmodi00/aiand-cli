# 1. The installers install the npm release, checked against npm and GitHub

Status: accepted, 2026-11

## Context

`install.sh` and `install.ps1` used to `git clone --depth 1` the main
branch and build it. That skipped everything a release goes through: the
`v<version>` tag, the green CI run on that commit, and npm's immutable
version. Nothing checked what was cloned, and a second run of the
installed copy rebuilt the same commit instead of updating.

Three designs were considered:

1. Clone the release tag (`--branch v<version>`) and check that the
   checked-out commit is the one the tag points to. Every input comes from
   GitHub, so a compromised GitHub, or a tag moved after the fact, still
   installs whatever it serves. It still runs `npm ci` and the TypeScript
   build on the user's machine.
2. Install the npm tarball and check it against npm's `dist.integrity`.
   The tarball and its hash come from the same registry, so this
   catches corruption in transit, not a registry that lies.
3. Install the npm tarball and require it to match two hashes from two
   parties: npm's `dist.integrity` (sha512) and a `SHA256SUMS` asset that
   `publish.yml` attaches to the GitHub release.

## Decision

Option 3. The installer:

- reads `SHA256SUMS` from the GitHub release (`releases/latest/download/`,
  or `releases/download/v$AIAND_VERSION/`). The single `aiand-cli-<version>.tgz`
  line in that file names the version. These are plain release-download
  URLs, not the REST API, so a shared IP doesn't hit the 60-request hourly
  limit for unauthenticated API calls.
- fetches `@aiand/cli@<version>` from the npm registry. It requires the
  manifest's `dist.tarball` to be the registry's own URL for that version
  and `dist.integrity` to be a sha512.
- downloads the tarball and stops unless both its sha512 matches npm and
  its sha256 matches `SHA256SUMS`.
- unpacks only regular files and directories under `package/`, refusing
  links, absolute paths, and `..`. It then runs the shipped
  `dist/index.js --version` against the expected version before swapping the
  install in.
- refuses to move backwards. A resolved version lower than the installed
  `package.json` version stops the install unless `AIAND_VERSION` names it,
  and no version below 0.8.0, the first release published with a
  `SHA256SUMS`, is installable at all, pinned or not. The floor is a constant
  in the helper (`FIRST_SUMS_RELEASE`); without it, a `SHA256SUMS` forged on
  GitHub for any older npm version would pass both checks.

`publish.yml` runs `npm pack` once, publishes that exact tarball, waits until
the registry serves the same sha512, and only then creates the GitHub
release with `SHA256SUMS` (plus `install.sh` and `install.ps1`). A first run
packs from the tagged checkout; if the draft release already holds a tarball
of that name, it has to be byte-identical to that pack or the run stops. Only
a resumed run (npm already has the version) takes a tarball from the draft
release instead of packing, and it still requires npm to serve those exact
bytes. The draft is published only when it holds exactly those four assets, so
one someone else attached is never published with them. The job runs in the GitHub environment `release`, which is what the
next section depends on.

There's no fallback. With no release, a 404, or a 403/429 rate limit, the
installer prints why and exits with the existing install untouched. It never
falls back to `main`. `AIAND_SOURCE` still clones and builds a source. It's
for development only: the installer labels the result as unverified, and
the source allowlist still applies.

### What has to be set up outside this repository

"Two parties" is only true if publishing to npm takes more than write access
to this repository. npm's trusted publishing authenticates the workflow, not
the ref it ran for, so the credential the publish step uses is whatever
GitHub hands to a run of `publish.yml`. These settings live outside the
repository's files; `publish.yml` and this ADR assume them, and nothing in the
repository can check that they are in place:

1. GitHub environment `release` (Settings, Environments): required reviewers
   other than whoever pushes the tag, and deployment branches and tags
   limited to the selected tag pattern `v*`, with no branch allowed.
2. npm trusted publisher for `@aiand/cli` (package Settings, Trusted
   Publisher): repository `aiandlabs/aiand-cli`, workflow filename
   `publish.yml`, environment name `release`. With the environment named
   there, npm only mints a publish credential for a run that went through
   it. Set the package's publishing access to require two-factor
   authentication and disallow tokens, so a token cannot publish around
   the environment. `publish.yml` passes no token.
3. A tag ruleset on `v*` (Settings, Rules, Rulesets, target: tags): creation,
   update, and deletion restricted to the release maintainers, with force
   pushes blocked. Without it anyone with write access can push a `v*` tag,
   and a moved or deleted tag changes what the environment is asked to
   approve.
4. A branch rule on `main` that requires a pull request, so a commit reaches
   the tagged history only through review. (`publish.yml` already requires the
   tag to be on `main` with a green CI run; that is only as strong as who can
   push to `main`.)

With all four in place, publishing needs a maintainer to create the tag and
a reviewer to approve the run, and a push, a branch, or a draft release made
with write access alone publishes nothing.

Until they are in place, the claim in Consequences does not hold. Someone with
only GitHub write access can push a commit to `main` (the existing rules block
deletion and force pushes, nothing more), tag it `v<next version>`, and
publish. `publish.yml` then packs that commit's bytes, npm accepts them over
OIDC, and the `SHA256SUMS` it attaches matches, so a correct installer
installs them. They can also edit the assets of a release that already
exists. Everything the installers check would pass, because both parties are
the same workflow.

Even with all four, GitHub write access can still replace the bootstrap
script that a fresh one-liner downloads (below), and whoever administers the
repository or the npm package can change these settings. Only the second is a
different party's account. The installers cannot tell that apart from a
release.

### The bootstrap script is trusted on first use

The two-party check covers the tarball. It does not cover the script that
runs it. A fresh install runs `install.sh` or `install.ps1` as fetched over
HTTPS from GitHub, before anything is verified, so GitHub alone decides what
that script checks and can make it skip every check, or run anything else
as the user. No later step in the script can repair that.

Two things narrow the gap without closing it:

- The README one-liners fetch the script from the latest GitHub release's
  assets (`releases/latest/download/install.sh` and `install.ps1`), which
  `publish.yml` attaches, instead of `raw.githubusercontent.com/.../main`.
  A push to main no longer changes what new users run; publishing a release
  does, and that takes a tag on a commit on main with a green CI run. This
  is still GitHub alone, so it raises the bar rather than adding a second
  party.
- `install.sh update` (and `install.ps1 update`) run the copy of the script
  that shipped inside a tarball an earlier run verified. From the second
  install on, the script that decides is itself two-party checked. Running
  the one-liner again downloads a new bootstrap instead, which is the
  first-use trust again.

A reader who wants no GitHub trust in the bootstrap installs from npm
(`npm install -g @aiand/cli`), which trusts npm alone.

## Consequences

- The tarball an installer installs has to satisfy two parties, npm and the
  GitHub release. That makes control of only GitHub, or only npm, not enough
  to put new bytes past a correct installer, **provided the settings in
  "What has to be set up outside this repository" are in place**: the
  protected `release` environment, the npm trusted publisher bound to it, and
  the tag ruleset. Without them, GitHub write access alone is enough (see
  that section for what it can do), because the same workflow speaks for
  both parties. With them, npm versions are immutable, so control of GitHub
  alone can only point a correct installer at an older published version (a
  downgrade). The installers refuse that unless `AIAND_VERSION` asks for it,
  and never go below 0.8.0. Once the package disallows tokens, no npm
  token can publish at all; until then, a stolen one can publish a version
  that no GitHub release vouches for.
- That claim is about the tarball, not the installer script. On a fresh
  install, GitHub alone is enough to run arbitrary code, through the
  bootstrap script (see above).
- Installs no longer run `npm ci` or a TypeScript build. The CLI has zero
  runtime dependencies, so the tarball runs as unpacked. The release path
  needs only Node, not git or npm.
- Releases from before this change have no `SHA256SUMS`. The installers
  can't install them, and they fail clearly until the first release
  published with the new `publish.yml` (0.8.0).
- `install.sh` and `install.ps1` ship in the npm package. Uninstall and
  `update` run them from `~/.aiand/cli`, and that copy always fetches a
  release rather than rebuilding itself.
- Node's `fetch` doesn't use `HTTPS_PROXY`. A machine that reaches the
  internet only through a proxy needs `npm install -g @aiand/cli` instead.
- Neither hash is a signature. Releases published with provenance carry an
  npm attestation, but checking it needs Sigstore verification that a
  shell script can't do without new tooling. It can be added later as a
  third check without changing this flow.
