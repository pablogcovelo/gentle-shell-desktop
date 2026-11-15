import type { ChatSummary } from "@shared/bridge-types";
import "./ChatListItem.css";

export interface ChatListItemProps {
  readonly chat: ChatSummary;
  readonly selected?: boolean;
  readonly onSelect: (chat: ChatSummary) => void;
}

/** Shared with the search filter; empty paths never invent a directory. */
export function directoryOf(cwd: ChatSummary["cwd"]): string | undefined {
  return cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : undefined;
}

export function ChatListItem({ chat, selected = false, onSelect }: ChatListItemProps) {
  const directory = directoryOf(chat.cwd);
  return (
    <li>
      <button type="button" className={`gc-chat-list-item${selected ? " gc-chat-list-item--selected" : ""}`} aria-current={selected || undefined} aria-label={directory ? `${directory} — ${chat.title}` : chat.title} title={chat.cwd ? `${chat.cwd} — ${chat.title}` : chat.title} onClick={() => onSelect(chat)}>
        <svg className="gc-chat-list-item__glyph" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" />
        </svg>
        <span className="gc-chat-list-item__body">
          <strong className="gc-chat-list-item__title">{directory ?? chat.title}</strong>
          {/* ChatSummary has no branch field: do not substitute a cwd, state or sample branch. */}
        </span>
      </button>
    </li>
  );
}
