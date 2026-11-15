import type { McpStatus, SessionIdentityView, WorktreeChanges, WorkspaceInfo } from "@shared/bridge-types";
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
  /** Session identity from pi's own RPC replies (desktop-rpc T4), moved
   * here by desktop-workspace-shell T7: the owner's decision ("Implementa
   * el footer tal cual está en el diseño") supersedes the old "one home per
   * datum" split, so model, thinking level and context render in the
   * footer's identity and context groups. Optional: absent until the first
   * correlated reply lands, and every field inside it is optional on its
   * own — an absent field renders nothing, never a fabricated zero. */
  readonly session?: SessionIdentityView;
  /** The app's own version, reported by the main process (T7's `app.info`
   * channel). The design's last footer fact; absent means no version is
   * rendered, never a placeholder. */
  readonly appVersion?: string;
}

/**
 * The design's footer (`design/slack-gentle/01-workspace.html`), group for
 * group, in the artboard's order: workspace path, changes, capabilities,
 * session identity, context, app version (desktop-workspace-shell S9).
 *
 * Every group is honest (S11): a group renders only the members the wire
 * can prove. The path is always rendered — the full directory of the open
 * workspace, or `~/` when none is open, never invented and never truncated
 * with an ellipsis. The changes group renders only when a worktree root is
 * known, with the child's own counts or `unavailable` for a failed, refused
 * or partially measured answer — never zeros. Capabilities are the MCP
 * inventory, never health: pi does not expose whether a server is
 * connected, so no wording here may ever claim it; `skills` and
 * `extensions` are not in `ChatState`, so they render only once a bridge
 * field supplies them (S11), never as a zero. The identity group carries
 * the session's effective model, thinking level and profile (S10), each
 * only when the child supplied it. The context group is a small meter plus
 * the real `contextPercent`: absent or `null` renders nothing — never 0%.
 * The version renders only when the app reported one.
 */
export function Footer({ workspace, workspacePath, session, appVersion }: FooterProps) {
  const mcp = workspace?.mcp;
  const worktree = workspacePath !== undefined ? workspace?.worktree : undefined;

  const profileLabel = workspace?.profile?.label;
  const contextPercent = session?.contextPercent;

  return (
    <section className="gc-footer" aria-label="Session footer" tabIndex={0} title="Scroll horizontally to see all session details in narrow windows.">
      <span className="gc-footer__group gc-footer__path">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" /></svg>
        <span>{workspacePath ?? "~/"}</span>
      </span>
      {worktree ? <ChangesGroup worktree={worktree} /> : null}
      {mcp ? <CapabilitiesGroup mcp={mcp} /> : null}
      {session ? <IdentityGroup session={session} profileLabel={profileLabel} /> : null}
      {contextPercent != null ? (
        <span className="gc-footer__group gc-footer__context" aria-label="Context used">
          <span className="gc-footer__label">context</span>
          <span className="gc-footer__meter" aria-hidden="true">
            <span style={{ width: `${contextPercent}%` }} />
          </span>
          <span className="gc-footer__context-used">{contextPercent}%</span>
        </span>
      ) : null}
      {appVersion ? <span className="gc-footer__version">{appVersion.startsWith("v") ? appVersion : `v${appVersion}`}</span> : null}
    </section>
  );
}

/**
 * Session identity (desktop-rpc T4, moved here by S10): the design's
 * `·`-separated facts, in the artboard's order. Each fact renders only when
 * the child actually reported it — a fact the child did not send renders
 * nothing, never a placeholder.
 */
function IdentityGroup({
  session,
  profileLabel,
}: {
  session?: SessionIdentityView;
  profileLabel?: string;
}) {
  const modelLabel = session?.modelName ?? session?.modelId;
  const thinkingLevel = session?.thinkingLevel;

  if (!modelLabel && !thinkingLevel && !profileLabel) return null;

  return (
    <span className="gc-footer__group gc-footer__identity" aria-label="Session identity">
      {modelLabel ? <span className="gc-footer__model">{modelLabel}</span> : null}
      {modelLabel && thinkingLevel ? <DotSeparator /> : null}
      {thinkingLevel ? <span className="gc-footer__thinking">{thinkingLevel}</span> : null}
      {(thinkingLevel || modelLabel) && profileLabel ? <DotSeparator /> : null}
      {profileLabel ? <span>{profileLabel}</span> : null}
    </span>
  );
}

/**
 * The child's own counts, or the unavailable word when it supplied none:
 * `countsUnavailable` covers a failed or unborn root, a refused answer and
 * a partial count (an unmeasured untracked file), and none of those may
 * render as zero files and zero lines.
 */
function ChangesGroup({ worktree }: { worktree: WorktreeChanges }) {
  // Absent tallies are as honest as the explicit flag: printing "0 files ·
  // +0/-0" would invent numbers the child never sent.
  const unavailable =
    worktree.countsUnavailable || worktree.added === undefined || worktree.deleted === undefined;

  return (
    <span className="gc-footer__group" role="group" aria-label="Workspace changes">
      <span className="gc-footer__label">changes</span>
      {unavailable ? (
        <span>unavailable</span>
      ) : (
        <>
          <span>{worktree.files.length} files</span>
          <span className="gc-footer__added">+{worktree.added}</span>
          <span className="gc-footer__deleted">-{worktree.deleted}</span>
        </>
      )}
    </span>
  );
}

/** Inventory wording only. `health` is deliberately not rendered: it is
 * always "unknown", and printing it would invite someone to read a green dot
 * into a channel that cannot report one. */
function CapabilitiesGroup({ mcp }: { mcp: McpStatus }) {
  const names = mcp.configuredNames.length > 0 ? mcp.configuredNames.length : mcp.registered.length;
  return (
    <span className="gc-footer__group" role="group" aria-label="Capabilities">
      <span className="gc-footer__capability" role="img" aria-label={`MCP: ${names} configured servers`} title={`MCP: ${names} configured servers`}>
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3v5M16 3v5M6 8h12v4a6 6 0 0 1-12 0V8ZM12 18v4" /></svg>
        <span>{names}</span>
      </span>
    </span>
  );
}

function DotSeparator() {
  return (
    <span className="gc-footer__dot" aria-hidden="true">
      ·
    </span>
  );
}
