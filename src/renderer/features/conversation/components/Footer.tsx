import type { McpStatus, SessionIdentityView, WorkspaceInfo } from "@shared/bridge-types";
import "./Footer.css";

export interface FooterProps {
  /** Worktree/MCP/profile facts from desktop-rpc (T8). Each part is optional
   * and renders only when it arrived. */
  readonly workspace?: WorkspaceInfo;
  /** The session identity the status line already reads (T4), repeated here
   * so the footer is one place rather than two. */
  readonly session?: SessionIdentityView;
}

/**
 * The composed footer: profile, MCP inventory, model, reasoning, context and
 * session cost — one quiet line, each field rendered only when the child
 * actually supplied it.
 *
 * Two honesty rules are visible in the copy itself. MCP is inventory, never
 * health: the label says what is configured and how many tool groups exist,
 * and no wording here may ever say a server is connected, because pi does not
 * expose that. And an absent value renders nothing rather than a zero.
 */
export function Footer({ workspace, session }: FooterProps) {
  const profile = workspace?.profile?.label;
  const mcp = workspace?.mcp;
  const modelLabel = session?.modelName ?? session?.modelId;
  const thinking = session?.thinkingLevel;
  const contextPercent = session?.contextPercent;
  const cost = session?.sessionCost;
  const mcpSummary = mcp ? describeMcp(mcp) : undefined;

  const hasAny =
    Boolean(profile) || Boolean(mcpSummary) || Boolean(modelLabel) || contextPercent != null || cost != null;
  if (!hasAny) return null;

  return (
    <footer className="gc-footer" aria-label="Session footer">
      {profile ? <Field label="profile" value={profile} /> : null}
      {mcpSummary ? <Field label="MCP" value={mcpSummary} /> : null}
      {modelLabel ? <Field label="model" value={modelLabel} /> : null}
      {thinking ? <Field label="thinking" value={thinking} /> : null}
      {contextPercent != null ? <Field label="context" value={`${contextPercent}%`} /> : null}
      {cost != null ? <Field label="cost" value={formatCost(cost)} /> : null}
    </footer>
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

function formatCost(cost: number): string {
  return `$${cost % 1 === 0 ? cost.toFixed(0) : cost.toFixed(2)}`;
}
