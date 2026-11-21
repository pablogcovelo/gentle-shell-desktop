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
  /** Runs one command from the addressed host's catalog through the
   * host's desktop-rpc `run_command` (palette-host-catalog T3, S4): the
   * request carries (hostId, name, args?) and answers a
   * ChatCommandRunResult — executed, a refusal reason, the retryable
   * `session_switching`, or a transport failure. A refusal is a SUCCESS
   * answer here, never a rejection. */
  COMMAND_RUN: "chat.runCommand",
  ANSWER_DIALOG: "dialog.answer",
  /** Asks the host addressed by the leading host id (palette-command-
   * arguments T1, S2) for its REAL available-model snapshot through pi's
   * own correlated `get_available_models` RPC command. Answers an
   * AvailableModelsResult — unsupported/failed resolve, never reject. */
  AVAILABLE_MODELS: "chat.availableModels",
  /** Asks the host addressed by the leading host id (palette-command-
   * arguments T1, S3) for the thinking levels the child offers, through
   * pi's own correlated `get_available_thinking_levels` RPC command.
   * Answers an AvailableThinkingLevelsResult — unsupported/failed
   * resolve, never reject. */
  AVAILABLE_THINKING_LEVELS: "chat.availableThinkingLevels",
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
  /** Opens Electron's native directory picker from the main process (T11)
   * and answers the chosen absolute directory path, or null when the user
   * cancelled. Choosing alone creates nothing — workspace.add (persist)
   * and workspace.create/workspace.open (open a chat) are the requests
   * that do. */
  WORKSPACE_CHOOSE_DIRECTORY: "workspace.chooseDirectory",
  /** Creates a workspace bound to an absolute directory (T11): the
   * directory is validated in main BEFORE anything is created (exists, is
   * a directory, readable), an already-open directory selects its existing
   * host instead of starting a second child for it, and a created host's
   * child is spawned with that directory as cwd. Answers the routed host id
   * + state like chat.open/chat.new; an invalid directory is refused with
   * a clear message and leaves no host, no chat and no state behind. */
  WORKSPACE_CREATE: "workspace.create",
  /** T1 (S1/S2): the Workspaces panel's directories — the persisted
   * workspace registry UNION the directories pi already has sessions for,
   * persisted entries first, deduplicated. Answers a WorkspaceList. */
  WORKSPACE_LIST: "workspace.list",
  /** T1 (S2): persists the picked directory in the app config (next to
   * `home`), AFTER the same validation workspace.create runs, and answers
   * the fresh WorkspaceList so the panel re-renders without a restart. */
  WORKSPACE_ADD: "workspace.add",
  /** T1: removes ONLY the persisted registry entry — never a session
   * file, a directory or a chat — and answers the fresh WorkspaceList.
   * A directory without a persisted entry is a no-op. */
  WORKSPACE_REMOVE: "workspace.remove",
  /** T1: opens a chat for a workspace directory WITHOUT the native
   * picker — the same creation path as workspace.create (validated
   * first, an already-open directory reusing its host, the child spawned
   * with that directory as cwd). Selecting a persisted workspace that
   * has no chats yet uses this. */
  WORKSPACE_OPEN: "workspace.open",
  /** First-run status (T5): whether to show the home-choice screen. */
  SETUP_STATUS: "setup.status",
  /** Persists the chosen home mode (T5). */
  CHOOSE_HOME: "setup.chooseHome",
  /** Answers the app's own facts the footer and settings dialog show. */
  APP_INFO: "app.info",
  /** Frameless-window controls: the renderer's chrome acts on its own
   * BrowserWindow (minimize, toggle maximize, close). */
  WINDOW_MINIMIZE: "window.minimize",
  WINDOW_TOGGLE_MAXIMIZE: "window.toggleMaximize",
  WINDOW_CLOSE: "window.close",
  /** Opens Electron's native FILE picker from the main process and answers
   * the chosen absolute path, or null when the user cancelled. The composer
   * inserts that path into the draft; nothing is read or uploaded. */
  COMPOSER_CHOOSE_FILE: "composer.chooseFile",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
