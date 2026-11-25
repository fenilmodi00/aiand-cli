#!/usr/bin/env bash
# aiand one-line installer.
#
#   curl -fsSL https://github.com/aiandlabs/aiand-cli/releases/latest/download/install.sh | bash
#   bash ~/.aiand/cli/install.sh update
#   bash install.sh uninstall [--force] [--purge]
#
# Installs the latest ai& CLI release into ~/.aiand/cli and drops an `aiand`
# launcher on PATH via ~/.local/bin. The release is the npm tarball for the
# version the latest GitHub release names; it must match both npm's sha512
# (`dist.integrity`) and the sha256 in that GitHub release's SHA256SUMS, or
# nothing is installed (docs/adr/0001-installers-verify-npm-release.md).
# There is no fallback to the main branch: with no release reachable, the
# installer stops. Those checks cover the tarball, not this script: a fresh
# install runs it as fetched from GitHub, before anything is verified (the
# one-liner takes it from the latest release's assets, not main), so the
# bootstrap is trusted on first use. `update` runs the copy that shipped in
# an already verified tarball.
# Re-running the installer replaces the previous install only after the new
# one is staged and verified — a failed stage leaves the old install
# untouched. The installer never rewrites or deletes anything under
# ~/.config/aiand (profiles, credentials, agent snapshots) — updating the CLI
# never unwires your agents. Answering yes to the closing login question runs
# `aiand login`, which stores a session there.
#
# `update` installs the latest release (or AIAND_VERSION) over an existing
# install. It always takes the release path, even when this script sits in a
# checkout or AIAND_SOURCE is set. Run from an install's own copy, it updates
# that install unless AIAND_DIR names another.
#
# On this branch the default is a side-by-side preview instead of the release:
# the command is `aiand-v2`, the checkout lives in ~/.aiand/cli-v2, runtime
# state goes to ~/.config/aiand-v2, and the tree built is the cli-v2 branch of
# this fork (an unverified development build, see AIAND_SOURCE below). It
# never touches a production `aiand` install beside it. AIAND_V2_SIDEBYSIDE=0
# restores the release install this header documents.
#
# `uninstall` turns every aiand-routed agent `off` first (via the installed
# CLI's `aiand init --off`, aborting before deleting anything when off fails
# so snapshots stay retryable), then removes the launcher and the
# checkout. Profiles, credentials, and snapshots under ~/.config/aiand are
# intentionally kept, unless `--purge` asks for a wipe (for a shared or loaner
# machine): then the installed CLI first runs `aiand logout --all` (or, on a
# CLI without it, `aiand logout` for every profile), which revokes the keys it
# minted and strips every agent's wiring, and the config directory is deleted
# after the files. The purge stops, deleting nothing, unless every key the CLI
# minted reports revoked (`--force` skips sign-out and says so). Like the checkout, that directory must canonicalize to a
# path strictly inside HOME, and its name must be the install's (`aiand`, or
# `aiand-v2` for the preview). An existing
# ~/.local/bin/aiand this installer did not write is never overwritten,
# executed, or removed.
#
# Knobs (environment only; no flags):
#   AIAND_VERSION=x.y.z                  install that release instead of the latest;
#                                        the only way to go to an older version
#                                        than the installed one (and nothing
#                                        below 0.8.0, the first release with a
#                                        SHA256SUMS, can be installed at all)
#   AIAND_SOURCE=https://…|/local/path   development only: build an unverified
#                                        clone of this source instead of a
#                                        release (https URLs must be
#                                        github.com/aiandlabs/aiand-cli, or this
#                                        branch's fork while the preview is on)
#   AIAND_BRANCH=…                       branch to clone when AIAND_SOURCE is a
#                                        git URL (default: the source's own)
#   AIAND_DIR=~/.aiand/cli               where the source lives
#   AIAND_CONFIG_DIR=~/.config/aiand     runtime state (profiles, credentials,
#                                        agent snapshots); uninstall names it
#   AIAND_INSTALL_NAME=aiand             launcher/command name this installer
#                                        writes and uninstalls
#   AIAND_V2_SIDEBYSIDE=0                install production aiand from a verified
#                                        release instead of the preview
#   AIAND_SKIP_BUILD=1                   reuse the existing dist/ build
#   AIAND_INSTALL_VERBOSE=1              show full npm output
#   AIAND_UNINSTALL_FORCE=1              on uninstall, skip turning agents off
#   AIAND_NO_MODIFY_PATH=1               never touch shell rc PATH entries
#   NO_COLOR                             disable ANSI colors in this script
set -euo pipefail

# --- cli-v2 side-by-side preview --------------------------------------------
# This branch installs next to a production `aiand` instead of over it: the
# command is `aiand-v2`, the checkout lives in ~/.aiand/cli-v2, runtime state
# (credentials, locks, agent snapshots) goes to ~/.config/aiand-v2, and the
# source is this fork's cli-v2 branch — never the published release, which is
# production. The launcher bakes these knobs so `aiand-v2 update` re-fetches
# this branch and `aiand-v2`'s uninstall addresses this install.
# Delete this block when cli-v2 merges back to main. AIAND_V2_SIDEBYSIDE=0
# restores the production defaults (the installer test harnesses pin it);
# a knob already set in the environment always wins.
if [[ "${AIAND_V2_SIDEBYSIDE:-1}" != "0" ]]; then
  : "${AIAND_INSTALL_NAME:=aiand-v2}"
  : "${AIAND_DIR:=${HOME}/.aiand/cli-v2}"
  : "${AIAND_CONFIG_DIR:=${HOME}/.config/aiand-v2}"
  : "${AIAND_SOURCE:=https://github.com/fenilmodi00/aiand-cli.git}"
  : "${AIAND_BRANCH:=cli-v2}"
  export AIAND_INSTALL_NAME AIAND_DIR AIAND_CONFIG_DIR AIAND_SOURCE AIAND_BRANCH
