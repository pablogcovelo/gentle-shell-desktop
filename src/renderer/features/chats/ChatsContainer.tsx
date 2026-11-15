import { useEffect, useState } from "react";
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
    void (async () => {
      if (!onWorkspaceCreated) return;
      const pick = bridge.chooseDirectory?.bind(bridge);
      const create = bridge.createWorkspace?.bind(bridge);
      if (!pick || !create) return;

      setWorkspaceError(null);
      const directory = await pick();
      if (directory === null) return; // cancelled: change nothing

      const result = await create(directory);
      onWorkspaceCreated(result);
    })().catch((cause: unknown) => {
      setWorkspaceError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  return (
    <aside className="gc-chats">
      <div className="gc-chats__header">
        <h2 className="gc-chats__heading">Chats</h2>
        {onWorkspaceCreated ? (
          <Button variant="ghost" type="button" onClick={handleAddWorkspace}>
            Add workspace
          </Button>
        ) : null}
        <Button variant="ghost" type="button" onClick={onNewChat}>
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
      <ChatList chats={chats} selectedId={selectedChatId} onSelect={onSelectChat} />
    </aside>
  );
}
