// publish.yml's pack step: a resumed run must publish the bytes the first run
// packed, not whatever `npm pack` produces today. The step's own shell runs
// here against a stub `gh` (a directory standing in for the draft release) and
// a stub `npm`, so nothing reaches a network. The release step gets the same
// treatment: it must not publish a draft that holds anything it did not attach.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");
const workflow = readFileSync(join(root, ".github", "workflows", "publish.yml"), "utf8");

const STEP = /- name: Pack the release tarball and SHA256SUMS\n {8}run: \|\n([\s\S]*?)\n {8}env:/
  .exec(workflow)?.[1]
  .replace(/^ {10}/gm, "");

const TGZ = "aiand-cli-1.2.3.tgz";
const SHA = "1111111111111111111111111111111111111111";

/** Run the pack step. `draft` is the release a previous run left: { asset, packedFrom } or null. */
function packStep({ draft = null, resume = false } = {}) {
  assert.ok(STEP, "found the pack step in publish.yml");
  const dir = mkdtempSync(join(tmpdir(), "aiand-publish-"));
  try {
    const bin = join(dir, "bin");
    const release = join(dir, "release-state");
    const out = join(dir, "tmp", "release");
    const log = join(dir, "calls.log");
    mkdirSync(bin);
    mkdirSync(release);
    mkdirSync(join(dir, "tmp"));
    if (draft) {
      writeFileSync(join(release, "exists"), "");
      writeFileSync(
        join(release, "body"),
        draft.packedFrom ? `packed-from: ${draft.packedFrom}` : "",
      );
      if (draft.asset !== undefined) writeFileSync(join(release, TGZ), draft.asset);
    }
    const script = (name, body) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    script(
      "gh",
      [
        `echo "gh $*" >> "${log}"`,
        `R="${release}"`,
        'case "$1 $2" in',
        '  "release view")',
        '    [ -e "$R/exists" ] || exit 1',
        '    case "$*" in',
        `      *assets*) [ -e "$R/${TGZ}" ] && echo true || echo false ;;`,
        '      *body*) cat "$R/body" ;;',
        "    esac ;;",
        '  "release download") cp "$R/$5" "$7/$5" ;;',
        `  "release upload") cp "$4" "$R/"; touch "$R/exists" ;;`,
        '  "release edit") printf "%s" "$5" > "$R/body" ;;',
        `  "release delete-asset") rm -f "$R/$4" ;;`,
        '  "release create")',
        '    touch "$R/exists"',
        "    while [ $# -gt 0 ]; do",
        '      case "$1" in --notes) printf "%s" "$2" > "$R/body"; shift ;; *.tgz) cp "$1" "$R/" ;; esac',
        "      shift",
        "    done ;;",
        "esac",
      ].join("\n"),
    );
    script(
      "npm",
      [
        `echo "npm $*" >> "${log}"`,
        // $4 is the --pack-destination directory
        `printf 'packed-by-today-npm' > "$4/${TGZ}"`,
      ].join("\n"),
    );
    script("sha256sum", 'shasum -a 256 "$@"');
    const run = spawnSync("bash", ["-c", STEP], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        GITHUB_REF_NAME: "v1.2.3",
        GITHUB_SHA: SHA,
        RUNNER_TEMP: join(dir, "tmp"),
        ...(resume ? { RESUME: "1" } : {}),
      },
    });
    const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);
    return {
      status: run.status,
      stderr: run.stderr,
      stdout: run.stdout,
      calls: (read(log) ?? "").trim().split("\n").filter(Boolean),
      tarball: read(join(out, TGZ)),
      draftAsset: read(join(release, TGZ)),
      draftBody: read(join(release, "body")),
      sums: read(join(out, "SHA256SUMS")),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a first run packs, and uploads the tarball to a draft release before anything publishes", () => {
  const r = packStep();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.tarball, "packed-by-today-npm");
  assert.equal(r.draftAsset, "packed-by-today-npm");
  assert.equal(r.draftBody, `packed-from: ${SHA}`);
  assert.ok(r.calls.some((c) => c.startsWith("gh release create v1.2.3 --verify-tag --draft")));
  assert.match(r.sums ?? "", new RegExp(`${TGZ}\\n`));
});

