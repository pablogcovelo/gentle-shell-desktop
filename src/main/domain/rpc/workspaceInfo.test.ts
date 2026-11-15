import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseWorktreeChanges } from "./workspaceInfo";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * `workspace-info.json` carries the worktree answer shapes of gentle-pi's
 * contract (`docs/desktop-rpc.md` "get_worktree_changes"): the documented
 * example, and the two truthful labels a root that cannot be counted gets —
 * `failed` (the scan failed) and `unborn` (no commits yet). The documented
 * example IS the contract's canonical payload shape, so the test reads it
 * off the fixture instead of re-typing it.
 */
function readFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(__dirname, "__fixtures__", "workspace-info.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("parseWorktreeChanges (desktop-rpc T8b)", () => {
  it("parses the documented wire example into the child's own numbers", () => {
    const data = readFixture().worktreeDocumentedExample;

    expect(parseWorktreeChanges(data)).toEqual({
      root: "/home/dev/project",
      branch: "main",
      files: ["src/index.ts"],
      added: 12,
      deleted: 3,
    });
  });

  it("a failed root, an unborn root and an answer without model are unavailable — never zeros", () => {
    const fixture = readFixture();
    const cases = [fixture.worktreeFailedRoot, fixture.worktreeUnbornRoot, { root: "/home/dev/project" }];

    for (const data of cases) {
      expect(parseWorktreeChanges(data)).toEqual({
        root: "/home/dev/project",
        files: [],
        countsUnavailable: true,
      });
      expect("added" in (parseWorktreeChanges(data) as object)).toBe(false);
      expect("deleted" in (parseWorktreeChanges(data) as object)).toBe(false);
    }
  });

  it("a malformed answer without a root is not the contract: undefined, nothing to fold", () => {
    expect(parseWorktreeChanges({ failed: true })).toBeUndefined();
    expect(parseWorktreeChanges("not an object")).toBeUndefined();
    expect(parseWorktreeChanges(undefined)).toBeUndefined();
  });

  it("an untracked file the child has not measured labels the whole count unavailable — the sums are partial, so no numbers are carried", () => {
    const data = readFixture().worktreeLabeledUntracked;

    expect(parseWorktreeChanges(data)).toEqual({
      root: "/home/dev/project",
      files: ["src/index.ts", "scratch/notes.md"],
      countsUnavailable: true,
    });
  });

it("keeps the branch the child supplied even when the counts are unavailable", () => {
  const parsed = parseWorktreeChanges({
    root: "/repo",
    branch: "main",
    model: { files: [{ path: "a.ts", countsUnavailable: true }], added: 4, deleted: 1, digest: "d" },
  });

  // The branch is the child's own fact and does not depend on the counts: a
  // partial answer must not silently drop it from the footer.
  expect(parsed).toEqual({
    root: "/repo",
    branch: "main",
    files: ["a.ts"],
    countsUnavailable: true,
  });
});
});
