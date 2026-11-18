import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ChatSummary, OpenChatResult, WorkspaceList } from "@shared/bridge-types";
import { useBridge } from "@renderer/shared/bridge/useBridge";
import { WorkspaceRow } from "./components/WorkspaceRow";
import "./components/ChatList.css";
import "./ChatsContainer.css";

export interface ChatsContainerProps {
  readonly onSelectChat: (chat: ChatSummary) => void;
  readonly onNewChat: () => void;
  readonly onWorkspaceCreated?: (result: OpenChatResult) => void;
  /** Opened directory registry only. Undefined means still loading, not history. */
  readonly workspaces?: WorkspaceList;
  readonly onWorkspacesChanged?: (workspaces: WorkspaceList) => void;
  readonly onSelectWorkspace?: (directory: string) => void;
  readonly onCloseWorkspace?: (directory: string) => Promise<WorkspaceList>;
  /** Invalidates pending Add actions when another control closes a directory. */
  readonly workspaceRevision?: number;
  readonly selectedDirectory?: string;
  readonly selectedChatId?: string;
  readonly activeBranch?: string;
  readonly query?: string;
  readonly navigationTools?: ReactNode;
  readonly navigationOpen?: boolean;
}

/** Directory navigation never reads Pi history. Saved sessions live in /resume. */
export function ChatsContainer({ onNewChat, onWorkspaceCreated, onSelectWorkspace, workspaces, onWorkspacesChanged, onCloseWorkspace, workspaceRevision = 0, selectedDirectory, activeBranch, query, navigationTools, navigationOpen }: ChatsContainerProps) {
  const bridge = useBridge();
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [addingWorkspace, setAddingWorkspace] = useState(false);
  const addingRef = useRef(false);
  const paneActions = useRef(0);
  const revisionRef = useRef(workspaceRevision);
  revisionRef.current = workspaceRevision;
  const closing = useRef(new Set<string>());
  const [closingRows, setClosingRows] = useState<ReadonlySet<string>>(new Set());
  const normalizedQuery = query?.trim();
  const needle = normalizedQuery?.toLowerCase();
  const directories = (workspaces?.directories ?? []).filter((directory) => !needle || directory.toLowerCase().includes(needle));

  const handleNewChat = (): void => {
    paneActions.current += 1;
    onNewChat();
  };
  const handleSelectWorkspace = (directory: string): void => {
    if (closing.current.has(directory)) return;
    paneActions.current += 1;
    onSelectWorkspace?.(directory);
  };
  const handleRemoveWorkspace = (directory: string): void => {
    if (closing.current.has(directory)) return;
    const remove = onCloseWorkspace ?? bridge.removeWorkspace?.bind(bridge);
    if (!remove) return;
    paneActions.current += 1;
    closing.current.add(directory);
    setClosingRows(new Set(closing.current));
    setWorkspaceError(null);
    void remove(directory).then((fresh) => {
      // App's shared close handler already reconciles the latest selection.
      if (!onCloseWorkspace) onWorkspacesChanged?.(fresh);
    }).catch((cause: unknown) => {
      setWorkspaceError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      closing.current.delete(directory);
      setClosingRows(new Set(closing.current));
    });
  };

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

  const handleAddWorkspace = (): void => {
    if (addingRef.current) return;
    void (async () => {
      if (!onWorkspaceCreated) return;
      const pick = bridge.chooseDirectory?.bind(bridge);
      const create = bridge.createWorkspace?.bind(bridge);
      if (!pick || !create) return;
      setWorkspaceError(null);
      addingRef.current = true;
      setAddingWorkspace(true);
      const actionAtStart = paneActions.current;
      const revisionAtStart = revisionRef.current;
      const stale = (): boolean => paneActions.current !== actionAtStart || revisionRef.current !== revisionAtStart;
      try {
        const directory = await pick();
        if (directory === null || stale() || closing.current.has(directory)) return;
        const add = bridge.addWorkspace?.bind(bridge);
        if (add) {
          const fresh = await add(directory);
          if (stale()) return;
          onWorkspacesChanged?.(fresh);
        }
        // A close may have started while add was pending. Never start a new
        // host after that close's pending-start join has already completed.
        if (stale()) return;
        const result = await create(directory);
        if (stale()) {
          // Exact-host cleanup, deliberately not directory closure: another
          // workspace action may now own other hosts in this directory.
          await bridge.closeChat?.(result.hostId).catch((cause: unknown) => {
            // An already-closed host is harmless; other cleanup errors remain visible.
            if (!String(cause).includes("unknown or already stopped")) throw cause;
          });
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

  return (
    <aside className="gc-chats" id="gc-chats" aria-label="Workspace directories" onKeyDown={(event) => {
      if (!navigationOpen || event.key !== "Tab") return;
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const first = buttons[0];
      const last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <div className="gc-chats__header">
        <p className="gc-chats__eyebrow">YOUR WORK, IN GOOD COMPANY</p>
        <div className="gc-chats__section">
          <h2 className="gc-chats__heading">Workspaces<span aria-hidden="true" className="gc-chats__dot">.</span></h2>
          {onWorkspaceCreated ? (
            <button type="button" className="gc-chats__add" aria-label="Add workspace" title="Add a workspace" onClick={handleAddWorkspace} disabled={addingWorkspace}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            </button>
          ) : null}
        </div>
        <p className="gc-chats__subtitle">Your directories. One place to build.</p>
      </div>
      <hr className="gc-chats__divider" />
      {workspaceError ? <p role="alert" style={{ color: "var(--muted)" }}>Workspace action failed: {workspaceError}</p> : null}
      <div className="gc-chat-list">
        <ul className="gc-chat-list__items" aria-label="Workspace directories">
          {directories.map((directory) => <WorkspaceRow key={directory} directory={directory} persisted selected={directory === selectedDirectory} branch={directory === selectedDirectory ? activeBranch : undefined} disabled={closingRows.has(directory)} onSelect={handleSelectWorkspace} onRemove={handleRemoveWorkspace} />)}
        </ul>
      </div>
      {normalizedQuery && directories.length === 0 ? <p className="gc-chats__empty">No workspaces match &quot;{normalizedQuery}&quot;.</p> : null}
      <div className="gc-chats__footer">
        <p>You lead. Gentle helps.</p><p>Local directory workspaces.</p>
        <div className="gc-chats__mobile-tools">{navigationTools}</div>
      </div>
    </aside>
  );
}
