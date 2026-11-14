import type { McpStatus, WorkspaceInfo } from "@shared/bridge-types";
import "./Footer.css";

export interface FooterProps {
  /** Worktree/MCP/profile facts from desktop-rpc (T8). Each part is optional
   * and renders only when it arrived. */
  readonly workspace?: WorkspaceInfo;
}

/**
 * The composed footer: the session-effective profile and the MCP inventory.
 *
 * It deliberately does NOT repeat the model, reasoning, context or cost: those
 * live in the status line (T4), and rendering them twice made two surfaces
 * compete for the same fact. One home per datum.
 *
 * MCP is inventory, never health: the label says what is configured and how
 * many tool groups exist, and no wording here may ever say a server is
 * connected, because pi does not expose that.
 */
export function Footer({ workspace }: FooterProps) {
  const profile = workspace?.profile?.label;
  const mcp = workspace?.mcp;
  const mcpSummary = mcp ? describeMcp(mcp) : undefined;

  if (!profile && !mcpSummary) return null;

  return (
    <section className="gc-footer" aria-label="Session footer">
      {profile ? <Field label="profile" value={profile} /> : null}
      {mcpSummary ? <Field label="MCP" value={mcpSummary} /> : null}
    </section>
  );
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
