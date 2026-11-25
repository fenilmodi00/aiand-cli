import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import {
  ALLOW_GIT_TRACKED_ENV,
  gitWorkTreeFor,
  jsoncDelete,
  jsoncSet,
  parseJsonc,
  readJsoncObject,
  readTextIfExists,
  writeKeyFile,
} from "../dist/agents/managed-file.js";
import { clearAddedState } from "../dist/agents/snapshot.js";
import { CliError } from "../dist/cli/errors.js";
import { withTestEnv } from "./helpers.mjs";

// File helpers, plus the per-file git opt-in `writeKeyFile` keeps under the config dir.
const box = withTestEnv("aiand-managed-file-test-", (dir) => {
  process.env.AIAND_CONFIG_DIR = join(dir, "config");
  process.env.AIAND_HOME = join(dir, "home-default");
});

describe("managed-file read side", () => {
  test("readTextIfExists returns empty string for a missing file and text otherwise", async () => {
    const missing = join(box.dir, "nope.txt");
    assert.equal(await readTextIfExists(missing), "");

    const present = join(box.dir, "hi.txt");
    writeFileSync(present, "hello\n");
    assert.equal(await readTextIfExists(present), "hello\n");
  });

  test("an unusable path refuses as a CliError, never a raw stack", async () => {
    // A file where a directory belongs (ENOTDIR), a directory where a file
    // belongs (EISDIR), and an unreadable file (EACCES): all three must read
    // as exit-1 CliErrors naming the path, not a raw errno exit 70.
    const squatter = join(box.dir, "squatter");
    writeFileSync(squatter, "not a dir\n");
    const isDir = join(box.dir, "dir-as-file");
    mkdirRecursive(isDir);
    const locked = join(box.dir, "locked.txt");
    writeFileSync(locked, "secret\n", { mode: 0o000 });
    try {
      // Windows reads a path below a file as ENOENT, i.e. missing; its write side
      // (writeFileAtomic) is covered in fsutil.test.mjs.
      if (process.platform !== "win32") {
        await assert.rejects(
          () => readTextIfExists(join(squatter, "config.json")),
          (error) => {
            assert.ok(error instanceof CliError);
            assert.match(error.message, /is not a directory/);
            return true;
          },
        );
      }
      await assert.rejects(
        () => readTextIfExists(isDir),
        (error) => {
          assert.ok(error instanceof CliError);
          assert.match(error.message, /it is a directory/);
          return true;
        },
      );
      if (process.platform !== "win32" && process.getuid?.() !== 0) {
        await assert.rejects(
          () => readTextIfExists(locked),
          (error) => {
            assert.ok(error instanceof CliError);
            assert.match(error.message, /permission denied/);
            return true;
          },
        );
      }
    } finally {
      chmodSync(locked, 0o600);
    }
  });
});

function mkdirRecursive(dir) {
  mkdirSync(dir, { recursive: true });
}

describe("readJsoncObject", () => {
  test("missing and blank files read as {}", async () => {
    assert.deepEqual(await readJsoncObject(join(box.dir, "absent.json")), {});
    const blank = join(box.dir, "blank.json");
    writeFileSync(blank, "   \n");
    assert.deepEqual(await readJsoncObject(blank), {});
  });

  test("readJsoncObject: a non-object root is the invalid-JSON error, not a silent {}", async () => {
    const models = join(box.dir, "models.json");
    writeFileSync(models, "[1,2]");
    const hint = "Fix it by hand, or delete it and run aiand pi on again.";
    await assert.rejects(
      readJsoncObject(models, hint),
      (error) =>
        error instanceof CliError &&
        error.message === `${models} is not valid JSON.` &&
        error.hint === hint,
    );
  });

  test("scalar roots are the invalid-JSON error too, not a silent {}", async () => {
    // Both shapes parse cleanly but cannot hold the object paths
    // adapters splice, so each must fail at the read the same way.
    for (const text of ['"just a string"', "true"]) {
      const file = join(box.dir, "scalar.json");
      writeFileSync(file, text);
      await assert.rejects(
        readJsoncObject(file, "recover"),
        (error) =>
          error instanceof CliError &&
          error.message === `${file} is not valid JSON.` &&
          error.hint === "recover",
      );
    }
  });
});

