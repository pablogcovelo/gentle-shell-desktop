import type { HelperStatus, HelpersActivity, SessionIdentityView, SubscriptionUsage, TodoPanelState } from "@shared/bridge-types";
import type { ReactElement } from "react";
import { TodoCard, todoProgress } from "./TodoCard";
import { UsageMeters } from "./UsageMeters";
import "./InspectorPanel.css";

export interface InspectorPanelProps {
  /** The open chat's ODD task state (ChatState.todo). Optional: absent
   * until the first push, and absent entirely for chats with no tasks. */
  readonly todo?: TodoPanelState;
  readonly session?: SessionIdentityView;
  /** The open chat's subscription usage (ChatState.usage). Optional: absent
   * until the first `get_subscription_usage` reply or `rate_limit` event. */
  readonly usage?: SubscriptionUsage;
  /** True when the desktop control channel probe failed for this chat's
   * child — routed straight into the meters' honest channel note. */
  readonly usageChannelUnavailable?: boolean;
  /** The open chat's delegated-agent activity (ChatState.helpers). */
  readonly helpers: HelpersActivity;
  /** Opens the helpers view (S10: the Agents head's eye button performs its stated action). */
  readonly onOpenHelpers: () => void;
}

/**
 * S9 (gui-design-alignment): the glyph and word a flat agent row shows,
 * total over the six statuses the app knows (HELPER_STATUS in
 * src/shared/bridge-types.ts). A status value outside that set falls
 * back to ○ and its raw word — the row never invents a reading.
 */
const AGENT_GLYPH: Record<HelperStatus, string> = {
  queued: "○",
  running: "◐",
  waiting: "○",
  done: "✓",
  failed: "✕",
  cancelled: "⊘",
};
const AGENT_WORD: Record<HelperStatus, string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

/**
 * The artboard's fixed three-section inspector (T3 — design/slack-gentle/
 * 01-workspace.html): Todo / Usage / Agents, three equal, independently
 * scrolling sections beside the conversation. Presentational: the
 * container feeds it the pushed ChatState slices of the open chat, so
 * every count, status and note is wire-supplied — a section with no data
 * says so and never renders a fabricated zero, percentage or agent (S5).
 */
export function InspectorPanel({ todo, usage, usageChannelUnavailable, helpers, onOpenHelpers, session }: InspectorPanelProps): ReactElement {
  const tasks = todo?.tasks ?? [];
  const progress = todo ? todoProgress(todo) : null;
  const hasAgents = helpers.tasks.length > 0;

  return (
    <aside className="gc-inspector" id="gc-inspector" aria-label="Plan, usage and delegated agents">
      <section className="gc-inspector__section" aria-labelledby="gc-inspector-todo">
        <div className="gc-inspector__head">
          <h2 id="gc-inspector-todo">Todo</h2>
          {progress && progress.planned > 0 ? (
            <span className="gc-inspector__meta">
              {progress.done}/{progress.planned} · {progress.percent}%
            </span>
          ) : null}
        </div>
        <div className="gc-inspector__scroll" tabIndex={0} role="group" aria-label="Tasks in this conversation">
          {todo && tasks.length > 0 ? (
            <TodoCard todo={todo} variant="panel" />
          ) : (
            <p className="gc-inspector__note">No tasks in this conversation yet.</p>
          )}
        </div>
      </section>

      <section className="gc-inspector__section" aria-labelledby="gc-inspector-usage">
        <div className="gc-inspector__head">
          <h2 id="gc-inspector-usage">Usage</h2>
          <span className="gc-inspector__meta">this session</span>
        </div>
        <div className="gc-inspector__scroll" tabIndex={0} role="group" aria-label="Usage in this conversation">
          {/* The cost opens the section (design/slack-gentle, clq1vtao): one
          tight row above the meters, so the value the reader checks first is
          not buried under every window. */}
          {session?.sessionCost != null && (
            <div className="gc-inspector__cost">
              <span>session cost</span>
              <strong aria-label="Total session cost in US dollars" title="Total session cost in USD">${session.sessionCost.toFixed(2)}</strong>
            </div>
          )}
          {/* Rendered unconditionally: the meters already render nothing when
          nothing survives their source filter, so a provider in scope with
          no usage source leaves only this section's reserved empty space —
          never a "no usage" paragraph next to a dead block. The meters own
          the channel-unavailable state: a failed probe renders their red
          channel note, which is a failure, not emptiness. */}
          <UsageMeters usage={usage} channelUnavailable={usageChannelUnavailable} variant="panel" />
        </div>
      </section>

      <section className="gc-inspector__section" aria-labelledby="gc-inspector-agents">
        <div className="gc-inspector__head">
          <h2 id="gc-inspector-agents">Agents</h2>
          <span className="gc-inspector__meta">
            {helpers.summary.running} active · {helpers.summary.finished} finished
          </span>
          {hasAgents ? (
            <button type="button" className="gc-inspector__eye" aria-label="Open helpers" title="Open helpers" onClick={onOpenHelpers}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
          ) : null}
        </div>
        <div className="gc-inspector__scroll" tabIndex={0} role="group" aria-label="Delegated agents in this conversation">
          {hasAgents ? (
            <>
              <p className="gc-inspector__agent-caption"><code>/gentle:agents</code></p>
              <ul className="gc-inspector__agents">
                {helpers.tasks.map((task) => (
                  <li key={task.id} className="gc-inspector__agent" data-status={task.status}>
                    <span className="gc-inspector__agent-status" aria-hidden="true">{AGENT_GLYPH[task.status] ?? "○"}</span>
                    <code className="gc-inspector__agent-name">{task.agent}</code>
                    <span className="gc-inspector__agent-sep">·</span>
                    <span className="gc-inspector__agent-word">{AGENT_WORD[task.status] ?? task.status}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="gc-inspector__note">No delegated agents in this conversation yet.</p>
          )}
        </div>
      </section>
    </aside>
  );
}
