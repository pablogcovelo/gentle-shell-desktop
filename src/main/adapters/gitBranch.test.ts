import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readGitBranch } from "./gitBranch";

const scratchDirectories: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "gentle-git-branch-"));
  scratchDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("readGitBranch", () => {
  it("answers the branch a repository directory has checked out", () => {
    const repository = scratch();
    mkdirSync(join(repository, ".git"), { recursive: true });
    writeFileSync(join(repository, ".git", "HEAD"), "ref: refs/heads/develop\n");

    expect(readGitBranch(repository)).toBe("develop");
  });

  it("keeps a branch name that carries a slash", () => {
    const repository = scratch();
    mkdirSync(join(repository, ".git"), { recursive: true });
    writeFileSync(join(repository, ".git", "HEAD"), "ref: refs/heads/feature/workspace-branch\n");

    expect(readGitBranch(repository)).toBe("feature/workspace-branch");
  });

  // A linked worktree's `.git` is a file pointing at the real git directory,
  // so the branch lives there — never in the worktree itself.
  it("resolves a linked worktree whose .git is a gitdir file", () => {
    const root = scratch();
    const worktree = join(root, "worktree");
    const gitDirectory = join(root, "main", ".git", "worktrees", "worktree");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(gitDirectory, { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${gitDirectory}\n`);
    writeFileSync(join(gitDirectory, "HEAD"), "ref: refs/heads/review/scroll\n");

    expect(readGitBranch(worktree)).toBe("review/scroll");
  });

  // A detached HEAD records a commit, not a branch: answering one would
  // invent a fact the repository does not have.
  it("answers nothing for a detached HEAD, where no branch is checked out", () => {
    const repository = scratch();
    mkdirSync(join(repository, ".git"), { recursive: true });
    writeFileSync(join(repository, ".git", "HEAD"), "9f2c4a1e8b7d6c5f4e3a2b1c0d9e8f7a6b5c4d3e\n");

    expect(readGitBranch(repository)).toBeUndefined();
  });

  it("answers nothing for a directory that is not a repository", () => {
    expect(readGitBranch(scratch())).toBeUndefined();
  });

  it("answers nothing for a directory that does not exist", () => {
    expect(readGitBranch(join(scratch(), "missing"))).toBeUndefined();
  });
});
