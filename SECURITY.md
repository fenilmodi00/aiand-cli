# Security Policy

## Reporting a vulnerability

Report it privately through
[GitHub Security Advisories](https://github.com/aiandlabs/aiand-cli/security/advisories/new)
for this repository. Do not open a public issue.

Please include:

- what an attacker can do, and what they need first
- steps to reproduce, or a proof of concept
- the affected version (`aiand --version`), OS, and key storage tier
  (`aiand status`)
- any mitigation you know of

Fixes ship in the latest release only; there are no backport branches before
`1.0`.

## Trust boundary

`aiand` runs as the local user, inside that user's trust boundary. It stores
an API key and writes it into coding-agent configs, so be precise about what
is in scope.

In scope:

- a key leaking outside the user's own account: into logs, error output,
  crash reports, process arguments other users can read, or world-readable
  files
- a stored credential (key or refresh token) sent anywhere but the endpoint
  that issued it
- the key shown on screen: in prompts, echoed input, or error messages
- a key written somewhere the documentation does not say it goes
- a file or directory created with broader permissions than documented
- running `aiand` in an untrusted current directory or cloned repository,
  where a program or a project-level agent config planted there gets run or
  followed instead of the user's own
- server- or model-controlled bytes reaching the terminal as control
  sequences
- the installers (`install.sh`, `install.ps1`) writing, deleting, or executing
  outside their documented paths
- the integrity of releases, the installers, and the update path, and the
  secrets held by CI
- sign-in flaws: device-code phishing that the CLI could have prevented, or
  accepting a token for the wrong account or organization

Out of scope:

- anything that needs prior write access to the user's home directory, shell
  startup files, environment, `~/.config/aiand`, or an agent's config. That
  access already controls every tool the user runs.
- reading the encrypted file tier's key: `secret-store.key` sits next to
  `secret-store.json` by design. That tier guards against a casual read, not
  against someone who can read the config directory (see the README).
- the key being readable in an agent's config after `aiand <agent> on`. The
  agent needs it there; `aiand <agent> off` removes it.
- `AIAND_KEY_STORAGE=plaintext`, which stores the key in plaintext on request
- vulnerabilities in the coding agents themselves (report those upstream)

## Shared and loaner computers

The trust boundary is the operating-system account, not the person. Anyone
who can sign in to the same account can use what `aiand` stored there. Before
you hand a machine back, run `aiand logout --all`, or the installer's
`uninstall --purge`. Both try to revoke the keys `aiand` minted and stop if
revocation fails. Neither can revoke a key you pasted in: revoke that one in
the ai& console.
