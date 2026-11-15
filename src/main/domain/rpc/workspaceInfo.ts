import type { ActiveProfile, McpStatus, WorktreeChanges } from "@shared/bridge-types";

/**
 * Decoders for the three desktop-rpc reads that fill the composed footer
 * (desktop-rpc T8): the worktree's changed counts, the MCP inventory, and the
 * active agent-model profile.
 *
 * Every payload below was captured from a live `gentle-shell --mode rpc` child
 * and is kept in `__fixtures__/workspace-info.json`, so the shapes here are
 * read off the wire rather than guessed:
 * - `get_worktree_changes` takes `{ root }` and answers `{ root, branch?,
 *   model: { files: [{ path, added, deleted, status, countsUnavailable? }],
 *   added, deleted, digest } }`; a root whose scan failed answers
 *   `{ root, failed: true }` and a root with no commits yet answers
 *   `{ root, unborn: true }` — each with no model, never zero files or zero
 *   lines (docs/desktop-rpc.md "get_worktree_changes");
 * - `mcp_status` answers `{ health, configured: { status, names },
 *   registered, namespaces }` with `health` always `"unknown"` — pi does not
 *   expose connection state, so nothing may imply it;
 * - `get_active_profile` answers `{ label, active }`, the session-effective
 *   label the terminal footer shows.
 *
 * All three are fail-closed: a payload that is not the documented shape
 * returns `undefined`, and the footer then renders no field at all rather than
 * a zero or a guess.
 */
export function parseWorktreeChanges(data: unknown): WorktreeChanges | undefined {
  if (!isRecord(data) || typeof data.root !== "string" || data.root.length === 0) return undefined;

  // The child's own truthful labels ("Truthful labels, real shapes",
  // docs/desktop-rpc.md): a failed or unborn root carries no model, and an
  // answer without a model at all is the same fact. Counts are unavailable —
  // never zeros, because zero would claim a measurement nobody made.
  if (data.failed === true || data.unborn === true) return unavailableWorktreeChanges(data.root);

  const model = data.model;
  const declaredBranch = typeof data.branch === "string" ? data.branch : undefined;
  if (!isRecord(model)) return unavailableWorktreeChanges(data.root, declaredBranch);
  if (typeof model.added !== "number" || !Number.isFinite(model.added)) return unavailableWorktreeChanges(data.root, declaredBranch);
  if (typeof model.deleted !== "number" || !Number.isFinite(model.deleted)) return unavailableWorktreeChanges(data.root, declaredBranch);

  const files = parseFilePaths(model.files);
  // A file the child has not measured (an untracked file's lines are not in
  // `diff --numstat`) makes the sums PARTIAL: labelled, with no numbers
  // carried, so the footer cannot present a partial count as complete.
  // `branch` sits beside `model` in the documented answer, and is "unknown"
  // when the root's own branch cannot be read — that is the child's own word
  // and is rendered as supplied, whether or not the counts survived.
  const branch = typeof data.branch === "string" && data.branch.length > 0 ? { branch: data.branch } : {};
  const countsUnavailable = files.labeled || model.countsUnavailable === true;
  if (countsUnavailable) {
    return { root: data.root, ...branch, files: files.paths, countsUnavailable: true };
  }

  return {
    root: data.root,
    ...branch,
    files: files.paths,
    added: model.added,
    deleted: model.deleted,
  };
}

/** The unavailable shape shared by every "the child supplied no counts"
 * answer: no numbers at all, only the flag the footer renders as such. */
export function unavailableWorktreeChanges(root: string, branch?: string): WorktreeChanges {
  return {
    root,
    ...(branch !== undefined && branch.length > 0 ? { branch } : {}),
    files: [],
    countsUnavailable: true,
  };
}

/** The per-file projection: `file.path` is relative to `root`, and a file
 * labelled `countsUnavailable` (an unmeasured untracked file) marks the
 * sums partial. Entries that are neither are dropped, not coerced. */
function parseFilePaths(value: unknown): { paths: readonly string[]; labeled: boolean } {
  if (!Array.isArray(value)) return { paths: [], labeled: false };
  const paths: string[] = [];
  let labeled = false;
  for (const entry of value) {
    if (typeof entry === "string") {
      paths.push(entry);
      continue;
    }
    if (isRecord(entry) && typeof entry.path === "string") {
      paths.push(entry.path);
      if (entry.countsUnavailable === true) labeled = true;
    }
  }
  return { paths, labeled };
}

export function parseMcpStatus(data: unknown): McpStatus | undefined {
  if (!isRecord(data)) return undefined;
  // `health` is part of the contract and is always "unknown" today. A payload
  // that claims otherwise is not this contract, so it is not modelled.
  if (data.health !== "unknown") return undefined;
  const configured = data.configured;
  if (!isRecord(configured) || typeof configured.status !== "string") return undefined;

  return {
    health: "unknown",
    configuredStatus: configured.status,
    configuredNames: toStrings(configured.names) ?? [],
    registered: toStrings(data.registered) ?? [],
    namespaces: toStrings(data.namespaces) ?? [],
  };
}

export function parseActiveProfile(data: unknown): ActiveProfile | undefined {
  if (!isRecord(data) || typeof data.label !== "string" || data.label.length === 0) return undefined;
  return {
    label: data.label,
    ...(typeof data.active === "string" && data.active.length > 0 ? { active: data.active } : {}),
  };
}

function toStrings(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((item): item is string => typeof item === "string")) return undefined;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