describe("parseJsonc", () => {
  test("parseJsonc strips a UTF-8 BOM before JSON.parse", () => {
    assert.deepEqual(parseJsonc('\uFEFF{"theme":"system"}'), { theme: "system" });
  });

  test("keeps ,} and ,] sequences inside string values", () => {
    // Global trailing-comma regex would corrupt these; the scan must be
    // string-aware the same way comment stripping is.
    assert.deepEqual(parseJsonc('{"pattern":",}","other":",]"}'), {
      pattern: ",}",
      other: ",]",
    });
  });

  test("strips trailing commas after comments", () => {
    assert.deepEqual(parseJsonc('{\n  "a": 1, // keep\n  "b": [2,],\n}\n'), {
      a: 1,
      b: [2],
    });
  });

  test("unclosed block comment yields SyntaxError from JSON.parse", () => {
    assert.throws(() => parseJsonc('{ "a": 1 /* never closed'), SyntaxError);
  });

  test("trailing unterminated block comment is rejected, not swallowed", () => {
    assert.throws(() => parseJsonc('{"theme":"system"} /*'), SyntaxError);
  });
});

describe("jsonc surgical edit", () => {
  test("jsoncDelete of the last key preserves comments inside the object", () => {
    const original = `{\n  /* keep */\n  "x-aiand": true\n}\n`;
    const removed = jsoncDelete(original, ["x-aiand"]);
    assert.match(removed, /keep/);
    assert.deepEqual(parseJsonc(removed), {});
  });

  test("jsoncSet inserts a key and jsoncDelete removes it, leaving comments and key order", () => {
    const original = `{
  // user comment
  "theme": "dark",
  "keybinds": { "quit": "q" },
}
`;
    const added = jsoncSet(original, ["x-aiand"], true);
    assert.match(added, /user comment/);
    assert.match(added, /"theme": "dark"/);
    assert.equal(parseJsonc(added).theme, "dark");
    assert.equal(parseJsonc(added)["x-aiand"], true);

    const removed = jsoncDelete(added, ["x-aiand"]);
    assert.equal(removed, original);
  });

  test("jsoncSet writes nested provider.aiand without rewriting sibling providers", () => {
    const original = `{
  "provider": {
    "anthropic": { "name": "Anthropic" }
  }
}
`;
    const next = jsoncSet(original, ["provider", "aiand"], { options: { apiKey: "sk-x" } });
    const parsed = parseJsonc(next);
    assert.equal(parsed.provider.anthropic.name, "Anthropic");
    assert.equal(parsed.provider.aiand.options.apiKey, "sk-x");
    assert.match(next, /Anthropic/);

    const stripped = jsoncDelete(next, ["provider", "aiand"]);
    assert.equal(parseJsonc(stripped).provider.anthropic.name, "Anthropic");
    assert.equal(parseJsonc(stripped).provider.aiand, undefined);
    assert.match(stripped, /Anthropic/);
  });

  test("jsoncSet on empty text creates an object; jsoncDelete of the last key leaves {}", () => {
    const created = jsoncSet("", ["model"], "aiand/glm");
    assert.equal(parseJsonc(created).model, "aiand/glm");
    const empty = jsoncDelete(created, ["model"]);
    assert.deepEqual(parseJsonc(empty), {});
  });
  test("jsoncSet into comment-only object keeps interior comments", () => {
    const original = `{\n  /* keep */\n}\n`;
    const added = jsoncSet(original, ["x-aiand"], true);
    assert.match(added, /keep/);
    assert.equal(parseJsonc(added)["x-aiand"], true);
  });

  test("jsoncSet and jsoncDelete on a BOM'd object keep editing (no raw SyntaxError)", () => {
    const original = '\uFEFF{\n  "theme": "system"\n}\n';
    const added = jsoncSet(original, ["x-aiand"], true);
    assert.equal(added.startsWith("\uFEFF"), true);
    assert.equal(parseJsonc(added).theme, "system");
    assert.equal(parseJsonc(added)["x-aiand"], true);
    const removed = jsoncDelete(added, ["x-aiand"]);
    assert.equal(removed, original);
  });
});

