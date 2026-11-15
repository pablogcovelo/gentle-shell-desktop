import type { HelpersActivity, SubscriptionUsage, TodoPanelState } from "@shared/bridge-types";
import type { ReactElement } from "react";
import { TodoCard, todoProgress } from "./TodoCard";
import { UsageMeters } from "./UsageMeters";
import "./InspectorPanel.css";

export interface InspectorPanelProps {
  /** The open chat's ODD task state (ChatState.todo). Optional: absent
   * until the first push, and absent entirely for chats with no tasks. */
  readonly todo?: TodoPanelState;
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
export function InspectorPanel({ todo, usage, usageChannelUnavailable, helpers, onOpenHelpers }: InspectorPanelProps): ReactElement {
  const tasks = todo?.tasks ?? [];
  const progress = todo ? todoProgress(todo) : null;
  // The meters own the channel-unavailable state: a failed probe renders
  // their red channel note, not the plainer "no usage reported" one.
  const hasUsage = usageChannelUnavailable === true || (usage?.providers?.length ?? 0) > 0;
  const hasAgents = helpers.tasks.length > 0;

  return (
    <aside className="gc-inspector" id="gc-inspector" aria-label="Plan, usage and delegated agents">
      <section className="gc-inspector__section" aria-labelledby="gc-inspector-todo">
        <div className="gc-inspector__head">
          <h2 id="gc-inspector-todo">Todo</h2>
          {progress && progress.planned > 0 ? (
            <span className="gc-inspector__meta">
              {progress.done}/{progress.planned}
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
          {hasUsage ? (
            <UsageMeters usage={usage} channelUnavailable={usageChannelUnavailable} variant="panel" />
          ) : (
            <p className="gc-inspector__note">No usage reported yet.</p>
          )}
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
              <ul className="gc-inspector__agents">
                {helpers.tasks.map((task) => (
                  <li key={task.id} className="gc-inspector__agent" data-status={task.status}>
                    <span className="gc-inspector__agent-name">{task.agent}</span>
                    <span className="gc-inspector__agent-status">{task.status}</span>
                    <span className="gc-inspector__agent-label">{task.label}</span>
                    {task.lastStep ? <span className="gc-inspector__agent-step">{task.lastStep}</span> : null}
                    <span className="gc-inspector__agent-counters">
                      {task.turns} turns · {task.toolCalls} tool calls
                    </span>
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
