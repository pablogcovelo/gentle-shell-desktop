import { useEffect, useState } from "react";
import type { ChatNotification, SessionIdentityView } from "@shared/bridge-types";
import "./StatusLine.css";

export interface StatusLineProps {
  readonly error?: string;
  /** Keyed statuses from ChatState (desktop-rpc T2b). Optional: absent until
   * an extension publishes one. */
  readonly statuses?: Readonly<Record<string, string>>;
  /** Retained notifications from ChatState (desktop-rpc T2b). Optional for
   * the same reason as `statuses`. */
  readonly notifications?: readonly ChatNotification[];
  /** Session identity from pi's own RPC replies (desktop-rpc T4): cost,
   * tokens, context usage and the EFFECTIVE model/thinking level. Optional:
   * absent until the first correlated reply lands, and every field inside it
   * is optional on its own. */
  readonly session?: SessionIdentityView;
}

/**
 * Transient-notification policy (desktop-rpc T2b, pinned by test): a pi
 * `notify` is the desktop counterpart of a terminal's transient
 * notification — feedback in the moment, not history. The stack renders
 * the notifications ChatState currently retains (the reducer caps that at
 * MAX_NOTIFICATIONS, so even a chatty child can only ever show this many)
 * and hides the whole stack NOTIFICATION_VISIBLE_MS after the newest
 * arrival; a later arrival restarts that window. Nothing accumulates
 * forever in the UI, and no notification ever becomes a conversation
 * message — it renders here, in the status surface, never in the thread.
 */
const NOTIFICATION_VISIBLE_MS = 6000;

// Presentational: the dedicated status surface ConversationContainer feeds
// from ChatState — errors (ChatState.lastError or a bridge.onError push),
// keyed statuses (ChatState.statuses, replaced/cleared by the wire) and
// transient notifications (ChatState.notifications, severity-coloured).
// None of the three is a synthetic ChatMessage appended to the thread.
export function StatusLine({ error, statuses, notifications, session }: StatusLineProps) {
  const statusEntries = Object.entries(statuses ?? {});
  const notificationCount = notifications?.length ?? 0;
  const [notificationsVisible, setNotificationsVisible] = useState(true);

  // Restarts the transient window on every pushed notifications payload (a
  // new arrival re-shows the stack and gives the user the full window
  // again). With no notifications there is nothing to show, so the timer
  // is not armed and the hidden state persists.
  useEffect(() => {
    if (notificationCount === 0) return;
    setNotificationsVisible(true);
    const timer = setTimeout(() => setNotificationsVisible(false), NOTIFICATION_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [notificationCount, notifications]);

  const showNotifications = notificationsVisible && notificationCount > 0;

  // Session identity (desktop-rpc T4). Each field renders only when the child
  // actually reported it: an absent or `null` context is "not supplied" and
  // must never look like 0 %, while a supplied 0 cost is a real zero. Both
  // distinctions are pinned by test.
  const modelLabel = session?.modelName ?? session?.modelId;
  const thinkingLevel = session?.thinkingLevel;
  const contextPercent = session?.contextPercent;
  const sessionCost = session?.sessionCost;
  const hasIdentity =
    Boolean(modelLabel) || Boolean(thinkingLevel) || contextPercent != null || sessionCost != null;

  if (!error && statusEntries.length === 0 && !showNotifications && !hasIdentity) return null;

  return (
    <>
      {error ? (
        <p role="status" className="gc-status-line">
          {error}
        </p>
      ) : null}
      {statusEntries.length > 0 ? (
        <ul className="gc-status-entries" aria-label="Session status">
          {statusEntries.map(([key, text]) => (
            <li key={key} className="gc-status-entries__entry">
              <span className="gc-status-entries__key">{key}</span>
              <span className="gc-status-entries__text">{text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {showNotifications ? (
        <ul className="gc-status-notifications" aria-label="Notifications" aria-live="polite">
          {notifications!.map((notification, index) => (
            <li
              key={`${index}-${notification.severity}-${notification.message}`}
              className={`gc-status-line__notification gc-status-line__notification--${notification.severity}`}
            >
              {notification.message}
            </li>
          ))}
        </ul>
      ) : null}
      {hasIdentity ? (
        <dl className="gc-status-identity" aria-label="Session identity">
          {modelLabel ? (
            <div className="gc-status-identity__field">
              <dt>model</dt>
              <dd>{modelLabel}</dd>
            </div>
          ) : null}
          {thinkingLevel ? (
            <div className="gc-status-identity__field">
              <dt>thinking</dt>
              <dd>{thinkingLevel}</dd>
            </div>
          ) : null}
          {contextPercent != null ? (
            <div className="gc-status-identity__field">
              <dt>context</dt>
              <dd>{contextPercent}%</dd>
            </div>
          ) : null}
          {sessionCost != null ? (
            <div className="gc-status-identity__field">
              <dt>cost</dt>
              <dd>{formatCost(sessionCost)}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </>
  );
}

/**
 * Session cost as the child reports it: a real zero stays "$0" and a
 * fractional cost keeps two decimals. The caller never reaches this function
 * when the child supplied nothing — absent cost renders no field at all.
 */
function formatCost(cost: number): string {
  return `$${cost % 1 === 0 ? cost.toFixed(0) : cost.toFixed(2)}`;
}
