import type { OddPhase } from "@shared/bridge-types";
import { Button } from "@renderer/shared/ui/atoms/Button";
import "./ConversationHeader.css";

export const CONVERSATION_PANE = { CHAT: "chat", HELPERS: "helpers" } as const;
/** Inspector controls open the detailed helper view, not a header tab. */
export type ConversationPane = (typeof CONVERSATION_PANE)[keyof typeof CONVERSATION_PANE];

export interface ConversationHeaderProps {
  readonly title: string;
  /** T5 (desktop-pending-work S5): the ODD phase token the child last
   * published through desktop-rpc's `session_state_changed`, as read from
   * ChatState.oddPhase. Absent means unknown or cleared: the indicator
   * renders nothing at all. Never inferred here, never derived from a
   * tool name. */
  readonly oddPhase?: OddPhase;
  readonly working?: boolean;
  readonly pane?: ConversationPane;
  readonly runningHelpersCount?: number;
  readonly onSelectPane?: (pane: ConversationPane) => void;
  /** P2: whether this pane addresses a live host it can close. False
   * before the open/new resolution answers, because there is no host to
   * stop yet — a control that cannot act must not be drawn. */
  readonly canCloseWorkspace?: boolean;
  /** P2: asks the container to close the addressed host through
   * chat.close. Nothing is stopped here; the header only reports intent. */
  readonly onCloseWorkspace?: () => void;
}

/** The app's own wording per ODD phase token (desktop-pending-work T5,
 * S5): the client owns its label — the host's own wording ("<phase>…") is
 * deliberately never copied. One consistent spelling: capitalized, no
 * trailing ellipsis, nothing more than the phase name. */
export const ODD_PHASE_LABELS: Readonly<Record<OddPhase, string>> = {
  authorizing: "Authorizing",
  exploring: "Exploring",
  researching: "Researching",
  deciding: "Deciding",
  planning: "Planning",
  implementing: "Implementing",
  checking: "Checking",
  closing: "Closing",
};

/** The board's directory-only context bar, plus the workspace's own close
 * control (P2) once the pane knows which host it is addressing, and the
 * ODD phase the child last published (T5, S5). */
export function ConversationHeader({ title, oddPhase, canCloseWorkspace = false, onCloseWorkspace }: ConversationHeaderProps) {
  return (
    <header className="gc-conversation-header">
      <div className="gc-conversation-header__context">
        <h2 className="gc-conversation-header__title">
          <svg className="gc-conversation-header__glyph" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" />
          </svg>
          <span className="gc-conversation-header__title-text">{title}</span>
        </h2>
        {/* The ODD phase the child last published through
        `session_state_changed` (S5): chrome, not a tab and not a control —
        plain text, no click handler, no tooltip claiming a capability.
        Absent means unknown or cleared: nothing is rendered at all. */}
        {oddPhase ? <span className="gc-conversation-header__phase">{ODD_PHASE_LABELS[oddPhase]}</span> : null}
        {canCloseWorkspace && onCloseWorkspace ? (
          <Button
            variant="ghost"
            className="gc-conversation-header__close"
            aria-label="Close this workspace"
            title="Stops this workspace's child process"
            onClick={onCloseWorkspace}
          >
            Close
          </Button>
        ) : null}
      </div>
    </header>
  );
}
