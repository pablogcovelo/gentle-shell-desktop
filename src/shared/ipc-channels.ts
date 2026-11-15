/**
 * IPC channel names shared between src/main/ipc/registerHandlers.ts and
 * src/preload/bridge.ts. Lives under src/shared/, not src/main/ipc/,
 * because both processes need it — the same Scope Rule that put
 * bridge-types.ts here instead of duplicating it locally (see
 * src/README.md).
 */
export const IPC_CHANNELS = {
  LIST_CHATS: "sessions.list",
  /** Opens a chat on the workspace host that already owns it (or a newly
   * minted one) and answers which host it was routed to (T5b). */
  OPEN_CHAT: "chat.open",
  /** Starts a fresh chat on a newly minted workspace host (T5b). */
  NEW_CHAT: "chat.new",
  /** Asks the workspace host addressed by the leading host id (T5c) for its
   * current ChatState — without starting or restarting its child. Answers
   * that host's latest known state; an unknown or stopped id is rejected. */
  REFRESH_CHAT: "chat.refresh",
  /** Closes the workspace host addressed by the leading host id (T5d):
   * stops exactly that host's child through the registry and forgets the
   * host. An unknown or already-stopped id is rejected and no child is
   * touched. */
  CLOSE_CHAT: "chat.close",
  /** Carries the host id first (T5b): the request is delivered to that
   * host's child only; an unknown id is rejected. */
  SEND_MESSAGE: "chat.send",
  ABORT: "chat.abort",
  ANSWER_DIALOG: "dialog.answer",
  /** Asks the host addressed by the leading host id (T5b) to stop one
   * helper (desktop-rpc T6): resolve with a StopHelperOutcome; the real
   * transition arrives via the state push. */
  STOP_HELPER: "helpers.stop",
  /** webContents.send push: a workspace host's ChatState changed; the
   * payload carries the emitting host's id (T5b). */
  STATE_PUSH: "chat.state",
  /** webContents.send push: an error was surfaced for a workspace host;
   * the second argument is that host's id (T5b). */
  ERROR_PUSH: "chat.error",
  /** webContents.send push: a workspace host was closed (T5d); the payload
   * is the closed host's id, so the renderer can forget that host's
   * snapshot and chat→host mapping. */
  CLOSED_PUSH: "chat.closed",
  /** First-run status (T5): whether to show the home-choice screen. */
  SETUP_STATUS: "setup.status",
  /** Persists the chosen home mode (T5). */
  CHOOSE_HOME: "setup.chooseHome",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
