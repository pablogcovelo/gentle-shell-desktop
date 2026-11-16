import { Button } from "@renderer/shared/ui/atoms/Button";
import "./ConversationHeader.css";

export const CONVERSATION_PANE = { CHAT: "chat", HELPERS: "helpers" } as const;
/** Inspector controls open the detailed helper view, not a header tab. */
export type ConversationPane = (typeof CONVERSATION_PANE)[keyof typeof CONVERSATION_PANE];

export interface ConversationHeaderProps {
  readonly title: string;
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

/** The board's directory-only context bar, plus the workspace's own close
 * control (P2) once the pane knows which host it is addressing. */
export function ConversationHeader({ title, canCloseWorkspace = false, onCloseWorkspace }: ConversationHeaderProps) {
  return (
    <header className="gc-conversation-header">
      <div className="gc-conversation-header__context">
        <h2 className="gc-conversation-header__title">
          <svg className="gc-conversation-header__glyph" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" />
          </svg>
          <span className="gc-conversation-header__title-text">{title}</span>
        </h2>
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
