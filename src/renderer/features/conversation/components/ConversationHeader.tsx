import { Pill, PILL_TONE } from "@renderer/shared/ui/atoms/Pill";
import "./ConversationHeader.css";

export const CONVERSATION_PANE = {
  CHAT: "chat",
  HELPERS: "helpers",
} as const;

/** Which pane the conversation view is showing — the plain thread/composer, or the D3 Helpers tab. Owned here (not ConversationContainer) because ConversationHeader owns the tab switch UI it names. */
export type ConversationPane = (typeof CONVERSATION_PANE)[keyof typeof CONVERSATION_PANE];

export interface ConversationHeaderProps {
  readonly title: string;
  readonly working: boolean;
  readonly pane: ConversationPane;
  readonly runningHelpersCount: number;
  readonly onSelectPane: (pane: ConversationPane) => void;
}

// Presentational: the context bar of the open chat — its directory glyph and
// title, a "Working…" pill while ChatState.working is true, and the
// Chat/Helpers tab row (D3) with the running helper count in the Helpers
// label. Mirrors the artboard's `.contextbar` + `.tabbar` pair.
export function ConversationHeader({ title, working, pane, runningHelpersCount, onSelectPane }: ConversationHeaderProps) {
  return (
    <header className="gc-conversation-header">
      <div className="gc-conversation-header__context">
        <h2 className="gc-conversation-header__title">
          <FolderGlyph />
          <span className="gc-conversation-header__title-text">{title}</span>
        </h2>
        {working && <Pill tone={PILL_TONE.WORKING}>Working…</Pill>}
      </div>
      <div className="gc-conversation-header__tabs" role="tablist">
        <PaneTab pane={CONVERSATION_PANE.CHAT} active={pane === CONVERSATION_PANE.CHAT} label="Chat" onSelectPane={onSelectPane} />
        <PaneTab
          pane={CONVERSATION_PANE.HELPERS}
          active={pane === CONVERSATION_PANE.HELPERS}
          label={runningHelpersCount > 0 ? `Helpers (${runningHelpersCount} running)` : "Helpers"}
          onSelectPane={onSelectPane}
        />
      </div>
    </header>
  );
}

/** Decorative directory mark, aria-hidden so the heading keeps its name. */
function FolderGlyph() {
  return (
    <svg
      className="gc-conversation-header__glyph"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" />
    </svg>
  );
}

interface PaneTabProps {
  readonly pane: ConversationPane;
  readonly active: boolean;
  readonly label: string;
  readonly onSelectPane: (pane: ConversationPane) => void;
}

function PaneTab({ pane, active, label, onSelectPane }: PaneTabProps) {
  const classes = ["gc-conversation-header__tab", active && "gc-conversation-header__tab--active"].filter(Boolean).join(" ");

  return (
    <button type="button" role="tab" aria-selected={active} className={classes} onClick={() => onSelectPane(pane)}>
      {label}
    </button>
  );
}
