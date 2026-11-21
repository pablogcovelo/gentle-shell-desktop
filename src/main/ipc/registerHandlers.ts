import { access, constants, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { IpcMain, WebContents } from "electron";
import type {
  AppInfo,
  AvailableModelsResult,
  AvailableThinkingLevelsResult,
  ChatCommandRunResult,
  ChatState,
  ChatSummary,
  DialogAnswer,
  HomeMode,
  OpenChatResult,
  PromptResult,
  StopHelperOutcome,
  WorkspaceList,
} from "@shared/bridge-types";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import type { ChatHost } from "../domain/session/ChatHost";
import type { SetupService } from "../ports";

/**
 * The slice of WorkspaceHostRegistry the router routes through, declared
 * structurally (instead of importing the registry type) so tests can
 * supply controllable sources — including real ChatHosts over fake child
 * processes — without going through the registry's constructor. In
 * src/main/index.ts the real WorkspaceHostRegistry is passed; its
 * get/createHost/list members match this shape exactly.
 */
export interface WorkspaceHostSource {
  /** The live host owning `hostId`, or undefined. A stopped or unknown id
   * never resolves to a different live host (U6a: never fall back to an
   * unrelated live child). */
  get(hostId: string): ChatHost | undefined;
  /** Mints a fresh host (and its opaque `host-N` id) and registers it.
   * T11: `cwd` is the absolute workspace directory the host's child must
   * run in (workspace.create); undefined for hosts minted without a
   * directory choice (chat.open/chat.new). */
  createHost(cwd?: string): ChatHost;
  /** T11: the live host whose workspace directory is `directory`, or
   * undefined — how an already-open directory selects its existing host
   * instead of a second child. A stopped host is never returned. */
  findByDirectory(directory: string): ChatHost | undefined;
  /** Every live host, in creation order. */
  list(): readonly ChatHost[];
  /** Stops exactly one host's child and forgets it. Optional: only used
   * to forget a host whose open/new failed (leaving it childless). */
  stopHost?(hostId: string): Promise<void>;
}

/**
 * Attaches the emitting host's id — and, when the host has one, its
 * workspace directory (T11) — to a state and to every Dialog in it,
 * exactly once, at the push boundary. The domain (PiSession/ChatHost)
 * never sees or needs the id; the renderer needs it on both so a dialog
 * answer can be addressed without guessing (T5b, S13). The directory is
 * the app-validated path the host's child runs in, so the footer can show
 * it without inventing one; a host created without a directory choice
 * carries none.
 */
function withHostId(state: ChatState, hostId: string, workspacePath?: string): ChatState {
  return {
    ...state,
    hostId,
    ...(workspacePath === undefined ? {} : { workspacePath }),
    pendingDialogs: state.pendingDialogs.map((dialog) => ({ ...dialog, hostId })),
  };
}

/**
 * T11: validates a workspace directory BEFORE anything is created —
 * absolute, exists, is a directory, readable. Each failure rejects with a
 * clear message, and WorkspaceHostRouter.createWorkspace awaits this
 * before minting any host, so an invalid selection leaves no host, no chat
 * and no state behind. Concrete adapter over node:fs/promises so the
 * refusals can be exercised against a real scratch directory; the router
 * itself takes the validator INJECTED, so its own tests never touch the
 * filesystem.
 */
export async function validateWorkspaceDirectory(directory: string): Promise<void> {
  if (directory.length === 0) throw new Error("Choose a directory for the workspace (none was given)");
  if (!isAbsolute(directory)) throw new Error(`"${directory}" is not an absolute path — choose the directory through the picker`);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(directory);
  } catch {
    throw new Error(`"${directory}" does not exist or cannot be read`);
  }
  if (!info.isDirectory()) throw new Error(`"${directory}" is not a directory`);
  try {
    await access(directory, constants.R_OK);
  } catch {
    throw new Error(`"${directory}" is not readable`);
  }
}

/**
 * T11 deps for the two workspace channels, injected so tests never open a
 * real dialog nor touch the real filesystem. main wires the Electron
 * dialog adapter and validateWorkspaceDirectory (src/main/index.ts).
 */
export interface WorkspaceRouterDeps {
  /** Opens the native directory picker. Resolves the chosen absolute path,
   * or null when the user cancelled — the caller must change nothing on
   * null. */
  readonly chooseDirectory?: () => Promise<string | null>;
  /** Validates a workspace directory before workspace.create touches
   * anything (see validateWorkspaceDirectory). */
  readonly validateDirectory?: (directory: string) => Promise<void>;
}

