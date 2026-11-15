import type { ChatSummary } from "@shared/bridge-types";
import { ChatListItem } from "./ChatListItem";
import "./ChatList.css";

export interface ChatListProps {
  readonly chats: readonly ChatSummary[];
  readonly selectedId?: string;
  readonly onSelect: (chat: ChatSummary) => void;
  /** The open workspace's branch, shown under that workspace's name only. */
  readonly activeBranch?: string;
  /** Retained for callers; directory navigation has no day buckets. */
  readonly now?: Date;
}

/** Preserve bridge order and session identities; never merge equal directories. */
export function ChatList({ chats, selectedId, onSelect, activeBranch }: ChatListProps) {
  return (
    <div className="gc-chat-list">
      <ul className="gc-chat-list__items" aria-label="Workspace directories">
        {chats.map((chat) => (
          <ChatListItem
            key={chat.id}
            chat={chat}
            selected={chat.id === selectedId}
            branch={chat.id === selectedId ? activeBranch : undefined}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </div>
  );
}
