import { CHAT_STATE, type ChatSummary } from "@shared/bridge-types";
import { Pill, PILL_TONE, type PillTone } from "@renderer/shared/ui/atoms/Pill";
import "./ChatListItem.css";

const STATE_PILL_TONE: Record<ChatSummary["state"], PillTone> = {
  [CHAT_STATE.IDLE]: PILL_TONE.NEUTRAL,
  [CHAT_STATE.WORKING]: PILL_TONE.WORKING,
  [CHAT_STATE.NEEDS_YOU]: PILL_TONE.NEEDS_YOU,
};

const STATE_LABEL: Record<ChatSummary["state"], string> = {
  [CHAT_STATE.IDLE]: "idle",
  [CHAT_STATE.WORKING]: "working",
  [CHAT_STATE.NEEDS_YOU]: "needs you",
};

export interface ChatListItemProps {
  readonly chat: ChatSummary;
  readonly selected?: boolean;
  readonly onSelect: (chat: ChatSummary) => void;
}

// Presentational only — receives props, talks to nothing. ChatsContainer
// (through ChatList) owns the bridge call and passes ChatSummary values
// down. A <button> (not a clickable <div>) so the list is keyboard- and
// screen-reader-navigable without extra ARIA plumbing.
/** T2/S8: the artboard's .workspace-item secondary line — the chat's
 * directory, i.e. the last segment of its cwd, on either path separator. An
 * empty or missing cwd yields no second line: we never invent one (S5).
 * Exported because ChatsContainer reuses it for the query filter: the list
 * is filtered by exactly the directory that is rendered. */
export function directoryOf(cwd: ChatSummary["cwd"]): string | undefined {
  return cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : undefined;
}

export function ChatListItem({ chat, selected = false, onSelect }: ChatListItemProps) {
  const classes = ["gc-chat-list-item", selected && "gc-chat-list-item--selected"].filter(Boolean).join(" ");
  const directory = directoryOf(chat.cwd);

  return (
    <li>
      <button
        type="button"
        className={classes}
        aria-current={selected || undefined}
        onClick={() => onSelect(chat)}
      >
        {/* S8: the artboard's .workspace-item leading folder mark; aria-hidden
        so it never joins the button's accessible name. */}
        <svg
          className="gc-chat-list-item__glyph"
          viewBox="0 0 24 24"
          width="18"
          height="18"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="M3 7a2 2 0 0 1 2-2h4.2a1 1 0 0 1 .8.4L11.3 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
        <span className="gc-chat-list-item__body">
          <strong className="gc-chat-list-item__title">{chat.title}</strong>
          <span className="gc-chat-list-item__meta">
            {directory ? <small className="gc-chat-list-item__directory">{directory}</small> : null}
            <Pill tone={STATE_PILL_TONE[chat.state]}>{STATE_LABEL[chat.state]}</Pill>
          </span>
        </span>
      </button>
    </li>
  );
}
