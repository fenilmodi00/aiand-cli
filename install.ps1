# aiand one-line installer for Windows (PowerShell 5.1+).
#
#   Invoke-RestMethod https://github.com/aiandlabs/aiand-cli/releases/latest/download/install.ps1 | Invoke-Expression
#   .\install.ps1
#   powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.aiand\cli\install.ps1" update
#   .\install.ps1 uninstall [--force] [--purge]
#
# Installs the latest ai& CLI release into ~/.aiand/cli and drops `aiand`
# launchers on PATH via ~/.local/bin. The release is the npm tarball for the
# version the latest GitHub release names; it must match both npm's sha512
# (dist.integrity) and the sha256 in that GitHub release's SHA256SUMS, or
# nothing is installed (docs/adr/0001-installers-verify-npm-release.md).
# There is no fallback to the main branch: with no release reachable, the
# installer stops. Those checks cover the tarball, not this script: a fresh
# install runs it as fetched from GitHub, before anything is verified (the
# one-liner takes it from the latest release's assets, not main), so the
# bootstrap is trusted on first use. `update` runs the copy that shipped in
# an already verified tarball.
# Re-running replaces the previous install only after the new one is staged
# and verified -- a failed stage leaves the old install untouched. The
# installer never rewrites or deletes anything under ~/.config/aiand
# (profiles, credentials, agent snapshots). Answering yes to the closing login
# question runs `aiand login`, which stores a session there.
#
# `update` installs the latest release (or AIAND_VERSION) over an existing
# install. It always takes the release path, even when this script sits in a
# checkout or AIAND_SOURCE is set. Run from an install's own copy, it updates
# that install unless AIAND_DIR names another.
#
# `uninstall` turns every aiand-routed agent `off` first (via the installed
# CLI's `aiand init --off`, aborting before deleting anything when off fails
# so snapshots stay retryable), then removes the launchers and checkout.
# Profiles, credentials, and snapshots are kept unless `--purge` asks for a
# wipe (for a shared or loaner machine): then the installed CLI first runs
# `aiand logout --all` (or, on a CLI without it, `aiand logout` for every
# profile), which revokes the keys it minted and strips every agent's wiring,
# and the config directory is deleted after the files. The purge stops, deleting
# nothing, unless every key the CLI minted reports revoked (`--force` skips
# sign-out and says so). Like the checkout, that
# directory must resolve strictly inside HOME, with no link or junction below
# HOME, and its name must be `aiand`.
#
# Knobs (environment only; no flags):
#   AIAND_VERSION=x.y.z  install that release instead of the latest; the only way
#                 to go to an older version than the installed one (and nothing
#                 below 0.8.0, the first release with a SHA256SUMS, can be
#                 installed at all)
#   AIAND_SOURCE  development only: build an unverified clone of this source
#                 instead of a release (https URLs must be github.com/aiandlabs/aiand-cli)
#   AIAND_DIR ($HOME\.aiand\cli)  where the source lives
#   AIAND_SKIP_BUILD=1  reuse the existing dist/ build
#   AIAND_INSTALL_VERBOSE=1  show full npm output
#   AIAND_UNINSTALL_FORCE=1  on uninstall, skip turning agents off
#   AIAND_NO_MODIFY_PATH=1  never touch the persistent user PATH
#   NO_COLOR  disable ANSI colors in this script
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RemainingArgs
)
$ErrorActionPreference = 'Stop'
# TLS 1.2 for all downloads; 5.1 defaults to TLS 1.0 which hosts reject.
try { [Net.ServicePointManager]::SecurityProtocol = ([Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12) } catch { }
# Test-only overrides for the installer tests' loopback double; the release
# helper refuses anything but these defaults.
if ($env:AIAND_INSTALL_RELEASES_URL) { $ReleasesUrl = $env:AIAND_INSTALL_RELEASES_URL } else { $ReleasesUrl = 'https://github.com/aiandlabs/aiand-cli/releases' }
if ($env:AIAND_INSTALL_NPM_REGISTRY) { $NpmRegistry = $env:AIAND_INSTALL_NPM_REGISTRY } else { $NpmRegistry = 'https://registry.npmjs.org' }
# Prefer env (USERPROFILE, then HOME) so CI can isolate without relying on
# the automatic $HOME, which PowerShell 5.1 snapshots at process start.
if ($env:USERPROFILE -and $env:USERPROFILE.Trim() -ne '') { $UserHome = $env:USERPROFILE.Trim() } elseif ($env:HOME -and $env:HOME.Trim() -ne '') { $UserHome = $env:HOME.Trim() } else { $UserHome = [string]$HOME }
if ($env:AIAND_SOURCE -and $env:AIAND_SOURCE.Trim() -ne '') { $Source = $env:AIAND_SOURCE.Trim() } else { $Source = '' }
if ($env:AIAND_DIR -and $env:AIAND_DIR.Trim() -ne '') { $InstallDir = $env:AIAND_DIR.Trim() } else { $InstallDir = (Join-Path (Join-Path $UserHome '.aiand') 'cli') }
$BinDir = (Join-Path (Join-Path $UserHome '.local') 'bin')
$MinNodeMajor = 22
$MinNodeMinor = 0
$MinNodeVersion = "$MinNodeMajor"
$OwnershipMarker = '.aiand-installer-owned'
# Baked into every launcher install.ps1 (and install.sh) writes; its presence
# is how uninstall and re-install tell ours from a foreign file.
$LauncherHeader = 'aiand launcher'
$InstallStageTotal = 5
$script:InstallNotes = @()
$script:StagingDir = ''
$script:DownloadDir = ''
$script:ReleaseVersion = ''
# The previous install, from the moment Activate-StagedInstall moves it aside
# until the new one is in place. Set before the first move, so an interruption
# at any point after it can put the previous install back.
$script:SwapPrevious = ''
# Piped (irm | iex) has no script path; otherwise prefer the checkout this
# script lives in so `.\install.ps1` installs local work in progress.
$script:ScriptDir = ''
try {
    $sp = $MyInvocation.MyCommand.Path
    if ($sp -and (Test-Path $sp)) { $script:ScriptDir = Split-Path -Parent $sp }
} catch { $script:ScriptDir = '' }
# File invocation (`-File` / `.\install.ps1`) may `exit`. `irm | iex` must not:
# `exit` would kill the user's interactive host.
$script:InvokedAsFile = $script:ScriptDir -ne ''
function Stop-Installer {
    param([string]$Message = '')
    if ($Message) { [Console]::Error.WriteLine($Message) }
    if ($script:InvokedAsFile) { exit 1 }
    throw 'AIAND_INSTALLER_STOP'
}
function Test-SupportsColor {
    if ($env:NO_COLOR) { return $false }
    if ($env:TERM -eq 'dumb') { return $false }
    try { if ([Console]::IsErrorRedirected) { return $false } } catch {
        try { if ([Console]::IsOutputRedirected) { return $false } } catch { return $false }
    }
    return $true
}
function Format-Step {
    param([Parameter(Mandatory = $true)][string]$Message)
    $esc = [char]27
    if (Test-SupportsColor) { return "$esc[1;36m==>$esc[0m $Message" }
    return "==> $Message"
}
# Diagnostic stream: stderr is the only progress channel, mirroring the CLI.
function Write-Step {
    param([Parameter(Mandatory = $true)][string]$Message)
    [Console]::Error.WriteLine((Format-Step $Message))
}
function Write-Stage {
    param([Parameter(Mandatory = $true)][int]$Number, [Parameter(Mandatory = $true)][string]$Message)
    Write-Step "[$Number/$InstallStageTotal] $Message"
}
function Write-Warn {
    param([Parameter(Mandatory = $true)][string]$Message)
    [Console]::Error.WriteLine("warning: $Message")
}
function Show-AiandIntro {
    $esc = [char]27
    $useColor = Test-SupportsColor
    if ($useColor) { [Console]::Error.WriteLine("$esc[1;36m") }
    # 8 wordmark lines; leading spaces are significant for column alignment.
    # The file stays ASCII (and has no BOM): it is served as raw bytes, and
    # Windows PowerShell 5.1 decodes those as Latin-1. '#' is a full block and
    # '+' a light shade; they are swapped for the real characters here.
    $full = [string][char]0x2588
    $shade = [string][char]0x2591
    $wordmark = @(
        '  #########    #####   ######',
        '  ###+++++### ++###   ###++###',
        ' +###    +###  +###  ++######',
        ' +###########  +###   ######',
        ' +###+++++###  +### +###++###',
        ' +###    +###  +### +### ++###',
        ' #####   ##### #####++#####+###',
        '+++++   +++++ +++++  +++++ +++'
    )
    foreach ($row in $wordmark) { [Console]::Error.WriteLine($row.Replace('#', $full).Replace('+', $shade)) }
    if ($useColor) { [Console]::Error.WriteLine("$esc[0m") }
    [Console]::Error.WriteLine('')
}
function Add-InstallNote {
    param([Parameter(Mandatory = $true)][string]$Message)
    $script:InstallNotes += $Message
}
function Write-InstallNotes {
    if ($script:InstallNotes.Count -eq 0) { return }
    foreach ($note in $script:InstallNotes) { Write-Output "Note: $note" }
}
# Post-install summary on stdout: which PATH coding agents are present, and
# the install hint for each one that is missing. The hint is that adapter's
# install.command, printed by the package just installed. A missing script
# (an older release) does not fail the install.
function Write-AgentSummary {
    param([Parameter(Mandatory = $true)][string]$SourceDir)
    $summary = Join-Path $SourceDir 'dist/agents/install-summary.js'
    if (-not (Test-Path -LiteralPath $summary)) { return }
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { return }
    # The summary must not fail the install, and must not leave node's exit
    # code for Show-InstalledVersion to read.
    $prev = $ErrorActionPreference
    $savedExit = $LASTEXITCODE
    $ErrorActionPreference = 'Continue'
    try { & $node.Source --disable-warning=ExperimentalWarning $summary } catch { }
    $ErrorActionPreference = $prev
    if ($null -eq $savedExit) { $global:LASTEXITCODE = 0 } else { $global:LASTEXITCODE = $savedExit }
}
# Only https://github.com/aiandlabs/aiand-cli(.git) may be a URL source.
# Local paths stay allowed: they carry no network trust decision.
function Assert-AllowlistedHttpsUri {
    param([Parameter(Mandatory = $true)][string]$Uri)
    $url = $Uri.Trim()
    # A leading dash would reach `git clone` as an option (e.g. --upload-pack).
    if ($url.StartsWith('-')) { throw 'error: AIAND_SOURCE is not an allowlisted https://github.com/aiandlabs/aiand-cli URL' }
    if ($url -notlike '*://*') {
        if ($url.Contains('@')) { throw 'error: AIAND_SOURCE is not an allowlisted https://github.com/aiandlabs/aiand-cli URL' }
        if ($url -match '^[A-Za-z]:([\\/].*)?$') { return }
        if ($url.Contains(':')) { throw 'error: AIAND_SOURCE is not an allowlisted https://github.com/aiandlabs/aiand-cli URL' }
        return
    }
    if ($url -notlike 'https://*') { throw 'error: AIAND_SOURCE is not an allowlisted https://github.com/aiandlabs/aiand-cli URL' }
    $rest = $url.Substring('https://'.Length)
    if ($rest.Contains('@') -or $rest.Contains('?') -or $rest.Contains('#')) { throw 'error: AIAND_SOURCE is not an allowlisted https://github.com/aiandlabs/aiand-cli URL' }
    $slash = $rest.IndexOf('/')
    if ($slash -lt 0) { $hostPart = $rest; $pathPart = '/' } else { $hostPart = $rest.Substring(0, $slash); $pathPart = $rest.Substring($slash) }
    if ($hostPart -ne 'github.com') { throw 'error: AIAND_SOURCE is not an allowlisted https://github.com/aiandlabs/aiand-cli URL' }
    if ($pathPart -ne '/aiandlabs/aiand-cli.git' -and $pathPart -ne '/aiandlabs/aiand-cli') { throw 'error: AIAND_SOURCE is not an allowlisted https://github.com/aiandlabs/aiand-cli URL' }
}
function Publish-EnvironmentChange {
    # Broadcast WM_SETTINGCHANGE so new shells pick up the user PATH.
    # Best-effort: the registry PATH update already landed before this runs.
    try {
        if (-not ('Aiand.NativeMethods' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Aiand {
    public static class NativeMethods {
        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
    }
}
'@
        }
        $result = [UIntPtr]::Zero
        [void][Aiand.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 0x0002, 5000, [ref]$result)
    } catch { }
}
function Test-PathContainsDirectory {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$PathValue, [Parameter(Mandatory = $true)][string]$Directory)
    if ([string]::IsNullOrEmpty($PathValue)) { return $false }
    $want = $Directory.TrimEnd('\', '/')
    foreach ($entry in $PathValue -split ';') {
        if ([string]::IsNullOrWhiteSpace($entry)) { continue }
        if ($entry.Trim().TrimEnd('\', '/') -ieq $want) { return $true }
    }
    return $false
}
function Add-ToUserPath {
    $binDir = $BinDir
    if (-not (Test-PathContainsDirectory -PathValue $env:PATH -Directory $binDir)) { $env:PATH = "$binDir;$env:PATH" }
    if ($env:AIAND_NO_MODIFY_PATH) { Write-Step 'Skipping persistent PATH update (AIAND_NO_MODIFY_PATH is set)'; return }
    try {
        $current = [Environment]::GetEnvironmentVariable('Path', 'User')
        if ($null -eq $current) { $current = '' }
        if (Test-PathContainsDirectory -PathValue $current -Directory $binDir) { return }
        if ([string]::IsNullOrWhiteSpace($current)) { $updated = $binDir } else { $updated = "$($current.TrimEnd(';'));$binDir" }
        [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
        Publish-EnvironmentChange
        Add-InstallNote "Added $binDir to the user PATH (open a new terminal if aiand is not found)."
        Add-InstallNote 'If aiand is not found in VS Code, restart VS Code so the integrated terminal picks up the new PATH.'
    } catch {
        Write-Warn "Could not update the user PATH: $($_.Exception.Message)"
        Add-InstallNote "Could not update the user PATH automatically; add $binDir to PATH manually."
    }
}
function Test-NodeMeetsMinimum {
    try { $version = (& node -p 'process.versions.node' 2>$null) } catch { return $false }
    if (-not $version) { return $false }
    $parts = $version.Trim() -split '\.'
    if ($parts.Count -lt 2) { return $false }
    $major = 0; $minor = 0
    if (-not [int]::TryParse($parts[0], [ref]$major)) { return $false }
    if (-not [int]::TryParse($parts[1], [ref]$minor)) { return $false }
    if ($major -gt $MinNodeMajor) { return $true }
    if ($major -eq $MinNodeMajor -and $minor -ge $MinNodeMinor) { return $true }
    return $false
}
function Write-ToolInstructions {
    param([Parameter(Mandatory = $true)][string]$Tool)
    [Console]::Error.WriteLine("Install $Tool and rerun this installer.")
    [Console]::Error.WriteLine('')
    [Console]::Error.WriteLine('Options:')
    [Console]::Error.WriteLine("  - https://nodejs.org/en/download (Node.js $MinNodeVersion+, ships with npm)")
    [Console]::Error.WriteLine('  - nvm-windows: https://github.com/coreybutler/nvm-windows')
    [Console]::Error.WriteLine('  - winget: winget install OpenJS.NodeJS Git.Git')
}
function Confirm-Toolchain {
    # Node is often installed but not on PATH (C:\Program Files\nodejs).
    # Probe common locations for this session before giving up.
    try { $null = Get-Command node -ErrorAction Stop } catch {
        $candidates = @()
        if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'nodejs') }
        if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'nodejs') }
        $candidates += 'C:\Program Files\nodejs'
        foreach ($dir in $candidates) { if (Test-Path (Join-Path $dir 'node.exe')) { $env:PATH = "$dir;$env:PATH"; break } }
    }
    $hasNode = $true
    try { $null = Get-Command node -ErrorAction Stop } catch { $hasNode = $false }
    if ($hasNode -and (Test-NodeMeetsMinimum)) { } else {
        if ($hasNode) {
            $current = 'unknown'
            try { $current = (& node -p 'process.versions.node' 2>$null).Trim() } catch { $current = 'unknown' }
            [Console]::Error.WriteLine("Node.js $MinNodeVersion+ is required (found $current).")
        } else {
            [Console]::Error.WriteLine("Node.js $MinNodeVersion+ is required to run the CLI.")
        }
        Write-ToolInstructions -Tool "Node.js $MinNodeVersion+"
        Stop-Installer
    }
}
# git and npm are only needed to build from source (AIAND_SOURCE or a local
# checkout); a release install needs Node alone.
function Confirm-Tools {
    param([Parameter(Mandatory = $true)][string[]]$Tools)
    foreach ($tool in $Tools) {
        try { $null = Get-Command $tool -ErrorAction Stop } catch {
            [Console]::Error.WriteLine("Missing required command: $tool")
            Write-ToolInstructions -Tool $tool
            Stop-Installer
        }
    }
}
# Read package.json via ConvertFrom-Json. Windows PowerShell 5.1 strips
# double quotes when invoking native commands, so `node -e` / `node -p`
# scripts that contain "fs" / "@aiand/cli" are corrupted and always fail.
function Read-PackageJson {
    param([Parameter(Mandatory = $true)][string]$PkgPath)
    if (-not (Test-Path $PkgPath)) { return $null }
    try { return (Get-Content -Raw -Path $PkgPath | ConvertFrom-Json) } catch { return $null }
}
# True iff package.json's top-level `name` is @aiand/cli. A grep for the string
# would also match nested keys, which is not enough identity for rm -rf.
function Test-AiandCliPackage {
    param([Parameter(Mandatory = $true)][string]$PkgPath)
    $parsed = Read-PackageJson -PkgPath $PkgPath
    if ($null -eq $parsed) { return $false }
    return ($parsed.name -eq '@aiand/cli')
}
# True iff the installer recorded this checkout as its own (or it is the
# default-path checkout from before markers existed). Ownership, not the
# package name, authorizes rm -rf.
function Test-InstallerOwned {
    param([Parameter(Mandatory = $true)][string]$Dir)
    if (Test-Path -LiteralPath (Join-Path $Dir $OwnershipMarker)) { return $true }
    $defaultDir = (Join-Path (Join-Path $UserHome '.aiand') 'cli')
    if ($Dir -ieq $defaultDir -and (Test-AiandCliPackage (Join-Path $Dir 'package.json'))) { return $true }
    return $false
}
# True iff the file was written by this installer (install.sh and install.ps1
# both bake an "aiand launcher" header). A foreign ~/.local/bin/aiand(.cmd)
# must never be overwritten, executed, or deleted.
function Test-AiandLauncher {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    try {
        foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
            if ($line -like "*$LauncherHeader*") { return $true }
        }
    } catch { return $false }
    return $false
}
# Refuse to install over a foreign launcher. Called up front in Invoke-Main
# so a refusal happens before any clone/build/swap (a failed install leaves
# the old install untouched, like every other early failure), and again in
# Install-CliLauncher as defense-in-depth.
function Refuse-ForeignLauncher {
    param([Parameter(Mandatory = $true)][string]$Path)
    if ((Test-Path -LiteralPath $Path) -and -not (Test-AiandLauncher $Path)) {
        Stop-Installer "Error: $Path was not written by the aiand installer; it was left untouched. Move or remove it and re-run the installer."
    }
}
# Best-effort: a read-only checkout must never fail an install over the marker.
function Set-InstallerOwned {
    param([Parameter(Mandatory = $true)][string]$Dir)
    try { 'aiand-cli installer ownership marker' | Out-File -FilePath (Join-Path $Dir $OwnershipMarker) -Encoding ascii -Force } catch { }
    # Keep the marker out of `git status` so the next update's local-changes
    # check does not trip over our own file.
    $exclude = Join-Path $Dir '.git/info/exclude'
    try { if (Test-Path (Split-Path -Parent $exclude)) { "/$OwnershipMarker" | Out-File -FilePath $exclude -Encoding ascii -Append } } catch { }
}
# Refuse to replace InstallDir unless it is ours and holds nothing a swap
# would lose. Mode is clone (an AIAND_SOURCE build) or release.
function Assert-InstallDirReplaceable {
    param([Parameter(Mandatory = $true)][string]$Mode)
    if (Test-Path (Join-Path $InstallDir '.git')) {
        if (-not (Test-AiandCliPackage (Join-Path $InstallDir 'package.json'))) { throw "Error: $InstallDir is not an aiand checkout; your checkout was left untouched. Move or remove it and re-run the installer." }
        try { $null = Get-Command git -ErrorAction Stop } catch { throw "Error: $InstallDir is a git checkout and git is not installed, so its local changes cannot be checked; your checkout was left untouched." }
        # A release replaces the checkout wholesale, so it may only replace one the
        # installer made: a developer's own clone at AIAND_DIR has no marker and
        # is not the default install directory. (Uninstall asks the same.)
        if ($Mode -eq 'release' -and -not (Test-InstallerOwned -Dir $InstallDir)) { throw "Error: $InstallDir is a git checkout the installer did not create (it has no installer ownership marker); your checkout was left untouched. Point AIAND_DIR at another directory, or move it and re-run the installer." }
        $porcelain = ''
        # The marker is excluded explicitly too: installs from before it was
        # written to .git/info/exclude still carry it as an untracked file.
        try { $porcelain = (& git -C $InstallDir status --porcelain -- . ":(exclude)$OwnershipMarker" 2>$null | Out-String) } catch { $porcelain = '' }
        if ($porcelain.Trim() -ne '') { throw "Error: $InstallDir has local changes; your checkout was left untouched. Commit, stash, or discard them and re-run the installer." }
        if ($Mode -eq 'release') {
            # A release replaces the checkout wholesale: refuse when it carries
            # commits its upstream does not (as last fetched; no network here). A
            # branch with no upstream cannot be compared, so its commits count as
            # local: a failed rev-list is never read as "nothing ahead".
            $ahead = ''
            $listed = $true
            try { $ahead = (& git -C $InstallDir rev-list '@{upstream}..HEAD' 2>$null | Out-String); if ($LASTEXITCODE -ne 0) { $listed = $false } } catch { $listed = $false }
            if (-not $listed) { throw "Error: $InstallDir is on a branch with no upstream, so its local commits cannot be checked; your checkout was left untouched. Move or remove it and re-run the installer." }
            if ($ahead.Trim() -ne '') { throw "Error: $InstallDir has local commits; your checkout was left untouched. Move or remove it and re-run the installer." }
            return
        }
        # Fetch (not pull): remotes update, the worktree stays exactly as is.
        try { & git -C $InstallDir fetch --quiet 2>$null; if ($LASTEXITCODE -ne 0) { throw 'fetch failed' } } catch { throw "Error: failed to fetch updates for $InstallDir; your checkout was left untouched." }
        # Fast-forward-only equivalent: refuse when live HEAD diverged from the
        # remote tip. Never check against the staging clone: `--depth 1` has
        # no history of live HEAD, so that check would refuse every update.
        try { & git -C $InstallDir merge-base --is-ancestor HEAD FETCH_HEAD 2>$null; if ($LASTEXITCODE -ne 0) { throw 'diverged' } } catch { throw "Error: $InstallDir has local commits; your checkout was left untouched. Move or remove it and re-run the installer." }
    } elseif ((Test-Path $InstallDir) -and @(Get-ChildItem -Force $InstallDir).Count -gt 0) {
        # A release install has no .git: its marker and package name are what
        # make it ours to replace.
        if ((Test-Path -LiteralPath (Join-Path $InstallDir $OwnershipMarker)) -and (Test-AiandCliPackage (Join-Path $InstallDir 'package.json'))) { return }
        # A pre-existing non-empty directory must fail safely instead of being
        # wiped -- even when it looks like an aiand checkout.
        if (Test-AiandCliPackage (Join-Path $InstallDir 'package.json')) { throw "Error: $InstallDir already exists; your checkout was left untouched. Move or remove it and re-run the installer to reinstall from scratch." } else { throw "Error: $InstallDir is not an aiand checkout; cloning into it failed safely" }
    }
}
function New-StagingDir {
    $parent = Split-Path -Parent $InstallDir
    if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    $suffix = [Guid]::NewGuid().ToString('N').Substring(0, 6)
    $script:StagingDir = (Join-Path $parent ".cli-staging-$PID-$suffix")
    if (Test-Path $script:StagingDir) { Remove-Item -Recurse -Force $script:StagingDir }
}
# Stage 3, clone path (development only): verify the live dir may be replaced,
# then clone SOURCE into a staging sibling. Sets StagingDir; failure exits with
# the old install kept.
function Clone-ToStaging {
    Assert-AllowlistedHttpsUri -Uri $Source
    Assert-InstallDirReplaceable -Mode 'clone'
    New-StagingDir
    try { & git clone --quiet --depth 1 '--' $Source $script:StagingDir 2>$null; if ($LASTEXITCODE -ne 0) { throw 'clone failed' } } catch { throw "error: failed to clone $Source; the existing installation was left unchanged." }
    Set-InstallerOwned -Dir $script:StagingDir
}
# The release helper, run by Node. install.sh embeds the same text between the
# same markers; scripts/install-behavior.mjs asserts they match. Written to a
# file because Windows PowerShell 5.1 strips the quotes out of `node -e`.
$ReleaseHelper = @'
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
'@
# Stage 3, release path: resolve the release, then download, verify, and
# unpack it into a staging sibling. Sets StagingDir and ReleaseVersion; any
# failure throws with the old install untouched.
function Fetch-ReleaseToStaging {
    Assert-InstallDirReplaceable -Mode 'release'
    New-StagingDir
    New-Item -ItemType Directory -Force -Path $script:StagingDir | Out-Null
    $script:DownloadDir = Join-Path ([System.IO.Path]::GetTempPath()) ('aiand-release-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $script:DownloadDir | Out-Null
    $helperPath = Join-Path $script:DownloadDir 'fetch-release.cjs'
    [System.IO.File]::WriteAllText($helperPath, $ReleaseHelper, (New-Object System.Text.UTF8Encoding $false))
    $nodeCmd = (Get-Command node -ErrorAction Stop).Source
    # Windows PowerShell 5.1 drops an empty native argument, so the optional
    # ones go last and are left off when unset.
    $helperArgs = @($helperPath, $ReleasesUrl, $NpmRegistry, $script:StagingDir)
    if ($env:AIAND_VERSION -and $env:AIAND_VERSION.Trim() -ne '') { $helperArgs += $env:AIAND_VERSION.Trim() }
    # The helper refuses to go below the installed version unless AIAND_VERSION
    # names the older one.
    $installedPkg = Read-PackageJson -PkgPath (Join-Path $InstallDir 'package.json')
    if ($installedPkg -and $installedPkg.name -eq '@aiand/cli' -and $installedPkg.version) { $helperArgs += ('--installed=' + ([string]$installedPkg.version).Trim()) }
    # Under redirection, 5.1 turns native stderr into error records, which
    # 'Stop' would throw on: collect both streams and replay stderr as text.
    $ErrorActionPreference = 'Continue'
    $lines = @(& $nodeCmd @helperArgs 2>&1)
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    $version = ''
    foreach ($line in $lines) {
        if ($line -is [System.Management.Automation.ErrorRecord]) { [Console]::Error.WriteLine($line.ToString()) } else { $version = ([string]$line).Trim() }
    }
    if ($code -ne 0 -or $version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') { throw 'error: no verified release was installed; the existing installation was left unchanged.' }
    if (-not (Test-AiandCliPackage (Join-Path $script:StagingDir 'package.json'))) { throw "error: the v$version tarball is not @aiand/cli; the existing installation was left unchanged." }
    Write-Step "Verified @aiand/cli $version against npm's sha512 and the release's SHA256SUMS"
    Set-InstallerOwned -Dir $script:StagingDir
    $script:ReleaseVersion = $version
}
# Stage 5, clone path: swap the staged checkout in for INSTALL_DIR. Runs only
# after the staged build verified; on failure the previous install is restored.
function Activate-StagedInstall {
    param([Parameter(Mandatory = $true)][string]$StagingPath)
    if (Test-Path $InstallDir) {
        $previous = "$InstallDir.prev-$PID"
        if (Test-Path $previous) { $previous = "$previous-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())-$(Get-Random -Maximum 100000)" }
        $script:SwapPrevious = $previous
        try { Move-Item -Force $InstallDir $previous } catch { $script:SwapPrevious = ''; throw 'error: staged aiand verification failed; the existing installation was left unchanged.' }
        try { Move-Item -Force $StagingPath $InstallDir } catch {
            try { Move-Item -Force $previous $InstallDir } catch { throw "error: staged swap failed; previous install is at $previous" }
            $script:SwapPrevious = ''
            throw 'error: staged aiand verification failed; the existing installation was left unchanged.'
        }
        $script:SwapPrevious = ''
        try { if (Test-Path $previous) { Remove-Item -Recurse -Force $previous } } catch { }
    } else {
        try { Move-Item -Force $StagingPath $InstallDir } catch { throw 'error: staged aiand verification failed; the existing installation was left unchanged.' }
    }
    $script:StagingDir = ''
}
# Put the previous install back when an update stopped between the two moves of
# the swap (Ctrl-C, a closed window): InstallDir would be empty, and `aiand`
# with it. Runs from the finally block before anything is deleted.
function Restore-InterruptedSwap {
    if ($script:SwapPrevious -and (Test-Path -LiteralPath $script:SwapPrevious) -and -not (Test-Path -LiteralPath $InstallDir)) {
        try { Move-Item -LiteralPath $script:SwapPrevious -Destination $InstallDir; $script:SwapPrevious = '' } catch { [Console]::Error.WriteLine("error: the update was interrupted and the previous install could not be put back; it is at $($script:SwapPrevious)") }
    }
}
# Folders directly under $Parent whose name starts with $Prefix: real folders
# only, never a link or junction.
function Get-LeftoverDirs {
    param([Parameter(Mandatory = $true)][string]$Parent, [Parameter(Mandatory = $true)][string]$Prefix)
    if (-not (Test-Path -LiteralPath $Parent)) { return @() }
    return @(Get-ChildItem -LiteralPath $Parent -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name.StartsWith($Prefix) -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) })
}
# True when the pid a run put after $Prefix in a folder name is still running:
# the digits alone (cli.prev-1234) or before a '-' and more (.cli-staging-1234-abcdef).
function Test-LeftoverInUse {
    param([Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)][string]$Prefix)
    $rest = $Name.Substring($Prefix.Length)
    if ($rest -notmatch '^(\d+)(-|$)') { return $false }
    return [bool](Get-Process -Id ([int]$Matches[1]) -ErrorAction SilentlyContinue)
}
# A run that was killed between the two moves of the swap leaves the previous
# install beside a missing InstallDir, and no finally block ran. Put it back
# before anything else happens, so `aiand` works again even if this run fails.
function Restore-PreviousInstall {
    if (Test-Path -LiteralPath $InstallDir) { return }
    $leaf = Split-Path -Leaf $InstallDir
    $newest = $null
    foreach ($dir in (Get-LeftoverDirs -Parent (Split-Path -Parent $InstallDir) -Prefix "$leaf.prev-")) {
        if (-not (Test-AiandCliPackage (Join-Path $dir.FullName 'package.json'))) { continue }
        # Another installer is between the two moves of its swap: this is its install,
        # and putting it back would make its second move nest the new one inside it.
        if (Test-LeftoverInUse -Name $dir.Name -Prefix "$leaf.prev-") { continue }
        if (-not $newest -or $dir.LastWriteTimeUtc -gt $newest.LastWriteTimeUtc) { $newest = $dir }
    }
    if (-not $newest) { return }
    try { Move-Item -LiteralPath $newest.FullName -Destination $InstallDir } catch { throw "error: could not put back the previous installation from $($newest.FullName)" }
    Write-Step "Put back the previous installation from $($newest.FullName), which an interrupted update had set aside"
}
# Remove what an earlier run left next to InstallDir: staging folders, and the
# previous install of a swap that did finish (InstallDir is back by now). Only
# real folders that are the installer's own are touched: a staging folder holds
# nothing that is not an @aiand/cli package, a previous install is one. A folder
# a still-running installer is using (its pid is in the name) is left.
function Remove-InstallLeftovers {
    $parent = Split-Path -Parent $InstallDir
    $leaf = Split-Path -Leaf $InstallDir
    $found = @()
    if (Test-Path -LiteralPath $InstallDir) {
        foreach ($dir in (Get-LeftoverDirs -Parent $parent -Prefix "$leaf.prev-")) {
            if (Test-AiandCliPackage (Join-Path $dir.FullName 'package.json')) { $found += , @($dir, "$leaf.prev-") }
        }
    }
    foreach ($dir in (Get-LeftoverDirs -Parent $parent -Prefix '.cli-staging-')) {
        $pkg = Join-Path $dir.FullName 'package.json'
        if ((Test-Path -LiteralPath $pkg) -and -not (Test-AiandCliPackage $pkg)) { continue }
        $found += , @($dir, '.cli-staging-')
    }
    foreach ($item in $found) {
        $dir = $item[0]
        if (Test-LeftoverInUse -Name $dir.Name -Prefix $item[1]) { continue }
        try { Remove-Item -LiteralPath $dir.FullName -Recurse -Force; Write-Step "Removed $($dir.FullName), left behind by an interrupted install" } catch { }
    }
}
# Run the built entry point the way the launcher will, before any launcher is
# written: --version must equal package.json version and --help must exit 0.
function Verify-BuiltCli {
    param([Parameter(Mandatory = $true)][string]$SourceDir, [string]$Want = '')
    $nodeCmd = (Get-Command node -ErrorAction Stop).Source
    $pkgPath = Join-Path $SourceDir 'package.json'
    $entryPath = Join-Path $SourceDir 'dist\index.js'
    $pkg = Read-PackageJson -PkgPath $pkgPath
    $expected = ''
    if ($pkg -and $pkg.version) { $expected = [string]$pkg.version }
    if (-not $expected -or $expected.Trim() -eq '') { throw 'error: staged aiand verification failed; the existing installation was left unchanged.' }
    $expected = $expected.Trim()
    if ($Want -ne '' -and $expected -ne $Want) { throw 'error: staged aiand verification failed; the existing installation was left unchanged.' }
    $actual = ''
    try { $actual = (& $nodeCmd --disable-warning=ExperimentalWarning $entryPath --version 2>$null) } catch { $actual = '' }
    if ("$actual".Trim() -ne $expected) { throw 'error: staged aiand verification failed; the existing installation was left unchanged.' }
    try { & $nodeCmd --disable-warning=ExperimentalWarning $entryPath --help *>$null; if ($LASTEXITCODE -ne 0) { throw 'help failed' } } catch { throw 'error: staged aiand verification failed; the existing installation was left unchanged.' }
}
function Ensure-Build {
    param([Parameter(Mandatory = $true)][string]$SourceDir)
    $entryPath = Join-Path $SourceDir 'dist\index.js'
    if ($env:AIAND_SKIP_BUILD -eq '1' -and (Test-Path $entryPath)) { return }
    Write-Step 'Building aiand...'
    $npmLoglevel = 'error'
    if ($env:AIAND_INSTALL_VERBOSE -eq '1') { $npmLoglevel = 'notice' }
    # --omit=dev would drop the TypeScript compiler the build needs; the CLI
    # itself ships zero runtime dependencies, so node_modules never runs.
    # --prefer-offline reuses the npm cache on a re-run and still hits the
    # network when a package is missing.
    try { Push-Location $SourceDir; try { & npm ci --ignore-scripts --no-fund --no-audit --prefer-offline --loglevel="$npmLoglevel" 2>&1; if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' } } finally { Pop-Location } } catch { throw 'error: staged aiand verification failed; the existing installation was left unchanged.' }
    try {
        Push-Location $SourceDir
        try {
            if ($env:AIAND_INSTALL_VERBOSE -eq '1') { & npm run build --loglevel="$npmLoglevel" 2>&1 } else { & npm run build --loglevel="$npmLoglevel" *>$null }
            if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
        } finally { Pop-Location }
    } catch { throw 'error: staged aiand verification failed; the existing installation was left unchanged.' }
    if (-not (Test-Path $entryPath)) { throw 'error: staged aiand verification failed; the existing installation was left unchanged.' }
}
# Git Bash (MSYS) treats `\` as an escape inside double quotes, so baking
# `C:\Program Files\nodejs\node.exe` into the shim splits on `\n` in
# `\nodejs`. Convert to `/c/...` before writing the bash launcher.
function ConvertTo-UnixPath {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Path)
    if ([string]::IsNullOrEmpty($Path)) { return '' }
    $normalized = $Path.Trim().Replace('\', '/')
    if ($normalized -match '^([A-Za-z]):/(.*)$') {
        return '/' + $Matches[1].ToLowerInvariant() + '/' + $Matches[2]
    }
    return $normalized
}
function Get-GitBash {
    $candidates = @()
    foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ($root) { $candidates += (Join-Path $root 'Git\bin\bash.exe') }
    }
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe') }
    foreach ($p in $candidates) { if ($p -and (Test-Path -LiteralPath $p)) { return $p } }
    try {
        $found = [string]((Get-Command bash -ErrorAction Stop).Source)
        if ($found -and $found -notmatch '(?i)\\Windows\\(System32|SysWOW64)\\bash\.exe$') { return $found }
    } catch { }
    return $null
}
function Set-UnixExecutable {
    param([Parameter(Mandatory = $true)][string]$Path)
    $bashCmd = Get-GitBash
    if (-not $bashCmd) { return }
    $unix = ConvertTo-UnixPath -Path $Path
    if (-not $unix) { return }
    try { & $bashCmd -c "chmod +x `"$unix`"" } catch { }
}
function Install-CliLauncher {
    param([Parameter(Mandatory = $true)][string]$SourceDir)
    $binDir = $BinDir
    $launcherCmd = Join-Path $binDir 'aiand.cmd'
    $launcherBash = Join-Path $binDir 'aiand'
    if (-not (Test-Path $binDir)) { New-Item -ItemType Directory -Force -Path $binDir | Out-Null }
    # Absolute Node path baked in at install time, with a PATH fallback, so
    # the launchers work where `node` is not on PATH.
    $nodeBin = ''
    try { $nodeBin = [string]((Get-Command node -ErrorAction Stop).Source).Trim() } catch { $nodeBin = '' }
    $entryPath = [string](Join-Path $SourceDir 'dist\index.js')
    # Here-strings, not @() + concat: PowerShell's comma operator binds tighter
    # than +, so 'a' + $x + 'b', 'c' becomes an array and -join splits NODE_BIN
    # across lines. WriteAllText (not Out-File): PS 5.1 Out-File wraps to the
    # host buffer width, which is often tiny under redirection.
    $cmdText = @"
@echo off
setlocal DisableDelayedExpansion
REM $($LauncherHeader). Uses the Node binary discovered at install time, falling
REM back to PATH lookup, so aiand works without node on PATH.
REM No nested parentheses: cmd treats ) inside if ( ) as the block closer,
REM even when it belongs to for /f in (...).
set "NODE_BIN=%AIAND_NODE_BIN%"
if "%NODE_BIN%"=="" set "NODE_BIN=$nodeBin"
if exist "%NODE_BIN%" goto :aiand_have_node
REM Not where.exe: it searches the current directory first, so a node.exe
REM in a cloned repo would run. Search PATH only. A hit reached through a
REM relative PATH entry (an empty one, a dot, a bare directory name, a
REM drive-relative C:dir) is a path under the current directory, so accept it
REM only when its directory is itself one of PATH's drive-rooted or UNC
REM entries: the same rule as windowsSearchDirs in src/cli/win-spawn.ts. A node
REM under the current directory is fine when PATH names it in full. Quotes are
REM stripped from the copy of PATH compared against.
set "NODE_BIN="
for %%i in (node.exe) do set "NODE_BIN=%%~`$PATH:i"
if "%NODE_BIN%"=="" goto :aiand_no_node
for %%i in ("%NODE_BIN%") do set "AIAND_NODE_DIR=%%~dpi"
set "AIAND_NODE_PATHS=;%PATH:"=%;"
set "AIAND_NODE_DIR=%AIAND_NODE_DIR:~0,-1%"
call set "AIAND_NODE_HIT=%%AIAND_NODE_PATHS:;%AIAND_NODE_DIR%;=%%"
if not "%AIAND_NODE_HIT%"=="%AIAND_NODE_PATHS%" goto :aiand_have_node
call set "AIAND_NODE_HIT=%%AIAND_NODE_PATHS:;%AIAND_NODE_DIR%\;=%%"
if not "%AIAND_NODE_HIT%"=="%AIAND_NODE_PATHS%" goto :aiand_have_node
:aiand_no_node
echo aiand: Node.js was not found. Install Node $MinNodeVersion+ and re-run the aiand installer. 1>&2
exit /b 1
:aiand_have_node
REM The search variables must not reach aiand's own environment.
set "AIAND_NODE_DIR="
set "AIAND_NODE_PATHS="
set "AIAND_NODE_HIT="
REM --disable-warning keeps node's ExperimentalWarning off aiand's stderr; the
REM flag exists since Node 21.3 and this installer requires $MinNodeMajor+.
"%NODE_BIN%" --disable-warning=ExperimentalWarning "$entryPath" %*
"@
    $nodeBinUnix = ConvertTo-UnixPath -Path $nodeBin
    $entryUnix = ConvertTo-UnixPath -Path $entryPath
    $bashText = @"
#!/usr/bin/env bash
# $($LauncherHeader). Uses the Node binary discovered at install time, falling
# back to PATH lookup, so aiand works without node on PATH.
NODE_BIN="`${AIAND_NODE_BIN:-$nodeBinUnix}"
if ! [ -x "`$NODE_BIN" ]; then
  NODE_BIN="`$(command -v node 2>/dev/null)"
  # A relative hit came from an empty or "." PATH entry: the current directory.
  case "`$NODE_BIN" in /*) ;; *) NODE_BIN="" ;; esac
fi
if [ -z "`$NODE_BIN" ] || ! [ -x "`$NODE_BIN" ]; then
  echo "aiand: Node.js was not found. Install Node $MinNodeVersion+ and re-run the aiand installer." >&2
  exit 1
fi
# --disable-warning keeps node's ExperimentalWarning off aiand's stderr; the
# flag exists since Node 21.3 and this installer requires $MinNodeMajor+.
exec "`$NODE_BIN" --disable-warning=ExperimentalWarning "$entryUnix" "`$@"
"@
    $utf8 = New-Object System.Text.UTF8Encoding $false
    $cmdText = ($cmdText -split "`r?`n") -join "`r`n"
    Refuse-ForeignLauncher -Path $launcherCmd
    Refuse-ForeignLauncher -Path $launcherBash
    [System.IO.File]::WriteAllText($launcherCmd, ($cmdText.Trim() + "`r`n"), $utf8)
    [System.IO.File]::WriteAllText($launcherBash, ($bashText.Trim() + "`n"), $utf8)
    Set-UnixExecutable -Path $launcherBash
    Add-ToUserPath
}

function Get-TrimmedFsPath {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Path)
    if ([string]::IsNullOrEmpty($Path)) { return $Path }
    if ($Path -match '^[A-Za-z]:\\?$') { return $Path.Substring(0, 2) + '\' }
    return $Path.TrimEnd('\', '/')
}
function Get-HomeChildPrefix {
    param([Parameter(Mandatory = $true)][string]$HomePath)
    $trimmed = Get-TrimmedFsPath $HomePath
    if ($trimmed.EndsWith('\') -or $trimmed.EndsWith('/')) { return $trimmed }
    return "$trimmed\"
}
function Get-CanonicalHome {
    try { return (Get-TrimmedFsPath ((Resolve-Path -LiteralPath $UserHome -ErrorAction Stop).Path)) } catch { return (Get-TrimmedFsPath $UserHome) }
}
function Get-CanonicalCheckout {
    param([Parameter(Mandatory = $true)][string]$Checkout)
    try { return (Get-TrimmedFsPath ((Resolve-Path -LiteralPath $Checkout -ErrorAction Stop).Path)) } catch {
        try {
            $parent = Split-Path -Parent $Checkout; $leaf = Split-Path -Leaf $Checkout
            if (-not $parent) { return $Checkout }
            return "$(Get-TrimmedFsPath ((Resolve-Path -LiteralPath $parent -ErrorAction Stop).Path))\$leaf"
        } catch { return $Checkout }
    }
}
# True when Path, or any directory between it and Root, is a link or
# junction. Resolve-Path does not follow them, and Windows PowerShell 5.1's
# Remove-Item -Recurse descends into a junction's target.
function Test-LinkBelow {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Root)
    $rootTrim = (Get-TrimmedFsPath $Root).ToLowerInvariant()
    $current = $Path
    while ($current -and (Get-TrimmedFsPath $current).ToLowerInvariant() -ne $rootTrim) {
        if (Test-Path -LiteralPath $current) {
            try {
                $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
                if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { return $true }
            } catch { return $true }
        }
        $parent = Split-Path -Parent $current
        if (-not $parent -or $parent -eq $current) { return $true }
        $current = $parent
    }
    return $false
}
# True when anything inside Dir is a directory link or junction. Test-LinkBelow
# covers the path above the config dir; this covers what is below it. Windows
# PowerShell 5.1's Remove-Item -Recurse descends into a junction and deletes the
# target's files, and so does Get-ChildItem -Recurse enumerate them, so this
# lists one directory at a time and stops at the first reparse point instead of
# entering it. The purge refuses rather than deleting around a link: shelling
# out to `cmd /c rmdir /s /q` (which does not follow junctions) would delete the
# rest of the tree with a different tool, and a link in aiand's own config
# directory is not something the CLI creates, so it is the user's to look at.
# Only directories matter: a file link is removed as a link, and cloud
# placeholder files carry the same attribute.
function Test-ReparsePointInside {
    param([Parameter(Mandatory = $true)][string]$Path)
    $pending = New-Object System.Collections.Generic.Stack[string]
    $pending.Push($Path)
    while ($pending.Count -gt 0) {
        $dir = $pending.Pop()
        try { $children = @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction Stop) } catch { return $true }
        foreach ($child in $children) {
            if (-not $child.PSIsContainer) { continue }
            if ($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { return $true }
            $pending.Push($child.FullName)
        }
    }
    return $false
}
# A string safe to print: control characters (a profile name or a path can
# carry text from files and errors) become '?'.
function Format-Plain {
    param([string]$Text)
    return [regex]::Replace($Text, '[\x00-\x1f\x7f-\x9f]', '?')
}
# Reads one `aiand logout --json` result (one profile) or `logout --all
# --json` result (a `profiles` array) and returns the profiles whose minted key
# is not confirmed revoked. Pasted keys are not ours to revoke, and a profile
# that was not signed in has nothing to revoke. Anything unreadable counts as
# unconfirmed, so the caller fails closed: text that is not a result; a
# `complete: false` carrying `problems` (the CLI could not read credentials, so
# its rows are not the whole story); and an empty `profiles` list while -Names
# (the profile names credentials.json listed before sign-out) names some,
# which are then returned as unrevoked.
function Get-UnrevokedProfiles {
    param([string]$Json, [string[]]$Names = @())
    $bad = @()
    try { $doc = ($Json | ConvertFrom-Json) } catch { return @('?') }
    if ($null -eq $doc) { return @('?') }
    $rows = @($doc)
    $all = $false
    if ($doc.PSObject.Properties['profiles']) { $all = $true; $rows = @($doc.profiles) }
    if ($doc.PSObject.Properties['complete'] -and $doc.complete -eq $false -and $doc.PSObject.Properties['problems'] -and $null -ne $doc.problems -and @($doc.problems).Count -gt 0) {
        $bad += '(credentials logout --all could not read)'
    }
    if ($all -and $rows.Count -eq 0) {
        foreach ($listed in $Names) { $bad += (Format-Plain ([string]$listed)) }
    }
    foreach ($row in $rows) {
        if ($null -eq $row) { $bad += '?'; continue }
        if ($row.PSObject.Properties['signed_in'] -and $row.signed_in -eq $false) { continue }
        if ($row.source -eq 'pasted-key') { continue }
        if ($row.revoked -eq $true) { continue }
        $label = '?'
        if ($row.profile) { $label = Format-Plain ([string]$row.profile) }
        $bad += $label
    }
    return $bad
}
# The profile names credentials.json lists, as @{ Ok; Names }: no names when the
# file is absent, Ok = $false when it exists but cannot be read, which the
# caller treats as "cannot prove nothing is signed in".
function Get-PurgeCredentialNames {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return @{ Ok = $true; Names = @() } }
    try {
        $text = [System.IO.File]::ReadAllText($Path)
        $doc = ($text | ConvertFrom-Json -ErrorAction Stop)
    } catch { return @{ Ok = $false; Names = @() } }
    if ($null -eq $doc -or $doc -isnot [System.Management.Automation.PSCustomObject]) { return @{ Ok = $false; Names = @() } }
    $names = @()
    foreach ($property in $doc.PSObject.Properties) { $names += (Format-Plain $property.Name) }
    return @{ Ok = $true; Names = $names }
}
# What a `logout --all --json` result says it left on this machine, as lines to
# print: files still holding an ai& key, what it kept or did not recognise in
# the config directory, and its problems. Nothing when it left nothing.
function Get-LogoutLeftovers {
    param([string]$Json)
    $lines = @()
    try { $doc = ($Json | ConvertFrom-Json) } catch { return @() }
    if ($null -eq $doc) { return @() }
    if ($doc.PSObject.Properties['keys_left_on_disk'] -and $null -ne $doc.keys_left_on_disk) {
        foreach ($file in @($doc.keys_left_on_disk)) { $lines += "!!   An ai& key is still in $(Format-Plain ([string]$file)). Open that file and delete the key by hand." }
    }
    if ($doc.PSObject.Properties['config_dir'] -and $null -ne $doc.config_dir) {
        if ($doc.config_dir.PSObject.Properties['kept'] -and $null -ne $doc.config_dir.kept) {
            foreach ($name in @($doc.config_dir.kept)) { $lines += "!!   Kept $(Format-Plain ([string]$name)) in the config directory: it still wires ai& into an agent, or is the sign-in a failed revoke needs." }
        }
        if ($doc.config_dir.PSObject.Properties['left'] -and $null -ne $doc.config_dir.left) {
            foreach ($name in @($doc.config_dir.left)) { $lines += "!!   $(Format-Plain ([string]$name)) in the config directory is not aiand's, so it was left." }
        }
    }
    if ($doc.PSObject.Properties['problems'] -and $null -ne $doc.problems) {
        foreach ($problem in @($doc.problems)) { $lines += "!!   $(Format-Plain ([string]$problem))" }
    }
    return $lines
}
# Prints Get-LogoutLeftovers' lines where they cannot be missed.
function Write-PurgeLeftovers {
    param([string[]]$Lines)
    if (@($Lines).Count -eq 0) { return }
    [Console]::Error.WriteLine('')
    [Console]::Error.WriteLine('!! aiand logout --all did not finish cleaning up. What it left:')
    foreach ($line in $Lines) { [Console]::Error.WriteLine($line) }
    [Console]::Error.WriteLine('')
}
# --purge: sign every profile out through the installed CLI, with stdin fed
# from a pipe so it revokes without asking. A CLI that exits 0 after a failed
# revoke (older ones) would let the purge delete the only credential that can
# revoke the key, so the verdict comes from the JSON each CLI emits, not the
# exit code: every minted key must report revoked, or the purge deletes
# nothing. `logout --all` also strips every agent and deletes snapshots,
# overlays and the config directory (keeping a profile whose revoke failed),
# and refuses to run unconfirmed off a terminal, so it gets --force: --purge is
# the confirmation. It exits non-zero when it left something behind (a kept
# snapshot, a key still in an agent's file): $script:PurgeAllExit carries that
# and $script:PurgeLeftovers what it reported, so the caller deletes no further
# than it kept. An older CLI gets `logout --profile` per profile and the
# caller deletes the directory. Output goes to the host, so the function's only
# output is its verdict.
function Invoke-PurgeSignOut {
    param([Parameter(Mandatory = $true)][string]$Launcher, [Parameter(Mandatory = $true)][string]$ConfigDir)
    # Under redirection, 5.1 turns native stderr into error records, which
    # 'Stop' would throw on.
    $ErrorActionPreference = 'Continue'
    # Read before signing out: logout --all deletes the file, and a CLI that
    # could not read it reports no profiles at all, which must not pass for
    # "nothing was signed in".
    $credentialsPath = Join-Path $ConfigDir 'credentials.json'
    $listed = Get-PurgeCredentialNames -Path $credentialsPath
    if (-not $listed.Ok) {
        [Console]::Error.WriteLine("Error: could not read $credentialsPath, so the installer cannot tell which keys need revoking.")
        return $false
    }
    $help = ''
    try { $help = ('' | & $Launcher logout --help 2>$null | Out-String) } catch { $help = '' }
    if ($help -match '--all') {
        Write-Step 'Signing out of every profile (aiand logout --all)...'
        $result = ''
        try { $result = ('' | & $Launcher logout --all --force --json 2>$null | Out-String) } catch { return $false }
        $script:PurgeAllExit = 1
        if ($null -ne $LASTEXITCODE) { $script:PurgeAllExit = [int]$LASTEXITCODE }
        $script:PurgeLeftovers = @(Get-LogoutLeftovers -Json $result)
        $unrevoked = @(Get-UnrevokedProfiles -Json $result -Names $listed.Names)
        if ($unrevoked.Count -gt 0) {
            [Console]::Error.WriteLine("Error: could not revoke the keys of: $($unrevoked -join ', ').")
            Write-PurgeLeftovers -Lines $script:PurgeLeftovers
            return $false
        }
        if ($script:PurgeAllExit -ne 0) {
            [Console]::Error.WriteLine("Note: aiand logout --all exited $($script:PurgeAllExit) after revoking every key; what it left behind is listed at the end, and the config directory is kept.")
        }
        return $true
    }
    $json = ''
    try { $json = ('' | & $Launcher config profiles --json 2>$null | Out-String) } catch { return $false }
    if ($LASTEXITCODE -ne 0) { return $false }
    try { $parsed = ($json | ConvertFrom-Json) } catch { return $false }
    Write-Step 'Signing out of every profile (aiand logout --profile ...)...'
    $failed = @()
    $seen = @{}
    foreach ($row in $parsed) {
        $name = [string]$row.name
        if ($name -eq '') { continue }
        $seen[$name] = $true
        $result = ''
        try { $result = ('' | & $Launcher logout --profile $name --json 2>$null | Out-String) } catch { $failed += $name; continue }
        if ($LASTEXITCODE -ne 0 -or @(Get-UnrevokedProfiles -Json $result).Count -gt 0) { $failed += $name }
    }
    # A sign-in credentials.json lists but the profile list did not is one this
    # loop never revoked.
    foreach ($listedName in $listed.Names) {
        if (-not $seen.ContainsKey($listedName)) { $failed += $listedName }
    }
    if ($failed.Count -gt 0) {
        [Console]::Error.WriteLine("Error: could not confirm that the key for $($failed -join ', ') was revoked.")
        return $false
    }
    return $true
}
function Uninstall-Cli {
    param([string[]]$UninstallArgs)
    # See the header for the contract. --force skips the agent teardown for
    # broken installs where no working launcher remains.
    $force = $false
    $purge = $false
    foreach ($arg in $UninstallArgs) {
        if ($arg -eq '--force') { $force = $true } elseif ($arg -eq '--purge') { $purge = $true } else { Stop-Installer 'Usage: install.ps1 [update | uninstall [--force] [--purge]]' }
    }
    if ($env:AIAND_UNINSTALL_FORCE -eq '1') { $force = $true }
    $script:PurgeAllExit = 0
    $script:PurgeLeftovers = @()
    $purgeIncomplete = $false
    $homeReal = Get-CanonicalHome
    $binDir = $BinDir
    $launcherCmd = Join-Path $binDir 'aiand.cmd'
    $launcherBash = Join-Path $binDir 'aiand'
    if ($env:AIAND_DIR -and $env:AIAND_DIR.Trim() -ne '') { $checkout = $env:AIAND_DIR.Trim() } else { $checkout = (Join-Path (Join-Path $homeReal '.aiand') 'cli') }
    # AIAND_DIR is user-controlled: canonicalize before comparing, then refuse
    # HOME itself, /, and anything outside HOME.
    $checkout = Get-CanonicalCheckout -Checkout $checkout
    $homeLower = $homeReal.ToLowerInvariant()
    $checkoutLower = $checkout.ToLowerInvariant()
    $homePrefix = (Get-HomeChildPrefix $homeReal).ToLowerInvariant()
    $homePrefixAlt = $homePrefix.Replace('\', '/')
    if ($checkoutLower -eq '/' -or $checkoutLower -eq '\' -or $checkoutLower -eq $homeLower) { Stop-Installer "Error: refusing to remove $checkout; unset AIAND_DIR and re-run." }
    if (-not ($checkoutLower.StartsWith($homePrefix) -or $checkoutLower.StartsWith($homePrefixAlt))) { Stop-Installer "Error: refusing to remove $checkout; it is outside $homeReal." }
    # Identity before teardown AND delete: the checkout must be an @aiand/cli
    # package this installer owns. A hand-cloned checkout must never be removed.
    if ((Test-Path -LiteralPath $checkout) -and -not (Test-AiandCliPackage (Join-Path $checkout 'package.json'))) { Stop-Installer "Error: $checkout is not an aiand checkout; it was left untouched. Remove it manually if you are sure." }
    if ((Test-Path -LiteralPath $checkout) -and -not (Test-InstallerOwned $checkout)) { Stop-Installer "Error: $checkout is not an installer-owned checkout; it was left untouched. Uninstall the installer's checkout (default ~/.aiand/cli) or remove $checkout manually." }
    # Remove-Item -Recurse follows a junction in Windows PowerShell 5.1, so the
    # checkout gets the config directory's link checks, before any teardown: a
    # link at or above it, or inside it, would have the delete reach files
    # outside it.
    if (Test-Path -LiteralPath $checkout) {
        if (Test-LinkBelow -Path $checkout -Root $homeReal) { Stop-Installer "Error: refusing to remove $checkout; it, or a directory between it and $homeReal, is a link or junction. Nothing was deleted." }
        if (Test-ReparsePointInside -Path $checkout) { Stop-Installer "Error: refusing to remove $checkout; a directory inside it is a link or junction, which Windows PowerShell would follow when deleting. Nothing was deleted. Remove the link yourself, then re-run." }
    }
    # Same resolution as the CLI's configDir() (src/fsutil.ts). --purge deletes
    # it, so it gets the checkout's guard plus link and name checks, all before
    # any teardown: a refusal leaves everything in place.
    $configDir = if ($env:AIAND_CONFIG_DIR) { $env:AIAND_CONFIG_DIR } elseif ($env:XDG_CONFIG_HOME) { Join-Path $env:XDG_CONFIG_HOME 'aiand' } else { Join-Path (Join-Path $homeReal '.config') 'aiand' }
    # A config directory that does not exist has nothing to delete or to guard
    # (guarding its spelling would refuse a HOME reached through a link).
    $configExists = Test-Path -LiteralPath $configDir
    if ($purge -and $configExists) {
        $configDir = Get-CanonicalCheckout -Checkout $configDir
        $configLower = $configDir.ToLowerInvariant()
        if ($configLower -eq '/' -or $configLower -eq '\' -or $configLower -eq $homeLower -or -not ($configLower.StartsWith($homePrefix) -or $configLower.StartsWith($homePrefixAlt))) { Stop-Installer "Error: refusing to purge $configDir; it is not strictly inside $homeReal. Nothing was deleted." }
        if ((Split-Path -Leaf $configDir) -ne 'aiand') { Stop-Installer "Error: refusing to purge $configDir; an aiand config directory is named aiand. Nothing was deleted; remove it yourself if you are sure." }
        if (Test-LinkBelow -Path $configDir -Root $homeReal) { Stop-Installer "Error: refusing to purge $configDir; it, or a directory between it and $homeReal, is a link or junction. Nothing was deleted." }
        if (Test-ReparsePointInside -Path $configDir) { Stop-Installer "Error: refusing to purge $configDir; a directory inside it is a link or junction, which Windows PowerShell would follow when deleting. Nothing was deleted. Remove the link yourself, then re-run." }
    }
    if (-not $force) {
        $workingLauncher = ''
        if (Test-Path -LiteralPath $launcherCmd) {
            if (-not (Test-AiandLauncher $launcherCmd)) { Stop-Installer "Error: $launcherCmd was not written by the aiand installer; refusing to run it. Move or remove it and re-run, or bypass agent teardown with --force (AIAND_UNINSTALL_FORCE=1). Nothing was deleted." }
            $workingLauncher = $launcherCmd
        } elseif (Test-Path -LiteralPath $launcherBash) {
            if (-not (Test-AiandLauncher $launcherBash)) { Stop-Installer "Error: $launcherBash was not written by the aiand installer; refusing to run it. Move or remove it and re-run, or bypass agent teardown with --force (AIAND_UNINSTALL_FORCE=1). Nothing was deleted." }
            $workingLauncher = $launcherBash
        }
        if ($workingLauncher -ne '') {
            Write-Step 'Turning agents off...'
            try { & $workingLauncher init --off; if ($LASTEXITCODE -ne 0) { throw 'teardown failed' } } catch { Stop-Installer 'Error: agent teardown failed; nothing was deleted. Fix the failure and re-run, or bypass it with --force (AIAND_UNINSTALL_FORCE=1).' }
            if ($purge -and -not (Invoke-PurgeSignOut -Launcher $workingLauncher -ConfigDir $configDir)) { Stop-Installer 'Error: signing out did not revoke every key, so the installer deleted nothing. Fix the failure and re-run (a profile whose revoke failed is kept where the CLI can retry it), or skip sign-out with --force --purge; the keys are then not revoked, so revoke them at https://console.aiand.com/api-keys.' }
        } else {
            Stop-Installer "Error: no working aiand launcher at $launcherCmd; nothing was deleted. Re-run with --force to remove files without turning agents off."
        }
    }
    $keptLaunchers = @()
    if (Test-Path -LiteralPath $launcherCmd) {
        if (Test-AiandLauncher $launcherCmd) { Remove-Item -LiteralPath $launcherCmd -Force }
        else { $keptLaunchers += $launcherCmd }
    }
    if (Test-Path -LiteralPath $launcherBash) {
        if (Test-AiandLauncher $launcherBash) { Remove-Item -LiteralPath $launcherBash -Force }
        else { $keptLaunchers += $launcherBash }
    }
    if (Test-Path -LiteralPath $checkout) { Remove-Item -LiteralPath $checkout -Recurse -Force }
    try {
        $aiandHome = Join-Path $homeReal '.aiand'
        if ((Test-Path -LiteralPath $aiandHome) -and @(Get-ChildItem -LiteralPath $aiandHome -Force).Count -eq 0) { Remove-Item -LiteralPath $aiandHome -Force }
    } catch { }
    if ($keptLaunchers.Count -gt 0) {
        Write-Output "Removed $checkout."
        foreach ($kept in $keptLaunchers) {
            Write-Output "Kept foreign launcher $kept; remove it manually if you are sure."
        }
    } else {
        Write-Output "Removed launchers and $checkout."
    }
    if ($purge) {
        if ($configExists) {
            # A clean `logout --all` (or none, with --force) leaves the directory to
            # delete, if it is not gone already. One that exited non-zero kept things
            # on purpose (a snapshot an agent still needs, a sign-in a failed revoke
            # needs), so only what it removed or left empty goes.
            if ($script:PurgeAllExit -eq 0) {
                if (Test-Path -LiteralPath $configDir) { Remove-Item -LiteralPath $configDir -Recurse -Force }
                Write-Output "Removed profiles, credentials, and agent snapshots under $configDir."
            } elseif (-not (Test-Path -LiteralPath $configDir)) {
                Write-Output "aiand logout --all already removed $configDir."
            } elseif (@(Get-ChildItem -LiteralPath $configDir -Force).Count -eq 0) {
                Remove-Item -LiteralPath $configDir -Force
                Write-Output "Removed the emptied $configDir."
            } else {
                $purgeIncomplete = $true
                Write-Output "Kept ${configDir}: aiand logout --all exited $($script:PurgeAllExit) and left what is listed below in it. Nothing in it was deleted past what it removed."
            }
        } else {
            Write-Output "There was no config directory at $configDir; nothing to purge there."
        }
        if ($force) { Write-Output 'Note: --force skipped sign-out, so keys this machine minted were not revoked. Revoke them in the console.' }
        if ($env:AIAND_API_KEY) { Write-Output 'Note: AIAND_API_KEY is still set in this session; remove it.' }
        if ($script:PurgeAllExit -ne 0) {
            Write-PurgeLeftovers -Lines $script:PurgeLeftovers
            if ($purgeIncomplete -or @($script:PurgeLeftovers).Count -gt 0) {
                Stop-Installer 'The purge is incomplete: the keys were revoked, but local data remains. Deal with what is listed above by hand.'
            }
        }
        return
    }
    Write-Output "Kept profiles, credentials, and agent snapshots under $configDir."
}
# Run the freshly written launcher, not dist\ directly: this is the command
# the user will type, so it proves the launcher itself works.
function Show-InstalledVersion {
    param([Parameter(Mandatory = $true)][string]$Launcher)
    $version = ''
    try { $version = [string](& $Launcher --version 2>$null) } catch { $version = '' }
    if ($LASTEXITCODE -ne 0 -or $version.Trim() -eq '') { Stop-Installer "error: $Launcher --version failed after install." }
    Write-Step "Installed aiand $($version.Trim()) ($Launcher)"
}
# True iff a person is at a console that can answer the login question. `irm | iex`
# keeps the console attached, so redirection is the signal, not the host.
function Test-CanPrompt {
    if ($env:CI) { return $false }
    if (-not [Environment]::UserInteractive) { return $false }
    try { if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected -or [Console]::IsErrorRedirected) { return $false } } catch { return $false }
    return $true
}
# Ctrl+C at Read-Host stops the whole script, not just the question. Read keys
# with Ctrl+C as plain input instead, so it answers no. $null means there is
# no console to read keys from, and the caller falls back to Read-Host.
function Read-LoginAnswer {
    param([Parameter(Mandatory = $true)][string]$Prompt)
    $saved = $false
    try {
        $saved = [Console]::TreatControlCAsInput
        [Console]::TreatControlCAsInput = $true
    } catch { return $null }
    try {
        [Console]::Error.Write($Prompt)
        $answer = ''
        while ($true) {
            $key = [Console]::ReadKey($true)
            # AltGr arrives as Ctrl+Alt, so a character typed with it is not Ctrl+C.
            $ctrl = ($key.Modifiers -band [ConsoleModifiers]::Control) -ne 0
            $alt = ($key.Modifiers -band [ConsoleModifiers]::Alt) -ne 0
            if ($key.KeyChar -eq [char]3 -or ($ctrl -and -not $alt -and $key.Key -eq [ConsoleKey]::C)) {
                [Console]::Error.WriteLine('^C')
                return 'n'
            }
            if ($key.Key -eq [ConsoleKey]::Enter) {
                [Console]::Error.WriteLine('')
                return $answer
            }
            if ($key.Key -eq [ConsoleKey]::Backspace) {
                if ($answer.Length -gt 0) {
                    $answer = $answer.Substring(0, $answer.Length - 1)
                    [Console]::Error.Write("`b `b")
                }
            } elseif (-not [char]::IsControl($key.KeyChar)) {
                $answer += $key.KeyChar
                [Console]::Error.Write($key.KeyChar)
            }
        }
    } catch {
        [Console]::Error.WriteLine('')
        return 'n'
    } finally {
        try { [Console]::TreatControlCAsInput = $saved } catch { }
    }
}
# Offer the next step instead of printing it. Never fails the install: the CLI
# is already in place, and `aiand login` can always be run later.
function Invoke-LoginOffer {
    param([Parameter(Mandatory = $true)][string]$Launcher)
    # `aiand login` stores nothing while the environment key is the session.
    if ($env:AIAND_API_KEY) {
        Write-Step 'Done. Using the key in AIAND_API_KEY.'
        return
    }
    if (-not (Test-CanPrompt)) {
        Write-Step "Done. Run 'aiand login' to sign in."
        return
    }
    # --local reads the stored session without a network call.
    $whoamiExitCode = 1
    try {
        & $Launcher whoami --local *>$null
        $whoamiExitCode = $LASTEXITCODE
    } catch {
        $whoamiExitCode = 1
    }
    if ($whoamiExitCode -eq 0) {
        Write-Step 'Done. You are already signed in.'
        return
    }
    $answer = Read-LoginAnswer -Prompt 'Log in to ai& now? [Y/n] '
    if ($null -eq $answer) {
        try { $answer = [string](Read-Host 'Log in to ai& now? [Y/n]') } catch { $answer = 'n' }
    }
    if ($answer.Trim() -ne '' -and $answer.Trim() -notmatch '^(?i)y(es)?$') {
        Write-Step "Done. Run 'aiand login' when you are ready."
        return
    }
    # Ctrl+C during login reaches PowerShell too, which can stop the script
    # once login exits. Only `finally` still runs then, and a stopping script
    # may refuse to run commands there, so the line is built beforehand and
    # written with a .NET call.
    $notFinished = Format-Step "Login did not finish. Run 'aiand login' to try again."
    $loginExitCode = 1
    $loginReturned = $false
    try {
        & $Launcher login
        $loginExitCode = $LASTEXITCODE
        $loginReturned = $true
    } catch {
        $loginReturned = $true
    } finally {
        if (-not $loginReturned) { [Console]::Error.WriteLine($notFinished) }
    }
    if ($loginExitCode -eq 0) { Write-Step 'Done.' } else { [Console]::Error.WriteLine($notFinished) }
}
function Invoke-Main {
    param([string[]]$MainArgs)
    $update = $false
    if ($MainArgs.Count -gt 0) {
        if ($MainArgs[0] -eq 'uninstall') {
            $rest = @()
            if ($MainArgs.Count -gt 1) { $rest = $MainArgs[1..($MainArgs.Count - 1)] }
            Uninstall-Cli -UninstallArgs $rest
            return
        }
        if (-not ($MainArgs[0] -eq 'update' -and $MainArgs.Count -eq 1)) { Stop-Installer 'Usage: install.ps1 [update | uninstall [--force] [--purge]]' }
        $update = $true
    }
    # This script's own install directory is the one to replace when it runs
    # from an install (the update notice runs it there), even a custom AIAND_DIR.
    if (-not ($env:AIAND_DIR -and $env:AIAND_DIR.Trim() -ne '') -and $script:ScriptDir -ne '' -and (Test-Path -LiteralPath (Join-Path $script:ScriptDir $OwnershipMarker)) -and (Test-AiandCliPackage (Join-Path $script:ScriptDir 'package.json'))) {
        $script:InstallDir = $script:ScriptDir
    }
    Restore-PreviousInstall
    Remove-InstallLeftovers
    Refuse-ForeignLauncher -Path (Join-Path $BinDir 'aiand.cmd')
    Refuse-ForeignLauncher -Path (Join-Path $BinDir 'aiand')
    Show-AiandIntro
    Write-Stage -Number 1 -Message 'Checking platform and install location'
    Write-Stage -Number 2 -Message 'Checking Node.js'
    Confirm-Toolchain
    $sourceDir = ''
    $fromClone = $false
    $releaseVersion = ''
    # A checkout this script sits in installs itself (development), unless it
    # is the installer's own install, whose copy of this script must fetch a
    # release instead of rebuilding what is already there.
    if (-not $update -and $script:ScriptDir -ne '' -and -not (Test-Path -LiteralPath (Join-Path $script:ScriptDir $OwnershipMarker)) -and (Test-AiandCliPackage (Join-Path $script:ScriptDir 'package.json'))) {
        Write-Stage -Number 3 -Message 'Using the local checkout'
        Confirm-Tools -Tools @('npm')
        $sourceDir = $script:ScriptDir
    } elseif (-not $update -and $Source -ne '') {
        Write-Stage -Number 3 -Message "Cloning $Source (development build, not a verified release)"
        Confirm-Tools -Tools @('git', 'npm')
        Clone-ToStaging
        $sourceDir = $script:StagingDir
        $fromClone = $true
    } else {
        Write-Stage -Number 3 -Message 'Downloading the release'
        Fetch-ReleaseToStaging
        $releaseVersion = $script:ReleaseVersion
        $sourceDir = $script:StagingDir
        $fromClone = $true
    }
    if ($releaseVersion -ne '') {
        Write-Stage -Number 4 -Message 'Verifying'
        Verify-BuiltCli -SourceDir $sourceDir -Want $releaseVersion
    } else {
        Write-Stage -Number 4 -Message 'Building and verifying'
        Ensure-Build -SourceDir $sourceDir
        Verify-BuiltCli -SourceDir $sourceDir
    }
    Write-Stage -Number 5 -Message 'Activating the verified installation'
    $finalDir = ''
    if ($fromClone) { Activate-StagedInstall -StagingPath $sourceDir; $finalDir = $InstallDir } else { $finalDir = $sourceDir }
    Write-Step 'Installing CLI...'
    Install-CliLauncher -SourceDir $finalDir
    Write-InstallNotes
    Write-AgentSummary -SourceDir $finalDir
    # Windows runs the cmd shim. Anywhere else (pwsh on Linux) the shim is not
    # executable, so the version check and the login offer use the bash launcher.
    $launcherName = 'aiand'
    if ($env:OS -eq 'Windows_NT') { $launcherName = 'aiand.cmd' }
    $launcher = Join-Path $BinDir $launcherName
    Show-InstalledVersion -Launcher $launcher
    Invoke-LoginOffer -Launcher $launcher
}
try {
    Invoke-Main -MainArgs $RemainingArgs
} catch {
    # Staged failures already carry the `left unchanged` wording; surface the
    # message exactly and stop without a stack trace. `irm | iex` must not `exit`.
    if ($_.Exception.Message -ne 'AIAND_INSTALLER_STOP') {
        [Console]::Error.WriteLine($_.Exception.Message)
    }
    if ($script:InvokedAsFile) { exit 1 }
} finally {
    Restore-InterruptedSwap
    if ($script:StagingDir -and (Test-Path -LiteralPath $script:StagingDir)) { try { Remove-Item -LiteralPath $script:StagingDir -Recurse -Force } catch { } }
    if ($script:DownloadDir -and (Test-Path -LiteralPath $script:DownloadDir)) { try { Remove-Item -LiteralPath $script:DownloadDir -Recurse -Force } catch { } }
}