/**
 * T5b (desktop-rpc-client.md S3/S13, U6a): routes every request, dialog
 * answer and pushed state through the workspace host that owns it, never
 * through "whichever chat is open".
 *
 * - `openChat`/`newChat` answer an `OpenChatResult`: the id of the host
 *   the request was routed to plus its state. An already-live chat
 *   (tracked by session id) reuses its host instead of starting a second
 *   child; a new chat mints a host through the registry.
 * - Every other request carries a host id and is delivered to that
 *   host's child only. An unknown or stopped id is rejected with a clear
 *   error and reaches no child — never another live host.
 * - Pushes fan out from EVERY live host (including hosts created after
 *   this router was built), each payload already tagged with its
 *   emitting host id by `wire`.
 */
export class WorkspaceHostRouter {
  private readonly registry: WorkspaceHostSource;
  /** Chat/session id -> the id of the live host whose child owns it. The
   * reuse key: chat.open resolves through this map before minting a host,
   * so an already-live chat never gets a second child. Entries for hosts
   * that are no longer live are dropped lazily on the next open. */
  private readonly chatHosts = new Map<string, string>();
  private readonly stateListeners = new Set<(state: ChatState, hostId: string) => void>();
  private readonly errorListeners = new Set<(message: string, hostId: string) => void>();
  private readonly closeListeners = new Set<(hostId: string) => void>();
  /** Per-host push unsubscriptions, keyed by host id. A host outlives the
   * windows that listen to it, so unwiring happens only for failed starts. */
  private readonly hostUnsubscribers = new Map<string, () => void>();
  /** In-flight workspace creations keyed by directory (see createWorkspace). */
  private readonly pendingWorkspaceCreates = new Map<string, Promise<OpenChatResult>>();
  /** Startup result -> authoritative directory discovery. Only discovery is
   * joined across unknown opens; known unrelated startups are never barriers. */
  private readonly pendingOpens = new Map<Promise<OpenChatResult>, Promise<string | undefined>>();
  private readonly closingDirectories = new Map<string, Promise<void>>();

  private refuseClosing(directory: string | undefined): void {
    if (directory !== undefined && this.closingDirectories.has(directory)) {
      throw new Error(`Workspace "${directory}" is closing`);
    }
  }

  private trackOpen(start: () => Promise<OpenChatResult>, directory: Promise<string | undefined>): Promise<OpenChatResult> {
    const operation = start().then((result) => {
      const host = this.registry.get(result.hostId);
      this.refuseClosing(host?.effectiveCwd ?? host?.cwd);
      return result;
    });
    this.pendingOpens.set(operation, directory);
    void operation.then(() => this.pendingOpens.delete(operation), () => this.pendingOpens.delete(operation));
    return operation;
  }

  /** Joins work already begun, then closes every actual directory owner.
   * Failures retain the persisted entry; every matching host is attempted. */
  closeWorkspace(directory: string): Promise<void> {
    const pending = this.closingDirectories.get(directory);
    if (pending) return pending;
    const earlier = [...this.pendingOpens];
    const closing = Promise.resolve().then(async () => {
      await Promise.allSettled(earlier.map(async ([operation, ownership]) => {
        if (await ownership === directory) await operation;
      }));
      const hosts = this.registry.list().filter((host) => (host.effectiveCwd ?? host.cwd) === directory);
      const results = await Promise.allSettled(hosts.map((host) => this.closeChat(host.hostId)));
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }).finally(() => { this.closingDirectories.delete(directory); });
    this.closingDirectories.set(directory, closing);
    return closing;
  }
  /** The latest state each live host pushed, tagged by withHostId. Main
   * learns a host's state only through that host's own tagged pushes, so
   * this record IS the host's current state as main holds it — what
   * chat.refresh (T5c) answers when the renderer regains focus, so the
   * pane can reconcile without restarting the child through chat.open. */
  private readonly lastStateByHost = new Map<string, ChatState>();

  private readonly deps: WorkspaceRouterDeps;

  constructor(registry: WorkspaceHostSource, deps: WorkspaceRouterDeps = {}) {
    this.registry = registry;
    this.deps = deps;
    for (const host of registry.list()) this.wire(host);
  }

