**English** | [日本語](windows-key-storage.ja.md)

# Windows key storage: cost, risks, and a test plan

How the Windows DPAPI tier works is in `CONTEXT.md` (Storage tier) and the
README (Where your key is stored). This note is for whoever has to run it on a real
fleet.

## What a read costs

DPAPI is reached through Windows PowerShell 5.1 (`powershell.exe -NoProfile
-NonInteractive -Command ...`, secret on stdin only). There is no native
module. So:

- Each **cold read** (a fresh `aiand` process that needs the key) starts one
  PowerShell. Each **write** starts one. Windows PowerShell 5.1 is
  .NET Framework, not Node: on a cold machine, or one running endpoint
  security that scans process starts, that start can take a second or more
  (`DPAPI_TIMEOUT_MS` allows 20 s).
- Within one process the plaintext is cached (`dpapiPlaintext` in
  `src/secrets.ts`), keyed by the ciphertext it came from: a store followed by
  reads, or many reads, start PowerShell once, and a read after another
  process rewrote the store (a token rotation, a sign-out) decrypts afresh
  instead of returning the old blob. `test/secrets-windows.test.mjs` pins this ("what a DPAPI
  read costs").
- Codex runs `aiand key export` as an auth command **per session**, and each
  is a new process, so each pays one cold read. That is the cost to watch.
- The cache is memory only. **Do not add an on-disk plaintext cache** to hide
  this cost: it would hold the key with nothing but file permissions
  protecting it, which is what the DPAPI tier exists to avoid. A test fails
  if any file under the config folder holds the key.
- A file-tier key whose DPAPI migration failed is remembered in
  `credentials.json`, so a PowerShell that hangs costs one 20 s wait and not
  one per process (every Codex session is a new process). Constrained Language
  Mode is recorded as `storage_fallback: "clm"` and not retried on read,
  because it is policy. Anything else (a timeout, a PowerShell that would not
  start) is recorded as `storage_fallback: "unavailable"` with
  `dpapi_retry_after`, ten minutes ahead; reads leave the key in the file until
  then, and `aiand status` says why. A retry time more than ten minutes away is
  a clock that was set back and is ignored. The next sign-in tries DPAPI
  whatever is recorded, and so does a token refresh, which saves the key.
  `AIAND_KEY_STORAGE=file` stops aiand trying at all.

## Rolling back

A key that has moved into DPAPI is invisible to an older aiand: it finds
nothing in the file store, so its `aiand logout` prints "not signed in" and
neither revokes the session nor clears it, and the refresh token stays in
`secret-store.dpapi.json`. Run `aiand logout` **before** downgrading. Signing in
again after the downgrade is not enough: the old session is still valid on the
server, and its token is still in the DPAPI store.

## Owner-only ACLs

The config folder, the key stores and the throwaway dirs that hold a key for
a launched agent are restricted to the current user. `/inheritance:r` drops
only entries marked inherited, and `/grant:r` replaces only the user's own
entry, so an entry for SYSTEM or Administrators that is set directly on the
folder (a folder made by an elevated process, or the temp folder of a
GitHub-hosted runner) survives both. aiand therefore lists the ACL after
granting and removes every other principal. The `installer-windows` job's
smoke script asserts the result with real `icacls`.

One thing no ACL change can do: a handle another process opened before the
restriction keeps the access it was granted then, because Windows checks the
ACL only when a handle is opened. For the throwaway dirs, aiand restricts the
folder before writing anything, then refuses it if it is not still empty, and
creates each file exclusively, so a file planted or held open under the
inherited ACL is refused rather than written through. On a machine where
`TEMP` is a folder other users can write to, point it somewhere only you can.

## Endpoint security and AMSI

The `-Command` text names `[System.Security.Cryptography.ProtectedData]` and
calls `Unprotect`, and it receives base64 on stdin. That shape resembles
credential-dumping tooling, so Microsoft Defender, a third-party EDR, or AMSI
may flag or block it. A block looks to aiand like any PowerShell failure:
`unavailable`. What happens next depends on whether aiand was writing or
reading:

- **On a write** (`aiand login`, a token refresh), the key is saved to the
  owner-only file with a warning, and DPAPI is tried again on the next save.
- **On a read** of a key already in DPAPI, nothing new can be written. aiand
  uses a copy in the owner-only file if there is one (a key whose move into
  DPAPI was interrupted leaves one); otherwise it warns that DPAPI could not
  decrypt the stored key and you are signed out until you run `aiand login`
  again.

What we do not do: obfuscate the script or build the type name from pieces to
slip past a scanner. A detection is a signal the user's security team should
see, and an allow-list entry is theirs to grant.

Mitigations that exist:

- `AIAND_KEY_STORAGE=file` makes new writes skip DPAPI and PowerShell (with
  `AIAND_SECRET_STORE_MASTER_KEY` the file is encrypted against a copy of the
  folder). The fallback warning names it. It does not stop PowerShell from
  starting to **read** a key that is already in DPAPI: a profile records its
  tier when it signs in. To move a profile off DPAPI, unset `AIAND_API_KEY`,
  set `AIAND_KEY_STORAGE=file`, and run `aiand login --force` for that
  profile. The sign-in can still start PowerShell once, to read the old key.
- The command line is stable and identifiable: always
  `<SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile
  -NonInteractive -Command <dpapiScript>`, never `-ExecutionPolicy Bypass`,
  never `-EncodedCommand`, no secret in argv or the environment. A security
  team can allow-list on that.

## Test plan on a real Windows machine

> **Use PowerShell 7 for this plan.** The commands below, like the other
> PowerShell commands in aiand's docs, are written for PowerShell 7 (`pwsh`).
> Windows PowerShell 5.1 only receives security fixes, and Microsoft recommends
> installing PowerShell 7:
> <https://learn.microsoft.com/powershell/scripting/install/install-powershell-on-windows>
> (Windows PowerShell 5.1 prints <https://aka.ms/PSWindows>, which leads
> there, each time it starts). This is about the shell you type into. aiand
> still drives Windows PowerShell 5.1 for DPAPI, which ships with Windows and
> needs no install, and `install.ps1`, including the `irm … | iex` one-liner,
> keeps running on 5.1.
>
> None of these steps may print the key: `aiand key export` writes it to
> standard output, so each use below discards that output and reads
> `$LASTEXITCODE` instead. Do not paste the key into a ticket or a transcript.

Everything above is stub-tested on macOS and Linux. The unit suite cannot see
Defender, AMSI, or real DPAPI timing. Before a release that changes this tier,
on Windows 11 with Defender real-time protection ON and default cloud
protection:

1. `npm ci && npm run build && node scripts/windows-secrets-smoke.mjs`: real
   DPAPI round trip, ACLs, and the Constrained Language Mode fallback. The
   `installer-windows` CI job runs this on `windows-latest`, which has
   Defender on, so a detection there fails the job.
2. `aiand login`, then `aiand status`: expect `storage  Windows DPAPI`. No
   Defender notification, and nothing under Protection history.
3. Time a cold read, three times, after a reboot and again warm. Record both.
   Compare with `AIAND_KEY_STORAGE=file`:
   `Measure-Command { aiand key export | Out-Null; if ($LASTEXITCODE -ne 0) { throw "key export exited $LASTEXITCODE" } }`.
4. Run 10 `aiand key export` processes at once:
   `1..10 | ForEach-Object -ThrottleLimit 10 -Parallel { aiand key export | Out-Null; $LASTEXITCODE }`
   prints one exit code per process. All must be `0`, and `credentials.json`
   and both key stores must be intact.
5. Defender with Controlled folder access, Attack surface reduction rules
   (block credential stealing from LSASS; block process creations from
   PSExec/WMI; block obfuscated scripts), and Tamper protection on: repeat
   steps 2 and 3. Any ASR audit event for `powershell.exe` with aiand as
   the parent goes in the report.
6. Defender Advanced Hunting or Event Viewer (Microsoft-Windows-Windows
   Defender/Operational, AMSI events): confirm no detection naming
   `ProtectedData`.
7. Block it on purpose: add a Defender custom indicator that blocks
   `powershell.exe` launched by `node.exe`, or set `__PSLockdownPolicy=4`
   machine-wide (`setx /M __PSLockdownPolicy 4`, then a new session). A
   process-level value has no effect on Server 2022's Windows PowerShell, which
   is why the smoke script skips its lockdown leg there.
   Then sign in again with `aiand login` to see the fallback: a one-line
   warning, the key in the owner-only file, `aiand status` showing
   `file (owner-only, ...)`, and, for the lockdown case, the Constrained
   Language Mode note. (A key already in DPAPI does not move on its own while
   PowerShell is blocked: a read of it says it could not be decrypted and
   asks you to sign in again, as above.) Remove the block and run
   `aiand login` again: the key goes back into DPAPI.
8. Shared folder: with the config folder shared with WSL
   (`AIAND_CONFIG_DIR=/mnt/c/Users/<you>/.config/aiand`), `aiand status` in
   WSL after a Windows sign-in says the key was stored with Windows DPAPI and
   to sign in again, and starts no process.
9. Repeat 2 and 3 with a third-party EDR if the fleet has one.

If step 2 or 6 shows a detection, hold the release; talk to the security team
about an allow-list entry for the command line above before changing code.