fi
# Every launcher path, uninstall target, and message that names the command
# derives from this one value.
INSTALL_NAME="${AIAND_INSTALL_NAME:-aiand}"
if ! [[ "${INSTALL_NAME}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  echo "error: AIAND_INSTALL_NAME must be a plain command name (letters, digits, . _ -); got '${INSTALL_NAME}'." >&2
  exit 1
fi

SOURCE="${AIAND_SOURCE:-}"
# Test-only overrides for the installer tests' loopback double; the helper
# refuses anything else but the defaults.
RELEASES_URL="${AIAND_INSTALL_RELEASES_URL:-https://github.com/aiandlabs/aiand-cli/releases}"
NPM_REGISTRY="${AIAND_INSTALL_NPM_REGISTRY:-https://registry.npmjs.org}"
INSTALL_DIR="${AIAND_DIR:-${HOME}/.aiand/cli}"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=0
MIN_NODE_VERSION="${MIN_NODE_MAJOR}"
INSTALL_NOTES=()
STAGING_DIR=""
DOWNLOAD_DIR=""
# The previous install, from the moment activate_staged_install moves it aside
# until the new one is in place. Set before the first move, so an interruption
# at any point after it can put the previous install back.
SWAP_PREVIOUS=""
INSTALL_STAGE_TOTAL=5

# When install.sh is piped (curl | bash), BASH_SOURCE[0] is unset; fall
# through to the clone path below. Otherwise, prefer the checkout this
# script already lives in so `./install.sh` installs local work in progress.
SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

cleanup() {
  # Before anything is deleted: an update stopped between the two moves of the
  # swap (Ctrl-C, a closed terminal, SIGTERM) leaves INSTALL_DIR empty, and
  # `aiand` with it. Put the previous install back.
  if [[ -n "${SWAP_PREVIOUS}" && -d "${SWAP_PREVIOUS}" && ! -e "${INSTALL_DIR}" ]]; then
    if mv -- "${SWAP_PREVIOUS}" "${INSTALL_DIR}" 2>/dev/null; then
      SWAP_PREVIOUS=""
    else
      echo "error: the update was interrupted and the previous install could not be put back; it is at ${SWAP_PREVIOUS}" >&2
    fi
  fi
  if [[ -n "${STAGING_DIR}" && -d "${STAGING_DIR}" ]]; then
    rm -rf -- "${STAGING_DIR}"
  fi
  if [[ -n "${DOWNLOAD_DIR}" && -d "${DOWNLOAD_DIR}" ]]; then
    rm -rf -- "${DOWNLOAD_DIR}"
  fi
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

supports_color() {
  # Progress goes to stderr; probe that fd so `curl | bash` still colors a TTY.
  [[ -t 2 && "${TERM:-}" != 'dumb' && -z "${NO_COLOR:-}" ]]
}

# Diagnostic stream: stderr is the only output channel the installer prints
# progress on, mirroring the CLI's answers-stdout rule.
log() {
  if supports_color; then
    printf '\033[1;36m==>\033[0m %s\n' "$*" >&2
  else
    printf '==> %s\n' "$*" >&2
  fi
}

stage() {
  local number="$1"
  shift
  log "[$number/$INSTALL_STAGE_TOTAL] $*"
}

show_intro() {
  if supports_color; then
    printf '\033[1;36m' >&2
  fi
  printf '%s\n' \
    '  █████████    █████   ██████' \
    '  ███░░░░░███ ░░███   ███░░███' \
    ' ░███    ░███  ░███  ░░██████' \
    ' ░███████████  ░███   ██████' \
    ' ░███░░░░░███  ░███ ░███░░███' \
    ' ░███    ░███  ░███ ░███ ░░███' \
    ' █████   █████ █████░░█████░███' \
    '░░░░░   ░░░░░ ░░░░░  ░░░░░ ░░░' >&2
  if supports_color; then
    printf '\033[0m' >&2
  fi
  printf '\n' >&2
}

# Only https://github.com/aiandlabs/aiand-cli(.git) may be a URL source.
# Local paths (CI workspace, a fork checkout) stay allowed: they carry no
# network trust decision. The fenilmodi00 fork (this branch's side-by-side
# preview source) is allowlisted only while the preview block above is on.
is_allowlisted_source() {
  local url="${1:-}" rest host path
  # A leading dash would reach `git clone` as an option (e.g. --upload-pack).
  [[ "${url}" == -* ]] && return 1
  if [[ "${url}" != *"://"* ]]; then
    # Local paths only. git@host:path and host:path are remotes, not files.
    [[ "${url}" == *"@"* ]] && return 1
    if [[ "${url}" =~ ^[A-Za-z]:([\\/].*)?$ ]]; then
      return 0
    fi
    [[ "${url}" == *":"* ]] && return 1
    return 0
  fi
  [[ "${url}" == https://* ]] || return 1
  rest="${url#https://}"
  # Reject userinfo, query, or fragment.
  [[ "${rest}" == *"@"* ]] && return 1
  [[ "${rest}" == *"?"* ]] && return 1
  [[ "${rest}" == *"#"* ]] && return 1
  host="${rest%%/*}"
  [[ "${host}" == "github.com" ]] || return 1
  if [[ "${rest}" == *"/"* ]]; then
    path="/${rest#*/}"
  else
    path="/"
  fi
  case "${path}" in
    "/aiandlabs/aiand-cli" | "/aiandlabs/aiand-cli.git") return 0 ;;
    "/fenilmodi00/aiand-cli" | "/fenilmodi00/aiand-cli.git")
      [[ "${AIAND_V2_SIDEBYSIDE:-1}" != "0" ]] && return 0
      return 1
      ;;
  esac
  return 1
}

install_note() {
  INSTALL_NOTES+=("$1")
}

print_install_notes() {
  local note
  # Empty "${array[@]}" is an unbound variable under `set -u` on Bash 3.2 (macOS).
  ((${#INSTALL_NOTES[@]})) || return 0
  for note in "${INSTALL_NOTES[@]}"; do
    echo "Note: ${note}"
  done
}

# Post-install summary on stdout: which PATH coding agents are present, and
# the install hint for each one that is missing. The hint is that adapter's
# install.command, printed by the package just installed, so the shell script
# does not carry a second copy. A missing script (an older release) does not
# fail the install. Wiring still waits for `aiand init`.
print_agent_summary() {
  local summary="${1}/dist/agents/install-summary.js"
  [[ -f "${summary}" ]] || return 0
  command -v node >/dev/null 2>&1 || return 0
  node --disable-warning=ExperimentalWarning "${summary}" || true
}

node_meets_minimum() {
  local version major minor
  version="$(node -p "process.versions.node" 2>/dev/null || echo "0.0.0")"
  major="${version%%.*}"
  minor="${version#*.}"
  minor="${minor%%.*}"
  [[ "${major}" =~ ^[0-9]+$ && "${minor}" =~ ^[0-9]+$ ]] || return 1
  ((major > MIN_NODE_MAJOR || (major == MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR)))
}

# True iff package.json's top-level `name` is @aiand/cli. A grep for the
# string would also match nested keys (e.g. metadata.name), which is not
# enough identity for rm -rf.
is_aiand_cli_package() {
  local pkg="${1:-}"
  [[ -f "${pkg}" ]] || return 1
  # Uninstall must still identify a valid checkout when `node` is missing
  # from PATH (the launcher bakes an absolute Node path at install time).
  if command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("fs");
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      } catch {
        process.exit(1);
      }
      process.exit(parsed && parsed.name === "@aiand/cli" ? 0 : 1);
    ' -- "${pkg}" 2>/dev/null && return 0
    return 1
  fi
  # No node on PATH: the first "name" key only, so a nested
  # metadata.name cannot authorize rm -rf.
  local line first=""
  while IFS= read -r line || [[ -n "${line}" ]]; do
    if [[ "${line}" =~ \"name\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
      first="${BASH_REMATCH[1]}"
      break
    fi
  done < "${pkg}"
  [[ "${first}" == "@aiand/cli" ]]
}

# True iff the installer recorded this checkout as its own (or it is the
# default-path checkout from before markers existed). Ownership metadata, not
# the package name, authorizes rm -rf: any @aiand/cli-named source checkout
# cloned by hand under $HOME/src would otherwise be deletable via AIAND_DIR.
OWNERSHIP_MARKER=".aiand-installer-owned"
# Baked into every launcher this installer (and install.ps1) writes; its
# presence is how uninstall and re-install tell ours from a foreign file.
LAUNCHER_HEADER="aiand launcher"
is_installer_owned() {
  local dir="${1:-}" home_real
  home_real="$(cd "${HOME}" 2>/dev/null && pwd -P || printf '%s' "${HOME}")"
  [[ -f "${dir}/${OWNERSHIP_MARKER}" ]] && return 0
  [[ "${dir}" == "${home_real}/.aiand/cli" ]] && is_aiand_cli_package "${dir}/package.json"
}

# True iff the file at $1 was written by the aiand installer (install.sh's
# launcher and install.ps1's shim pair both bake an "aiand launcher"
# header). A foreign ~/.local/bin/aiand must never be overwritten,
# executed, or deleted. Pure bash so uninstall --force keeps working with
# node and grep off PATH (same reason is_aiand_cli_package has a fallback).
is_aiand_launcher() {
  local launcher="${1:-}" line
  [[ -f "${launcher}" ]] || return 1
  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ "${line}" == *"${LAUNCHER_HEADER}"* ]] && return 0
  done <"${launcher}"
  return 1
}

# Refuse to install over a foreign launcher. Called up front in main so a
# refusal happens before any clone/build/swap (a failed install leaves the
# old install untouched, like every other early failure), and again in
# install_cli_launcher as defense-in-depth.
refuse_foreign_launcher() {
  local launcher_path="${1:-}"
  if [[ -e "${launcher_path}" ]] && ! is_aiand_launcher "${launcher_path}"; then
    echo "Error: ${launcher_path} was not written by the aiand installer; it was left untouched. Move or remove it and re-run the installer." >&2
    exit 1
  fi
}

# Best-effort: a read-only checkout must never fail an install over the
# marker — uninstall falls back to refusing, which errs toward keeping files.
mark_installer_owned() {
  local dir="${1:-}"
  printf 'aiand-cli installer ownership marker\n' >"${dir}/${OWNERSHIP_MARKER}" 2>/dev/null || true
  # Keep the marker out of `git status` so the next update's local-changes
  # check does not trip over our own file.
  if [[ -d "${dir}/.git/info" ]]; then
    printf '%s\n' "/${OWNERSHIP_MARKER}" >>"${dir}/.git/info/exclude" 2>/dev/null || true
  fi
}

print_tool_instructions() {
  echo "Install ${1} and rerun this installer." >&2
  echo >&2
  echo "Options:" >&2
  echo "  - https://nodejs.org/en/download (Node.js ${MIN_NODE_VERSION}+, ships with npm)" >&2
  echo "  - nvm: https://github.com/nvm-sh/nvm#installing-and-updating" >&2
  if command -v apt-get >/dev/null 2>&1; then
    echo "  - NodeSource on Debian/Ubuntu (review the setup script before running it):" >&2
    echo "      curl -fsSL https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x -o /tmp/nodesource-setup.sh" >&2
    echo "      less /tmp/nodesource-setup.sh" >&2
    echo "      sudo bash /tmp/nodesource-setup.sh && sudo apt-get install -y nodejs git" >&2
  fi
}

ensure_toolchain() {
  # Windows (Git Bash / MSYS / Cygwin): Node is frequently installed but not on
  # the PATH the shell inherits (e.g. C:\Program Files\nodejs). Probe the common
  # install location and add it to PATH for this session before giving up.
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*)
      if ! command -v node >/dev/null 2>&1; then
        local win_node candidates=() win_pf
        if command -v cygpath >/dev/null 2>&1 && [[ -n "${PROGRAMFILES:-}" ]] \
          && win_pf="$(cygpath -u "${PROGRAMFILES}" 2>/dev/null)"; then
          candidates+=("${win_pf}/nodejs")
        fi
        candidates+=("/c/Program Files/nodejs")
        for win_node in "${candidates[@]}"; do
          if [[ -x "${win_node}/node.exe" || -x "${win_node}/node" ]]; then
            PATH="${win_node}:${PATH}"
            export PATH
            break
          fi
        done
      fi
      ;;
  esac

  if command -v node >/dev/null 2>&1 && node_meets_minimum; then
    :
  else
    if command -v node >/dev/null 2>&1; then
      local current
      current="$(node -p "process.versions.node" 2>/dev/null || echo "unknown")"
      echo "Node.js ${MIN_NODE_VERSION}+ is required (found ${current})." >&2
    else
      echo "Node.js ${MIN_NODE_VERSION}+ is required to run the CLI." >&2
    fi
    if [[ "$(uname -s)" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then
      # Prompt from the controlling terminal so this works under `curl … | bash`,
      # where stdin is the script stream (a plain `read -p` prompt never shows and
      # would consume the next line of the script).
      local install_node
      if [[ -r /dev/tty ]]; then
        read -r -p "Install Node.js with Homebrew now? [y/N] " install_node </dev/tty
      else
        read -r -p "Install Node.js with Homebrew now? [y/N] " install_node
      fi
      if [[ ! "${install_node}" =~ ^[Yy]$ ]]; then
        print_tool_instructions "Node.js ${MIN_NODE_VERSION}+"
        exit 1
      fi
      echo "Installing Node.js with Homebrew..."
      brew install node
      if ! node_meets_minimum; then
        echo "Node.js ${MIN_NODE_VERSION}+ is still required after install." >&2
        print_tool_instructions "Node.js ${MIN_NODE_VERSION}+"
        exit 1
      fi
    else
      print_tool_instructions "Node.js ${MIN_NODE_VERSION}+"
      exit 1
    fi
  fi
}

# git and npm are only needed to build from source (AIAND_SOURCE or a local
# checkout); a release install needs Node alone.
require_tools() {
  local tool
  for tool in "$@"; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
      echo "Missing required command: ${tool}" >&2
      if [[ "${tool}" == "npm" ]]; then
        # npm ships with Node.js, so the Node install options apply.
        print_tool_instructions "${tool}"
      else
        echo "Install git (https://git-scm.com/downloads) and rerun this installer." >&2
      fi
      exit 1
    fi
  done
}

# Refuse to replace INSTALL_DIR unless it is ours and holds nothing a swap
# would lose. $1 is clone (an AIAND_SOURCE build) or release.
check_install_dir_replaceable() {
  local mode="$1"
  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    if ! command -v git >/dev/null 2>&1; then
      echo "Error: ${INSTALL_DIR} is a git checkout and git is not installed, so its local changes cannot be checked; your checkout was left untouched." >&2
      exit 1
    fi
    if ! is_aiand_cli_package "${INSTALL_DIR}/package.json"; then
      echo "Error: ${INSTALL_DIR} is not an aiand checkout; your checkout was left untouched. Move or remove it and re-run the installer." >&2
      exit 1
    fi
    # A release replaces the checkout wholesale, so it may only replace one the
    # installer made: a developer's own clone at AIAND_DIR has no marker and
    # is not the default install directory. (Uninstall asks the same.)
    if [[ "${mode}" == "release" ]] && ! is_installer_owned "${INSTALL_DIR}"; then
      echo "Error: ${INSTALL_DIR} is a git checkout the installer did not create (it has no installer ownership marker); your checkout was left untouched. Point AIAND_DIR at another directory, or move it and re-run the installer." >&2
      exit 1
    fi
    # The marker is excluded explicitly too: installs from before it was
    # written to .git/info/exclude still carry it as an untracked file.
    if [[ -n "$(git -C "${INSTALL_DIR}" status --porcelain -- . ":(exclude)${OWNERSHIP_MARKER}" 2>/dev/null)" ]]; then
      echo "Error: ${INSTALL_DIR} has local changes; your checkout was left untouched. Commit, stash, or discard them and re-run the installer." >&2
      exit 1
    fi
    if [[ "${mode}" == "release" ]]; then
      # A release replaces the checkout wholesale: refuse when it carries
      # commits its upstream does not (as last fetched; no network here). A
      # branch with no upstream cannot be compared, so its commits count as
      # local: a failed rev-list is never read as "nothing ahead".
      local ahead
      if ! ahead="$(git -C "${INSTALL_DIR}" rev-list '@{upstream}..HEAD' 2>/dev/null)"; then
        echo "Error: ${INSTALL_DIR} is on a branch with no upstream, so its local commits cannot be checked; your checkout was left untouched. Move or remove it and re-run the installer." >&2
        exit 1
      fi
      if [[ -n "${ahead}" ]]; then
        echo "Error: ${INSTALL_DIR} has local commits; your checkout was left untouched. Move or remove it and re-run the installer." >&2
        exit 1
      fi
      return 0
    fi
    # Fetch (not pull): remotes update, the worktree stays exactly as it is.
    if ! git -C "${INSTALL_DIR}" fetch --quiet 2>/dev/null; then
      echo "Error: failed to fetch updates for ${INSTALL_DIR}; your checkout was left untouched." >&2
      exit 1
    fi
    # Fast-forward-only equivalent: refuse when live HEAD has diverged from
    # the remote tip (local commits ahead would be destroyed by the swap).
    # Never ancestor-check against the staging clone: `git clone --depth 1`
    # has no history of live HEAD, so that check would refuse every update.
    if ! git -C "${INSTALL_DIR}" merge-base --is-ancestor HEAD FETCH_HEAD 2>/dev/null; then
      echo "Error: ${INSTALL_DIR} has local commits; your checkout was left untouched. Move or remove it and re-run the installer." >&2
      exit 1
    fi
  elif [[ -e "${INSTALL_DIR}" && -n "$(ls -A "${INSTALL_DIR}" 2>/dev/null)" ]]; then
    # A release install has no .git: its marker and package name are what make
    # it ours to replace.
    if [[ -f "${INSTALL_DIR}/${OWNERSHIP_MARKER}" ]] && is_aiand_cli_package "${INSTALL_DIR}/package.json"; then
      return 0
    fi
    # A pre-existing non-empty directory (e.g. AIAND_DIR=~) must fail safely
    # instead of being wiped — even when it looks like an aiand checkout.
    if is_aiand_cli_package "${INSTALL_DIR}/package.json"; then
      echo "Error: ${INSTALL_DIR} already exists; your checkout was left untouched. Move or remove it and re-run the installer to reinstall from scratch." >&2
    else
      echo "Error: ${INSTALL_DIR} is not an aiand checkout; cloning into it failed safely" >&2
    fi
    exit 1
  fi
}

# Stage 3, clone path (development only): verify the live INSTALL_DIR may be
# replaced, then clone SOURCE into a staging sibling. Sets STAGING_DIR on
# success; any failure exits 1 with the old install untouched.
clone_to_staging() {
  if ! is_allowlisted_source "${SOURCE}"; then
    echo "error: AIAND_SOURCE is not an allowlisted https://github.com/aiandlabs/aiand-cli URL" >&2
    exit 1
  fi
  check_install_dir_replaceable clone

  mkdir -p "$(dirname "${INSTALL_DIR}")"
  STAGING_DIR="$(mktemp -d "$(dirname "${INSTALL_DIR}")/.cli-staging-$$-XXXXXX")"
  # AIAND_BRANCH picks a non-default branch from the same allowlisted source
  # (the side-by-side preview builds its own branch). Both invocations end
  # their options with `--`: SOURCE is user text, and a leading dash would
  # otherwise reach git as an option.
  if [[ -n "${AIAND_BRANCH:-}" ]]; then
    if ! git clone --quiet --depth 1 --branch "${AIAND_BRANCH}" -- "${SOURCE}" "${STAGING_DIR}"; then
      echo "error: failed to clone ${AIAND_BRANCH} from ${SOURCE}; the existing installation was left unchanged." >&2
      exit 1
    fi
  elif ! git clone --quiet --depth 1 -- "${SOURCE}" "${STAGING_DIR}"; then
    echo "error: failed to clone ${SOURCE}; the existing installation was left unchanged." >&2
    exit 1
  fi
  mark_installer_owned "${STAGING_DIR}"
  # Announce the source: this path otherwise prints only the stage line, and a
  # side-by-side install must say which fork's branch it built.
  log "Using source from ${SOURCE}"
}

# The release helper, run by Node. install.ps1 embeds the same text between
# the same markers; scripts/install-behavior.mjs asserts they match.
write_release_helper() {
  cat >"$1" <<'AIAND_RELEASE_HELPER'
// aiand release fetch: install.sh and install.ps1 embed this file verbatim.
// Resolves the release, downloads the npm tarball, checks it against npm's
// sha512 and the GitHub release's SHA256SUMS, and unpacks it into outDir.
// Usage: node fetch-release.cjs <releases-url> <npm-registry> <out-dir> [version] [--installed=<version>]
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const DEFAULT_RELEASES = "https://github.com/aiandlabs/aiand-cli/releases";
const DEFAULT_REGISTRY = "https://registry.npmjs.org";
// Overrides exist for the installer tests' loopback double, never a mirror.
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
// Size limits, checked while the body streams so an oversized one is stopped at
// the limit instead of after it has all been downloaded. A release tarball is
// a few hundred KiB, so each limit is far above anything real.
const MIB = 1024 * 1024;
const MAX_METADATA_BYTES = 4 * MIB; // SHA256SUMS and npm's version manifest
const MAX_TARBALL_BYTES = 16 * MIB; // the compressed npm tarball
const MAX_UNPACKED_BYTES = 64 * MIB; // what it may unpack to
// The first release published with a SHA256SUMS. A SHA256SUMS naming anything
// older was not made by the release process, so no install is steered to an
// older version through it.
const FIRST_SUMS_RELEASE = "0.8.0";

// Tar entry names, npm manifest fields and URLs are server text: drop terminal
// escape sequences and any other control character before they reach a terminal.
const CONTROL =
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[[0-?]*[ -\/]*[@-~]?|\x1b[PX^_][^\x1b]*(?:\x1b\\)?|\x1b.?|[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;
function fail(message) {
  process.stderr.write(`error: ${String(message).replace(CONTROL, " ")}\n`);
  process.exit(1);
}

const [releasesArg = "", registryArg = "", outDir = "", ...rest] = process.argv.slice(2);
let pinned = "";
let installed = "";
for (const arg of rest) {
  if (arg.startsWith("--installed=")) installed = arg.slice("--installed=".length);
  else pinned = arg;
}
const releases = releasesArg.replace(/\/+$/, "");
const registry = registryArg.replace(/\/+$/, "");
for (const [label, value, fallback] of [
  ["release URL", releases, DEFAULT_RELEASES],
  ["npm registry", registry, DEFAULT_REGISTRY],
]) {
  if (value !== fallback && !LOOPBACK.test(value)) {
    fail(`the ${label} ${value} is not allowed; only ${fallback} (or a loopback test double) is`);
  }
}
if (!outDir || !fs.statSync(outDir, { throwIfNoEntry: false })?.isDirectory()) {
  fail(`staging directory ${outDir} does not exist`);
}
if (pinned && !VERSION.test(pinned)) fail(`AIAND_VERSION=${pinned} is not a version like 1.2.3`);

// Semver precedence for the versions VERSION accepts: numeric core first, a
// prerelease below its release, prerelease identifiers left to right.
function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v);
    return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (x.pre.length === 0 || y.pre.length === 0) return Math.sign(y.pre.length - x.pre.length);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pNum = /^\d+$/.test(p);
    const qNum = /^\d+$/.test(q);
    if (pNum && qNum) {
      if (Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1;
    } else if (pNum !== qNum) {
      return pNum ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}
function refuseBelowFloor(version, where) {
  if (compareVersions(version, FIRST_SUMS_RELEASE) < 0) {
    fail(`${where} names @aiand/cli ${version}, older than ${FIRST_SUMS_RELEASE}, the first release published with a SHA256SUMS. Releases before it cannot be verified, so the installer refuses them; install @aiand/cli ${FIRST_SUMS_RELEASE} or newer.`);
  }
}
if (pinned) refuseBelowFloor(pinned, "AIAND_VERSION");

function tooLarge(url, limit) {
  fail(`${url} is larger than ${limit / MIB} MiB, which no @aiand/cli release is; stopped downloading it and installed nothing`);
}
async function get(url, limit) {
  let response;
  try {
    response = await fetch(url, {
      headers: { "user-agent": "aiand-installer" },
      signal: AbortSignal.timeout(120000),
    });
  } catch (error) {
    fail(`could not reach ${url}: ${error?.cause?.message ?? error?.message ?? error}`);
  }
  if (Number(response.headers.get("content-length") ?? 0) > limit) tooLarge(url, limit);
  const chunks = [];
  let received = 0;
  try {
    for await (const chunk of response.body ?? []) {
      received += chunk.length;
      if (received > limit) tooLarge(url, limit);
      chunks.push(chunk);
    }
  } catch (error) {
    fail(`could not finish downloading ${url}: ${error?.cause?.message ?? error?.message ?? error}`);
  }
  return { status: response.status, body: Buffer.concat(chunks) };
}

// npm tarballs are ustar, with pax or GNU long-name records for long paths.
// Only regular files and directories under package/ are accepted: a link,
// an absolute path, or a .. segment aborts the install.
function unpack(tar, destination) {
  const root = path.resolve(destination);
  let offset = 0;
  let longName = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, end) => {
      const raw = header.subarray(start, end);
      const nul = raw.indexOf(0);
      return raw.subarray(0, nul === -1 ? raw.length : nul).toString("utf8");
    };
    const size = Number.parseInt(field(124, 136).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) fail("the release tarball is corrupt");
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    const prefix = field(257, 262) === "ustar" ? field(345, 500) : "";
    let name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (body.length !== size) fail("the release tarball is truncated");
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"));
      longName = match ? match[1] : longName;
      continue;
    }
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    if (type === "g") continue;
    if (longName !== null) {
      name = longName;
      longName = null;
    }
    if (!name.startsWith("package/")) fail(`the release tarball holds ${name} outside package/`);
    const parts = name.slice("package/".length).split("/").filter((p) => p !== "" && p !== ".");
    if (parts.some((p) => p === ".." || p.includes("\\") || p.includes(":"))) {
      fail(`the release tarball holds an unsafe path: ${name}`);
    }
    if (parts.length === 0) continue;
    const target = path.join(root, ...parts);
    if (!target.startsWith(root + path.sep)) fail(`the release tarball holds an unsafe path: ${name}`);
    if (type === "5") {
      fs.mkdirSync(target, { recursive: true });
    } else if (type === "0" || type === "7") {
      const mode = Number.parseInt(field(100, 108).trim() || "644", 8) & 0o111 ? 0o755 : 0o644;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body, { mode, flag: "wx" });
    } else {
      fail(`the release tarball holds ${name} of type ${type}; only files and directories are allowed`);
    }
  }
}

// Best effort and never fatal: only used to explain an install that is behind npm.
async function latestOnNpm() {
  try {
    const response = await fetch(`${registry}/@aiand%2fcli/latest`, {
      headers: { "user-agent": "aiand-installer" },
      signal: AbortSignal.timeout(5000),
    });
    if (response.status !== 200) return "";
    const found = (await response.json())?.version;
    return typeof found === "string" && VERSION.test(found) ? found : "";
  } catch {
    return "";
  }
}

(async () => {
  const sumsUrl = pinned
    ? `${releases}/download/v${pinned}/SHA256SUMS`
    : `${releases}/latest/download/SHA256SUMS`;
  const sums = await get(sumsUrl, MAX_METADATA_BYTES);
  if (sums.status === 404) {
    fail(
      pinned
        ? `release v${pinned} was not found, or has no SHA256SUMS (${sumsUrl}). Pick a published release at ${DEFAULT_RELEASES}, or install from npm meanwhile: npm install -g @aiand/cli@${pinned}`
        : `no published release was found (${sumsUrl} returned 404). The installer installs released versions only, and a release carries a SHA256SUMS only from 0.8.0 on. Until one is out, install from npm instead: npm install -g @aiand/cli`,
    );
  }
  if (sums.status === 403 || sums.status === 429) {
    fail(`GitHub refused ${sumsUrl} (HTTP ${sums.status}, likely a rate limit). Wait a few minutes and run the installer again.`);
  }
  if (sums.status !== 200) fail(`${sumsUrl} returned HTTP ${sums.status}`);
  const listed = [];
  for (const line of sums.body.toString("utf8").split(/\r?\n/)) {
    const match = /^([0-9a-f]{64}) [ *]aiand-cli-(\S+)\.tgz$/.exec(line.trim());
    if (match) listed.push({ sha256: match[1], version: match[2] });
  }
  if (listed.length !== 1) {
    fail(`${sumsUrl} must list exactly one aiand-cli-<version>.tgz; it lists ${listed.length}`);
  }
  const { sha256, version } = listed[0];
  if (!VERSION.test(version)) fail(`${sumsUrl} names an invalid version ${version}`);
  if (pinned && version !== pinned) fail(`${sumsUrl} lists aiand-cli-${version}.tgz, not ${pinned}`);
  refuseBelowFloor(version, sumsUrl);
  // Installing an older release than the one in place is a downgrade: allowed
  // only when AIAND_VERSION names it, never because a SHA256SUMS says so.
  if (!pinned && VERSION.test(installed) && compareVersions(version, installed) < 0) {
    fail(`the latest release is ${version}, older than the installed ${installed}. Refusing to downgrade; set AIAND_VERSION=${version} to install it on purpose.`);
  }

  const metaUrl = `${registry}/@aiand%2fcli/${version}`;
  const meta = await get(metaUrl, MAX_METADATA_BYTES);
  if (meta.status === 404) fail(`@aiand/cli@${version} is not on the npm registry (${metaUrl})`);
  if (meta.status !== 200) fail(`${metaUrl} returned HTTP ${meta.status}`);
  let manifest;
  try {
    manifest = JSON.parse(meta.body.toString("utf8"));
  } catch {
    fail(`${metaUrl} did not return JSON`);
  }
  if (manifest?.name !== "@aiand/cli" || manifest?.version !== version) {
    fail(`${metaUrl} describes ${manifest?.name}@${manifest?.version}, not @aiand/cli@${version}`);
  }
  const tarballUrl = `${registry}/@aiand/cli/-/cli-${version}.tgz`;
  if (manifest.dist?.tarball !== tarballUrl) {
    fail(`npm lists the tarball at ${manifest.dist?.tarball}, not ${tarballUrl}`);
  }
  const integrity = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(String(manifest.dist?.integrity ?? ""));
  if (!integrity) fail(`npm lists no sha512 integrity for @aiand/cli@${version}`);

  const tarball = await get(tarballUrl, MAX_TARBALL_BYTES);
  if (tarball.status !== 200) fail(`${tarballUrl} returned HTTP ${tarball.status}`);
  const sha512 = crypto.createHash("sha512").update(tarball.body).digest("base64");
  if (sha512 !== integrity[1]) {
    fail(`integrity check failed: the tarball does not match npm's sha512 for @aiand/cli@${version}`);
  }
  const actual256 = crypto.createHash("sha256").update(tarball.body).digest("hex");
  if (actual256 !== sha256) {
    fail(`integrity check failed: the tarball does not match the sha256 in the v${version} release's SHA256SUMS`);
  }
  let tar;
  try {
    tar = zlib.gunzipSync(tarball.body, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch (error) {
    fail(error?.code === "ERR_BUFFER_TOO_LARGE" ? `the release tarball unpacks to more than ${MAX_UNPACKED_BYTES / MIB} MiB, which no @aiand/cli release does` : "the release tarball is corrupt");
  }
  unpack(tar, outDir);
  // The update notice reads npm's latest dist-tag, this installer the latest
  // GitHub release. While npm is ahead (publish done, release not out yet) an
  // update would look like a no-op that the notice contradicts; say why.
  if (!pinned) {
    const npmLatest = await latestOnNpm();
    if (npmLatest && compareVersions(npmLatest, version) > 0) {
      process.stderr.write(`note: ${installed === version ? `already up to date at ${version}; ` : ""}npm shows @aiand/cli ${npmLatest}, but its GitHub release is not out yet, so this installs ${version}. Run the update again once the release is published.\n`);
    }
  }
  process.stdout.write(`${version}\n`);
})().catch((error) => fail(error?.message ?? String(error)));
AIAND_RELEASE_HELPER
}

# The first "version" key, or nothing. Bash, not node: verify already spawns
# node to run the CLI, and this read happens again for the installed copy.
# Leftmost match, so a one-line package.json whose later object also has
# "version" cannot win. A missing file is empty, not a failed install.
package_json_version() {
  local line
  [[ -f "${1:-}" ]] || return 0
  while IFS= read -r line || [[ -n "${line}" ]]; do
    if [[ "${line}" =~ \"version\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]]; then
      printf '%s\n' "${BASH_REMATCH[1]}"
      return 0
    fi
  done < "$1"
  return 0
}

# The version of the aiand install at INSTALL_DIR, or nothing when there is
# none. The release helper refuses to go below it unless AIAND_VERSION says so.
installed_version() {
  local pkg="${INSTALL_DIR}/package.json"
  is_aiand_cli_package "${pkg}" || return 0
  package_json_version "${pkg}"
}

# Stage 3, release path: resolve the release, then download, verify, and
# unpack it into a staging sibling. Sets STAGING_DIR and RELEASE_VERSION;
# any failure exits 1 with the old install untouched.
RELEASE_VERSION=""
fetch_release_to_staging() {
  check_install_dir_replaceable release
  mkdir -p "$(dirname "${INSTALL_DIR}")"
  STAGING_DIR="$(mktemp -d "$(dirname "${INSTALL_DIR}")/.cli-staging-$$-XXXXXX")"
  DOWNLOAD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aiand-release-XXXXXX")"
  write_release_helper "${DOWNLOAD_DIR}/fetch-release.cjs"
  local args=("${RELEASES_URL}" "${NPM_REGISTRY}" "${STAGING_DIR}")
  if [[ -n "${AIAND_VERSION:-}" ]]; then
    args+=("${AIAND_VERSION}")
  fi
  local installed
  installed="$(installed_version)"
  if [[ -n "${installed}" ]]; then
    args+=("--installed=${installed}")
  fi
  if ! RELEASE_VERSION="$(node "${DOWNLOAD_DIR}/fetch-release.cjs" "${args[@]}")" || [[ -z "${RELEASE_VERSION}" ]]; then
    echo "error: no verified release was installed; the existing installation was left unchanged." >&2
    exit 1
  fi
  if ! is_aiand_cli_package "${STAGING_DIR}/package.json"; then
    echo "error: the v${RELEASE_VERSION} tarball is not @aiand/cli; the existing installation was left unchanged." >&2
    exit 1
  fi
  log "Verified @aiand/cli ${RELEASE_VERSION} against npm's sha512 and the release's SHA256SUMS"
  mark_installer_owned "${STAGING_DIR}"
}

# Stage 5, clone path: swap the staged checkout in for INSTALL_DIR. Runs only
# after the staged build verified; on any failure the previous install is
# restored. Clears STAGING_DIR on success so the EXIT trap is a no-op.
activate_staged_install() {
  local staging_dir="$1" previous
  if [[ -e "${INSTALL_DIR}" ]]; then
    previous="${INSTALL_DIR}.prev-$$"
    if [[ -e "${previous}" ]]; then
      previous="${previous}-$(date +%s)-${RANDOM:-0}"
    fi
    SWAP_PREVIOUS="${previous}"
    if ! mv "${INSTALL_DIR}" "${previous}"; then
      SWAP_PREVIOUS=""
      echo "error: staged aiand verification failed; the existing installation was left unchanged." >&2
      exit 1
    fi
    if ! mv "${staging_dir}" "${INSTALL_DIR}"; then
      if ! mv "${previous}" "${INSTALL_DIR}"; then
        echo "error: staged swap failed; previous install is at ${previous}" >&2
        exit 1
      fi
      SWAP_PREVIOUS=""
      echo "error: staged aiand verification failed; the existing installation was left unchanged." >&2
      exit 1
    fi
    SWAP_PREVIOUS=""
    rm -rf -- "${previous}"
  else
    if ! mv "${staging_dir}" "${INSTALL_DIR}"; then
      echo "error: staged aiand verification failed; the existing installation was left unchanged." >&2
      exit 1
    fi
  fi
  STAGING_DIR=""
}

# The pid a run put in the name of a folder it made ($1 is the name, $2 what
# precedes the pid), or nothing for a name from before they carried one. The
# pid is the digits that follow, alone (`cli.prev-1234`) or before a `-` and
# more (`.cli-staging-1234-abcdef`, `cli.prev-1234-1700000000-42`).
leftover_pid() {
  local rest="${1#"$2"}"
  if [[ "${rest}" =~ ^([0-9]+)(-.*)?$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
  return 0
}

# True when the installer that made folder $1 (the pid in its name; $2 is what
# precedes it) is still running.
leftover_in_use() {
  local pid
  pid="$(leftover_pid "${1##*/}" "$2")"
  [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null
}

# A run that was killed (SIGKILL, power loss) between the two moves of the swap
# leaves the previous install beside a missing INSTALL_DIR, and the trap never
# ran. Put it back before anything else happens, so `aiand` works again even if
# this run goes on to fail.
recover_interrupted_swap() {
  [[ -e "${INSTALL_DIR}" || -L "${INSTALL_DIR}" ]] && return 0
  local candidate newest=""
  for candidate in "${INSTALL_DIR}".prev-*; do
    [[ -d "${candidate}" && ! -L "${candidate}" ]] || continue
    is_aiand_cli_package "${candidate}/package.json" || continue
    # Another installer is between the two moves of its swap: this is its
    # install, and putting it back would make its second move nest the new one
    # inside it.
    leftover_in_use "${candidate}" "${INSTALL_DIR##*/}.prev-" && continue
    if [[ -z "${newest}" || "${candidate}" -nt "${newest}" ]]; then
      newest="${candidate}"
    fi
  done
  [[ -n "${newest}" ]] || return 0
  if mv -- "${newest}" "${INSTALL_DIR}"; then
    log "Put back the previous installation from ${newest}, which an interrupted update had set aside"
  else
    echo "error: could not put back the previous installation from ${newest}" >&2
    exit 1
  fi
}

# Remove what an earlier run left next to INSTALL_DIR: staging folders, and the
# previous install of a swap that did finish (INSTALL_DIR is back by now).
# Only real folders that are the installer's own are touched: a staging folder
# holds nothing that is not an @aiand/cli package, a previous install is one.
# A folder a still-running installer is using (its pid is in the name) is left.
remove_install_leftovers() {
  local candidate name pid
  local base="${INSTALL_DIR##*/}"
  if [[ -e "${INSTALL_DIR}" ]]; then
    for candidate in "${INSTALL_DIR}".prev-*; do
      [[ -d "${candidate}" && ! -L "${candidate}" ]] || continue
      is_aiand_cli_package "${candidate}/package.json" || continue
      pid="$(leftover_pid "${candidate##*/}" "${base}.prev-")"
      remove_leftover "${candidate}" "${pid}"
    done
  fi
  for candidate in "$(dirname "${INSTALL_DIR}")"/.cli-staging-*; do
    [[ -d "${candidate}" && ! -L "${candidate}" ]] || continue
    if [[ -f "${candidate}/package.json" ]] && ! is_aiand_cli_package "${candidate}/package.json"; then
      continue
    fi
    name="${candidate##*/}"
    pid="$(leftover_pid "${name}" ".cli-staging-")"
    remove_leftover "${candidate}" "${pid}"
  done
}

# Remove folder $1 unless the process $2 (when there is one) is still running.
remove_leftover() {
  if [[ -n "${2}" ]] && kill -0 "${2}" 2>/dev/null; then
    return 0
  fi
  if rm -rf -- "${1}"; then
    log "Removed ${1}, left behind by an interrupted install"
  fi
}

# Run the built CLI's entry point the way the launcher will, before any
# launcher is written: the reported version must equal the staged
# package.json version (and the release's, when $2 names one) and --help
# must exit 0.
verify_built_cli() {
  local source_dir="$1" want="${2:-}" node_bin expected actual
  node_bin="$(command -v node)"
  expected="$(package_json_version "${source_dir}/package.json")"
  if [[ -z "${expected}" || ( -n "${want}" && "${expected}" != "${want}" ) ]]; then
    echo "error: staged aiand verification failed; the existing installation was left unchanged." >&2
    exit 1
  fi
  actual="$("${node_bin}" --disable-warning=ExperimentalWarning "${source_dir}/dist/index.js" --version 2>/dev/null || true)"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "error: staged aiand verification failed; the existing installation was left unchanged." >&2
    exit 1
  fi
  if ! "${node_bin}" --disable-warning=ExperimentalWarning "${source_dir}/dist/index.js" --help >/dev/null 2>&1; then
    echo "error: staged aiand verification failed; the existing installation was left unchanged." >&2
    exit 1
  fi
}

ensure_build() {
  local source_dir="$1"
  if [[ "${AIAND_SKIP_BUILD:-}" == "1" && -f "${source_dir}/dist/index.js" ]]; then
    return
  fi
  log "Building aiand..."
  local npm_loglevel=error
  if [[ "${AIAND_INSTALL_VERBOSE:-}" == "1" ]]; then
    npm_loglevel=notice
  fi
  # --omit=dev would drop the TypeScript compiler the build needs; the CLI
  # itself ships zero runtime dependencies, so node_modules never runs.
  # --prefer-offline reuses the npm cache on a re-run and still hits the
  # network when a package is missing.
  if ! (cd "${source_dir}" && npm ci --ignore-scripts --no-fund --no-audit --prefer-offline --loglevel="${npm_loglevel}"); then
    echo "error: staged aiand verification failed; the existing installation was left unchanged." >&2
    exit 1
  fi
  if ! (cd "${source_dir}" && npm run build --loglevel="${npm_loglevel}" >/dev/null); then
    echo "error: staged aiand verification failed; the existing installation was left unchanged." >&2
    exit 1
  fi
  if [[ ! -f "${source_dir}/dist/index.js" ]]; then
    echo "error: staged aiand verification failed; the existing installation was left unchanged." >&2
    exit 1
  fi
}

add_bin_dir_to_path() {
  local bin_dir="${HOME}/.local/bin"
  local path_entry="export PATH=\"${bin_dir}:\$PATH\""
  local shell_config=""

  export PATH="${bin_dir}:${PATH}"

  if [[ -n "${AIAND_NO_MODIFY_PATH:-}" ]]; then
    log "Skipping persistent PATH update (AIAND_NO_MODIFY_PATH is set)"
    return
  fi

  # Branch on the user's login shell ($SHELL), not the shell running this
  # script (always bash), or fish/nushell users get a ~/.bashrc edit their
  # shell never reads plus a note that cannot work.
  case "${SHELL:-}" in
    *fish*)
      install_note "fish detected: run 'fish_add_path ${bin_dir}' so ${INSTALL_NAME} stays on PATH."
      return
      ;;
    *nushell*|*/nu|nu)
      install_note "nushell detected: append '${bin_dir}' to \$env.PATH in your config.nu (open it with 'config nu') so ${INSTALL_NAME} stays on PATH."
      return
      ;;
  esac

  case "${SHELL:-}" in
    *zsh) shell_config="${HOME}/.zshrc" ;;
    *bash | "")
      # An unset SHELL defaults to bash, the shell running this script.
      if [[ "$(uname -s)" == "Darwin" ]]; then
        shell_config="${HOME}/.bash_profile"
      else
        shell_config="${HOME}/.bashrc"
      fi
      ;;
    *)
      install_note "Add ${bin_dir} to PATH in your shell's startup file so ${INSTALL_NAME} stays on PATH."
      return
      ;;
  esac

  if [[ -n "${shell_config}" ]]; then
    touch "${shell_config}"
    if ! grep -qxF "${path_entry}" "${shell_config}" 2>/dev/null; then
      echo "${path_entry}" >>"${shell_config}"
      install_note "Added ${bin_dir} to PATH in ${shell_config} (open a new terminal if ${INSTALL_NAME} is not found)."
    fi
  fi
}

# Identity knobs baked into the launcher, so a side-by-side install keeps
# updating, uninstalling, and wiring agents as itself instead of drifting
# onto production aiand's paths (`aiand-v2 update` reruns its checkout's
# install.sh with these in the environment). Only knobs actually set are
# baked: a production install that did not set them keeps the launcher main
# writes.
bake_launcher_env() {
  local var value preview=1
  for var in AIAND_SOURCE AIAND_BRANCH AIAND_DIR AIAND_CONFIG_DIR AIAND_INSTALL_NAME; do
    value="${!var:-}"
    [[ -n "${value}" ]] || continue
    # %q makes the value safe to re-read in the launcher whatever it holds
    # (spaces, quotes, a trailing backslash from a native Windows path).
    printf 'export %s=%q\n' "${var}" "${value}"
  done
  # Pin the mode this launcher was installed in, so an update rerun cannot
  # drift onto the other install's paths when the switch is not in the
  # environment it was started from.
  [[ "${AIAND_V2_SIDEBYSIDE:-1}" == "0" ]] && preview=0
  printf 'export AIAND_V2_SIDEBYSIDE="%s"\n' "${preview}"
  # The command name the CLI writes into agent configs (codex profiles,
  # provider keys, managedBy markers): baked only when it is not the default,
  # keeping the production launcher byte-identical.
  if [[ "${INSTALL_NAME}" != "aiand" ]]; then
    printf 'export AIAND_COMMAND_NAME="%s"\n' "${INSTALL_NAME}"
  fi
}

install_cli_launcher() {
  local source_dir="$1"
  local bin_dir="${HOME}/.local/bin"
  local launcher_path="${bin_dir}/${INSTALL_NAME}"
  local shadow=""

  refuse_foreign_launcher "${launcher_path}"
  # Snapshot before add_bin_dir_to_path prepends bin_dir: another launcher
  # earlier on PATH keeps shadowing the new one in this shell.
  shadow="$(command -v "${INSTALL_NAME}" 2>/dev/null || true)"

  mkdir -p "${bin_dir}"

  # Resolve an absolute Node path at install time and bake it into the launcher,
  # with a PATH fallback. This keeps the launcher working in non-interactive
  # shells where `node` is not on PATH — common in sandboxes and CI.
  local node_bin
  node_bin="$(command -v node 2>/dev/null || true)"

  cat >"${launcher_path}" <<EOF
#!/usr/bin/env bash
# ${LAUNCHER_HEADER}. Uses the Node binary discovered at install time, falling
# back to PATH lookup, so ${INSTALL_NAME} works without \`node\` on PATH.
NODE_BIN="\${AIAND_NODE_BIN:-${node_bin}}"
if ! [ -x "\$NODE_BIN" ]; then
  NODE_BIN="\$(command -v node 2>/dev/null)"
  # A relative hit came from an empty or "." PATH entry: the current directory.
  case "\$NODE_BIN" in /*) ;; *) NODE_BIN="" ;; esac
fi
if [ -z "\$NODE_BIN" ] || ! [ -x "\$NODE_BIN" ]; then
  echo "${INSTALL_NAME}: Node.js was not found. Install Node ${MIN_NODE_VERSION}+ and re-run the aiand installer." >&2
  exit 1
fi
$(bake_launcher_env)
# --disable-warning keeps node's ExperimentalWarning off aiand's stderr; the
# flag exists since Node 21.3 and this installer requires ${MIN_NODE_MAJOR}+.
exec "\$NODE_BIN" --disable-warning=ExperimentalWarning "${source_dir}/dist/index.js" "\$@"
EOF
  chmod +x "${launcher_path}"

  add_bin_dir_to_path

  if [[ -n "${shadow}" && "${shadow}" != "${launcher_path}" ]]; then
    install_note "Another ${INSTALL_NAME} at ${shadow} shadows the new launcher in this shell (open a new terminal if ${INSTALL_NAME} is not found)."
  fi
}
# Run the freshly written launcher, not dist/ directly: this is the command
# the user will type, so it proves the launcher itself works.
show_installed_version() {
  local launcher="$1" version
  if ! version="$("${launcher}" --version 2>/dev/null)" || [[ -z "${version}" ]]; then
    echo "error: ${launcher} --version failed after install." >&2
    exit 1
  fi
  log "Installed ${INSTALL_NAME} ${version} (${launcher})"
}

# True iff a person is at a terminal we can both write to and read from. Under
# `curl | bash` stdin is the script, so answers come from /dev/tty; opening it
# (not just -r) fails when there is no controlling terminal (CI, sandboxes).
can_prompt() {
  [[ -t 1 && -t 2 && -z "${CI:-}" ]] || return 1
  { : </dev/tty; } 2>/dev/null
}

# Offer the next step instead of printing it. Never fails the install: the CLI
# is already in place, and `${INSTALL_NAME} login` can always be run later.
offer_login() {
  local launcher="$1" answer
  # `login` stores nothing while the environment key is the session.
  if [[ -n "${AIAND_API_KEY:-}" ]]; then
    log "Done. Using the key in AIAND_API_KEY."
    return
  fi
  if ! can_prompt; then
    log "Done. Run '${INSTALL_NAME} login' to sign in."
    return
  fi
  # --local reads the stored session without a network call.
  if "${launcher}" whoami --local >/dev/null 2>&1 </dev/null; then
    log "Done. You are already signed in."
    return
  fi
  # Ctrl+C here cancels the question or the login, not the finished install.
  # A no-op trap (not '') leaves children at the default SIGINT, so login
  # still stops. bash 3.2 restarts `read` after a trap, so the question runs
  # in a subshell, which resets the trap and dies on Ctrl+C.
  trap ':' INT
  if ! answer="$(read -r -p "Log in to ai& now? [Y/n] " reply </dev/tty && printf '%s' "${reply}")"; then
    answer="n"
    printf '\n' >&2
  fi
  if [[ -n "${answer}" && ! "${answer}" =~ ^[Yy]([Ee][Ss])?$ ]]; then
    log "Done. Run '${INSTALL_NAME} login' when you are ready."
  elif "${launcher}" login </dev/tty; then
    log "Done."
  else
    log "Login did not finish. Run '${INSTALL_NAME} login' to try again."
  fi
  trap 'exit 130' INT
}

# Resolve a user-controlled path for rm -rf: canonical when it (or its
# parent) exists, else as spelled. Prints the result.
canonical_target() {
  local orig="$1" parent
  if ! (cd "${orig}" 2>/dev/null && pwd -P); then
    if parent="$(cd "$(dirname "${orig}")" 2>/dev/null && pwd -P)"; then
      printf '%s\n' "${parent}/$(basename "${orig}")"
    else
      printf '%s\n' "${orig}"
    fi
  fi
}

# Run the installed launcher (the Git Bash shim, or aiand.cmd via cmd.exe).
run_launcher() {
  local launcher="$1"
  shift
  if [[ "${launcher}" == *.cmd ]] && command -v cmd.exe >/dev/null 2>&1; then
    cmd.exe //c "${launcher}" "$@"
  else
    "${launcher}" "$@"
  fi
}

# Reads one `aiand logout --json` result (one profile) or `logout --all
# --json` result (a `profiles` array) on stdin and prints each profile whose
# minted key is not confirmed revoked. Pasted keys are not ours to revoke,
# and a profile that was not signed in has nothing to revoke. Anything it
# cannot read counts as unconfirmed, so the caller fails closed: exit 2 for
# text that is not a result; a `complete: false` carrying `problems` (the CLI
# could not read credentials, so its rows are not the whole story); and an
# empty `profiles` list while AIAND_PURGE_NAMES (the profile names
# credentials.json listed before sign-out, one per line) names some, which are
# then printed as unrevoked.
unrevoked_profiles() {
  node -e '
    let text = "";
    process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
      let doc;
      try { doc = JSON.parse(text); } catch { process.exit(2); }
      if (doc === null || typeof doc !== "object") process.exit(2);
      const show = (name) => String(name).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
      const all = Array.isArray(doc.profiles);
      const rows = all ? doc.profiles : [doc];
      if (doc.complete === false && Array.isArray(doc.problems) && doc.problems.length > 0) {
        console.log("(credentials logout --all could not read)");
      }
      const listed = (process.env.AIAND_PURGE_NAMES || "").split("\n").filter(Boolean);
      if (all && rows.length === 0) for (const name of listed) console.log(show(name));
      for (const row of rows) {
        if (row === null || typeof row !== "object") process.exit(2);
        if (row.signed_in === false || row.source === "pasted-key" || row.revoked === true) continue;
        console.log(typeof row.profile === "string" ? show(row.profile) : "?");
      }
    });
  ' 2>/dev/null
}

# Prints the profile names credentials.json (in $1) lists, one per line: none
# when the file is absent, exit 2 when it exists but cannot be read, which the
# caller treats as "cannot prove nothing is signed in".
purge_credential_names() {
  node -e '
    const fs = require("node:fs");
    let text;
    try { text = fs.readFileSync(process.argv[1], "utf8"); } catch (e) { process.exit(e.code === "ENOENT" ? 0 : 2); }
    let doc;
    try { doc = JSON.parse(text); } catch { process.exit(2); }
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) process.exit(2);
    for (const name of Object.keys(doc)) console.log(name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?"));
  ' "$1" 2>/dev/null
}

# Reads a `logout --all --json` result on stdin and prints what it says it left
# on this machine, one `kind<TAB>value` line each: `key` (a file still holding
# an ai& key), `kept` and `left` (what it kept or did not recognise in the
# config directory), `problem`. Control characters are replaced, since the
# strings can carry text from files and errors.
logout_leftovers() {
  node -e '
    let text = "";
    process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
      let doc;
      try { doc = JSON.parse(text); } catch { process.exit(0); }
      if (doc === null || typeof doc !== "object") process.exit(0);
      const show = (value) => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
      const list = (value) => (Array.isArray(value) ? value : []);
      for (const file of list(doc.keys_left_on_disk)) console.log("key\t" + show(file));
      const dir = doc.config_dir && typeof doc.config_dir === "object" ? doc.config_dir : {};
      for (const name of list(dir.kept)) console.log("kept\t" + show(name));
      for (const name of list(dir.left)) console.log("left\t" + show(name));
      for (const problem of list(doc.problems)) console.log("problem\t" + show(problem));
    });
  ' 2>/dev/null
}

# What `logout --all` left, from `logout_leftovers` lines in $1, printed where
# it cannot be missed. Nothing when it left nothing.
print_purge_leftovers() {
  local lines="$1" kind value
  [[ -n "${lines}" ]] || return 0
  {
    echo ""
    echo "!! ${INSTALL_NAME} logout --all did not finish cleaning up. What it left:"
    while IFS=$'\t' read -r kind value; do
      case "${kind}" in
        key) echo "!!   An ai& key is still in ${value}. Open that file and delete the key by hand." ;;
        kept) echo "!!   Kept ${value} in the config directory: it still wires ai& into an agent, or is the sign-in a failed revoke needs." ;;
        left) echo "!!   ${value} in the config directory is not aiand's, so it was left." ;;
        problem) echo "!!   ${value}" ;;
      esac
    done <<<"${lines}"
    echo ""
  } >&2
}

# --purge: sign every profile out through the installed CLI, with stdin closed
# so it revokes without asking. A CLI that exits 0 after a failed revoke (older
# ones) would let the purge delete the only credential that can revoke the key,
# so the verdict comes from the JSON each CLI emits, not the exit code: every
# minted key must report revoked, or the purge deletes nothing. `logout --all`
# also strips every agent and deletes snapshots, overlays and the config
# directory (keeping a profile whose revoke failed), and refuses to run
# unconfirmed off a terminal, so it gets --force: --purge is the confirmation.
# It exits non-zero when it left something behind (a kept snapshot, a key still
# in an agent's file): PURGE_ALL_EXIT carries that and PURGE_LEFTOVERS what it
# reported, so the caller deletes no further than it kept. An older CLI gets
# `logout --profile` per profile and the caller deletes the directory.
PURGE_ALL_EXIT=0
PURGE_LEFTOVERS=""
purge_sign_out() {
  local launcher="$1" config_dir="$2" help profiles line name result unrevoked listed status failed=0 bad=() seen=" "
  if ! command -v node >/dev/null 2>&1; then
    echo "Error: node is needed to confirm that signing out revoked the keys." >&2
    return 1
  fi
  # Read before signing out: logout --all deletes the file, and a CLI that
  # could not read it reports no profiles at all, which must not pass for
  # "nothing was signed in".
  if ! listed="$(purge_credential_names "${config_dir}/credentials.json")"; then
    echo "Error: could not read ${config_dir}/credentials.json, so the installer cannot tell which keys need revoking." >&2
    return 1
  fi
  help="$(run_launcher "${launcher}" logout --help 2>/dev/null </dev/null || true)"
  if [[ "${help}" == *"--all"* ]]; then
    log "Signing out of every profile (${INSTALL_NAME} logout --all)..."
    status=0
    result="$(run_launcher "${launcher}" logout --all --force --json </dev/null)" || status=$?
    PURGE_ALL_EXIT="${status}"
    PURGE_LEFTOVERS="$(logout_leftovers <<<"${result}" || true)"
    if ! unrevoked="$(AIAND_PURGE_NAMES="${listed}" unrevoked_profiles <<<"${result}")"; then
      echo "Error: could not read the result of ${INSTALL_NAME} logout --all." >&2
      print_purge_leftovers "${PURGE_LEFTOVERS}"
      return 1
    fi
    if [[ -n "${unrevoked}" ]]; then
      echo "Error: could not revoke the keys of: ${unrevoked//$'\n'/, }." >&2
      print_purge_leftovers "${PURGE_LEFTOVERS}"
      return 1
    fi
    if ((status != 0)); then
      echo "Note: ${INSTALL_NAME} logout --all exited ${status} after revoking every key; what it left behind is listed at the end, and the config directory is kept." >&2
    fi
    return 0
  fi
  if ! profiles="$(run_launcher "${launcher}" config profiles --json 2>/dev/null </dev/null)"; then
    echo "Error: could not list profiles to sign out of." >&2
    return 1
  fi
  log "Signing out of every profile (${INSTALL_NAME} logout --profile …)..."
  while IFS= read -r line; do
    if [[ "${line}" =~ \"name\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
      name="${BASH_REMATCH[1]}"
      seen+="${name} "
      status=0
      result="$(run_launcher "${launcher}" logout --profile "${name}" --json </dev/null)" || status=$?
      if ((status != 0)) || ! unrevoked="$(unrevoked_profiles <<<"${result}")" || [[ -n "${unrevoked}" ]]; then
        bad+=("${name}")
        failed=1
      fi
    fi
  done <<<"${profiles}"
  # A sign-in credentials.json lists but the profile list did not is one this
  # loop never revoked.
  while IFS= read -r name; do
    if [[ -n "${name}" && "${seen}" != *" ${name} "* ]]; then
      bad+=("${name}")
      failed=1
    fi
  done <<<"${listed}"
  if ((failed)); then
    echo "Error: could not confirm that the key for ${bad[*]} was revoked." >&2
  fi
  return "${failed}"
}

uninstall_cli() {
  # See the header for the contract. --force skips the agent teardown for
  # broken installs where no working launcher remains.
  local force=0 purge=0 purge_incomplete=0 arg
  for arg in "$@"; do
    case "${arg}" in
      --force) force=1 ;;
      --purge) purge=1 ;;
      *)
        echo "Usage: bash install.sh [update | uninstall [--force] [--purge]]" >&2
        exit 1
        ;;
    esac
  done
  if [[ "${AIAND_UNINSTALL_FORCE:-}" == "1" ]]; then
    force=1
  fi

  local home_real launcher launcher_cmd working_launcher checkout checkout_orig checkout_parent off_ok kept_launcher kept_cmd config_dir config_exists config_name
  home_real="$(cd "${HOME}" 2>/dev/null && pwd -P || printf '%s' "${HOME}")"
  launcher="${home_real}/.local/bin/${INSTALL_NAME}"
  # install.ps1 writes <name>.cmd next to the Git Bash shim; uninstall must
  # remove both and may need the .cmd file for `init --off` when the shim
  # is missing or not executable.
  launcher_cmd="${home_real}/.local/bin/${INSTALL_NAME}.cmd"
  checkout="${AIAND_DIR:-${home_real}/.aiand/cli}"
  # AIAND_DIR is user-controlled: canonicalize before comparing ("$HOME/",
  # "$HOME//" and "//" name the same directories), then refuse HOME itself,
  # /, and anything outside HOME. Resolve against a saved copy so a failed
  # lookup never canonicalizes "" (i.e. "."). When neither the checkout nor
  # its parent exists there is nothing to delete (local-checkout installs),
  # so the original spelling is kept and uninstall still removes the launcher.
  checkout_orig="${checkout}"
  if ! checkout="$(cd "${checkout_orig}" 2>/dev/null && pwd -P)"; then
    if checkout_parent="$(cd "$(dirname "${checkout_orig}")" 2>/dev/null && pwd -P)"; then
      checkout="${checkout_parent}/$(basename "${checkout_orig}")"
    else
      checkout="${checkout_orig}"
    fi
  fi
  if [[ "${checkout}" == "/" || "${checkout}" == "${home_real}" || "${checkout}" == "${home_real}/" ]]; then
    echo "Error: refusing to remove ${checkout}; unset AIAND_DIR and re-run." >&2
    exit 1
  fi
  if [[ "${checkout}" != "${home_real}"/* ]]; then
    echo "Error: refusing to remove ${checkout}; it is outside ${home_real}." >&2
    exit 1
  fi

  # Same resolution as the CLI's configDir() (src/fsutil.ts). --purge deletes
  # it, so it gets the checkout's guard plus a name check, all before any
  # teardown: a refusal leaves everything in place.
  # A config directory that does not exist has nothing to delete and nothing
  # to canonicalize: guarding its spelling would refuse a HOME reached through
  # a symlink (HOME=/home/u -> /mnt/u) whose ~/.config/aiand was never made.
  config_dir="${AIAND_CONFIG_DIR:-${XDG_CONFIG_HOME:-${HOME}/.config}/aiand}"
  # The config directory is named after the install: production aiand keeps
  # `aiand`, the side-by-side preview keeps `aiand-v2`. --purge refuses any
  # other name, so AIAND_CONFIG_DIR=$HOME (or a parent) cannot be wiped.
  config_name="aiand"
  if [[ "${INSTALL_NAME}" != "aiand" ]]; then
    config_name="${INSTALL_NAME}"
  fi
  config_exists=0
  [[ -e "${config_dir}" ]] && config_exists=1
  if ((purge && config_exists)); then
    config_dir="$(canonical_target "${config_dir}")"
    if [[ "${config_dir}" == "/" || "${config_dir}" == "${home_real}" || "${config_dir}" == "${home_real}/" || "${config_dir}" != "${home_real}"/* ]]; then
      echo "Error: refusing to purge ${config_dir}; it is not strictly inside ${home_real}. Nothing was deleted." >&2
      exit 1
    fi
    if [[ "$(basename "${config_dir}")" != "${config_name}" ]]; then
      echo "Error: refusing to purge ${config_dir}; an ${INSTALL_NAME} config directory is named ${config_name}. Nothing was deleted; remove it yourself if you are sure." >&2
      exit 1
    fi
  fi

  # Ownership (is_installer_owned) is checked before any teardown or delete.
  if [[ -e "${checkout}" ]] && ! is_aiand_cli_package "${checkout}/package.json"; then
    echo "Error: ${checkout} is not an aiand checkout; it was left untouched. Remove it manually if you are sure." >&2
    exit 1
  fi
  if [[ -e "${checkout}" ]] && ! is_installer_owned "${checkout}"; then
    echo "Error: ${checkout} is not an installer-owned checkout; it was left untouched. Uninstall the installer's checkout (default ~/.aiand/cli) or remove ${checkout} manually." >&2
    exit 1
  fi

  if ((force == 0)); then
    if [[ -x "${launcher}" ]] && ! is_aiand_launcher "${launcher}"; then
      echo "Error: ${launcher} was not written by the aiand installer; refusing to run it. Move or remove it and re-run, or bypass agent teardown with --force (AIAND_UNINSTALL_FORCE=1). Nothing was deleted." >&2
      exit 1
    fi
    working_launcher=""
    if [[ -x "${launcher}" ]]; then
      working_launcher="${launcher}"
    elif [[ -f "${launcher_cmd}" ]]; then
      if ! is_aiand_launcher "${launcher_cmd}"; then
        echo "Error: ${launcher_cmd} was not written by the aiand installer; refusing to run it. Move or remove it and re-run, or bypass agent teardown with --force (AIAND_UNINSTALL_FORCE=1). Nothing was deleted." >&2
        exit 1
      fi
      working_launcher="${launcher_cmd}"
    fi
    if [[ -n "${working_launcher}" ]]; then
      log "Turning agents off..."
      off_ok=0
      if run_launcher "${working_launcher}" init --off; then
        off_ok=1
      fi
      if ((off_ok == 0)); then
        echo "Error: agent teardown failed; nothing was deleted. Fix the failure and re-run, or bypass it with --force (AIAND_UNINSTALL_FORCE=1)." >&2
        exit 1
      fi
      if ((purge)) && ! purge_sign_out "${working_launcher}" "${config_dir}"; then
        echo "Error: signing out did not revoke every key, so the installer deleted nothing. Fix the failure and re-run (a profile whose revoke failed is kept where the CLI can retry it), or skip sign-out with --force --purge; the keys are then not revoked, so revoke them at https://console.aiand.com/api-keys." >&2
        exit 1
      fi
    else
      echo "Error: no working ${INSTALL_NAME} launcher at ${launcher}; nothing was deleted. Re-run with --force to remove files without turning agents off." >&2
      exit 1
    fi
  fi


  kept_launcher=0
  if [[ -e "${launcher}" ]] && ! is_aiand_launcher "${launcher}"; then
    kept_launcher=1
  else
    rm -f "${launcher}"
  fi
  kept_cmd=0
  if [[ -e "${launcher_cmd}" ]] && ! is_aiand_launcher "${launcher_cmd}"; then
    kept_cmd=1
  else
    rm -f "${launcher_cmd}"
  fi
  if [[ -e "${checkout}" ]]; then
    rm -rf "${checkout}"
  fi
  rmdir "${HOME}/.aiand" 2>/dev/null || true
  if ((kept_launcher || kept_cmd)); then
    echo "Removed ${checkout}."
    if ((kept_launcher)); then
      echo "Kept foreign launcher ${launcher}; remove it manually if you are sure."
    fi
    if ((kept_cmd)); then
      echo "Kept foreign launcher ${launcher_cmd}; remove it manually if you are sure."
    fi
  else
    echo "Removed ${launcher} and ${checkout}."
  fi
  if ((purge)); then
    if ((config_exists)); then
      # A clean logout --all (or none, with --force) leaves the directory to
      # delete. One that exited non-zero kept things on purpose (a snapshot an
      # agent still needs, a sign-in a failed revoke needs), so only what it
      # removed or left empty goes.
      if ((PURGE_ALL_EXIT == 0)); then
        rm -rf -- "${config_dir}"
        echo "Removed profiles, credentials, and agent snapshots under ${config_dir}."
      elif [[ ! -e "${config_dir}" ]]; then
        echo "${INSTALL_NAME} logout --all already removed ${config_dir}."
      elif rmdir "${config_dir}" 2>/dev/null; then
        echo "Removed the emptied ${config_dir}."
      else
        purge_incomplete=1
        echo "Kept ${config_dir}: ${INSTALL_NAME} logout --all exited ${PURGE_ALL_EXIT} and left what is listed below in it. Nothing in it was deleted past what it removed."
      fi
    else
      echo "There was no config directory at ${config_dir}; nothing to purge there."
    fi
    if ((force)); then
      echo "Note: --force skipped sign-out, so keys this machine minted were not revoked and OS keychain entries may remain. Revoke them in the console."
    fi
    if [[ -n "${AIAND_API_KEY:-}" ]]; then
      echo "Note: AIAND_API_KEY is still set in this shell; unset it."
    fi
    if ((PURGE_ALL_EXIT != 0)); then
      print_purge_leftovers "${PURGE_LEFTOVERS}"
      if ((purge_incomplete)) || [[ -n "${PURGE_LEFTOVERS}" ]]; then
        echo "The purge is incomplete: the keys were revoked, but local data remains. Deal with what is listed above by hand." >&2
        exit 1
      fi
    fi
    return
  fi
  echo "Kept profiles, credentials, and agent snapshots under ${config_dir}."
}


main() {
  local update=0
  if [[ "${1:-}" == "uninstall" ]]; then
    shift
    uninstall_cli "$@"
    return
  fi
  if [[ "${1:-}" == "update" && $# -eq 1 ]]; then
    # The preview has no release lineage: its update re-fetches the baked
    # source and branch instead of putting production's release under the
    # preview's name. Production still takes the release path below.
    if [[ "${AIAND_V2_SIDEBYSIDE:-1}" == "0" ]]; then
      update=1
    fi
  elif [[ -n "${1:-}" ]]; then
    echo "Usage: bash install.sh [update | uninstall [--force] [--purge]]" >&2
    exit 1
  fi
  # This script's own install directory is the one to replace when it runs
  # from an install (the update notice runs it there), even a custom AIAND_DIR.
  if [[ -z "${AIAND_DIR:-}" && -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/${OWNERSHIP_MARKER}" ]] \
    && is_aiand_cli_package "${SCRIPT_DIR}/package.json"; then
    INSTALL_DIR="${SCRIPT_DIR}"
  fi
  recover_interrupted_swap
  remove_install_leftovers
  refuse_foreign_launcher "${HOME}/.local/bin/${INSTALL_NAME}"

  show_intro
  stage 1 'Checking platform and install location'
  stage 2 'Checking Node.js'
  ensure_toolchain

  local source_dir from_clone=0 from_release=0
  # A checkout this script sits in installs itself (development), unless it
  # is the installer's own install, whose copy of this script must fetch a
  # release instead of rebuilding what is already there.
  if ((update == 0)) && [[ -n "${SCRIPT_DIR}" && ! -f "${SCRIPT_DIR}/${OWNERSHIP_MARKER}" ]] \
    && is_aiand_cli_package "${SCRIPT_DIR}/package.json"; then
    stage 3 'Using the local checkout'
    require_tools npm
    source_dir="${SCRIPT_DIR}"
  elif ((update == 0)) && [[ -n "${SOURCE}" ]]; then
    stage 3 "Cloning ${SOURCE} (development build, not a verified release)"
    require_tools git npm
    clone_to_staging
    source_dir="${STAGING_DIR}"
    from_clone=1
  else
    stage 3 'Downloading the release'
    fetch_release_to_staging
    source_dir="${STAGING_DIR}"
    from_clone=1
    from_release=1
  fi

  if ((from_release)); then
    stage 4 'Verifying'
    verify_built_cli "${source_dir}" "${RELEASE_VERSION}"
  else
    stage 4 'Building and verifying'
    ensure_build "${source_dir}"
    verify_built_cli "${source_dir}"
  fi

  stage 5 'Activating the verified installation'
  local final_dir
  if ((from_clone)); then
    activate_staged_install "${source_dir}"
    final_dir="${INSTALL_DIR}"
  else
    final_dir="${source_dir}"
  fi
  log "Installing CLI..."
  install_cli_launcher "${final_dir}"

  print_install_notes
  print_agent_summary "${final_dir}"
  show_installed_version "${HOME}/.local/bin/${INSTALL_NAME}"
  offer_login "${HOME}/.local/bin/${INSTALL_NAME}"
}

main "$@"
