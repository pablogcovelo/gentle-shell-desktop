import type {
  AppInfo,
  ChatCommandRunResult,
  ChatState,
  ChatSummary,
  DialogAnswer,
  GentleBridge,
  HomeMode,
  OpenChatResult,
  PromptResult,
  SetupStatus,
  StopHelperOutcome,
  WorkspaceList,
} from "@shared/bridge-types";
import { IPC_CHANNELS } from "@shared/ipc-channels";

/**
 * The minimal shape of Electron's ipcRenderer this bridge needs, injected
 * so createBridge(ipc) can be unit-tested with a fake ipc instead of the
 * real Electron renderer process (which vitest's Node environment doesn't
 * provide).
 */
export interface RendererIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
}

/**
 * Implements GentleBridge over ipc.invoke (request/response) and
 * ipc.on/removeListener (state/error pushes). src/preload/index.ts calls
 * this with the real Electron ipcRenderer.
 *
 * T5b: openChat/newChat answer the routed host's id; every request
 * channel carries that host id first, and error pushes carry it as their
 * second argument. The state push needs no extra argument — the pushed
 * ChatState already carries its emitting host's id.
 */
export function createBridge(ipc: RendererIpc): GentleBridge {
  return {
    listChats: () => ipc.invoke(IPC_CHANNELS.LIST_CHATS) as Promise<ChatSummary[]>,
    openChat: (id: string) => ipc.invoke(IPC_CHANNELS.OPEN_CHAT, id) as Promise<OpenChatResult>,
    newChat: () => ipc.invoke(IPC_CHANNELS.NEW_CHAT) as Promise<OpenChatResult>,
    sendMessage: (hostId: string, text: string) => ipc.invoke(IPC_CHANNELS.SEND_MESSAGE, hostId, text) as Promise<PromptResult>,
    abort: (hostId: string) => ipc.invoke(IPC_CHANNELS.ABORT, hostId) as Promise<void>,
    answerDialog: (hostId: string, id: string, answer: DialogAnswer) =>
      ipc.invoke(IPC_CHANNELS.ANSWER_DIALOG, hostId, id, answer) as Promise<void>,
    stopHelper: (hostId: string, id: string) => ipc.invoke(IPC_CHANNELS.STOP_HELPER, hostId, id) as Promise<StopHelperOutcome>,
    // palette-host-catalog T3 (S4): the ONE named method for running a
    // catalog row. The answer is a ChatCommandRunResult — a refusal is a
    // resolved answer, never a rejection; args is omitted, never passed as
    // an explicit undefined, so the wire sees exactly the documented keys.
    runCommand: (hostId: string, name: string, args?: string) =>
      args === undefined
        ? (ipc.invoke(IPC_CHANNELS.COMMAND_RUN, hostId, name) as Promise<ChatCommandRunResult>)
        : (ipc.invoke(IPC_CHANNELS.COMMAND_RUN, hostId, name, args) as Promise<ChatCommandRunResult>),
    // T5c: asks the addressed host for its current state (no child
    // round-trip, no restart); the answer is the ChatState the renderer
    // reconciles its focus-painted snapshot against.
    refreshChat: (hostId: string) => ipc.invoke(IPC_CHANNELS.REFRESH_CHAT, hostId) as Promise<ChatState>,
    // T5d: closes exactly the addressed workspace host (no close button in
    // the UI — this is reachable through the bridge only); an unknown or
    // already-stopped id is rejected by main without touching any child.
    closeChat: (hostId: string) => ipc.invoke(IPC_CHANNELS.CLOSE_CHAT, hostId) as Promise<void>,
    // T11: the native directory picker runs in the main process; the answer
    // is the chosen absolute path, or null when the user cancelled (the
    // caller must change nothing on null).
    chooseDirectory: () => ipc.invoke(IPC_CHANNELS.WORKSPACE_CHOOSE_DIRECTORY) as Promise<string | null>,
    // T11: creates a workspace bound to an absolute directory — validated
    // in main BEFORE anything is created, an already-open directory reuses
    // its host, and the created host's child runs with that directory as
    // cwd. The answer routes the pane like chat.open/chat.new do.
    createWorkspace: (directory: string) => ipc.invoke(IPC_CHANNELS.WORKSPACE_CREATE, directory) as Promise<OpenChatResult>,
    // Opened-directory registry only; Pi history is read separately for
    // GUI /resume. remove closes the directory's hosts and unregisters it,
    // retaining Pi session files. Each action answers the fresh list.
    listWorkspaces: () => ipc.invoke(IPC_CHANNELS.WORKSPACE_LIST) as Promise<WorkspaceList>,
    addWorkspace: (directory: string) => ipc.invoke(IPC_CHANNELS.WORKSPACE_ADD, directory) as Promise<WorkspaceList>,
    removeWorkspace: (directory: string) => ipc.invoke(IPC_CHANNELS.WORKSPACE_REMOVE, directory) as Promise<WorkspaceList>,
    openWorkspace: (directory: string) => ipc.invoke(IPC_CHANNELS.WORKSPACE_OPEN, directory) as Promise<OpenChatResult>,
    setupStatus: () => ipc.invoke(IPC_CHANNELS.SETUP_STATUS) as Promise<SetupStatus>,
    chooseHome: (mode: HomeMode) => ipc.invoke(IPC_CHANNELS.CHOOSE_HOME, mode) as Promise<void>,
    // The shell's own chrome: real window controls and app facts, never
    // guessed in the renderer.
    appInfo: () => ipc.invoke(IPC_CHANNELS.APP_INFO) as Promise<AppInfo>,
    minimizeWindow: () => ipc.invoke(IPC_CHANNELS.WINDOW_MINIMIZE) as Promise<void>,
    toggleMaximizeWindow: () => ipc.invoke(IPC_CHANNELS.WINDOW_TOGGLE_MAXIMIZE) as Promise<boolean>,
    closeWindow: () => ipc.invoke(IPC_CHANNELS.WINDOW_CLOSE) as Promise<void>,
    // A null answer is a cancelled pick: the composer must change nothing.
    chooseFile: () => ipc.invoke(IPC_CHANNELS.COMPOSER_CHOOSE_FILE) as Promise<string | null>,

    onState(callback: (state: ChatState) => void): () => void {
      const listener = (_event: unknown, state: unknown): void => callback(state as ChatState);
      ipc.on(IPC_CHANNELS.STATE_PUSH, listener);
      return () => ipc.removeListener(IPC_CHANNELS.STATE_PUSH, listener);
    },

    onError(callback: (message: string, hostId: string) => void): () => void {
      const listener = (_event: unknown, message: unknown, hostId: unknown): void =>
        callback(message as string, hostId as string);
      ipc.on(IPC_CHANNELS.ERROR_PUSH, listener);
      return () => ipc.removeListener(IPC_CHANNELS.ERROR_PUSH, listener);
    },

    // T5d: the close report carries the closed host's id, which is what
    // makes the renderer forget that host's snapshot and chat→host
    // mapping.
    onClosed(callback: (hostId: string) => void): () => void {
      const listener = (_event: unknown, hostId: unknown): void => callback(hostId as string);
      ipc.on(IPC_CHANNELS.CLOSED_PUSH, listener);
      return () => ipc.removeListener(IPC_CHANNELS.CLOSED_PUSH, listener);
    },
  };
}
