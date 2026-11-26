"""Fail a PR that changes a path listed in CODEOWNERS unless, for every such path,
a code owner of that path wrote the PR (a person, not a bot) or approved its
latest commit. CODEOWNERS is read from the PR's base commit, so a PR cannot edit
the list to pass itself."""

import base64
import json
import os
import re
import subprocess
import sys

REPO = os.environ["REPO"]
PR = os.environ["PR"]


def gh(path):
    out = subprocess.run(
        ["gh", "api", "--paginate", "--slurp", path],
        check=True, capture_output=True, text=True,
    ).stdout
    pages = json.loads(out)
    if pages and isinstance(pages[0], list):
        return [item for page in pages for item in page]
    return pages[0]


def pattern_to_regex(pattern):
    """CODEOWNERS (gitignore-style) pattern to a regex over repo-relative paths.
    `**` spans directories, `*` and `?` stay within one segment, a trailing `/`
    or a wildcard-free last segment matches everything below, and a last segment
    with a wildcard matches only at that level."""
    anchored = pattern.startswith("/") or "/" in pattern.rstrip("/")
    body = pattern.strip("/")
    directory = pattern.endswith("/")
    out, i = [], 0
    while i < len(body):
        if body.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif body.startswith("**", i):
            out.append(".*")
            i += 2
        elif body[i] == "*":
            out.append("[^/]*")
            i += 1
        elif body[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(body[i]))
            i += 1
    rx = "".join(out)
    last = body.rsplit("/", 1)[-1]
    if directory:
        rx += "/.*"
    elif not any(c in last for c in "*?"):
        rx += "(?:/.*)?"
    return re.compile(("^" if anchored else "^(?:.*/)?") + rx + "$")


class Unresolvable(Exception):
    pass


def parse_codeowners(text):
    """Rules as (regex, owners). owners is None for an explicitly ownerless rule.
    Team and email owners can't be resolved with this job's token, so they are
    kept and can never be satisfied: the check fails closed for such paths."""
    rules = []
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        pattern, *owners = line.split()
        rules.append((pattern_to_regex(pattern), {o.lstrip("@").lower() for o in owners} or None))
    return rules


def owners_for(path, rules):
    found = None
    for rx, owners in rules:  # last match wins, as in GitHub
        if rx.match(path):
            found = owners
    return found


def safe(text):
    return text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A").replace(":", "%3A")


def main():
    pr = gh(f"repos/{REPO}/pulls/{PR}")
    base_sha = pr["base"]["sha"]
    head_sha = pr["head"]["sha"]
    author = pr["user"]["login"].lower()
    author_is_person = pr["user"]["type"] == "User"

    blob = gh(f"repos/{REPO}/contents/.github/CODEOWNERS?ref={base_sha}")
    rules = parse_codeowners(base64.b64decode(blob["content"]).decode())

    paths = set()
    for f in gh(f"repos/{REPO}/pulls/{PR}/files?per_page=100"):
        paths.add(f["filename"])
        if f.get("previous_filename"):
            paths.add(f["previous_filename"])
    owned = {p: o for p in sorted(paths) if (o := owners_for(p, rules))}

    if not owned:
        print("No protected path changed.")
        return 0

    latest = {}
    for r in gh(f"repos/{REPO}/pulls/{PR}/reviews?per_page=100"):
        if r["state"] in ("APPROVED", "CHANGES_REQUESTED", "DISMISSED"):
            latest[r["user"]["login"].lower()] = r
    approvers = {
        u for u, r in latest.items()
        if r["state"] == "APPROVED" and r["commit_id"] == head_sha and u != author
    }

    missing = []
    for path, owners in owned.items():
        if author_is_person and author in owners:
            print(f"{safe(path)}: written by owner {author}")
        elif owners & approvers:
            print(f"{safe(path)}: approved by {', '.join(sorted(owners & approvers))}")
        else:
            missing.append((path, owners))

    if not missing:
        return 0
    for path, owners in missing:
        print(f"::error::{safe(path)} needs approval of {head_sha[:12]} from one of: {safe(', '.join(sorted(owners)))}")
    print("After an approval, re-run this job from the PR's checks.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
