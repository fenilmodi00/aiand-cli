#!/usr/bin/env bash
# aiand one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/aiandlabs/aiand-cli/main/install.sh | bash
#   bash install.sh uninstall [--force]
#
# Clones the CLI into ~/.aiand/cli, builds it with the project's own
# toolchain, and drops an `aiand` launcher on PATH via ~/.local/bin.
# Re-running the installer replaces the previous install only after the new
# build is staged and verified — a failed stage leaves the old install
# untouched. Nothing under ~/.config/aiand (profiles, credentials, agent
# snapshots) is ever touched — updating the CLI never unwires your agents.
#
# `uninstall` turns every aiand-routed agent `off` first (via the installed
# CLI's `aiand init --off`, aborting before deleting anything when off fails
# so snapshots stay retryable), then removes the launcher and the
# checkout. Profiles, credentials, and snapshots under ~/.config/aiand are
# intentionally kept.
#
# Knobs (environment only; no flags):
#   AIAND_SOURCE=https://…|/local/path   where to clone from (https URLs
#                                        must be github.com/aiandlabs/aiand-cli)
#   AIAND_DIR=~/.aiand/cli               where the source lives
#   AIAND_SKIP_BUILD=1                   reuse the existing dist/ build
#   AIAND_INSTALL_VERBOSE=1              show full npm output
#   AIAND_UNINSTALL_FORCE=1              on uninstall, skip turning agents off
#   AIAND_NO_MODIFY_PATH=1               never touch shell rc PATH entries
#   NO_COLOR                             disable ANSI colors in this script
set -euo pipefail

DEFAULT_SOURCE="https://github.com/aiandlabs/aiand-cli.git"
SOURCE="${AIAND_SOURCE:-${DEFAULT_SOURCE}}"
INSTALL_DIR="${AIAND_DIR:-${HOME}/.aiand/cli}"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=0
MIN_NODE_VERSION="${MIN_NODE_MAJOR}"
INSTALL_NOTES=()
STAGING_DIR=""
INSTALL_STAGE_TOTAL=5

# When install.sh is piped (curl | bash), BASH_SOURCE[0] is unset; fall
# through to the clone path below. Otherwise, prefer the checkout this
# script already lives in so `./install.sh` installs local work in progress.
SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

