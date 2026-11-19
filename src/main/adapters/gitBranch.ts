import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** The ref prefix a checked-out branch records in `HEAD`. */
const HEAD_REF_PREFIX = "ref: refs/heads/";
/** The marker a linked worktree (or a submodule) writes into its `.git` file. */
const GITDIR_PREFIX = "gitdir:";

/**
 * The git directory backing `directory`: `.git` itself for an ordinary
 * repository, or the path a linked worktree's `.git` FILE points at. Absent
 * means "not a repository" — including an unreadable `.git`.
 */
function gitDirectoryOf(directory: string): string | undefined {
  const dotGit = join(directory, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
  } catch {
    return undefined;
  }
  // A linked worktree's `.git` is a FILE naming the real git directory, so
  // its HEAD lives there — never in the worktree.
  try {
    const pointer = readFileSync(dotGit, "utf8").trim();
    if (!pointer.startsWith(GITDIR_PREFIX)) return undefined;
    const target = pointer.slice(GITDIR_PREFIX.length).trim();
    if (target.length === 0) return undefined;
    return isAbsolute(target) ? target : resolve(directory, target);
  } catch {
    return undefined;
  }
}

/**
 * The branch `directory` has checked out, read straight from its `HEAD`.
 *
 * This is a file read, never a child round trip and never a spawned git, so
 * it answers for EVERY listed workspace when the list is built — at startup
 * and right after an add — instead of only for the one directory whose live
 * child happened to reply. Absent means "no branch to show": not a
 * repository, an unreadable HEAD, or a DETACHED HEAD (a commit, not a
 * branch — answering one there would invent a fact the repository lacks).
 */
export function readGitBranch(directory: string): string | undefined {
  const gitDirectory = gitDirectoryOf(directory);
  if (!gitDirectory) return undefined;
  let head: string;
  try {
    head = readFileSync(join(gitDirectory, "HEAD"), "utf8").trim();
  } catch {
    return undefined;
  }
  if (!head.startsWith(HEAD_REF_PREFIX)) return undefined;
  const branch = head.slice(HEAD_REF_PREFIX.length).trim();
  return branch.length > 0 ? branch : undefined;
}
