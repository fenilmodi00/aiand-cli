import { existsSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { agentHome, pathIsInside } from "../fsutil.js";

/**
 * The bare-repo dotfiles setup (`git --git-dir=~/.dotfiles --work-tree=~`)
 * leaves no `.git` anywhere above the config files it tracks, so the walk
 * up for one never finds it. The repository is a directory directly in HOME
 * instead (or, for yadm and vcsh, in their own directories), and what it tracks is named by its own `core.worktree`, or, when
 * the work tree only ever rides on the command line, implied by an `index`
 * file: a bare repository has none until something is added through an
 * external work tree.
 */

/** A git directory, by what git itself needs to see: HEAD, objects/ and refs/. */
async function isGitDir(dir: string): Promise<boolean> {
  if (!existsSync(join(dir, "HEAD"))) return false;
  const [objects, refs] = await Promise.all([
    stat(join(dir, "objects")).catch(() => null),
    stat(join(dir, "refs")).catch(() => null),
  ]);
  return objects?.isDirectory() === true && refs?.isDirectory() === true;
}

/** `core.worktree` from a git config file's text, unquoted; undefined when unset. */
function coreWorktree(config: string): string | undefined {
  let inCore = false;
  let found: string | undefined;
  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]*)\]/.exec(line);
    if (section) {
      inCore = section[1]?.trim().toLowerCase() === "core";
      continue;
    }
    if (!inCore) continue;
    const value = /^\s*worktree\s*=\s*(.*?)\s*$/i.exec(line)?.[1];
    if (value !== undefined) found = value.replace(/^"(.*)"$/, "$1");
  }
  return found;
}

async function resolveWorktree(gitDir: string, config: string): Promise<string | null> {
  const declared = coreWorktree(config);
  let tree: string;
  if (declared !== undefined) {
    tree = declared.startsWith("~/") ? join(agentHome(), declared.slice(2)) : declared;
    tree = resolve(gitDir, tree);
  } else if (existsSync(join(gitDir, "index"))) {
    tree = agentHome();
  } else {
    return null;
  }
  return realpath(tree).catch(() => resolve(tree));
}

/** Directories in `dir` named `*.git` (vcsh keeps one repository per name); none when unreadable. */
async function bareReposIn(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter((name) => name.endsWith(".git")).map((name) => join(dir, name));
}

/**
 * Where a dotfiles manager keeps its repository, besides the directory in
 * HOME that a hand-made bare setup uses. yadm: `repo.git` under its data dir
 * (`YADM_REPO` moves it). vcsh: one `<name>.git` per repository under
 * `vcsh/repo.d` in the config dir. Both set `core.worktree` to HOME, so the
 * walk up from a config file never meets a `.git` for them either.
 */
async function managerRepos(home: string): Promise<string[]> {
  const absolute = (value: string | undefined): string | null =>
    value && isAbsolute(value) ? value : null;
  const dataDirs = [join(home, ".local", "share"), absolute(process.env.XDG_DATA_HOME)];
  const configDirs = [join(home, ".config"), absolute(process.env.XDG_CONFIG_HOME)];
  const found = new Set<string>();
  const yadm = absolute(process.env.YADM_REPO);
  if (yadm !== null) found.add(yadm);
  for (const dir of dataDirs) if (dir !== null) found.add(join(dir, "yadm", "repo.git"));
  for (const dir of configDirs) {
    if (dir === null) continue;
    for (const repo of await bareReposIn(join(dir, "vcsh", "repo.d"))) found.add(repo);
  }
  return [...found];
}

/**
 * The dotfiles repository whose work tree covers `real`, or null: a bare-style
 * directory directly in HOME, or one a dotfiles manager keeps (yadm, vcsh).
 * Reads files only: git is never spawned, since `git` off PATH is a program a
 * cloned repository can plant, and git could not be pointed at these
 * repositories without already knowing where they are.
 */
export async function dotfilesRepoFor(real: string): Promise<string | null> {
  const home = agentHome();
  const inHome = await readdir(home).catch(() => [] as string[]);
  const candidates = [...inHome.map((name) => join(home, name)), ...(await managerRepos(home))];
  for (const gitDir of candidates) {
    if (!(await isGitDir(gitDir))) continue;
    const config = await readFile(join(gitDir, "config"), "utf8").catch(() => "");
    const tree = await resolveWorktree(gitDir, config);
    if (tree !== null && pathIsInside(tree, real)) return gitDir;
  }
  return null;
}
