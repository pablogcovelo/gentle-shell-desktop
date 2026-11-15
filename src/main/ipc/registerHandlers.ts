import type { IpcMain, WebContents } from "electron";
import type {
  ChatState,
  ChatSummary,
  DialogAnswer,
  HomeMode,
  OpenChatResult,
  PromptResult,
  StopHelperOutcome,
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
  /** Mints a fresh host (and its opaque `host-N` id) and registers it. */
  createHost(): ChatHost;
  /** Every live host, in creation order. */
  list(): readonly ChatHost[];
  /** Stops exactly one host's child and forgets it. Optional: only used
   * to forget a host whose open/new failed (leaving it childless). */
  stopHost?(hostId: string): Promise<void>;
}

/**
 * Attaches the emitting host's id to a state and to every Dialog in it,
 * exactly once, at the push boundary. The domain (PiSession/ChatHost)
 * never sees or needs the id; the renderer needs it on both so a dialog
 * answer can be addressed without guessing (T5b, S13).
 */
function withHostId(state: ChatState, hostId: string): ChatState {
  return {
    ...state,
    hostId,
    pendingDialogs: state.pendingDialogs.map((dialog) => ({ ...dialog, hostId })),
  };
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
  /** Per-host push unsubscriptions, keyed by host id. A host outlives the
   * windows that listen to it, so unwiring happens only for failed starts. */
  private readonly hostUnsubscribers = new Map<string, () => void>();
  /** The latest state each live host pushed, tagged by withHostId. Main
   * learns a host's state only through that host's own tagged pushes, so
   * this record IS the host's current state as main holds it — what
   * chat.refresh (T5c) answers when the renderer regains focus, so the
   * pane can reconcile without restarting the child through chat.open. */
  private readonly lastStateByHost = new Map<string, ChatState>();

  constructor(registry: WorkspaceHostSource) {
    this.registry = registry;
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

  /** Opens a chat on the host that already owns it (reuse), or on a newly
   * minted host. The answer names the host actually routed to — never
   * "the current host" the caller did not ask for. */
  async openChat(chatId: string): Promise<OpenChatResult> {
    const ownedHostId = this.chatHosts.get(chatId);
    if (ownedHostId !== undefined) {
      const host = this.registry.get(ownedHostId);
      if (host) {
        const state = await host.openChat(chatId);
        return { hostId: ownedHostId, state: withHostId(state, ownedHostId) };
      }
      this.chatHosts.delete(chatId); // stale entry: that host is no longer live
    }
    const host = this.spawnHost();
    try {
      const state = await host.openChat(chatId);
      this.lastStateByHost.set(host.hostId, withHostId(state, host.hostId));
      this.chatHosts.set(chatId, host.hostId);
      return { hostId: host.hostId, state: withHostId(state, host.hostId) };
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
   * own independent child; chat.new never lands on someone else's host). */
  async newChat(): Promise<OpenChatResult> {
    const host = this.spawnHost();
    try {
      const state = await host.newChat();
      this.lastStateByHost.set(host.hostId, withHostId(state, host.hostId));
      return { hostId: host.hostId, state: withHostId(state, host.hostId) };
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

  /** Mints a host through the registry and wires its pushes into this
   * router, so hosts created after construction are still fanned out. */
  private spawnHost(): ChatHost {
    const host = this.registry.createHost();
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
      // per host, before fanning out to the router's listeners.
      this.lastStateByHost.set(hostId, withHostId(state, emittingHostId));
      for (const listener of this.stateListeners) listener(withHostId(state, emittingHostId), emittingHostId);
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
export function registerHandlers(router: WorkspaceHostRouter, setup: SetupService, webContents: WebContents, ipc: IpcMain): () => void {
  registerRequestHandler(ipc, IPC_CHANNELS.LIST_CHATS, () => router.listChats());
  registerRequestHandler(ipc, IPC_CHANNELS.OPEN_CHAT, (_event, chatId: string) => router.openChat(chatId));
  registerRequestHandler(ipc, IPC_CHANNELS.NEW_CHAT, () => router.newChat());
  // T5c: asks the addressed host for its current state (no child round
  // trip, no restart); an unknown id is rejected like every other request.
  registerRequestHandler(ipc, IPC_CHANNELS.REFRESH_CHAT, (_event, hostId: string) => router.refreshChat(hostId));
  // From here on every request carries the host id first (T5b): the
  // address the request must be delivered to, never inferred.
  registerRequestHandler(ipc, IPC_CHANNELS.SEND_MESSAGE, (_event, hostId: string, text: string) => router.sendMessage(hostId, text));
  registerRequestHandler(ipc, IPC_CHANNELS.ABORT, (_event, hostId: string) => router.abort(hostId));
  registerRequestHandler(ipc, IPC_CHANNELS.ANSWER_DIALOG, (_event, hostId: string, dialogId: string, answer: DialogAnswer) =>
    router.answerDialog(hostId, dialogId, answer),
  );
  registerRequestHandler(ipc, IPC_CHANNELS.STOP_HELPER, (_event, hostId: string, helperId: string) => router.stopHelper(hostId, helperId));
  registerRequestHandler(ipc, IPC_CHANNELS.SETUP_STATUS, () => setup.status());
  registerRequestHandler(ipc, IPC_CHANNELS.CHOOSE_HOME, (_event, mode: HomeMode) => setup.chooseHome(mode));

  // Pushes fan out from EVERY live host (including hosts created after
  // this registration, through the router's own subscription). The state
  // payload already carries its emitting host id; the error push carries
  // it as a second argument, mirroring the request channels.
  const unsubscribeState = router.onState((state) => webContents.send(IPC_CHANNELS.STATE_PUSH, state));
  const unsubscribeError = router.onError((message, hostId) => webContents.send(IPC_CHANNELS.ERROR_PUSH, message, hostId));

  return () => {
    unsubscribeState();
    unsubscribeError();
  };
}

type IpcHandleListener = Parameters<IpcMain["handle"]>[1];

function registerRequestHandler(ipc: IpcMain, channel: string, listener: IpcHandleListener): void {
  ipc.removeHandler(channel);
  ipc.handle(channel, listener);
}
