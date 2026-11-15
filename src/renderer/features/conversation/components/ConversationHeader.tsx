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
}

/** The board's directory-only context bar. */
export function ConversationHeader({ title }: ConversationHeaderProps) {
  return (
    <header className="gc-conversation-header">
      <div className="gc-conversation-header__context">
        <h2 className="gc-conversation-header__title">
          <svg className="gc-conversation-header__glyph" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" />
          </svg>
          <span className="gc-conversation-header__title-text">{title}</span>
        </h2>
      </div>
    </header>
  );
}
