import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ChatSummary, OpenChatResult } from "@shared/bridge-types";
import { useBridge } from "@renderer/shared/bridge/useBridge";
import { Button } from "@renderer/shared/ui/atoms/Button";
import { ChatList } from "./components/ChatList";
import { directoryOf } from "./components/ChatListItem";
import "./ChatsContainer.css";

export interface ChatsContainerProps {
  /** Notifies the parent (App) that a sidebar chat was picked; App owns the currentChat state. */
  readonly onSelectChat: (chat: ChatSummary) => void;
  /** Notifies the parent that "New chat" was clicked. */
  readonly onNewChat: () => void;
  /** T11: reports a workspace the user just created through the native
   * directory picker — this container runs the picker/create flow over the
   * bridge (it owns the sidebar's error surface) and hands the resolution
   * up, so App can open the created workspace's pane. Absent when the
   * parent does not support workspace creation, and then the action is not
   * rendered. */
  readonly onWorkspaceCreated?: (result: OpenChatResult) => void;
  /** The currently open chat's id, for highlighting; undefined while a fresh chat is open. */
  readonly selectedChatId?: string;
  /** Case-insensitive filter from the top bar's search. When undefined or
   * blank, every chat renders. Matches the chat title or its directory. */
  readonly query?: string;
  readonly navigationTools?: ReactNode;
  readonly navigationOpen?: boolean;
}

/**
 * Sidebar container: owns the bridge listChats() call and hands plain
 * ChatSummary props to the presentational ChatList (container/presentational
 * split). Does not call chat.open/chat.new itself — ConversationContainer
 * owns "the currently open chat" per GentleBridge's single-current-chat
 * shape, so this only reports selection intent up to App.
 */
export function ChatsContainer({ onSelectChat, onNewChat, onWorkspaceCreated, selectedChatId, query, navigationTools, navigationOpen }: ChatsContainerProps) {
  const bridge = useBridge();
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  // T11: the Add-workspace flow's own error surface, separate from the
  // list's — a refused directory is a clear message beside the action that
  // asked for it, and never a fake chat entry.
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  // T11: one Add-workspace flow at a time, and any action that moves the pane
  // supersedes a flow already running (see handleAddWorkspace).
  const [addingWorkspace, setAddingWorkspace] = useState(false);
  // The ref is the synchronous guard: state only lands on the next render, so
  // two clicks in the same tick would both pass a state-based check.
  const addingRef = useRef(false);
  const paneActions = useRef(0);

  // S8/T8: the top bar's search filters this list — a pure client-side pass
  // over the loaded chats, matching the chat title or exactly the directory
  // the row renders (same last-path-segment rule as ChatListItem). A blank
  // query renders every chat; no chat is ever invented to fill a match.
  const normalizedQuery = query?.trim();
  const visibleChats = normalizedQuery
    ? chats.filter((chat) => {
        const needle = normalizedQuery.toLowerCase();
        return chat.title.toLowerCase().includes(needle) || (directoryOf(chat.cwd) ?? "").toLowerCase().includes(needle);
      })
    : chats;

  const handleSelect = (chat: ChatSummary): void => {
    paneActions.current += 1;
    onSelectChat(chat);
  };

  const handleNewChat = (): void => {
    paneActions.current += 1;
    onNewChat();
  };

  // The removed visible New chat action remains available with Ctrl/⌘+N.
  // Reuse the same pane-action helper so pending creations still lose to it.
  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n" && !document.querySelector('[role="dialog"]')) {
        event.preventDefault();
        handleNewChat();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });

  useEffect(() => {
    let cancelled = false;

    bridge
      .listChats()
      .then((loaded) => {
        if (!cancelled) setChats(loaded);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [bridge]);

  /** T11: runs the Add-workspace flow — native picker first; a null answer
   * is a cancelled pick and changes NOTHING (no request, no chat, no
   * state); otherwise main validates the directory and creates the
   * workspace, and the resolution is handed up so App can adopt the pane.
   * A refused directory surfaces here, beside the action that asked for it. */
  const handleAddWorkspace = (): void => {
    if (addingRef.current) return; // one flow at a time: no duplicate creations
    void (async () => {
      if (!onWorkspaceCreated) return;
      const pick = bridge.chooseDirectory?.bind(bridge);
      const create = bridge.createWorkspace?.bind(bridge);
      if (!pick || !create) return;

      setWorkspaceError(null);
      addingRef.current = true;
      setAddingWorkspace(true);
      // A creation takes as long as the picker and a child start. If the user
      // opens another chat in the meantime, their later choice wins: the stale
      // answer would otherwise switch the pane back and strand the chat they
      // picked, with its host alive and invisible.
      const actionAtStart = paneActions.current;
      try {
        const directory = await pick();
        if (directory === null) return; // cancelled: change nothing
        // The picker can stay open for a while: if the user moved on meanwhile,
        // stop here and start no child at all for a workspace nobody waits for.
        if (paneActions.current !== actionAtStart) return;

        const result = await create(directory);
        if (paneActions.current !== actionAtStart) {
          // The child already exists, so merely dropping the result would leave
          // a workspace host nobody can reach — the same orphan this flow is
          // meant to prevent. Close it instead.
          void bridge.closeChat?.(result.hostId).catch(() => undefined);
          return;
        }
        onWorkspaceCreated(result);
      } finally {
        addingRef.current = false;
        setAddingWorkspace(false);
      }
    })().catch((cause: unknown) => {
      setWorkspaceError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  // S8: the sidebar SHOWS chats as workspaces (the bridge serves chats, the
  // owner's call), so the panel's heading is the artboard's "Workspaces".
  return (
    <aside className="gc-chats" id="gc-chats" aria-label="Workspace directories" onKeyDown={(event) => {
      if (!navigationOpen || event.key !== "Tab") return;
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const first = buttons[0];
      const last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      {/* T2: the artboard's directory-panel anatomy (design/slack-gentle/
      01-workspace.html .sidebar-head): eyebrow, heading with its accent dot
      and a subtitle. The dot is aria-hidden so the heading's accessible name
      stays exactly "Workspaces". */}
      <div className="gc-chats__header">
        <p className="gc-chats__eyebrow">YOUR WORK, IN GOOD COMPANY</p>
        <h2 className="gc-chats__heading">
          Workspaces<span aria-hidden="true" className="gc-chats__dot">.</span>
        </h2>
        <p className="gc-chats__subtitle">Your directories. One place to build.</p>
      </div>
      <div className="gc-chats__actions">
        {onWorkspaceCreated ? (
          <Button variant="ghost" type="button" onClick={handleAddWorkspace} disabled={addingWorkspace}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            Add workspace
          </Button>
        ) : null}
      </div>
      {error && (
        <p style={{ color: "var(--muted)" }}>Chats are not available yet: {error}</p>
      )}
      {workspaceError && (
        <p role="alert" style={{ color: "var(--muted)" }}>
          Could not add the workspace: {workspaceError}
        </p>
      )}
      <ChatList chats={visibleChats} selectedId={selectedChatId} onSelect={handleSelect} />
      {normalizedQuery && visibleChats.length === 0 && (
        <p className="gc-chats__empty">No chats match &quot;{normalizedQuery}&quot;.</p>
      )}
      <div className="gc-chats__footer">
        <p>You lead. Gentle helps.</p>
        <p>Local directory workspaces.</p>
        <div className="gc-chats__mobile-tools">{navigationTools}</div>
      </div>
    </aside>
  );
}
