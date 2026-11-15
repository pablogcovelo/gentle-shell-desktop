import type { McpStatus, WorktreeChanges, WorkspaceInfo } from "@shared/bridge-types";
import "./Footer.css";

export interface FooterProps {
  /** Worktree/MCP/profile facts from desktop-rpc (T8). Each part is optional
   * and renders only when it arrived. */
  readonly workspace?: WorkspaceInfo;
  /** T11: the open workspace's directory — the app-validated absolute path
   * the host's child runs in, or the session summary's own cwd for a chat
   * opened from the sidebar. Undefined means no workspace directory is
   * known: the footer shows `~/` and never an invented path. */
  readonly workspacePath?: string;
}

/**
 * The composed footer: the open workspace's path (T11), the
 * session-effective profile and the MCP inventory.
 *
 * It deliberately does NOT repeat the model, reasoning, context or cost: those
 * live in the status line (T4), and rendering them twice made two surfaces
 * compete for the same fact. One home per datum.
 *
 * The path (T11) is always rendered — the full directory of the open
 * workspace, or `~/` when none is open — and is never invented: it comes
 * from the validated workspace.create choice or from the session summary
 * the child itself reports. It is NOT the worktree group: no worktree
 * counts render here (that is T8b, which this unblocks).
 *
 * MCP is inventory, never health: the label says what is configured and how
 * many tool groups exist, and no wording here may ever say a server is
 * connected, because pi does not expose that.
 *
 * The worktree group (T8b) renders only when a root is known — no root, no
 * group, nothing invented — and only what the child supplied: the branch
 * when it reports one, the changed-file count and the added/deleted counts.
 * `countsUnavailable` (a failed or unborn root, a refused answer, a file
 * the child has not measured) renders as unavailable, never as zero files
 * and zero lines.
 */
export function Footer({ workspace, workspacePath }: FooterProps) {
  const profile = workspace?.profile?.label;
  const mcp = workspace?.mcp;
  const mcpSummary = mcp ? describeMcp(mcp) : undefined;
  const worktree = workspacePath !== undefined ? workspace?.worktree : undefined;

  return (
    <section className="gc-footer" aria-label="Session footer">
      <Field label="path" value={workspacePath ?? "~/"} />
      {profile ? <Field label="profile" value={profile} /> : null}
      {mcpSummary ? <Field label="MCP" value={mcpSummary} /> : null}
      {worktree?.branch ? <Field label="branch" value={worktree.branch} /> : null}
      {worktree ? <Field label="changes" value={describeWorktree(worktree)} /> : null}
    </section>
  );
}

/** The child's own counts, or the unavailable word when it supplied none:
 * `countsUnavailable` covers a failed or unborn root, a refused answer and
 * a partial count (an unmeasured untracked file), and none of those may
 * render as zero files and zero lines. */
function describeWorktree(worktree: WorktreeChanges): string {
  // Absent tallies are as honest as the explicit flag: printing "0 files ·
  // +0/-0" would invent numbers the child never sent.
  if (worktree.countsUnavailable || worktree.added === undefined || worktree.deleted === undefined) {
    return "unavailable";
  }
  return `${worktree.files.length} files · +${worktree.added}/-${worktree.deleted}`;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <span className="gc-footer__field">
      <span className="gc-footer__label">{label}</span>
      <span className="gc-footer__value">{value}</span>
    </span>
  );
}

/** Inventory wording only. `health` is deliberately not rendered: it is
 * always "unknown", and printing it would invite someone to read a green dot
 * into a channel that cannot report one. */
function describeMcp(mcp: McpStatus): string {
  const names = mcp.configuredNames.length > 0 ? mcp.configuredNames.length : mcp.registered.length;
  if (names === 0 && mcp.configuredStatus === "absent") return "none configured";
  return `${names} configured · ${mcp.namespaces.length} tool groups`;
}
