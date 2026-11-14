import type { ActiveProfile, McpStatus, WorktreeChanges } from "@shared/bridge-types";

/**
 * Decoders for the three desktop-rpc reads that fill the composed footer
 * (desktop-rpc T8): the worktree's changed counts, the MCP inventory, and the
 * active agent-model profile.
 *
 * Every payload below was captured from a live `gentle-shell --mode rpc` child
 * and is kept in `__fixtures__/workspace-info.json`, so the shapes here are
 * read off the wire rather than guessed:
 * - `get_worktree_changes` takes `{ root }` and answers
 *   `{ root, model: { files, added, deleted, digest } }`;
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
  const model = data.model;
  if (!isRecord(model)) return undefined;
  if (typeof model.added !== "number" || !Number.isFinite(model.added)) return undefined;
  if (typeof model.deleted !== "number" || !Number.isFinite(model.deleted)) return undefined;
  const files = toStrings(model.files);

  return {
    root: data.root,
    ...(typeof model.branch === "string" && model.branch.length > 0 ? { branch: model.branch } : {}),
    files: files ?? [],
    added: model.added,
    deleted: model.deleted,
    // gentle-pi reports counts as unavailable for a root it could not read;
    // keeping the flag is what lets the footer say so instead of showing zero.
    ...(model.countsUnavailable === true ? { countsUnavailable: true } : {}),
  };
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
