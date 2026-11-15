import { useEffect, useRef, useState } from "react";
import type { ChatSummary, OpenChatResult } from "@shared/bridge-types";
import { useBridge } from "@renderer/shared/bridge/useBridge";
import { ChatsContainer } from "@renderer/features/chats/ChatsContainer";
import { ConversationContainer, type ActiveChat } from "@renderer/features/conversation/ConversationContainer";
import { FirstRunContainer } from "@renderer/features/first-run/FirstRunContainer";
import "./App.css";

const NEW_CHAT: ActiveChat = { kind: "new", epoch: 0 };

const SCREEN = {
  LOADING: "loading",
  FIRST_RUN: "first-run",
  CHAT: "chat",
} as const;

type Screen = (typeof SCREEN)[keyof typeof SCREEN];

// App shell: composes feature-level containers only (Scope Rule — layout
// wiring lives here, feature internals stay inside their own folder).
// Holds the small `activeChat` selection as local state (no global store
// for M1, see odd/tasks/desktop-m1-chat-core.md's "Selected chat" note) —
// both ChatsContainer (highlighting) and ConversationContainer (which chat
// to open) need it.
//
// Decides between the first-run screen and the normal chat layout from
// bridge.setupStatus() on mount (T5): a brief `loading` screen while that
// resolves, then `first-run` when needsChoice is true, else the chat
// shell directly. FirstRunContainer's onDone flips straight to `chat`
// locally instead of re-querying setupStatus() — it already knows the
// choice it just persisted.
export function App() {
  const bridge = useBridge();
  const [screen, setScreen] = useState<Screen>(SCREEN.LOADING);
  const [activeChat, setActiveChat] = useState<ActiveChat>(NEW_CHAT);
  // T5b: the active chat's workspace host id, as answered by chat.open/
  // chat.new (ConversationContainer reports it up on resolution). It is
  // reset on every selection change so the previous chat's host can never
  // answer for the new one, and passed back down as every request's
  // routing key.
  const [activeHostId, setActiveHostId] = useState<string | undefined>(undefined);
  // Every "New chat" click is a distinct pane identity (its own welcome
  // intro, T9b): the counter starts after the initial chat's epoch 0 and is
  // bumped once per click, so no two unsaved chats ever share a key.
  const nextNewChatEpoch = useRef(1);
  // T11: a workspace just created through "Add workspace" — the pane key it
  // belongs to plus the resolution main returned. ConversationContainer
  // adopts it directly instead of resolving the pane through bridge.newChat()
  // again, which would spawn a second child for the same workspace. Cleared
  // on every selection change so a stale creation can never adopt.
  const [createdWorkspace, setCreatedWorkspace] = useState<{ readonly chatKey: string; readonly result: OpenChatResult } | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    bridge
      .setupStatus()
      .then((status) => {
        if (!cancelled) setScreen(status.needsChoice ? SCREEN.FIRST_RUN : SCREEN.CHAT);
      })
      .catch(() => {
        // Fail open: a broken setup-status check should never block the
        // whole app from starting.
        if (!cancelled) setScreen(SCREEN.CHAT);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const handleSelectChat = (chat: ChatSummary): void => {
    setActiveHostId(undefined); // the old host id must not answer for the new chat (T5b)
    setCreatedWorkspace(undefined); // a stale creation must not adopt into this pane (T11)
    setActiveChat({ kind: "existing", chat });
  };

  const handleNewChat = (): void => {
    setActiveHostId(undefined);
    setCreatedWorkspace(undefined);
    setActiveChat({ kind: "new", epoch: nextNewChatEpoch.current++ });
  };

  /** T11: opens the pane of a workspace just created through "Add
   * workspace". Its own unsaved-pane epoch — the same identity rule as
   * "New chat" — with the resolution handed straight down for adoption. */
  const handleWorkspaceCreated = (result: OpenChatResult): void => {
    const epoch = nextNewChatEpoch.current++;
    setActiveHostId(undefined);
    setActiveChat({ kind: "new", epoch });
    setCreatedWorkspace({ chatKey: `new-${epoch}`, result });
  };

  if (screen === SCREEN.LOADING) return <div className="gc-app-loading" />;
  if (screen === SCREEN.FIRST_RUN) return <FirstRunContainer onDone={() => setScreen(SCREEN.CHAT)} />;

  return (
    <div className="gc-app">
      <ChatsContainer
        onSelectChat={handleSelectChat}
        onNewChat={handleNewChat}
        onWorkspaceCreated={handleWorkspaceCreated}
        selectedChatId={activeChat.kind === "existing" ? activeChat.chat.id : undefined}
      />
      <ConversationContainer
        activeChat={activeChat}
        activeHostId={activeHostId}
        createdWorkspace={createdWorkspace}
        onHostResolved={setActiveHostId}
      />
    </div>
  );
}
