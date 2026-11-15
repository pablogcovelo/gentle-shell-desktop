import { useEffect, useRef, useState } from "react";
import type { ChatSummary, OpenChatResult, SetupStatus } from "@shared/bridge-types";
import { useBridge } from "@renderer/shared/bridge/useBridge";
import { ChatsContainer } from "@renderer/features/chats/ChatsContainer";
import { ConversationContainer, type ActiveChat } from "@renderer/features/conversation/ConversationContainer";
import { FirstRunContainer } from "@renderer/features/first-run/FirstRunContainer";
import { AppRail } from "./components/AppRail";
import { AppDialogs, APP_DIALOG, type AppDialogName } from "./components/AppDialogs";
import { TopBar, type WindowControls } from "./components/TopBar";
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
  // Panel visibility (artboard "Workspace"): the chrome's two toggles collapse
  // the directory column and the plan/usage/agents panel. Held as two booleans
  // on the shell so the modifier classes below stay the only source of layout.
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [inspectorVisible, setInspectorVisible] = useState(true);
  // The top bar's one search: the shell owns the text, the sidebar applies it
  // (the artboard's search box filters the directory list).
  const [query, setQuery] = useState("");
  // The chrome's two dialogs: which one is open, if any.
  const [dialog, setDialog] = useState<AppDialogName | undefined>(undefined);
  // Facts the dialogs report: what the first-run probe found, and the
  // version this build ships. Both are read once and never guessed.
  const [setup, setSetup] = useState<SetupStatus | undefined>(undefined);
  const [appVersion, setAppVersion] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    bridge
      .setupStatus()
      .then((status) => {
        if (cancelled) return;
        setSetup(status);
        setScreen(status.needsChoice ? SCREEN.FIRST_RUN : SCREEN.CHAT);
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

  // The version the settings dialog reports. Asked once: it cannot change
  // while the window lives, and a bridge without app facts leaves it absent
  // rather than guessed.
  useEffect(() => {
    let cancelled = false;
    bridge
      .appInfo?.()
      .then((info) => {
        if (!cancelled) setAppVersion(info.version);
      })
      .catch(() => {
        if (!cancelled) setAppVersion(undefined);
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

  const toggleSidebar = (): void => setSidebarVisible((visible) => !visible);
  const toggleInspector = (): void => setInspectorVisible((visible) => !visible);
  // The window's own buttons exist only where the bridge does: outside
  // Electron (the browser preview) there is no OS window to act on, so the
  // chrome omits them instead of drawing buttons that do nothing.
  const windowControls: WindowControls | undefined =
    bridge.minimizeWindow && bridge.toggleMaximizeWindow && bridge.closeWindow
      ? {
          minimize: () => void bridge.minimizeWindow?.(),
          toggleMaximize: () => void bridge.toggleMaximizeWindow?.(),
          close: () => void bridge.closeWindow?.(),
        }
      : undefined;

  const appClasses = [
    "gc-app",
    !sidebarVisible && "gc-app--sidebar-hidden",
    !inspectorVisible && "gc-app--inspector-hidden",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={appClasses}>
      <TopBar
        sidebarVisible={sidebarVisible}
        inspectorVisible={inspectorVisible}
        onToggleSidebar={toggleSidebar}
        onToggleInspector={toggleInspector}
        query={query}
        onQueryChange={setQuery}
        onOpenSettings={() => setDialog(APP_DIALOG.SETTINGS)}
        onOpenShortcuts={() => setDialog(APP_DIALOG.SHORTCUTS)}
        windowControls={windowControls}
      />
      <div className="gc-app__body">
        <AppRail sidebarVisible={sidebarVisible} onToggleSidebar={toggleSidebar} />
        <ChatsContainer
          onSelectChat={handleSelectChat}
          onNewChat={handleNewChat}
          onWorkspaceCreated={handleWorkspaceCreated}
          selectedChatId={activeChat.kind === "existing" ? activeChat.chat.id : undefined}
          query={query}
        />
        <ConversationContainer
          activeChat={activeChat}
          activeHostId={activeHostId}
          createdWorkspace={createdWorkspace}
          onHostResolved={setActiveHostId}
        />
      </div>
      <AppDialogs
        dialog={dialog}
        onClose={() => setDialog(undefined)}
        appVersion={appVersion}
        setup={setup}
      />
    </div>
  );
}
