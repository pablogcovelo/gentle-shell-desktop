import type { ChatNotification } from "@shared/bridge-types";
import "./StatusLine.css";

export interface StatusLineProps {
  readonly error?: string;
  /** Keyed statuses from ChatState (desktop-rpc T2b). Optional: absent until
   * an extension publishes one. */
  readonly statuses?: Readonly<Record<string, string>>;
  /** Retained notifications from ChatState (desktop-rpc T2b). Optional for
   * the same reason as `statuses`. */
  readonly notifications?: readonly ChatNotification[];
}

/**
 * Persistent status policy (S12, gui-design-alignment, pinned by test):
 * errors, keyed statuses and notifications are part of the conversation
 * flow and NEVER auto-hidden — the owner's decision (L4 3.5): "si solo se
 * muestran por un periodo de tiempo limitado es muy fácil que el usuario
 * se pierda estos StatusLine". There is no visibility timer: whatever the
 * surfaces currently hold renders for as long as it exists. Notifications
 * stay bounded by ChatState's reducer cap (MAX_NOTIFICATIONS), so even a
 * chatty child can only ever show that many, and clearing is the wire's
 * job, not the UI's.
 *
 * None of the three is a synthetic ChatMessage appended to the thread —
 * they render here, in the status surface, and ConversationContainer feeds
 * them from ChatState (the same surfaces the Helpers pane already shows).
 * The chat pane and the helpers pane both mount this component; the entries
 * colour by severity (error red, warning amber, info blue) but never join
 * the transcript.
 *
 * Session identity is NOT here: the owner's footer decision
 * (desktop-workspace-shell S9/S10) supersedes the old "one home per datum"
 * split, and model, thinking level, context and cost moved out of this
 * surface into the footer and the inspector's usage summary.
 */

// Presentational: the dedicated status surface ConversationContainer feeds
// from ChatState — errors (ChatState.lastError or a bridge.onError push),
// keyed statuses (ChatState.statuses, replaced/cleared by the wire) and
// notifications (ChatState.notifications, severity-coloured). Rendered
// whenever they exist, persistent, never auto-hidden; returns null only
// when there is nothing at all to show.
export function StatusLine({ error, statuses, notifications }: StatusLineProps) {
  const statusEntries = Object.entries(statuses ?? {});
  const notificationList = notifications ?? [];
  const hasError = Boolean(error);
  const hasStatuses = statusEntries.length > 0;
  const hasNotifications = notificationList.length > 0;

  if (!hasError && !hasStatuses && !hasNotifications) return null;

  return (
    <>
      {hasError ? (
        <p role="status" className="gc-status-line gc-status-line--error">
          {error}
        </p>
      ) : null}
      {hasStatuses ? (
        <ul className="gc-status-entries gc-status-entries--info" aria-label="Session status">
          {statusEntries.map(([key, text]) => (
            <li key={key} className="gc-status-entries__entry">
              <span className="gc-status-entries__key">{key}</span>
              <span className="gc-status-entries__text">{text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {hasNotifications ? (
        <ul className="gc-status-notifications" aria-label="Notifications" aria-live="polite">
          {notificationList.map((notification, index) => (
            <li
              key={`${index}-${notification.severity}-${notification.message}`}
              className={`gc-status-line__notification gc-status-line__notification--${notification.severity}`}
            >
              {notification.message}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
