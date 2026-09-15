#!/usr/bin/env bash
# aiand one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/aiandlabs/aiand-cli/main/install.sh | bash
#   bash install.sh uninstall [--force]
#
# Clones (or fast-forward updates) the CLI into ~/.aiand/cli, builds it with
# the project's own toolchain, and drops an `aiand` launcher on PATH via
# ~/.local/bin. Re-running the installer updates an existing install.
# Nothing under ~/.config/aiand (profiles, credentials, agent snapshots) is
# ever touched — updating the CLI never unwires your agents.
#
# `uninstall` turns every aiand-routed agent `off` first (via the installed
# CLI's `aiand init --off`, aborting before deleting anything when a restore
# fails so snapshots stay retryable), then removes the launcher and the
# checkout. Profiles, credentials, and snapshots under ~/.config/aiand are
# intentionally kept.
#
# Knobs (environment only; no flags):
#   AIAND_SOURCE=https://…|/local/path   where to clone from
#   AIAND_DIR=~/.aiand/cli               where the source lives
#   AIAND_SKIP_BUILD=1                   reuse the existing dist/ build
#   AIAND_INSTALL_VERBOSE=1              show full npm output
#   AIAND_UNINSTALL_FORCE=1              on uninstall, skip the agent restore
set -euo pipefail

DEFAULT_SOURCE="https://github.com/aiandlabs/aiand-cli.git"
SOURCE="${AIAND_SOURCE:-${DEFAULT_SOURCE}}"
INSTALL_DIR="${AIAND_DIR:-${HOME}/.aiand/cli}"
MIN_NODE_MAJOR=22
INSTALL_NOTES=()