describe("jsoncSet layout", () => {
  test("insert keeps normal JSON layout and deletes byte-identically, both comma styles", () => {
    const files = [
      `{\n  "theme": "dark"\n}\n`, // no trailing comma
      `{\n  "theme": "dark",\n}\n`, // trailing comma
    ];
    for (const text of files) {
      const set = jsoncSet(text, ["x-aiand"], true);
      // Normal layout: comma on the prior line, brace on its own line.
      assert.ok(set.includes(`"theme": "dark",\n  "x-aiand"`), set);
      assert.ok(!set.includes("\n,"), `comma on its own line in: ${set}`);
      // And deleting what we added restores the original bytes.
      assert.equal(jsoncDelete(set, ["x-aiand"]), text);
    }
  });
});

describe("writeKeyFile refuses a git work tree", () => {
  /** A stow-style layout: a dotfiles repo plus a home dir linking into it. */
  function stowLayout(name) {
    const root = join(box.dir, name);
    const repo = join(root, "dotfiles");
    const target = join(repo, "opencode", ".config", "opencode", "opencode.json");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(root, "home", ".config", "opencode"), { recursive: true });
    mkdirSync(join(repo, "opencode", ".config", "opencode"), { recursive: true });
    writeFileSync(target, "{}\n");
    const link = join(root, "home", ".config", "opencode", "opencode.json");
    symlinkSync(target, link);
    return { repo, target, link };
  }

  test("a key file symlinked into a dotfiles repo is refused, untouched", async () => {
    const { repo, target, link } = stowLayout("stow");
    await assert.rejects(
      () => writeKeyFile(link, '{"key":"sk-secret"}\n', { agentId: "pi" }),
      (error) =>
        error instanceof CliError &&
        error.message.includes(repo) &&
        error.message.includes("links there") &&
        error.hint.includes(ALLOW_GIT_TRACKED_ENV),
    );
    assert.equal(readFileSync(target, "utf8"), "{}\n");
    assert.equal(lstatSync(link).isSymbolicLink(), true);
  });

  test("a directory symlinked into the repo (stow folding) is refused too", async () => {
    const root = join(box.dir, "folded");
    const repo = join(root, "dotfiles");
    mkdirSync(join(repo, "pi"), { recursive: true });
    writeFileSync(join(repo, ".git"), "gitdir: elsewhere\n");
    mkdirSync(join(root, "home"), { recursive: true });
    symlinkSync(join(repo, "pi"), join(root, "home", "agent"));
    const file = join(root, "home", "agent", "auth.json");
    await assert.rejects(
      () => writeKeyFile(file, "{}\n", { agentId: "pi" }),
      /inside the git repository/,
    );
    assert.equal(existsSync(join(repo, "pi", "auth.json")), false);
  });

  test("the opt-in env writes through the link", async () => {
    const { target, link } = stowLayout("opt-in");
    process.env[ALLOW_GIT_TRACKED_ENV] = "1";
    try {
      await writeKeyFile(link, '{"key":"sk-secret"}\n', { agentId: "pi" });
    } finally {
      delete process.env[ALLOW_GIT_TRACKED_ENV];
    }
    assert.equal(readFileSync(target, "utf8"), '{"key":"sk-secret"}\n');
  });

  test("a key file outside any repo is written normally", async () => {
    const file = join(box.dir, "plain", "nested", "auth.json");
    await writeKeyFile(file, "{}\n", { mode: 0o600, agentId: "pi" });
    assert.equal(readFileSync(file, "utf8"), "{}\n");
    assert.equal(await gitWorkTreeFor(file), null);
  });
});

