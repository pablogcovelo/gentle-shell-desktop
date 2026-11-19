import { Fragment } from "react";
import type { ChatSummary } from "@shared/bridge-types";
import { ChatListItem } from "./ChatListItem";
import { WorkspaceRow } from "./WorkspaceRow";
import "./ChatList.css";

export interface WorkspaceGroup {
  readonly directory: string;
  /** The chats whose session cwd is this directory (already filtered by
   * the panel's search). A persisted directory with no chat yet keeps its
   * row with an empty list — that is the whole point of the registry. */
  readonly chats: readonly ChatSummary[];
  /** Whether a persisted registry entry backs this row: only such a row
   * carries a remove action (see WorkspaceRow). */
  readonly persisted: boolean;
}

export interface ChatListProps {
  readonly chats: readonly ChatSummary[];
  readonly selectedId?: string;
  readonly onSelect: (chat: ChatSummary) => void;
  /** T1: one group per workspace directory (persisted UNION pi-session
   * directories), each with its chat rows underneath. `chats` then holds
   * only the chats that belong to no group (an empty cwd). Absent keeps
   * today's flat chat list. */
  readonly groups?: readonly WorkspaceGroup[];
  /** T1: a workspace row was picked — open that directory's pane without
   * the picker. */
  readonly onSelectWorkspace?: (directory: string) => void;
  /** T1: a persisted row's remove action was clicked — delete only the
   * persisted entry. */
  readonly onRemoveWorkspace?: (directory: string) => void;
  /** The open workspace's branch, reported live by its child. It wins for the
   * SELECTED chat's directory only. */
  readonly activeBranch?: string;
  /** The branch each directory has checked out, keyed by directory. It is the
   * per-workspace answer, so a row that is not open still carries its own. */
  readonly branches?: Readonly<Record<string, string>>;
  /** Retained for callers; directory navigation has no day buckets. */
  readonly now?: Date;
}

/** Preserve bridge order and session identities; never merge equal directories. */
export function ChatList({ chats, groups, selectedId, onSelect, onSelectWorkspace, onRemoveWorkspace, activeBranch, branches }: ChatListProps) {
  // The selected chat names the selected workspace row (T2: one selected
  // workspace, its chat the active pane).
  const selectedDirectory = chats.find((chat) => chat.id === selectedId)?.cwd;
  // A branch belongs to each workspace, never to the open one alone: the live
  // child's report wins for the selected directory, the registry's map covers
  // every other row.
  const branchOf = (directory: string | undefined): string | undefined =>
    (directory !== undefined && directory === selectedDirectory ? activeBranch : undefined) ??
    (directory !== undefined ? branches?.[directory] : undefined);
  // Flat fallback: a caller without the workspace registry renders today's
  // list exactly as before.
  if (groups === undefined) {
    return (
      <div className="gc-chat-list">
        <ul className="gc-chat-list__items" aria-label="Workspace directories">
          {chats.map((chat) => (
            <ChatListItem
              key={chat.id}
              chat={chat}
              selected={chat.id === selectedId}
              branch={branchOf(chat.cwd)}
              onSelect={onSelect}
            />
          ))}
        </ul>
      </div>
    );
  }

  // The selected chat names the selected workspace row (T2: one selected
  // workspace, its chat the active pane).
  return (
    <div className="gc-chat-list">
      <ul className="gc-chat-list__items" aria-label="Workspace directories">
        {groups.map((group) => (
          <Fragment key={group.directory}>
            <WorkspaceRow
              directory={group.directory}
              persisted={group.persisted}
              selected={group.directory === selectedDirectory}
              onSelect={onSelectWorkspace}
              onRemove={onRemoveWorkspace}
            />
            {group.chats.map((chat) => (
              <ChatListItem
                key={chat.id}
                chat={chat}
                selected={chat.id === selectedId}
                branch={chat.id === selectedId ? activeBranch : undefined}
                onSelect={onSelect}
              />
            ))}
          </Fragment>
        ))}
        {/* Chats whose cwd belongs to no workspace directory (an empty cwd)
        keep their flat rows — never dropped, never invented a group. */}
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
