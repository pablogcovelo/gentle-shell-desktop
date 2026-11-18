import { useEffect, useRef, useState } from "react";
import type { ChatSummary, OpenChatResult, SetupStatus, WorkspaceList } from "@shared/bridge-types";
import { useBridge } from "@renderer/shared/bridge/useBridge";
import { ChatsContainer } from "@renderer/features/chats/ChatsContainer";
import {
  ConversationContainer,
  type ActiveChat,
} from "@renderer/features/conversation/ConversationContainer";
import { FirstRunContainer } from "@renderer/features/first-run/FirstRunContainer";
import { AppRail, RailTools } from "./components/AppRail";
import { AppDialogs, APP_DIALOG, type AppDialogName } from "./components/AppDialogs";
import { TopBar, type WindowControls } from "./components/TopBar";
import "./App.css";

// T2 (S3/S4): the app starts with NO chat and NO workspace selected —
// never the synthetic `{kind:"new"}` chat that used to spawn a child on
// first paint. The workspace list resolves after mount and decides what
// happens next (placeholder, or one selected workspace with its chat).
const NO_CHAT: ActiveChat = { kind: "none" };

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
  const [activeChat, setActiveChat] = useState<ActiveChat>(NO_CHAT);
  // T1: the Workspaces panel's directories (persisted UNION pi-session
  // directories), owned here because the selection default and the empty
  // state need the same list the panel renders. Undefined while the first
  // read is in flight. Re-set after every add/remove (onWorkspacesChanged).
  const [workspaces, setWorkspaces] = useState<WorkspaceList | undefined>(undefined);
  // The open workspace's branch, reported by the conversation pane and shown
  // under the workspace's name in the sidebar (owner decision).
  const [activeBranch, setActiveBranch] = useState<string | undefined>(undefined);
  // T5b: the active chat's workspace host id, as answered by chat.open/
  // chat.new (ConversationContainer reports it up on resolution). It is
  // reset on every selection change so the previous chat's host can never
  // answer for the new one, and passed back down as every request's
  // routing key.
  const [activeHostId, setActiveHostId] = useState<string | undefined>(undefined);
  const registryRevision = useRef(0);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const pendingCloses = useRef(new Map<string, Promise<WorkspaceList>>());
  const closeQueue = useRef<Promise<unknown>>(Promise.resolve());
  const closedHostIds = useRef(new Set<string>());
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
  const [resolvedDirectory, setResolvedDirectory] = useState<string | undefined>();
  const activeDirectory = activeChat.kind === "workspace" ? activeChat.directory
    : activeChat.kind === "existing" ? activeChat.chat.cwd
    : activeChat.kind === "new" ? createdWorkspace?.result.state.workspacePath ?? resolvedDirectory : undefined;
  const activeDirectoryRef = useRef(activeDirectory);
  activeDirectoryRef.current = activeDirectory;
  useEffect(() => bridge.onClosed?.((id) => { closedHostIds.current.add(id); }), [bridge]);
  // Panel visibility (artboard "Workspace"): the chrome's two toggles collapse
  // the directory column and the plan/usage/agents panel. Held as two booleans
  // on the shell so the modifier classes below stay the only source of layout.
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [narrow, setNarrow] = useState(() => window.innerWidth <= 800);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [footerTarget, setFooterTarget] = useState<HTMLDivElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchTrigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const resize = (): void => {
      setNarrow(window.innerWidth <= 800);
      if (window.innerWidth > 800) setNavigationOpen(false);
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const [inspectorVisible, setInspectorVisible] = useState(true);
  // Search stays available through Ctrl/⌘+K without restoring removed chrome.
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

  // T1: the first workspace read — the panel's rows and the selection
  // default both come from it. A failed read fails open to "no workspaces
  // persisted": the placeholder shows instead of blocking the app, exactly
  // like the setup-status read above.
  useEffect(() => {
    let cancelled = false;
    const revision = registryRevision.current;
    bridge
      .listWorkspaces?.()
      .then((list) => {
        if (!cancelled && registryRevision.current === revision) setWorkspaces(list);
      })
      .catch(() => {
        if (!cancelled) setWorkspaces({ directories: [], persisted: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  // T2 (S3/S4/S11): when the list resolves, the app is either empty (the
  // placeholder stays, no child is ever spawned) or exactly one workspace
  // is selected — the first directory — and its pane opens (the most
  // recent session, else a new chat; ConversationContainer resolves that).
  // A selection the user already made always wins: only a still-"none"
  // pane takes the default.
  useEffect(() => {
    if (!workspaces || activeChat.kind !== "none") return;
    const first = workspaces.directories[0];
    if (first) openPane({ kind: "workspace", directory: first });
    // openPane is a stable-enough local (a plain state wrapper); its
    // identity is deliberately not a dependency, exactly like
    // onHostResolved in ConversationContainer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces, activeChat]);

  useEffect(() => {
    if (screen !== SCREEN.CHAT) return;
    const keydown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !dialog) {
        event.preventDefault();
        searchTrigger.current = document.activeElement as HTMLElement;
        setSearchOpen(true);
        setNavigationOpen(true);
        setSidebarVisible(true);
      }
      if (event.key === "Escape" && !dialog) {
        if (searchOpen) {
          setSearchOpen(false);
          setQuery("");
          searchTrigger.current?.focus();
        } else if (navigationOpen) {
          setNavigationOpen(false);
          document.querySelector<HTMLButtonElement>('.gc-topbar__toggle')?.focus();
        }
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [screen, dialog, searchOpen, navigationOpen]);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (narrow && navigationOpen && !searchOpen) {
      document.querySelector<HTMLButtonElement>(".gc-chats button")?.focus();
    }
  }, [narrow, navigationOpen, searchOpen]);

  // Every selection change shares one rule (T5b/T11): the old host id must
  // never answer for the new pane, and a stale creation must not adopt into
  // it.
  const openPane = (chat: ActiveChat): void => {
    setActiveHostId(undefined);
    setActiveBranch(undefined);
    setResolvedDirectory(undefined);
    setCreatedWorkspace(undefined);
    setActiveChat(chat);
  };

  const handleSelectChat = (chat: ChatSummary): void => {
    setNavigationOpen(false);
    setSearchOpen(false);
    setQuery("");
    openPane({ kind: "existing", chat });
  };

  // T1: a workspace row was picked — open that directory's pane. Selecting
  // a persisted workspace that has no chats opens a new chat for it without
  // the picker (ConversationContainer resolves the pane through
  // workspace.open; the Add-workspace flow is never re-run).
  const handleSelectWorkspace = (directory: string): void => {
    if (pendingCloses.current.has(directory)) return;
    setNavigationOpen(false);
    setSearchOpen(false);
    setQuery("");
    openPane({ kind: "workspace", directory });
  };

  // T1: the panel re-read the list (after add or after remove — the
  // add/remove answers carry the fresh union; no push channel). S11: while
  // at least one workspace remains, one is always selected; if the removed
  // directory was the active pane, the selection moves to the next
  // workspace — or back to the placeholder when none is left. The active
  // pane's directory is either the selected workspace or (for a pane just
  // created through the Add flow) the directory its adopted host runs in.
  const handleWorkspacesChanged = (fresh: WorkspaceList): void => {
    registryRevision.current += 1;
    setWorkspaces(fresh);
    const directory = activeDirectoryRef.current;
    if (directory && !fresh.directories.includes(directory)) {
      const next = fresh.directories[0];
      openPane(next ? { kind: "workspace", directory: next } : { kind: "none" });
    }
  };

  // Both close controls share one operation. Serialize distinct directory
  // removals so an older registry answer cannot resurrect another closed row.
  const handleCloseWorkspace = (directory: string): Promise<WorkspaceList> => {
    const pending = pendingCloses.current.get(directory);
    if (pending) return pending;
    registryRevision.current += 1;
    setWorkspaceRevision((revision) => revision + 1);
    const operation = closeQueue.current.catch(() => undefined).then(async () => {
      if (!bridge.removeWorkspace) throw new Error("This bridge cannot close a workspace directory");
      const fresh = await bridge.removeWorkspace(directory);
      handleWorkspacesChanged(fresh);
      return fresh;
    }).finally(() => { pendingCloses.current.delete(directory); });
    pendingCloses.current.set(directory, operation);
    closeQueue.current = operation;
    return operation;
  };

  const handleNewChat = (): void => {
    setNavigationOpen(false);
    setQuery("");
    openPane({ kind: "new", epoch: nextNewChatEpoch.current++ });
  };

  /** T11: opens the pane of a workspace just created through "Add
   * workspace". Its own unsaved-pane epoch — the same identity rule as
   * "New chat" — with the resolution handed straight down for adoption. */
  const handleWorkspaceCreated = (result: OpenChatResult): void => {
    if (closedHostIds.current.has(result.hostId) || pendingCloses.current.has(result.state.workspacePath ?? "")) return;
    const epoch = nextNewChatEpoch.current++;
    setActiveHostId(undefined);
    setActiveChat({ kind: "new", epoch });
    setCreatedWorkspace({ chatKey: `new-${epoch}`, result });
    setNavigationOpen(false);
  };

  if (screen === SCREEN.LOADING) return <div className="gc-app-loading" />;
  if (screen === SCREEN.FIRST_RUN) return <FirstRunContainer onDone={() => setScreen(SCREEN.CHAT)} />;

  const toggleSidebar = (): void => {
    if (narrow) setNavigationOpen((visible) => !visible);
    else setSidebarVisible((visible) => !visible);
  };
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
    !sidebarVisible && !narrow && "gc-app--sidebar-hidden",
    navigationOpen && "gc-app--nav-open",
    !inspectorVisible && "gc-app--inspector-hidden",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={appClasses}>
      <TopBar
        sidebarVisible={narrow ? navigationOpen : sidebarVisible}
        inspectorVisible={inspectorVisible}
        onToggleSidebar={toggleSidebar}
        onToggleInspector={toggleInspector}
        windowControls={windowControls}
      />
      <div className="gc-app__body">
        <AppRail sidebarVisible={sidebarVisible} onToggleSidebar={() => setSidebarVisible(true)} onOpenSettings={() => setDialog(APP_DIALOG.SETTINGS)} onOpenShortcuts={() => setDialog(APP_DIALOG.SHORTCUTS)} />
        <ChatsContainer
          onSelectChat={handleSelectChat}
          onNewChat={handleNewChat}
          onWorkspaceCreated={handleWorkspaceCreated}
          onSelectWorkspace={handleSelectWorkspace}
          workspaces={workspaces}
          onWorkspacesChanged={handleWorkspacesChanged}
          onCloseWorkspace={handleCloseWorkspace}
          workspaceRevision={workspaceRevision}
          selectedDirectory={activeDirectory}
          selectedChatId={activeChat.kind === "existing" ? activeChat.chat.id : undefined}
          activeBranch={activeBranch}
          query={query}
          navigationTools={<RailTools onOpenSettings={() => setDialog(APP_DIALOG.SETTINGS)} onOpenShortcuts={() => setDialog(APP_DIALOG.SHORTCUTS)} />}
          navigationOpen={narrow && navigationOpen}
        />
        {activeChat.kind === "none" ? (
          // T2 (S3/S4): no workspace open — plain text plus the add-workspace
          // hint. No ConversationContainer is rendered, so no child process
          // can be spawned: the placeholder is a real empty state.
          <section className="gc-conversation gc-conversation--empty" aria-label="No workspace open">
            <p className="gc-conversation__empty-title">No workspace is open yet.</p>
            <p className="gc-conversation__empty-hint">
              Add a directory from the Workspaces panel — Gentle opens a chat for it.
            </p>
          </section>
        ) : (
          <ConversationContainer
            footerTarget={footerTarget}
            activeChat={activeChat}
            activeHostId={activeHostId}
            createdWorkspace={createdWorkspace}
            onHostResolved={setActiveHostId}
            onResumeChat={handleSelectChat}
            onWorktreeBranch={setActiveBranch}
            onWorkspacePath={setResolvedDirectory}
            onCloseWorkspace={handleCloseWorkspace}
          />
        )}
      </div>
      <div className="gc-app__footer" ref={setFooterTarget} />
      {searchOpen ? (
        <div className="gc-dialog-backdrop">
          <div className="gc-dialog" role="dialog" aria-modal="true" aria-label="Search chats" onKeyDown={(event) => {
            if (event.key !== "Tab") return;
            const input = searchRef.current;
            const button = event.currentTarget.querySelector("button");
            if (event.shiftKey && document.activeElement === input) { event.preventDefault(); button?.focus(); }
            else if (!event.shiftKey && document.activeElement === button) { event.preventDefault(); input?.focus(); }
          }}>
            <h2>Search chats</h2>
            <input ref={searchRef} type="search" aria-label="Search chats" placeholder="Search chats…" value={query} onChange={(event) => setQuery(event.target.value)} />
            <p>Search by title or directory. Escape clears the filter and closes search.</p>
            <button type="button" onClick={() => { setSearchOpen(false); searchTrigger.current?.focus(); }}>Show results</button>
          </div>
        </div>
      ) : null}
      <AppDialogs
        dialog={dialog}
        onClose={() => setDialog(undefined)}
        appVersion={appVersion}
        setup={setup}
      />
    </div>
  );
}
