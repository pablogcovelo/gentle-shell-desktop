import { useEffect, useRef, useState } from "react";
import type { ChatSummary, OpenChatResult } from "@shared/bridge-types";
import { useBridge } from "@renderer/shared/bridge/useBridge";
import { Button } from "@renderer/shared/ui/atoms/Button";
import { ChatList } from "./components/ChatList";
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
}

/**
 * Sidebar container: owns the bridge listChats() call and hands plain
 * ChatSummary props to the presentational ChatList (container/presentational
 * split). Does not call chat.open/chat.new itself — ConversationContainer
 * owns "the currently open chat" per GentleBridge's single-current-chat
 * shape, so this only reports selection intent up to App.
 */
export function ChatsContainer({ onSelectChat, onNewChat, onWorkspaceCreated, selectedChatId }: ChatsContainerProps) {
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

  const handleSelect = (chat: ChatSummary): void => {
    paneActions.current += 1;
    onSelectChat(chat);
  };

  const handleNewChat = (): void => {
    paneActions.current += 1;
    onNewChat();
  };

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

        const result = await create(directory);
        if (paneActions.current !== actionAtStart) return; // superseded
        onWorkspaceCreated(result);
      } finally {
        addingRef.current = false;
        setAddingWorkspace(false);
      }
    })().catch((cause: unknown) => {
      setWorkspaceError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  return (
    <aside className="gc-chats">
      <div className="gc-chats__header">
        <h2 className="gc-chats__heading">Chats</h2>
        {onWorkspaceCreated ? (
          <Button variant="ghost" type="button" onClick={handleAddWorkspace} disabled={addingWorkspace}>
            Add workspace
          </Button>
        ) : null}
        <Button variant="ghost" type="button" onClick={handleNewChat}>
          New chat
        </Button>
      </div>
      {error && (
        <p style={{ color: "var(--muted)" }}>Chats are not available yet: {error}</p>
      )}
      {workspaceError && (
        <p role="alert" style={{ color: "var(--muted)" }}>
          Could not add the workspace: {workspaceError}
        </p>
      )}
      <ChatList chats={chats} selectedId={selectedChatId} onSelect={handleSelect} />
    </aside>
  );
}