cleanup() {
  if [[ -n "${STAGING_DIR}" && -d "${STAGING_DIR}" ]]; then
    rm -rf -- "${STAGING_DIR}"
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
# network trust decision.
is_allowlisted_source() {
  local url="${1:-}" rest host path
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
  [[ "${path}" == "/aiandlabs/aiand-cli.git" || "${path}" == "/aiandlabs/aiand-cli" ]]
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
is_installer_owned() {
  local dir="${1:-}" home_real
  home_real="$(cd "${HOME}" 2>/dev/null && pwd -P || printf '%s' "${HOME}")"
  [[ -f "${dir}/${OWNERSHIP_MARKER}" ]] && return 0
  [[ "${dir}" == "${home_real}/.aiand/cli" ]] && is_aiand_cli_package "${dir}/package.json"
}

# Best-effort: a read-only checkout must never fail an install over the
# marker — uninstall falls back to refusing, which errs toward keeping files.
mark_installer_owned() {
  local dir="${1:-}"
  printf 'aiand-cli installer ownership marker\n' >"${dir}/${OWNERSHIP_MARKER}" 2>/dev/null || true
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
      echo "Node.js ${MIN_NODE_VERSION}+ is required to build the CLI." >&2
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

  for tool in git npm; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
      echo "Missing required command: ${tool}" >&2
      print_tool_instructions "${tool}"
      exit 1
    fi
  done
}

# Stage 3, clone path: verify the live INSTALL_DIR may be replaced, then
# clone SOURCE into a staging sibling. Sets STAGING_DIR on success; any
# failure exits 1 with the old install untouched.
clone_to_staging() {
  if ! is_allowlisted_source "${SOURCE}"; then
    echo "error: AIAND_SOURCE is not an allowlisted https://github.com/aiandlabs/aiand-cli URL" >&2
    exit 1
  fi

  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    if ! is_aiand_cli_package "${INSTALL_DIR}/package.json"; then
      echo "Error: ${INSTALL_DIR} is not an aiand checkout; your checkout was left untouched. Move or remove it and re-run the installer." >&2
      exit 1
    fi
    if [[ -n "$(git -C "${INSTALL_DIR}" status --porcelain 2>/dev/null)" ]]; then
      echo "Error: ${INSTALL_DIR} has local changes; your checkout was left untouched. Commit, stash, or discard them and re-run the installer." >&2
      exit 1
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
    # A pre-existing non-empty directory (e.g. AIAND_DIR=~) must fail safely
    # instead of being wiped — even when it looks like an aiand checkout.
    if is_aiand_cli_package "${INSTALL_DIR}/package.json"; then
      echo "Error: ${INSTALL_DIR} already exists; your checkout was left untouched. Move or remove it and re-run the installer to reinstall from scratch." >&2
    else
      echo "Error: ${INSTALL_DIR} is not an aiand checkout; cloning into it failed safely" >&2
    fi
    exit 1
  fi

  mkdir -p "$(dirname "${INSTALL_DIR}")"
  STAGING_DIR="$(mktemp -d "$(dirname "${INSTALL_DIR}")/.cli-staging-XXXXXX")"
  if ! git clone --quiet --depth 1 "${SOURCE}" "${STAGING_DIR}"; then
    echo "error: staged aiand verification failed; the existing installation was left unchanged." >&2
    exit 1
  fi
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
    if ! mv "${INSTALL_DIR}" "${previous}"; then
      echo "error: staged aiand verification failed; the existing installation was left unchanged." >&2
      exit 1
    fi
    if ! mv "${staging_dir}" "${INSTALL_DIR}"; then
      if ! mv "${previous}" "${INSTALL_DIR}"; then
        echo "error: staged swap failed; previous install is at ${previous}" >&2
        exit 1
      fi
      echo "error: staged aiand verification failed; the existing installation was left unchanged." >&2
      exit 1
    fi
    rm -rf -- "${previous}"
  else
    if ! mv "${staging_dir}" "${INSTALL_DIR}"; then
      echo "error: staged aiand verification failed; the existing installation was left unchanged." >&2
      exit 1
    fi
  fi
  STAGING_DIR=""
}

# Run the built CLI's entry point the way the launcher will, before any
# launcher is written: the reported version must equal the staged
# package.json version and --help must exit 0.
verify_built_cli() {
  local source_dir="$1" node_bin expected actual
  node_bin="$(command -v node)"
  expected="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version' -- "${source_dir}/package.json" 2>/dev/null || true)"
  if [[ -z "${expected}" ]]; then
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
  if ! (cd "${source_dir}" && npm ci --no-fund --no-audit --loglevel="${npm_loglevel}"); then
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

  if [[ -n "${ZSH_VERSION:-}" || "${SHELL:-}" == *"zsh" ]]; then
    shell_config="${HOME}/.zshrc"
  elif [[ -n "${BASH_VERSION:-}" || "${SHELL:-}" == *"bash" ]]; then
    if [[ "$(uname -s)" == "Darwin" ]]; then
      shell_config="${HOME}/.bash_profile"
    else
      shell_config="${HOME}/.bashrc"
    fi
  fi

  if [[ -n "${shell_config}" ]]; then
    touch "${shell_config}"
    if ! grep -qxF "${path_entry}" "${shell_config}" 2>/dev/null; then
      echo "${path_entry}" >>"${shell_config}"
      install_note "Added ${bin_dir} to PATH in ${shell_config} (open a new terminal if aiand is not found)."
    fi
  fi
}

install_cli_launcher() {
  local source_dir="$1"
  local bin_dir="${HOME}/.local/bin"
  local launcher_path="${bin_dir}/aiand"

  mkdir -p "${bin_dir}"

  # Resolve an absolute Node path at install time and bake it into the launcher,
  # with a PATH fallback. This keeps the launcher working in non-interactive
  # shells where `node` is not on PATH — common in sandboxes and CI.
  local node_bin
  node_bin="$(command -v node 2>/dev/null || true)"

  cat >"${launcher_path}" <<EOF
#!/usr/bin/env bash
# aiand launcher. Uses the Node binary discovered at install time, falling
# back to PATH lookup, so aiand works without \`node\` on PATH.
NODE_BIN="\${AIAND_NODE_BIN:-${node_bin}}"
[ -x "\$NODE_BIN" ] || NODE_BIN="\$(command -v node 2>/dev/null)"
if [ -z "\$NODE_BIN" ] || ! [ -x "\$NODE_BIN" ]; then
  echo "aiand: Node.js was not found. Install Node ${MIN_NODE_VERSION}+ and re-run the aiand installer." >&2
  exit 1
fi
# --disable-warning silences node's ExperimentalWarning for node:sqlite; the
# flag exists since Node 21.3 and this installer requires ${MIN_NODE_MAJOR}+.
exec "\$NODE_BIN" --disable-warning=ExperimentalWarning "${source_dir}/dist/index.js" "\$@"
EOF
  chmod +x "${launcher_path}"

  add_bin_dir_to_path
}
uninstall_cli() {
  # `bash install.sh uninstall [--force]`: turn every aiand-routed agent
  # `off` first (aborting before deleting anything when off fails so
  # snapshots stay retryable), then remove the launcher and the checkout.
  # Profiles, credentials, and snapshots under ~/.config/aiand are kept.
  # --force (or AIAND_UNINSTALL_FORCE=1) skips the agent teardown for broken
  # installs where no working launcher remains.
  local force=0 arg
  for arg in "$@"; do
    case "${arg}" in
      --force) force=1 ;;
      *)
        echo "Usage: bash install.sh [uninstall [--force]]" >&2
        exit 1
        ;;
    esac
  done
  if [[ "${AIAND_UNINSTALL_FORCE:-}" == "1" ]]; then
    force=1
  fi

  local home_real launcher launcher_cmd working_launcher checkout checkout_orig checkout_parent off_ok
  home_real="$(cd "${HOME}" 2>/dev/null && pwd -P || printf '%s' "${HOME}")"
  launcher="${home_real}/.local/bin/aiand"
  # install.ps1 writes aiand.cmd next to the Git Bash shim; uninstall must
  # remove both and may need the .cmd file for `init --off` when the shim
  # is missing or not executable.
  launcher_cmd="${home_real}/.local/bin/aiand.cmd"
  checkout="${AIAND_DIR:-${home_real}/.aiand/cli}"
  # AIAND_DIR is user-controlled: canonicalize before comparing (an exact
  # string compare would let "$HOME/", "$HOME//", or "//" — the same
  # directories spelled differently — straight through to rm -rf), then
  # refuse HOME itself, /, and anything outside HOME.
  # Resolve against a saved copy: assigning the failed lookup back into
  # $checkout first would make the fallback canonicalize "" (i.e. ".").
  # When neither the checkout nor its parent exists there is nothing rm -rf
  # could delete (local-checkout installs never create ~/.aiand/cli), so the
  # original spelling is kept for the HOME-bounds comparison below and the
  # uninstall proceeds to remove the launcher.
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


  # Identity before any agent teardown AND before any delete: the checkout
  # must be an @aiand/cli package this installer owns (marker file, or the
  # default-path checkout from before markers existed). A hand-cloned
  # source checkout under $HOME must never be rm -rf'ed via AIAND_DIR.
  if [[ -e "${checkout}" ]] && ! is_aiand_cli_package "${checkout}/package.json"; then
    echo "Error: ${checkout} is not an aiand checkout; it was left untouched. Remove it manually if you are sure." >&2
    exit 1
  fi
  if [[ -e "${checkout}" ]] && ! is_installer_owned "${checkout}"; then
    echo "Error: ${checkout} is not an installer-owned checkout; it was left untouched. Uninstall the installer's checkout (default ~/.aiand/cli) or remove ${checkout} manually." >&2
    exit 1
  fi

  if ((force == 0)); then
    working_launcher=""
    if [[ -x "${launcher}" ]]; then
      working_launcher="${launcher}"
    elif [[ -f "${launcher_cmd}" ]]; then
      working_launcher="${launcher_cmd}"
    fi
    if [[ -n "${working_launcher}" ]]; then
      log "Turning agents off..."
      off_ok=0
      if [[ "${working_launcher}" == *.cmd ]] && command -v cmd.exe >/dev/null 2>&1; then
        if cmd.exe //c "${working_launcher}" init --off; then
          off_ok=1
        fi
      else
        if "${working_launcher}" init --off; then
          off_ok=1
        fi
      fi
      if ((off_ok == 0)); then
        echo "Error: agent teardown failed; nothing was deleted. Fix the failure and re-run, or bypass it with --force (AIAND_UNINSTALL_FORCE=1)." >&2
        exit 1
      fi
    else
      echo "Error: no working aiand launcher at ${launcher}; nothing was deleted. Re-run with --force to remove files without turning agents off." >&2
      exit 1
    fi
  fi


  rm -f "${launcher}" "${launcher_cmd}"
  if [[ -e "${checkout}" ]]; then
    rm -rf "${checkout}"
  fi
  rmdir "${HOME}/.aiand" 2>/dev/null || true
  echo "Removed ${launcher} and ${checkout}."
  echo "Kept profiles, credentials, and agent snapshots under ${HOME}/.config/aiand."
}


main() {
  if [[ "${1:-}" == "uninstall" ]]; then
    shift
    uninstall_cli "$@"
    return
  fi

  show_intro
  stage 1 'Checking platform and install location'
  stage 2 'Checking Node.js, git, and npm'
  ensure_toolchain

  local source_dir from_clone=0
  if [[ -n "${SCRIPT_DIR}" ]] && is_aiand_cli_package "${SCRIPT_DIR}/package.json"; then
    stage 3 'Fetching source'
    log "Using local checkout"
    source_dir="${SCRIPT_DIR}"
  else
    stage 3 'Fetching source'
    clone_to_staging
    source_dir="${STAGING_DIR}"
    from_clone=1
  fi

  stage 4 'Building and verifying'
  ensure_build "${source_dir}"
  verify_built_cli "${source_dir}"

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
  log "Done. Run 'aiand --version' to check the install."
}

main "$@"