describe("a bare dotfiles repository in HOME (git --git-dir=~/.dotfiles --work-tree=~)", () => {
  /** A HOME holding a bare-style git dir named `.dotfiles`, with `config` as given. */
  function bareHome(name, { config, index = false } = {}) {
    const home = join(box.dir, name);
    const gitDir = join(home, ".dotfiles");
    mkdirSync(join(gitDir, "objects"), { recursive: true });
    mkdirSync(join(gitDir, "refs"), { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(gitDir, "config"), config);
    if (index) writeFileSync(join(gitDir, "index"), "DIRC");
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    return { home, gitDir, file: join(home, ".config", "opencode", "opencode.json") };
  }
  const withHome = async (home, fn) => {
    const previous = process.env.AIAND_HOME;
    process.env.AIAND_HOME = home;
    try {
      return await fn();
    } finally {
      process.env.AIAND_HOME = previous;
    }
  };

  test("core.worktree covering the file refuses the write", async () => {
    const { home, gitDir, file } = bareHome("bare-config", {
      config: "[core]\n\tbare = false\n\tworktree = ../\n",
    });
    await withHome(home, async () => {
      await assert.rejects(
        () => writeKeyFile(file, '{"key":"sk-secret"}\n', { agentId: "opencode" }),
        (error) => error instanceof CliError && error.message.includes(gitDir),
      );
      assert.equal(existsSync(file), false);
    });
  });

  test("an index in a bare directory (work tree only on the command line) implies HOME", async () => {
    const { home, gitDir, file } = bareHome("bare-index", {
      config: "[core]\n\tbare = true\n",
      index: true,
    });
    await withHome(home, async () => {
      assert.equal((await gitWorkTreeFor(file))?.repo, gitDir);
    });
  });

  test("a bare repository with no work tree and no index is not a dotfiles repo", async () => {
    const { home, file } = bareHome("bare-plain", { config: "[core]\n\tbare = true\n" });
    await withHome(home, async () => {
      assert.equal(await gitWorkTreeFor(file), null);
    });
  });

  test("a core.worktree that does not cover the file leaves it alone", async () => {
    const { home, file } = bareHome("bare-elsewhere", {
      config: `[core]\n\tworktree = ${join(box.dir, "somewhere-else")}\n`,
      index: true,
    });
    await withHome(home, async () => {
      assert.equal(await gitWorkTreeFor(file), null);
    });
  });
});

describe("a dotfiles manager's repository (yadm, vcsh)", () => {
  /** A HOME with a git dir at `rel` under it, whose work tree is `worktree` (HOME when omitted). */
  function managedHome(name, rel, { worktree } = {}) {
    const home = join(box.dir, name);
    const gitDir = join(home, ...rel);
    mkdirSync(join(gitDir, "objects"), { recursive: true });
    mkdirSync(join(gitDir, "refs"), { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/master\n");
    writeFileSync(
      join(gitDir, "config"),
      `[core]\n\tbare = false\n\tworktree = ${worktree ?? home}\n`,
    );
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    return { home, gitDir, file: join(home, ".config", "opencode", "opencode.json") };
  }
  const withHome = async (home, fn, env = {}) => {
    const keys = ["AIAND_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "YADM_REPO"];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys.slice(1)) delete process.env[key];
    process.env.AIAND_HOME = home;
    Object.assign(process.env, env);
    try {
      return await fn();
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  };

  test("yadm's repo.git under ~/.local/share/yadm refuses the write, and nothing is written", async () => {
    const { home, gitDir, file } = managedHome("yadm", [".local", "share", "yadm", "repo.git"]);
    await withHome(home, async () => {
      assert.equal((await gitWorkTreeFor(file))?.repo, gitDir);
      await assert.rejects(
        () => writeKeyFile(file, '{"key":"sk-secret"}\n', { agentId: "opencode" }),
        (error) => error instanceof CliError && error.message.includes(gitDir),
      );
      assert.equal(existsSync(file), false);
    });
  });

  test("a yadm repository under XDG_DATA_HOME, or at YADM_REPO, counts too", async () => {
    const xdg = managedHome("yadm-xdg", ["data", "yadm", "repo.git"]);
    await withHome(
      xdg.home,
      async () => assert.equal((await gitWorkTreeFor(xdg.file))?.repo, xdg.gitDir),
      { XDG_DATA_HOME: join(xdg.home, "data") },
    );
    const moved = managedHome("yadm-env", ["elsewhere", "repo.git"]);
    await withHome(
      moved.home,
      async () => assert.equal((await gitWorkTreeFor(moved.file))?.repo, moved.gitDir),
      { YADM_REPO: moved.gitDir },
    );
  });

  test("every vcsh repository in ~/.config/vcsh/repo.d is checked", async () => {
    const { home, gitDir, file } = managedHome("vcsh", [".config", "vcsh", "repo.d", "dots.git"]);
    const other = join(home, ".config", "vcsh", "repo.d", "other.git");
    mkdirSync(join(other, "objects"), { recursive: true });
    mkdirSync(join(other, "refs"), { recursive: true });
    writeFileSync(join(other, "HEAD"), "ref: refs/heads/master\n");
    writeFileSync(join(other, "config"), `[core]\n\tworktree = ${join(home, "elsewhere")}\n`);
    await withHome(home, async () => {
      assert.equal((await gitWorkTreeFor(file))?.repo, gitDir);
      await assert.rejects(
        () => writeKeyFile(file, '{"key":"sk-secret"}\n', { agentId: "opencode" }),
        /inside the git repository/,
      );
    });
  });

  test("a yadm or vcsh repository whose work tree does not cover the file leaves it alone", async () => {
    const yadm = managedHome("yadm-elsewhere", [".local", "share", "yadm", "repo.git"], {
      worktree: join(box.dir, "yadm-elsewhere", "projects"),
    });
    const vcsh = managedHome("vcsh-elsewhere", [".config", "vcsh", "repo.d", "x.git"], {
      worktree: join(box.dir, "vcsh-elsewhere", "projects"),
    });
    for (const { home, file } of [yadm, vcsh]) {
      await withHome(home, async () => assert.equal(await gitWorkTreeFor(file), null));
    }
  });
});

describe("the git opt-in is remembered for the file (rotation runs without the env)", () => {
  function trackedFile(name) {
    const repo = join(box.dir, name, "dotfiles");
    mkdirSync(join(repo, ".git"), { recursive: true });
    return join(repo, "auth.json");
  }

  test("a write opted in once is allowed later without the env, for that agent only", async () => {
    const file = trackedFile("optin");
    process.env[ALLOW_GIT_TRACKED_ENV] = "1";
    try {
      await writeKeyFile(file, '{"key":"sk-old"}\n', { agentId: "pi" });
    } finally {
      delete process.env[ALLOW_GIT_TRACKED_ENV];
    }
    await writeKeyFile(file, '{"key":"sk-rotated"}\n', { agentId: "pi" });
    assert.equal(readFileSync(file, "utf8"), '{"key":"sk-rotated"}\n');
    await assert.rejects(
      () => writeKeyFile(file, "{}\n", { agentId: "omp" }),
      /inside the git repository/,
    );
  });

  test("off clears the opt-in: a later on is refused again", async () => {
    const file = trackedFile("optin-cleared");
    process.env[ALLOW_GIT_TRACKED_ENV] = "1";
    try {
      await writeKeyFile(file, "{}\n", { agentId: "pi" });
    } finally {
      delete process.env[ALLOW_GIT_TRACKED_ENV];
    }
    await clearAddedState("pi");
    await assert.rejects(
      () => writeKeyFile(file, "{}\n", { agentId: "pi" }),
      /inside the git repository/,
    );
  });
});
