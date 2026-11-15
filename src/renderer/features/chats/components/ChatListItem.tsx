import type { ChatSummary } from "@shared/bridge-types";
import "./ChatListItem.css";

export interface ChatListItemProps {
  readonly chat: ChatSummary;
  readonly selected?: boolean;
  /** The open workspace's branch, when its child reported one. Only the
   * selected row can have it: it comes from that workspace's live worktree
   * state, and the session summary carries no branch to invent one from. */
  readonly branch?: string;
  readonly onSelect: (chat: ChatSummary) => void;
}

/** Shared with the search filter; empty paths never invent a directory. */
export function directoryOf(cwd: ChatSummary["cwd"]): string | undefined {
  return cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : undefined;
}

export function ChatListItem({ chat, selected = false, branch, onSelect }: ChatListItemProps) {
  const directory = directoryOf(chat.cwd);
  return (
    <li>
      <button type="button" className={`gc-chat-list-item${selected ? " gc-chat-list-item--selected" : ""}`} aria-current={selected || undefined} aria-label={directory ? `${directory} — ${chat.title}` : chat.title} title={chat.cwd ? `${chat.cwd} — ${chat.title}` : chat.title} onClick={() => onSelect(chat)}>
        <svg className="gc-chat-list-item__glyph" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" />
        </svg>
        <span className="gc-chat-list-item__body">
          <strong className="gc-chat-list-item__title">{directory ?? chat.title}</strong>
          {/* The branch belongs under the workspace name (owner decision), and
          only when the child reported one: ChatSummary has no branch field, so
          an unselected row must not invent one. */}
          {branch !== undefined ? <span className="gc-chat-list-item__branch">{branch}</span> : null}
        </span>
      </button>
    </li>
  );
}