test("a resumed run publishes the bytes the first run uploaded, not a fresh pack", () => {
  const r = packStep({ draft: { asset: "packed-by-first-run", packedFrom: SHA }, resume: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.tarball, "packed-by-first-run");
  assert.ok(!r.calls.some((c) => c.startsWith("npm pack")), r.calls.join(" | "));
});

test("a first run packs from the checkout and accepts a leftover asset only when it is the same bytes", () => {
  const r = packStep({ draft: { asset: "packed-by-today-npm", packedFrom: SHA } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.tarball, "packed-by-today-npm");
  assert.ok(
    r.calls.some((c) => c.startsWith("npm pack")),
    r.calls.join(" | "),
  );
  assert.ok(!r.calls.some((c) => c.startsWith("gh release upload")));
  assert.ok(!r.calls.some((c) => c.startsWith("gh release delete-asset")));
});

for (const [label, packedFrom] of [
  ["whose release notes name this commit", SHA],
  ["packed from another commit", "2".repeat(40)],
  ["with no packed-from line", ""],
]) {
  test(`a first run stops on a leftover asset that differs from its own pack, ${label}`, () => {
    const r = packStep({ draft: { asset: "bytes-someone-else-attached", packedFrom } });
    assert.notEqual(r.status, 0);
    assert.match(
      r.stderr + r.stdout,
      /already holds aiand-cli-1\.2\.3\.tgz .* differs from what this checkout packs/,
    );
    assert.ok(r.calls.some((c) => c.startsWith("npm pack")));
    assert.equal(r.draftAsset, "bytes-someone-else-attached", "the asset is left alone");
    assert.ok(
      !r.calls.some((c) => /^gh release (upload|delete-asset|edit)/.test(c)),
      r.calls.join(" | "),
    );
    assert.equal(r.sums, null, "no SHA256SUMS is written for bytes that were not checked");
  });
}

test("a tag moved after the publish stops the run instead of repacking", () => {
  const r = packStep({
    draft: { asset: "packed-from-old-commit", packedFrom: "2".repeat(40) },
    resume: true,
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /tag moved after the publish/);
  assert.ok(!r.calls.some((c) => c.startsWith("npm pack")));
});

test("a resume with nothing to reuse packs again and uploads nothing", () => {
  const r = packStep({ resume: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.tarball, "packed-by-today-npm");
  assert.ok(!r.calls.some((c) => /^gh release (create|upload|edit)/.test(c)), r.calls.join(" | "));
});

const RELEASE_STEP = /- name: Create the GitHub release\n {8}run: \|\n([\s\S]*?)\n {8}env:/
  .exec(workflow)?.[1]
  .replace(/^ {10}/gm, "");

const OWN_ASSETS = [TGZ, "SHA256SUMS", "install.sh", "install.ps1"];

/**
 * Run the release step against a stub `gh`. `draft` is the assets already on a
 * draft release (the pack step uploaded the tarball), or null for no release.
 */
function releaseStep({ draft }) {
  assert.ok(RELEASE_STEP, "found the release step in publish.yml");
  const dir = mkdtempSync(join(tmpdir(), "aiand-release-"));
  try {
    const bin = join(dir, "bin");
    const assets = join(dir, "assets");
    const out = join(dir, "tmp", "release");
    const log = join(dir, "calls.log");
    mkdirSync(bin);
    mkdirSync(assets);
    mkdirSync(out, { recursive: true });
    for (const name of ["SHA256SUMS", "install.sh", "install.ps1"])
      writeFileSync(join(out, name), `fresh ${name}`);
    if (draft) {
      writeFileSync(join(dir, "exists"), "");
      for (const name of draft) writeFileSync(join(assets, name), `attached ${name}`);
    }
    const script = (name, body) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    script(
      "gh",
      [
        `echo "gh $*" >> "${log}"`,
        `A="${assets}"`,
        'case "$1 $2" in',
        '  "release view")',
        `    [ -e "${dir}/exists" ] || exit 1`,
        '    case "$*" in *assets*) ls "$A" ;; esac ;;',
        '  "release upload") shift 3; for f in "$@"; do case "$f" in --*) ;; *) cp "$f" "$A/" ;; esac; done ;;',
        `  "release create") touch "${dir}/exists"; for f in "$@"; do case "$f" in */*) cp "$f" "$A/" ;; esac; done ;;`,
        `  "release edit") touch "${dir}/published" ;;`,
        "esac",
      ].join("\n"),
    );
    script("node", "echo release notes");
    const run = spawnSync("bash", ["-c", RELEASE_STEP], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        GITHUB_REF_NAME: "v1.2.3",
        RUNNER_TEMP: join(dir, "tmp"),
      },
    });
    return {
      status: run.status,
      output: run.stderr + run.stdout,
      calls: (existsSync(log) ? readFileSync(log, "utf8") : "").trim().split("\n").filter(Boolean),
      published: existsSync(join(dir, "published")),
      assets: existsSync(assets) ? readdirSync(assets).sort() : [],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a draft that holds exactly the release's assets is published", () => {
  const r = releaseStep({ draft: [TGZ] });
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(r.assets, [...OWN_ASSETS].sort());
  assert.ok(r.published);
  assert.ok(r.calls.some((c) => /^gh release edit v1\.2\.3 .*--draft=false --latest/.test(c)));
});

test("a release without the tarball on it is not published", () => {
  const r = releaseStep({ draft: null });
  // The pack step uploads the tarball before this one; with no release at all
  // it is missing, and the run must not publish a release without it.
  assert.notEqual(r.status, 0);
  assert.match(r.output, /missing/);
  assert.ok(!r.published);
});

test("a draft with an asset someone else attached is not published, and the message says what to remove", () => {
  const r = releaseStep({ draft: [TGZ, "backdoor.sh"] });
  assert.notEqual(r.status, 0);
  assert.ok(!r.published, r.calls.join(" | "));
  assert.ok(!r.calls.some((c) => c.startsWith("gh release edit")), r.calls.join(" | "));
  assert.match(r.output, /backdoor\.sh/);
  assert.match(r.output, /gh release delete-asset v1\.2\.3 /);
  assert.match(r.output, /Nothing was published/);
  assert.ok(r.assets.includes("backdoor.sh"), "the asset is left for a person to look at");
});

test("every unexpected asset is named, and a name with workflow-command characters is quoted", () => {
  const r = releaseStep({ draft: [TGZ, "a.zip", "::set-output name=x::y.txt"] });
  assert.notEqual(r.status, 0);
  assert.ok(!r.published);
  assert.match(r.output, /a\.zip/);
  assert.doesNotMatch(r.output, /^::set-output/m);
  assert.match(r.output, /set-output\\ name=x::y\.txt/);
});

test("the release is published only after the asset set is checked", () => {
  const publish = RELEASE_STEP.indexOf("--draft=false");
  assert.ok(publish > 0);
  const check = RELEASE_STEP.indexOf("delete-asset");
  assert.ok(check >= 0 && check < publish, "the asset check comes before the draft is published");
});

test("the publishing job runs in a protected environment", () => {
  const job = workflow.slice(workflow.indexOf("\n  publish:\n"));
  assert.match(job, /\n {4}environment: release\n/);
  assert.ok(job.indexOf("environment: release") < job.indexOf("steps:"));
});

test("publish.yml pins an exact Node, and the tarball is uploaded before the publish step", () => {
  assert.match(workflow, /node-version: 22\.\d+\.\d+\n/);
  assert.ok(
    workflow.indexOf("Pack the release tarball") < workflow.indexOf("- name: Publish to npm"),
  );
  const step = workflow.slice(
    workflow.indexOf("Pack the release tarball"),
    workflow.indexOf("- name: Publish to npm"),
  );
  assert.ok(step.includes("gh release create"), "uploads inside the pack step");
  assert.ok(step.indexOf("npm pack") < step.indexOf("gh release create"));
});