# When install.sh is piped (curl | bash), BASH_SOURCE[0] is unset; fall
# through to the clone path below. Otherwise, prefer the checkout this
# script already lives in so `./install.sh` installs local work in progress.
SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
install_progress() {
  # Diagnostic stream: stdout is reserved for captured values (see
  # ensure_durable_source), mirroring the CLI's answers-stdout rule.
  echo "→ $*" >&2
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

node_major_version() {
  node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo "0"
}

node_meets_minimum() {
  local major
  major="$(node_major_version)"
  [[ "${major}" =~ ^[0-9]+$ ]] && ((major >= MIN_NODE_MAJOR))
}

print_tool_instructions() {
  echo "Install ${1} and rerun this installer." >&2
  echo >&2
  echo "Options:" >&2
  echo "  - https://nodejs.org/en/download (Node.js ${MIN_NODE_MAJOR}+, ships with npm)" >&2
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
      echo "Node.js ${MIN_NODE_MAJOR}+ is required (found ${current})." >&2
    else
      echo "Node.js ${MIN_NODE_MAJOR}+ is required to build the CLI." >&2
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
        print_tool_instructions "Node.js ${MIN_NODE_MAJOR}+"
        exit 1
      fi
      echo "Installing Node.js with Homebrew..."
      brew install node
      if ! node_meets_minimum; then
        echo "Node.js ${MIN_NODE_MAJOR}+ is still required after install." >&2
        print_tool_instructions "Node.js ${MIN_NODE_MAJOR}+"
        exit 1
      fi
    else
      print_tool_instructions "Node.js ${MIN_NODE_MAJOR}+"
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

# Echo the source checkout to install from: the local repo when this script
# runs from one, otherwise a clone/update of SOURCE under INSTALL_DIR.
ensure_durable_source() {
  if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/package.json" ]] \
    && grep -q '"name": "@aiand/cli"' "${SCRIPT_DIR}/package.json" 2>/dev/null; then
    printf '%s\n' "${SCRIPT_DIR}"
    return
  fi

  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    install_progress "Updating aiand..."
    if git -C "${INSTALL_DIR}" pull --ff-only --quiet 2>/dev/null; then
      printf '%s\n' "${INSTALL_DIR}"
      return
    fi
    # A failed fast-forward (local commits, local changes, or a transient
    # fetch error) must never delete the checkout: leave it on disk and fail
    # so the user recovers with explicit action. This function runs inside
    # $(...) so install_note alone would die with the subshell: echo the
    # failure too, then exit 1 to abort the assignment in main (set -e).
    if [[ -f "${INSTALL_DIR}/package.json" ]] && grep -q '"name": "@aiand/cli"' "${INSTALL_DIR}/package.json" 2>/dev/null; then
      echo "Error: failed to fast-forward update ${INSTALL_DIR}; your checkout was left untouched. Commit, stash, or discard your local changes (or move ${INSTALL_DIR} aside) and re-run the installer." >&2
      exit 1
    else
      install_note "${INSTALL_DIR} is not an aiand checkout; cloning into it failed safely"
      echo "Error: ${INSTALL_DIR} is not an aiand checkout; cloning into it failed safely" >&2
      exit 1
    fi
  else
    install_progress "Downloading aiand..."
    # A pre-existing non-empty directory (e.g. AIAND_DIR=~) must fail safely
    # instead of being wiped — even when it looks like an aiand checkout.
    # Require explicit user action before any replacement. A missing or
    # empty directory is a fresh target — clone into it.
    if [[ -e "${INSTALL_DIR}" && -n "$(ls -A "${INSTALL_DIR}" 2>/dev/null)" ]]; then
      if [[ -f "${INSTALL_DIR}/package.json" ]] && grep -q '"name": "@aiand/cli"' "${INSTALL_DIR}/package.json" 2>/dev/null; then
        echo "Error: ${INSTALL_DIR} already exists; your checkout was left untouched. Move or remove it and re-run the installer to reinstall from scratch." >&2
        exit 1
      else
        install_note "${INSTALL_DIR} is not an aiand checkout; cloning into it failed safely"
        echo "Error: ${INSTALL_DIR} is not an aiand checkout; cloning into it failed safely" >&2
        exit 1
      fi
    fi
  fi
  mkdir -p "$(dirname "${INSTALL_DIR}")"
  git clone --quiet --depth 1 "${SOURCE}" "${INSTALL_DIR}"
  printf '%s\n' "${INSTALL_DIR}"
}

ensure_build() {
  local source_dir="$1"
  if [[ "${AIAND_SKIP_BUILD:-}" == "1" && -f "${source_dir}/dist/index.js" ]]; then
    return
  fi
  install_progress "Building aiand..."
  local npm_loglevel=error
  if [[ "${AIAND_INSTALL_VERBOSE:-}" == "1" ]]; then
    npm_loglevel=notice
  fi
  # --omit=dev would drop the TypeScript compiler the build needs; the CLI
  # itself ships zero runtime dependencies, so node_modules never runs.
  if ! (cd "${source_dir}" && npm ci --no-fund --no-audit --loglevel="${npm_loglevel}"); then
    echo "Failed to install build dependencies." >&2
    exit 1
  fi
  if ! (cd "${source_dir}" && npm run build --loglevel="${npm_loglevel}" >/dev/null); then
    echo "Failed to build aiand." >&2
    exit 1
  fi
  if [[ ! -f "${source_dir}/dist/index.js" ]]; then
    echo "Build finished but dist/index.js is missing." >&2
    exit 1
  fi
}

add_bin_dir_to_path() {
  local bin_dir="${HOME}/.local/bin"
  local path_entry="export PATH=\"${bin_dir}:\$PATH\""
  local shell_config=""

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
  echo "aiand: Node.js was not found. Install Node ${MIN_NODE_MAJOR}+ and re-run the aiand installer." >&2
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
  # `off` first (aborting before deleting anything when a restore fails so
  # snapshots stay retryable), then remove the launcher and the checkout.
  # Profiles, credentials, and snapshots under ~/.config/aiand are kept.
  # --force (or AIAND_UNINSTALL_FORCE=1) skips the restore for broken
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

  local launcher="${HOME}/.local/bin/aiand"
  local checkout="${AIAND_DIR:-${HOME}/.aiand/cli}"
  # AIAND_DIR is user-controlled: canonicalize before comparing (an exact
  # string compare would let "$HOME/", "$HOME//", or "//" — the same
  # directories spelled differently — straight through to rm -rf), then
  # refuse HOME itself, /, and anything outside HOME.
  checkout="$(cd "${checkout}" 2>/dev/null && pwd -P)" \
    || checkout="$(cd "$(dirname "${checkout}")" 2>/dev/null && pwd -P)/$(basename "${checkout}")"
  if [[ "${checkout}" == "/" || "${checkout}" == "${HOME}" || "${checkout}" == "${HOME}/" ]]; then
    echo "Error: refusing to remove ${checkout}; unset AIAND_DIR and re-run." >&2
    exit 1
  fi
  if [[ "${checkout}" != "${HOME}"/* ]]; then
    echo "Error: refusing to remove ${checkout}; it is outside ${HOME}." >&2
    exit 1
  fi


  if ((force == 0)); then
    if [[ -x "${launcher}" ]]; then
      install_progress "Restoring agents..."
      if ! "${launcher}" init --off; then
        echo "Error: agent restore failed; nothing was deleted. Fix the failure and re-run, or bypass the restore with --force (AIAND_UNINSTALL_FORCE=1)." >&2
        exit 1
      fi
    else
      echo "Error: no working aiand launcher at ${launcher}; nothing was deleted. Re-run with --force to remove files without restoring agents." >&2
      exit 1
    fi
  fi

  # Identity before any delete: a --force uninstall whose AIAND_DIR is
  # HOME-bounded but not an @aiand/cli checkout must leave the launcher.
  if [[ -e "${checkout}" ]]; then
    if [[ ! -f "${checkout}/package.json" ]] \
      || ! grep -Eq '"name"[[:space:]]*:[[:space:]]*"@aiand/cli"' "${checkout}/package.json" 2>/dev/null; then
      echo "Error: ${checkout} is not an aiand checkout; it was left untouched. Remove it manually if you are sure." >&2
      exit 1
    fi
  fi

  rm -f "${launcher}"
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
  ensure_toolchain
  local source_dir
  source_dir="$(ensure_durable_source)"
  ensure_build "${source_dir}"

  install_progress "Installing CLI..."
  install_cli_launcher "${source_dir}"

  # Smoke-test the launcher we just wrote. Best-effort after this point —
  # never abort once the launcher is on disk.
  install_progress "Checking install..."
  local launcher="${HOME}/.local/bin/aiand"
  if ! "${launcher}" --version >/dev/null 2>&1; then
    install_note "The aiand launcher did not start. Re-run this installer with AIAND_INSTALL_VERBOSE=1."
  fi
  "${launcher}" --help >/dev/null 2>&1 || true

  "${launcher}" --version 2>/dev/null || true
  print_install_notes
}

main "$@"
