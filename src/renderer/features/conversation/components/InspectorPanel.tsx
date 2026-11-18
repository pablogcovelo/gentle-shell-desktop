import type { HelpersActivity, SessionIdentityView, SubscriptionUsage, TodoPanelState } from "@shared/bridge-types";
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
  /** Opens the helpers view (S6: the button performs its stated action). */
  readonly onOpenHelpers: () => void;
}

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
            <>
              <p className="gc-inspector__note gc-inspector__intro">A small plan. A clear next step.</p>
              {progress?.percent != null && <>
                <div className="gc-inspector__progress" role="progressbar" aria-label="Task progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}><span style={{ width: `${progress.percent}%` }} /></div>
              </>}
              <TodoCard todo={todo} variant="panel" />
            </>
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
        </div>
        <div className="gc-inspector__scroll" tabIndex={0} role="group" aria-label="Delegated agents in this conversation">
          {hasAgents ? (
            <>
              <p className="gc-inspector__agent-caption"><code>/gentle:agents</code></p>
              <ul className="gc-inspector__agents">
                {helpers.tasks.map((task) => (
                  <li key={task.id} className="gc-inspector__agent" data-status={task.status}>
                    <details>
                      <summary aria-label={`${task.status} subagent ${task.agent}: ${task.label}`}><span className="gc-inspector__agent-tree" aria-hidden="true">└</span><span className="gc-inspector__agent-status" aria-hidden="true">{task.status === "running" ? "◐" : task.status === "done" ? "✓" : task.status === "failed" ? "✕" : "○"}</span><span className="gc-inspector__agent-name">Subagent <code>{task.agent}</code></span></summary>
                      <div className="gc-inspector__agent-log">
                        <p className="gc-inspector__agent-label">{task.label}</p>
                        <p><code>{task.id}</code> · {task.status}</p>
                        {task.lastStep ? <p className="gc-inspector__agent-step">{task.lastStep}</p> : null}
                        <p className="gc-inspector__agent-counters">{task.turns} turns · {task.toolCalls} tool calls</p>
                      </div>
                    </details>
                  </li>
                ))}
              </ul>
              <button type="button" className="gc-inspector__open-helpers" onClick={onOpenHelpers}>
                Open helpers
              </button>
            </>
          ) : (
            <p className="gc-inspector__note">No delegated agents in this conversation yet.</p>
          )}
        </div>
      </section>
    </aside>
  );
}
