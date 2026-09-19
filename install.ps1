# aiand one-line installer for Windows (PowerShell 5.1+).
#
#   Invoke-RestMethod https://raw.githubusercontent.com/aiandlabs/aiand-cli/main/install.ps1 | Invoke-Expression
#   .\install.ps1
#   .\install.ps1 uninstall [--force]
#
# Clones the CLI into ~/.aiand/cli, builds it with the project's own
# toolchain, and drops `aiand` launchers on PATH via ~/.local/bin.
# Re-running replaces the previous install only after the new build is staged
# and verified -- a failed stage leaves the old install untouched. Nothing
# under ~/.config/aiand (profiles, credentials, agent snapshots) is touched.
#
# `uninstall` turns every aiand-routed agent `off` first (via the installed
# CLI's `aiand init --off`, aborting before deleting anything when off fails
# so snapshots stay retryable), then removes the launchers and checkout.
#
# Knobs (environment only; no flags):
#   AIAND_SOURCE  where to clone from (https URLs must be github.com/aiandlabs/aiand-cli)
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
$DefaultSource = 'https://github.com/aiandlabs/aiand-cli.git'
# Prefer env (USERPROFILE, then HOME) so CI can isolate without relying on
# the automatic $HOME, which PowerShell 5.1 snapshots at process start.
if ($env:USERPROFILE -and $env:USERPROFILE.Trim() -ne '') { $UserHome = $env:USERPROFILE.Trim() } elseif ($env:HOME -and $env:HOME.Trim() -ne '') { $UserHome = $env:HOME.Trim() } else { $UserHome = [string]$HOME }
if ($env:AIAND_SOURCE -and $env:AIAND_SOURCE.Trim() -ne '') { $Source = $env:AIAND_SOURCE.Trim() } else { $Source = $DefaultSource }
if ($env:AIAND_DIR -and $env:AIAND_DIR.Trim() -ne '') { $InstallDir = $env:AIAND_DIR.Trim() } else { $InstallDir = (Join-Path (Join-Path $UserHome '.aiand') 'cli') }
$BinDir = (Join-Path (Join-Path $UserHome '.local') 'bin')
$MinNodeMajor = 22
$MinNodeMinor = 0
$MinNodeVersion = "$MinNodeMajor"
$OwnershipMarker = '.aiand-installer-owned'
$InstallStageTotal = 5
$script:InstallNotes = @()
$script:StagingDir = ''
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
# Diagnostic stream: stderr is the only progress channel, mirroring the CLI.
function Write-Step {
    param([Parameter(Mandatory = $true)][string]$Message)
    $esc = [char]27
    if (Test-SupportsColor) { [Console]::Error.WriteLine("$esc[1;36m==>$esc[0m $Message") } else { [Console]::Error.WriteLine("==> $Message") }
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
    [Console]::Error.WriteLine('  █████████    █████  ██████')
    [Console]::Error.WriteLine('  ███░░░░░███ ░░███   ███░░███')
    [Console]::Error.WriteLine(' ░███    ░███  ░███  ░░██████')
    [Console]::Error.WriteLine(' ░███████████  ░███   ██████')
    [Console]::Error.WriteLine(' ░███░░░░░███  ░███ ░███░░███')
    [Console]::Error.WriteLine(' ░███    ░███  ░███ ░███ ░░███')
    [Console]::Error.WriteLine(' █████   █████ █████░░█████░███')
    [Console]::Error.WriteLine('░░░░░   ░░░░░ ░░░░░  ░░░░░ ░░░')
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
# Only https://github.com/aiandlabs/aiand-cli(.git) may be a URL source.
# Local paths stay allowed: they carry no network trust decision.
function Assert-AllowlistedHttpsUri {
    param([Parameter(Mandatory = $true)][string]$Uri)
    $url = $Uri.Trim()
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
            [Console]::Error.WriteLine("Node.js $MinNodeVersion+ is required to build the CLI.")
        }
        Write-ToolInstructions -Tool "Node.js $MinNodeVersion+"
        Stop-Installer
    }
    foreach ($tool in @('git', 'npm')) {
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
# Best-effort: a read-only checkout must never fail an install over the marker.
function Set-InstallerOwned {
    param([Parameter(Mandatory = $true)][string]$Dir)
    try { 'aiand-cli installer ownership marker' | Out-File -FilePath (Join-Path $Dir $OwnershipMarker) -Encoding ascii -Force } catch { }
}
# Stage 3, clone path: verify the live dir may be replaced, then clone SOURCE
# into a staging sibling. Sets StagingDir; failure exits with old install kept.
function Clone-ToStaging {
    Assert-AllowlistedHttpsUri -Uri $Source
    if (Test-Path (Join-Path $InstallDir '.git')) {
        if (-not (Test-AiandCliPackage (Join-Path $InstallDir 'package.json'))) { throw "Error: $InstallDir is not an aiand checkout; your checkout was left untouched. Move or remove it and re-run the installer." }
        $porcelain = ''
        try { $porcelain = (& git -C $InstallDir status --porcelain 2>$null | Out-String) } catch { $porcelain = '' }
        if ($porcelain.Trim() -ne '') { throw "Error: $InstallDir has local changes; your checkout was left untouched. Commit, stash, or discard them and re-run the installer." }
        # Fetch (not pull): remotes update, the worktree stays exactly as is.
        try { & git -C $InstallDir fetch --quiet 2>$null; if ($LASTEXITCODE -ne 0) { throw 'fetch failed' } } catch { throw "Error: failed to fetch updates for $InstallDir; your checkout was left untouched." }
        # Fast-forward-only equivalent: refuse when live HEAD diverged from the
        # remote tip. Never check against the staging clone: `--depth 1` has
        # no history of live HEAD, so that check would refuse every update.
        try { & git -C $InstallDir merge-base --is-ancestor HEAD FETCH_HEAD 2>$null; if ($LASTEXITCODE -ne 0) { throw 'diverged' } } catch { throw "Error: $InstallDir has local commits; your checkout was left untouched. Move or remove it and re-run the installer." }
    } elseif ((Test-Path $InstallDir) -and @(Get-ChildItem -Force $InstallDir).Count -gt 0) {
        # A pre-existing non-empty directory must fail safely instead of being
        # wiped -- even when it looks like an aiand checkout.
        if (Test-AiandCliPackage (Join-Path $InstallDir 'package.json')) { throw "Error: $InstallDir already exists; your checkout was left untouched. Move or remove it and re-run the installer to reinstall from scratch." } else { throw "Error: $InstallDir is not an aiand checkout; cloning into it failed safely" }
    }
    $parent = Split-Path -Parent $InstallDir
    if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    $suffix = [Guid]::NewGuid().ToString('N').Substring(0, 6)
    $script:StagingDir = (Join-Path $parent ".cli-staging-$suffix")
    if (Test-Path $script:StagingDir) { Remove-Item -Recurse -Force $script:StagingDir }
    try { & git clone --quiet --depth 1 $Source $script:StagingDir 2>$null; if ($LASTEXITCODE -ne 0) { throw 'clone failed' } } catch { throw 'error: staged aiand verification failed; the existing installation was left unchanged.' }
    Set-InstallerOwned -Dir $script:StagingDir
}
# Stage 5, clone path: swap the staged checkout in for INSTALL_DIR. Runs only
# after the staged build verified; on failure the previous install is restored.
function Activate-StagedInstall {
    param([Parameter(Mandatory = $true)][string]$StagingPath)
    if (Test-Path $InstallDir) {
        $previous = "$InstallDir.prev-$PID"
        if (Test-Path $previous) { $previous = "$previous-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())-$(Get-Random -Maximum 100000)" }
        try { Move-Item -Force $InstallDir $previous } catch { throw 'error: staged aiand verification failed; the existing installation was left unchanged.' }
        try { Move-Item -Force $StagingPath $InstallDir } catch {
            try { Move-Item -Force $previous $InstallDir } catch { throw "error: staged swap failed; previous install is at $previous" }
            throw 'error: staged aiand verification failed; the existing installation was left unchanged.'
        }
        try { if (Test-Path $previous) { Remove-Item -Recurse -Force $previous } } catch { }
    } else {
        try { Move-Item -Force $StagingPath $InstallDir } catch { throw 'error: staged aiand verification failed; the existing installation was left unchanged.' }
    }
    $script:StagingDir = ''
}
# Run the built entry point the way the launcher will, before any launcher is
# written: --version must equal package.json version and --help must exit 0.
function Verify-BuiltCli {
    param([Parameter(Mandatory = $true)][string]$SourceDir)
    $nodeCmd = (Get-Command node -ErrorAction Stop).Source
    $pkgPath = Join-Path $SourceDir 'package.json'
    $entryPath = Join-Path $SourceDir 'dist\index.js'
    $pkg = Read-PackageJson -PkgPath $pkgPath
    $expected = ''
    if ($pkg -and $pkg.version) { $expected = [string]$pkg.version }
    if (-not $expected -or $expected.Trim() -eq '') { throw 'error: staged aiand verification failed; the existing installation was left unchanged.' }
    $expected = $expected.Trim()
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
    try { Push-Location $SourceDir; try { & npm ci --no-fund --no-audit --loglevel="$npmLoglevel" 2>&1; if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' } } finally { Pop-Location } } catch { throw 'error: staged aiand verification failed; the existing installation was left unchanged.' }
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
REM aiand launcher. Uses the Node binary discovered at install time, falling
REM back to PATH lookup, so aiand works without node on PATH.
REM No nested parentheses: cmd treats ) inside if ( ) as the block closer,
REM even when it belongs to for /f in (...).
set "NODE_BIN=%AIAND_NODE_BIN%"
if "%NODE_BIN%"=="" set "NODE_BIN=$nodeBin"
if exist "%NODE_BIN%" goto :aiand_have_node
for /f "delims=" %%i in ('where node 2^>nul') do set "NODE_BIN=%%i" & goto :aiand_have_node
echo aiand: Node.js was not found. Install Node $MinNodeVersion+ and re-run the aiand installer. 1>&2
exit /b 1
:aiand_have_node
REM --disable-warning silences node's ExperimentalWarning for node:sqlite; the
REM flag exists since Node 21.3 and this installer requires $MinNodeMajor+.
"%NODE_BIN%" --disable-warning=ExperimentalWarning "$entryPath" %*
"@
    $nodeBinUnix = ConvertTo-UnixPath -Path $nodeBin
    $entryUnix = ConvertTo-UnixPath -Path $entryPath
    $bashText = @"
#!/usr/bin/env bash
# aiand launcher. Uses the Node binary discovered at install time, falling
# back to PATH lookup, so aiand works without node on PATH.
NODE_BIN="`${AIAND_NODE_BIN:-$nodeBinUnix}"
[ -x "`$NODE_BIN" ] || NODE_BIN="`$(command -v node 2>/dev/null)"
if [ -z "`$NODE_BIN" ] || ! [ -x "`$NODE_BIN" ]; then
  echo "aiand: Node.js was not found. Install Node $MinNodeVersion+ and re-run the aiand installer." >&2
  exit 1
fi
# --disable-warning silences node's ExperimentalWarning for node:sqlite; the
# flag exists since Node 21.3 and this installer requires $MinNodeMajor+.
exec "`$NODE_BIN" --disable-warning=ExperimentalWarning "$entryUnix" "`$@"
"@
    $utf8 = New-Object System.Text.UTF8Encoding $false
    $cmdText = ($cmdText -split "`r?`n") -join "`r`n"
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
function Uninstall-Cli {
    param([string[]]$UninstallArgs)
    # `.\install.ps1 uninstall [--force]`: turn agents `off` first (aborting
    # before deleting anything when off fails), then remove launchers and the
    # checkout. Profiles, credentials, snapshots under ~/.config/aiand kept.
    # --force (or AIAND_UNINSTALL_FORCE=1) skips teardown for broken installs.
    $force = $false
    foreach ($arg in $UninstallArgs) {
        if ($arg -eq '--force') { $force = $true } else { Stop-Installer 'Usage: install.ps1 [uninstall [--force]]' }
    }
    if ($env:AIAND_UNINSTALL_FORCE -eq '1') { $force = $true }
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
    if (-not $force) {
        $workingLauncher = ''
        if (Test-Path -LiteralPath $launcherCmd) { $workingLauncher = $launcherCmd } elseif (Test-Path -LiteralPath $launcherBash) { $workingLauncher = $launcherBash }
        if ($workingLauncher -ne '') {
            Write-Step 'Turning agents off...'
            try { & $workingLauncher init --off; if ($LASTEXITCODE -ne 0) { throw 'teardown failed' } } catch { Stop-Installer 'Error: agent teardown failed; nothing was deleted. Fix the failure and re-run, or bypass it with --force (AIAND_UNINSTALL_FORCE=1).' }
        } else {
            Stop-Installer "Error: no working aiand launcher at $launcherCmd; nothing was deleted. Re-run with --force to remove files without turning agents off."
        }
    }
    if (Test-Path -LiteralPath $launcherCmd) { Remove-Item -LiteralPath $launcherCmd -Force }
    if (Test-Path -LiteralPath $launcherBash) { Remove-Item -LiteralPath $launcherBash -Force }
    if (Test-Path -LiteralPath $checkout) { Remove-Item -LiteralPath $checkout -Recurse -Force }
    try {
        $aiandHome = Join-Path $homeReal '.aiand'
        if ((Test-Path -LiteralPath $aiandHome) -and @(Get-ChildItem -LiteralPath $aiandHome -Force).Count -eq 0) { Remove-Item -LiteralPath $aiandHome -Force }
    } catch { }
    $configDir = Join-Path $homeReal '.config\aiand'
    Write-Output "Removed launchers and $checkout."
    Write-Output "Kept profiles, credentials, and agent snapshots under $configDir."
}
function Invoke-Main {
    param([string[]]$MainArgs)
    if ($MainArgs.Count -gt 0) {
        if ($MainArgs[0] -eq 'uninstall') {
            $rest = @()
            if ($MainArgs.Count -gt 1) { $rest = $MainArgs[1..($MainArgs.Count - 1)] }
            Uninstall-Cli -UninstallArgs $rest
            return
        }
        Stop-Installer 'Usage: install.ps1 [uninstall [--force]]'
    }
    Show-AiandIntro
    Write-Stage -Number 1 -Message 'Checking platform and install location'
    Write-Stage -Number 2 -Message 'Checking Node.js, git, and npm'
    Confirm-Toolchain
    $sourceDir = ''
    $fromClone = $false
    if ($script:ScriptDir -ne '' -and (Test-AiandCliPackage (Join-Path $script:ScriptDir 'package.json'))) {
        Write-Stage -Number 3 -Message 'Fetching source'
        Write-Step 'Using local checkout'
        $sourceDir = $script:ScriptDir
    } else {
        Write-Stage -Number 3 -Message 'Fetching source'
        Clone-ToStaging
        $sourceDir = $script:StagingDir
        $fromClone = $true
    }
    Write-Stage -Number 4 -Message 'Building and verifying'
    Ensure-Build -SourceDir $sourceDir
    Verify-BuiltCli -SourceDir $sourceDir
    Write-Stage -Number 5 -Message 'Activating the verified installation'
    $finalDir = ''
    if ($fromClone) { Activate-StagedInstall -StagingPath $sourceDir; $finalDir = $InstallDir } else { $finalDir = $sourceDir }
    Write-Step 'Installing CLI...'
    Install-CliLauncher -SourceDir $finalDir
    Write-InstallNotes
    Write-Step "Done. Run 'aiand --version' to check the install."
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
    if ($script:StagingDir -and (Test-Path -LiteralPath $script:StagingDir)) { try { Remove-Item -LiteralPath $script:StagingDir -Recurse -Force } catch { } }
}
