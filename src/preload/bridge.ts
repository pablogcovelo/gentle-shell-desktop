import type {
  ChatState,
  ChatSummary,
  DialogAnswer,
  GentleBridge,
  HomeMode,
  OpenChatResult,
  PromptResult,
  SetupStatus,
  StopHelperOutcome,
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
    // T5c: asks the addressed host for its current state (no child
    // round-trip, no restart); the answer is the ChatState the renderer
    // reconciles its focus-painted snapshot against.
    refreshChat: (hostId: string) => ipc.invoke(IPC_CHANNELS.REFRESH_CHAT, hostId) as Promise<ChatState>,
    // T5d: closes exactly the addressed workspace host (no close button in
    // the UI — this is reachable through the bridge only); an unknown or
    // already-stopped id is rejected by main without touching any child.
    closeChat: (hostId: string) => ipc.invoke(IPC_CHANNELS.CLOSE_CHAT, hostId) as Promise<void>,
    setupStatus: () => ipc.invoke(IPC_CHANNELS.SETUP_STATUS) as Promise<SetupStatus>,
    chooseHome: (mode: HomeMode) => ipc.invoke(IPC_CHANNELS.CHOOSE_HOME, mode) as Promise<void>,

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