  /** Subscribes to tagged state pushes from every live host. The pushed
   * state already carries `hostId` (see withHostId); the second callback
   * argument repeats it for the error-style parity of the two push
   * channels. */
  onState(listener: (state: ChatState, hostId: string) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Subscribes to error pushes from every live host, each carrying the
   * emitting host's id. */
  onError(listener: (message: string, hostId: string) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  /** Subscribes to close reports (T5d): invoked with the closed host's id
   * whenever a workspace host is closed through chat.close, which is what
   * makes the renderer forget that host's snapshot and chat→host
   * mapping. */
  onClosed(listener: (hostId: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Opens a chat on the host that already owns it (reuse), or on a newly
   * minted host. The answer names the host actually routed to — never
   * "the current host" the caller did not ask for. */
  async openChat(chatId: string): Promise<OpenChatResult> {
    let reportDirectory!: (directory: string | undefined) => void;
    const ownership = new Promise<string | undefined>((resolve) => { reportDirectory = resolve; });
    const boundDirectory = this.registry.get(this.chatHosts.get(chatId) ?? "")?.cwd;
    if (boundDirectory !== undefined) reportDirectory(boundDirectory);
    const operation = this.trackOpen(async () => {
      // A lookup begun after close must not slip past its pending snapshot.
      if (this.closingDirectories.size > 0) {
        const closing = new Set(this.closingDirectories.keys());
        const summary = (await this.listChats()).find((chat) => chat.id === chatId);
        const directory = boundDirectory ?? summary?.cwd;
        reportDirectory(directory);
        if (directory !== undefined && closing.has(directory)) {
          throw new Error(`Workspace "${directory}" is closing`);
        }
      }
      return this.performOpenChat(chatId, reportDirectory);
    }, ownership);
    // Failed lookup has no directory to close. Sources without an early
    // ownership observer can still report ownership through their result.
    void operation.then((result) => {
      const host = this.registry.get(result.hostId);
      reportDirectory(host?.effectiveCwd ?? host?.cwd);
    }, () => reportDirectory(undefined));
    return operation;
  }

  private async performOpenChat(chatId: string, reportDirectory: (directory: string | undefined) => void): Promise<OpenChatResult> {
    const ownedHostId = this.chatHosts.get(chatId);
    if (ownedHostId !== undefined) {
      const host = this.registry.get(ownedHostId);
      if (host) {
        const state = await host.openChat(chatId, reportDirectory);
        return { hostId: ownedHostId, state: withHostId(state, ownedHostId, host.cwd) };
      }
      this.chatHosts.delete(chatId); // stale entry: that host is no longer live
    }
    const host = this.spawnHost();
    try {
      const state = await host.openChat(chatId, reportDirectory);
      this.lastStateByHost.set(host.hostId, withHostId(state, host.hostId, host.cwd));
      this.chatHosts.set(chatId, host.hostId);
      return { hostId: host.hostId, state: withHostId(state, host.hostId, host.cwd) };
    } catch (cause) {
      // A failed open leaves the fresh host childless (or with a child it
      // failed to finish starting); forget it so failed opens never
      // accumulate empty hosts.
      this.forgetHostWiring(host.hostId); // T5c: the stored unsubscriber must fire too, or the router stays subscribed to a host the registry is dropping
      try {
        await this.registry.stopHost?.(host.hostId);
      } catch {
        // nothing left to clean up
      }
      throw cause;
    }
  }

  /** Starts a fresh chat on a newly minted host (U6a: each workspace its
   * own independent child; chat.new never lands on someone else's host).
   * The host carries no workspace directory: only workspace.create
   * (T11) binds a chat to a validated directory. */
  async newChat(): Promise<OpenChatResult> {
    const host = this.spawnHost();
    try {
      const state = await host.newChat();
      this.lastStateByHost.set(host.hostId, withHostId(state, host.hostId, host.cwd));
      return { hostId: host.hostId, state: withHostId(state, host.hostId, host.cwd) };
    } catch (cause) {
      this.forgetHostWiring(host.hostId); // same failed-start unwiring as openChat (T5c)
      try {
        await this.registry.stopHost?.(host.hostId);
      } catch {
        // nothing left to clean up
      }
      throw cause;
    }
  }

  /** T11: opens the native directory picker and answers the chosen
   * absolute path, or null when the user cancelled — the caller must
   * change NOTHING on null (no host, no chat, no state). Choosing alone
   * creates nothing; workspace.create is the request that does. */
  async chooseDirectory(): Promise<string | null> {
    if (!this.deps.chooseDirectory) {
      throw new Error("WorkspaceHostRouter: no directory picker is configured");
    }
    return this.deps.chooseDirectory();
  }

  /** T11: creates a workspace bound to `directory` — a fresh chat whose
   * host's child runs with that directory as cwd, so ChatSummary.cwd and
   * the footer's path report the directory the user chose, not Electron's
   * launch directory.
   *
   * Order is the safety property: the directory is validated BEFORE
   * anything is created, so an invalid selection is refused with a clear
   * message and leaves no host, no chat and no state behind. A directory
   * that is already open selects its existing host instead of starting a
   * second child for it (U6a: reuse an already open session rather than
   * creating an accidental duplicate). A failed start cleans up exactly
   * like newChat: unwire, forget, stop the childless host. */
  async createWorkspace(directory: string): Promise<OpenChatResult> {
    return this.trackOpen(() => this.beginWorkspace(directory), Promise.resolve(directory));
  }

  private async beginWorkspace(directory: string): Promise<OpenChatResult> {
    this.refuseClosing(directory);
    if (!this.deps.validateDirectory) {
      throw new Error("WorkspaceHostRouter: no directory validator is configured");
    }
    await this.deps.validateDirectory(directory);
    this.refuseClosing(directory);
    // Serialized per directory: two clicks on the same folder share one start
    // instead of racing (the loser used to see a host whose chat had not
    // reported a state yet and was refused).
    const inFlight = this.pendingWorkspaceCreates.get(directory);
    if (inFlight) return inFlight;
    const started = this.createOrReuseWorkspace(directory).finally(() => {
      this.pendingWorkspaceCreates.delete(directory);
    });
    this.pendingWorkspaceCreates.set(directory, started);
    return started;
  }

  private async createOrReuseWorkspace(directory: string): Promise<OpenChatResult> {
    // Live only: the registry drops a host whose child exited, so a dead one
    // can never answer a directory as if it were still open.
    const existing = this.registry.findByDirectory(directory);
    if (existing) {
      // Only a host that still owns a live child may answer for its directory:
      // a child can exit on its own and leaves the host constructed, and a
      // live host that never reported a state has nothing to hand over. Both
      // are replaced instead of being answered with a dead or empty workspace.
      const state = existing.isAlive ? this.lastStateByHost.get(existing.hostId) : undefined;
      if (state) return { hostId: existing.hostId, state };
      try {
        await this.registry.stopHost?.(existing.hostId);
      } catch {
        // nothing left to clean up
      }
    }

    const host = this.spawnHost(directory);
    try {
      const state = await host.newChat();
      this.lastStateByHost.set(host.hostId, withHostId(state, host.hostId, host.cwd));
      return { hostId: host.hostId, state: withHostId(state, host.hostId, host.cwd) };
    } catch (cause) {
      this.forgetHostWiring(host.hostId); // same failed-start unwiring as newChat
      try {
        await this.registry.stopHost?.(host.hostId);
      } catch {
        // nothing left to clean up
      }
      throw cause;
    }
  }

  /** Closes the addressed workspace host (T5d): stops exactly that host's
   * child through the registry and forgets it. requireHost refuses an
   * unknown or already-stopped id before anything is touched — no child is
   * reached, and a live host is never stopped twice. Only on a successful
   * stop is the close then REPORTED to the onClosed listeners
   * (registerHandlers forwards it as the chat.closed push), which is what
   * makes the renderer forget the host's snapshot and chat→host mapping.
   * Quit is unaffected: the registry's stopAll covers every host still in
   * it, and a closed host is no longer in it. */
  async closeChat(hostId: string): Promise<void> {
    this.requireHost(hostId);
    // Bound: the registry's method must run with the registry as `this`.
    const stop = this.registry.stopHost?.bind(this.registry);
    if (!stop) throw new Error(`WorkspaceHostRouter: the host source cannot stop hosts (no stopHost), host "${hostId}" stays open`);
    // The cleanup runs even when the stop fails: a source drops the host
    // before awaiting its child, so a rejected stop still leaves a host the
    // router must stop believing in. Keeping the wiring or the reuse entry
    // would point later opens at a host nothing owns any more.
    //
    // The failure is tracked with its own flag, not with `failure !== undefined`
    // (R3-001): a promise may legally reject with `undefined`, and treating
    // that as "nothing failed" would resolve a close whose child may still be
    // running.
    let failed = false;
    let failure: unknown;
    try {
      await stop(hostId);
    } catch (cause) {
      failed = true;
      failure = cause;
    } finally {
      this.forgetHostWiring(hostId);
      // A chat this host owned must resolve through a FRESH host on its next
      // chat.open: the stale reuse entry must never resurrect the closed id.
      for (const [chatId, owner] of this.chatHosts) {
        if (owner === hostId) this.chatHosts.delete(chatId);
      }
      for (const listener of this.closeListeners) listener(hostId);
    }
    if (failed) {
      // P3: the source already dropped the host, so a rejected stop can leave
      // a child nothing tracks any more. Cleanup alone says nothing about it —
      // without this report the failure only reached a caller that may swallow
      // it, and a live process outlived the workspace in silence. Reported
      // AFTER the close listeners (see the finally above) because the renderer
      // repaints one status line from both: the specific failure must be the
      // last word, not the generic "host was closed" notice.
      const reason = failure instanceof Error ? failure.message : String(failure);
      for (const listener of this.errorListeners) {
        listener(`Could not close this workspace's host: ${reason}. Its process may still be running.`, hostId);
      }
      throw failure;
    }
  }

  /** T1: validates a workspace directory through the injected validator —
   * the SAME check workspace.create runs before anything is created, so
   * workspace.add can persist only a directory the creation path would
   * accept. Refuses clearly when no validator is configured. */
  async validateWorkspace(directory: string): Promise<void> {
    if (!this.deps.validateDirectory) {
      throw new Error("WorkspaceHostRouter: no directory validator is configured");
    }
    await this.deps.validateDirectory(directory);
  }

  /** Answers the addressed host's current state WITHOUT starting or
   * restarting its child (T5c): the renderer calls this when it regains
   * focus on a chat it already resolved, after painting the snapshot it
   * cached from that host's pushes, so the child keeps running instead of
   * being restarted through chat.open. The host must still be live
   * (requireHost), so an unknown or stopped id is refused and no child is
   * touched; a live host whose chat never reported a state is refused
   * too, because there is nothing to answer with. */
  async refreshChat(hostId: string): Promise<ChatState> {
    this.requireHost(hostId);
    const state = this.lastStateByHost.get(hostId);
    if (!state) {
      throw new Error(`No known state for host "${hostId}" (its chat has not reported any state yet)`);
    }
    return state;
  }

  /** The session list is host-independent: every host reads the same
   * dynamic SessionStore (the home choice re-resolves per call). Served
   * from the newest live host; before any open/new there is none, so a
   * childless host is created just for the list (it spawns no child until
   * an open/new routes to it). */
  async listChats(): Promise<ChatSummary[]> {
    const host = this.registry.list().at(-1) ?? this.spawnHost();
    return host.listChats();
  }

  /** The live host owning `hostId`, or a clear rejection. There is no
   * fallback to another live host (U6a), so an unknown or stopped id can
   * never make any child act. */
  private requireHost(hostId: string): ChatHost {
    const host = this.registry.get(hostId);
    if (!host) {
      throw new Error(`No live workspace host for id "${hostId}" (unknown or already stopped)`);
    }
    return host;
  }

  // The request methods are async (not merely promise-returning) so an
  // unknown host id becomes a REJECTED PROMISE at the ipc.handle boundary
  // — Electron's invoke() contract — instead of a synchronous throw inside
  // the listener.
  async sendMessage(hostId: string, text: string): Promise<PromptResult> {
    return this.requireHost(hostId).sendMessage(text);
  }

  async abort(hostId: string): Promise<void> {
    return this.requireHost(hostId).abort();
  }

  async answerDialog(hostId: string, dialogId: string, answer: DialogAnswer): Promise<void> {
    return this.requireHost(hostId).answerDialog(dialogId, answer);
  }

  async stopHelper(hostId: string, helperId: string): Promise<StopHelperOutcome> {
    return this.requireHost(hostId).stopHelper(helperId);
  }

  /** Reads the addressed host's REAL available-model snapshot (palette-
   * command-arguments T1, S2) — the same host-addressed shape as
   * stopHelper/runCommand; the classification is PiSession's. */
  async availableModels(hostId: string): Promise<AvailableModelsResult> {
    return this.requireHost(hostId).availableModels();
  }

  /** Reads the addressed host's available thinking levels (palette-
   * command-arguments T1, S3) — the same host-addressed shape. */
  async availableThinkingLevels(hostId: string): Promise<AvailableThinkingLevelsResult> {
    return this.requireHost(hostId).availableThinkingLevels();
  }

  /** Runs one catalog command on the addressed host (palette-host-catalog
   * T3, S4): the answer is a ChatCommandRunResult — a refusal is a SUCCESS
   * answer, never a rejection — and only the addressed host is touched. */
  async runCommand(hostId: string, name: string, args?: string): Promise<ChatCommandRunResult> {
    return this.requireHost(hostId).runCommand(name, args);
  }

  /** Mints a host through the registry and wires its pushes into this
   * router, so hosts created after construction are still fanned out.
   * T11: `cwd` is the workspace directory for workspace.create hosts;
   * undefined for chat.open/chat.new hosts. */
  private spawnHost(cwd?: string): ChatHost {
    const host = this.registry.createHost(cwd);
    this.wire(host);
    return host;
  }

  /** Subscribes to one host's state/error events and fans them out to this
   * router's listeners with the host id attached (state payloads get it
   * from withHostId; error payloads carry it as their second argument). */
  private wire(host: ChatHost): void {
    const hostId = host.hostId;
    this.hostUnsubscribers.get(hostId)?.();
    const unsubscribeState = host.onState((state, emittingHostId) => {
      // The record chat.refresh answers from (T5c): the latest tagged push
      // per host, before fanning out to the router's listeners. The host's
      // workspace directory rides along (T11), so every pushed state — not
      // just the open/new answer — carries the footer's path.
      this.lastStateByHost.set(hostId, withHostId(state, emittingHostId, host.cwd));
      for (const listener of this.stateListeners) listener(withHostId(state, emittingHostId, host.cwd), emittingHostId);
    });
    const unsubscribeError = host.onError((message, emittingHostId) => {
      for (const listener of this.errorListeners) listener(message, emittingHostId);
    });
    this.hostUnsubscribers.set(hostId, () => {
      unsubscribeState();
      unsubscribeError();
    });
  }

  /** Invokes and drops one host's stored push unsubscriber (T5c, L24
   * follow-up): a failed start removes the host from the registry, so the
   * router must stop hearing it too — without this, the router stays
   * subscribed to a host that no longer exists. Also drops the host's
   * recorded state: no live host owns it any more. */
  private forgetHostWiring(hostId: string): void {
    this.hostUnsubscribers.get(hostId)?.();
    this.hostUnsubscribers.delete(hostId);
    this.lastStateByHost.delete(hostId);
  }
}

/**
 * Registers `ipcMain.handle` for every GentleBridge request channel —
 * now routed through WorkspaceHostRouter by host identity (T5b) — and
 * forwards every live host's state/error pushes to the renderer via
 * `webContents.send`, each payload tagged with its emitting host id.
 * Takes `ipc`/`webContents` as parameters (never imports the `ipcMain`
 * value itself) so this file never executes `require("electron")` at
 * module load time — only src/main/index.ts, which genuinely runs inside
 * Electron, does that.
 *
 * Returns an unsubscribe function that stops forwarding state/error
 * pushes for this call's webContents. Request handlers are re-registered
 * on `ipc` every call (`removeHandler` first, since Electron's
 * `ipc.handle` throws "Attempted to register a second handler" for a
 * channel that already has one): M1 has exactly one window at a time, but
 * that window can still close and a new one open later (macOS `activate`,
 * T5 host follow-up), so this must tolerate being called again rather
 * than assuming it only ever runs once for the app's lifetime. `setup`
 * answers the first-run/home-choice channels; it has no per-window state,
 * so it is exposed the same way for every window instead of also needing
 * an unsubscribe. The router itself is created once per app (in
 * src/main/index.ts) and shared across windows — hosts outlive windows.
 */
/**
 * Everything the shell's own chrome needs from the process that owns it,
 * injected instead of imported: window controls, the app's version and the
 * native file picker all sit behind Electron values this module must never
 * load at import time (node tests import it directly).
 */
export interface ShellPorts {
  readonly windowControls?: WindowControlsPort;
  readonly appInfo?: () => AppInfo;
  readonly chooseFile?: () => Promise<string | null>;
  /** T1 (S1/S2): the persisted workspace registry over the app config
   * (src/main/index.ts builds it from the same config.json that holds
   * `home`). `add` persists one absolute directory (most-recently-added
   * first, deduplicated); `remove` deletes ONLY the persisted entry;
   * `list` answers the persisted directories. Backed by a real store in
   * the packaged app; absent in a build without one, where the registry
   * channels refuse clearly instead of pretending. */
  readonly workspaces?: WorkspaceRegistryPort;
  /** The branch a directory has checked out, read by main while the workspace
   * list is built. A file read (never a spawn, never a child round trip), so
   * every listed workspace answers at startup and right after an add. Absent
   * leaves the list without branches, exactly as before. */
  readonly readWorkspaceBranch?: (directory: string) => string | undefined;
}

/**
 * T1 (S1/S2): the persisted workspace registry, injected (never imported
 * from Electron here) so tests can back the channels with an in-memory
 * registry. The concrete store lives in the app config
 * (createAppConfigStore's workspaces key) and is wired in src/main/index.ts.
 */
export interface WorkspaceRegistryPort {
  /** The persisted workspace directories, most-recently-added first. */
  list(): readonly string[];
  /** Persists one directory (the store validates absolute-ness and
   * deduplicates). Returns the fresh persisted list. */
  add(directory: string): readonly string[];
  /** Deletes ONLY the persisted entry for `directory` — never a session
   * file, a directory or a chat. A no-op for an unknown directory.
   * Returns the fresh persisted list. */
  remove(directory: string): readonly string[];
}

/** Opened navigation only: Pi history remains available through listChats.
 * `branches` answers the checked-out branch of every persisted directory, so
 * the panel never has to wait for one live child to describe the others. */
function workspaceList(
  persisted: readonly string[],
  readBranch?: (directory: string) => string | undefined,
): WorkspaceList {
  const directories = [...persisted];
  const list = { directories, persisted: [...persisted] };
  if (!readBranch) return list;
  const branches: Record<string, string> = {};
  for (const directory of directories) {
    const branch = readBranch(directory);
    if (branch !== undefined) branches[directory] = branch;
  }
  return { ...list, branches };
}

function requireWorkspaceRegistry(ports: ShellPorts): WorkspaceRegistryPort {
  if (!ports.workspaces) throw new Error("The workspace registry is unavailable in this build.");
  return ports.workspaces;
}

/** The BrowserWindow actions the frameless chrome performs. */
export interface WindowControlsPort {
  minimize(): void;
  toggleMaximize(): boolean;
  close(): void;
}

export function registerHandlers(
  router: WorkspaceHostRouter,
  setup: SetupService,
  webContents: WebContents,
  ipc: IpcMain,
  ports: ShellPorts = {},
): () => void {
  registerRequestHandler(ipc, IPC_CHANNELS.LIST_CHATS, () => router.listChats());
  registerRequestHandler(ipc, IPC_CHANNELS.OPEN_CHAT, (_event, chatId: string) => router.openChat(chatId));
  registerRequestHandler(ipc, IPC_CHANNELS.NEW_CHAT, () => router.newChat());
  // T5c: asks the addressed host for its current state (no child round
  // trip, no restart); an unknown id is rejected like every other request.
  registerRequestHandler(ipc, IPC_CHANNELS.REFRESH_CHAT, (_event, hostId: string) => router.refreshChat(hostId));
  // T5d: closes exactly the addressed workspace host — its child is
  // stopped through the registry and the host is forgotten; an unknown or
  // already-stopped id is rejected without touching any child.
  registerRequestHandler(ipc, IPC_CHANNELS.CLOSE_CHAT, (_event, hostId: string) => router.closeChat(hostId));
  // From here on every request carries the host id first (T5b): the
  // address the request must be delivered to, never inferred.
  registerRequestHandler(ipc, IPC_CHANNELS.SEND_MESSAGE, (_event, hostId: string, text: string) => router.sendMessage(hostId, text));
  registerRequestHandler(ipc, IPC_CHANNELS.ABORT, (_event, hostId: string) => router.abort(hostId));
  registerRequestHandler(ipc, IPC_CHANNELS.ANSWER_DIALOG, (_event, hostId: string, dialogId: string, answer: DialogAnswer) =>
    router.answerDialog(hostId, dialogId, answer),
  );
  // palette-command-arguments T1: the available reads — the same
  // host-addressed surface style as the channels above, the host id first;
  // unsupported/failed resolve, never reject.
  registerRequestHandler(ipc, IPC_CHANNELS.AVAILABLE_MODELS, (_event, hostId: string) => router.availableModels(hostId));
  registerRequestHandler(ipc, IPC_CHANNELS.AVAILABLE_THINKING_LEVELS, (_event, hostId: string) => router.availableThinkingLevels(hostId));
  registerRequestHandler(ipc, IPC_CHANNELS.STOP_HELPER, (_event, hostId: string, helperId: string) => router.stopHelper(hostId, helperId));
  // palette-host-catalog T3 (S4): the ONE execution channel for runnable
  // catalog rows. Same chat.* surface style as the channels above — the
  // host id first, the catalog name, then the optional args (the /resume
  // picker's session path among them); a refusal resolves, never rejects.
  registerRequestHandler(ipc, IPC_CHANNELS.COMMAND_RUN, (_event, hostId: string, name: string, args?: string) =>
    router.runCommand(hostId, name, args),
  );
  // T11: the native directory picker runs in main (injected adapter); a
  // null answer is a cancellation, and the create request does the actual
  // work — validation first, then the host whose child runs in the
  // directory.
  registerRequestHandler(ipc, IPC_CHANNELS.WORKSPACE_CHOOSE_DIRECTORY, () => router.chooseDirectory());
  registerRequestHandler(ipc, IPC_CHANNELS.WORKSPACE_CREATE, (_event, directory: string) => router.createWorkspace(directory));
  // T1 (S1/S2): the workspace registry. Each of list/add/remove answers
  // the fresh WorkspaceList, so the panel re-reads after add and after
  // remove without a restart — one explicit re-read per action, never a
  // push channel. add validates through the SAME validator workspace
  // create uses, so a directory the creation path would refuse is never
  // persisted. open is the creation path itself (workspace.create) minus
  // the picker: selecting a persisted workspace that has no chats yet
  // opens a new chat for that directory without asking again, with no
  // duplicated host lifecycle logic.
  registerRequestHandler(ipc, IPC_CHANNELS.WORKSPACE_LIST, async () => {
    const registry = requireWorkspaceRegistry(ports);
    return workspaceList(registry.list(), ports.readWorkspaceBranch);
  });
  registerRequestHandler(ipc, IPC_CHANNELS.WORKSPACE_ADD, async (_event, directory: string) => {
    const registry = requireWorkspaceRegistry(ports);
    await router.validateWorkspace(directory);
    registry.add(directory);
    return workspaceList(registry.list(), ports.readWorkspaceBranch);
  });
  registerRequestHandler(ipc, IPC_CHANNELS.WORKSPACE_REMOVE, async (_event, directory: string) => {
    const registry = requireWorkspaceRegistry(ports);
    await router.closeWorkspace(directory);
    registry.remove(directory);
    return workspaceList(registry.list(), ports.readWorkspaceBranch);
  });
  registerRequestHandler(ipc, IPC_CHANNELS.WORKSPACE_OPEN, (_event, directory: string) => router.createWorkspace(directory));
  registerRequestHandler(ipc, IPC_CHANNELS.SETUP_STATUS, () => setup.status());
  registerRequestHandler(ipc, IPC_CHANNELS.CHOOSE_HOME, (_event, mode: HomeMode) => setup.chooseHome(mode));
  // The shell's own chrome (second increment): app facts, the frameless
  // window's controls and the native FILE picker. Each one refuses clearly
  // when its port is absent instead of silently answering nothing, and the
  // picker's null answer is a cancellation the caller must treat as "change
  // nothing" — exactly like the directory picker.
  registerRequestHandler(ipc, IPC_CHANNELS.APP_INFO, () => {
    if (!ports.appInfo) throw new Error("The app's version is unavailable in this build.");
    return ports.appInfo();
  });
  registerRequestHandler(ipc, IPC_CHANNELS.WINDOW_MINIMIZE, () => {
    requireWindowControls(ports).minimize();
  });
  registerRequestHandler(ipc, IPC_CHANNELS.WINDOW_TOGGLE_MAXIMIZE, () => requireWindowControls(ports).toggleMaximize());
  registerRequestHandler(ipc, IPC_CHANNELS.WINDOW_CLOSE, () => {
    requireWindowControls(ports).close();
  });
  registerRequestHandler(ipc, IPC_CHANNELS.COMPOSER_CHOOSE_FILE, () => ports.chooseFile?.() ?? Promise.resolve(null));

  // Pushes fan out from EVERY live host (including hosts created after
  // this registration, through the router's own subscription). The state
  // payload already carries its emitting host id; the error push carries
  // it as a second argument, mirroring the request channels.
  const unsubscribeState = router.onState((state) => webContents.send(IPC_CHANNELS.STATE_PUSH, state));
  const unsubscribeError = router.onError((message, hostId) => webContents.send(IPC_CHANNELS.ERROR_PUSH, message, hostId));
  // T5d: a successful chat.close is REPORTED as its own push, carrying the
  // closed host's id, so the renderer can forget that host's snapshot and
  // chat→host mapping instead of painting a dead host's state again.
  const unsubscribeClosed = router.onClosed((hostId) => webContents.send(IPC_CHANNELS.CLOSED_PUSH, hostId));

  return () => {
    unsubscribeState();
    unsubscribeError();
    unsubscribeClosed();
  };
}

type IpcHandleListener = Parameters<IpcMain["handle"]>[1];

/** One refusal message for every window channel, so a build without a
 * window (a headless test, a second registration) cannot pretend to act. */
function requireWindowControls(ports: ShellPorts): WindowControlsPort {
  if (!ports.windowControls) throw new Error("Window controls are unavailable in this build.");
  return ports.windowControls;
}

function registerRequestHandler(ipc: IpcMain, channel: string, listener: IpcHandleListener): void {
  ipc.removeHandler(channel);
  ipc.handle(channel, listener);
}
