import {
  MESSAGE_ROLE,
  type AvailableModelsResult,
  type AvailableThinkingLevelsResult,
  type ChatMessage,
} from "@shared/bridge-types";
import {
  STOP_HELPER_OUTCOME,
  type ChatCommand,
  type ChatCommandRunResult,
  type ChatCommandSource,
  type ChatState,
  type DialogAnswer,
  type HelperAgentState,
  type HelpersActivity,
  type PromptResult,
  type StopChannelState,
  type StopHelperOutcome,
} from "@shared/bridge-types";
import { INITIAL_CHAT_STATE, reduceChat } from "../rpc/chatReducer";
import { decodeLine, encodeCommand } from "../rpc/codec";
import { applyAgentState, mergeAgentEntry, parseAgentEntry, parseAgentList } from "../rpc/agents";
import { CATALOG_SOURCES, parseCommandCatalog } from "../rpc/commandCatalog";
import { DESKTOP_RPC_DEFAULT_TIMEOUT_MS, DESKTOP_RPC_WIDGET_KEY, DesktopRpcClient, parseDesktopRpcWidget } from "../rpc/desktopRpc";
import { parseAvailableModels, parseAvailableThinkingLevels, parseSessionState, parseSessionStats } from "../rpc/sessionStats";
import { parseToolVocabulary } from "../rpc/toolVocabulary";
import {
  parseActiveProfile,
  parseMcpStatus,
  parseWorktreeChanges,
  unavailableWorktreeChanges,
} from "../rpc/workspaceInfo";
import { mergeUsageProviders, parseRateLimitEvent, parseSubscriptionUsage } from "../rpc/usage";
import { extractHistoryMessages, historyToMessages, historyToToolCalls } from "../rpc/history";
import { extractTodoPanel } from "../rpc/todoPanel";
import type { RpcCommand, RpcEvent, RpcResponse } from "../rpc/types";
import type { LauncherLocator, ProcessSpawner, SpawnedProcess } from "../../ports";

export interface PiSessionOptions {
  readonly spawner: ProcessSpawner;
  readonly locator: LauncherLocator;
  /** e.g. `["--link"]` or `["--isolated"]`; empty means gentle-shell's own default. */
  readonly homeArgs?: readonly string[];
  readonly sessionPath?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
  /**
   * Receives raw child stderr lines (diagnostics, warnings) for logging.
   * Defaults to a no-op. Stderr output is not, by itself, evidence of a
   * failure (see handleStderrLine) so it no longer sets `lastError`.
   */
  readonly onLog?: (line: string) => void;
}

// PromptResult and DialogAnswer now live in @shared/bridge-types (T5, T3: the renderer
// constructs these too, answering a Dialog card through
// GentleBridge.answerDialog).

interface PiSessionEventMap {
  readonly state: ChatState;
  readonly event: RpcEvent;
  readonly error: Error;
}

type Listener<T> = (payload: T) => void;

/** Minimal typed pub/sub — PiSession only needs on/off/emit, not a full EventEmitter. */
class TypedEmitter<Events> {
  private readonly listeners: { [K in keyof Events]?: Array<Listener<Events[K]>> } = {};

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    const list = this.listeners[event] ?? [];
    list.push(listener);
    this.listeners[event] = list;
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    const list = this.listeners[event];
    if (!list) return;
    this.listeners[event] = list.filter((registered) => registered !== listener);
  }

  protected emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    for (const listener of this.listeners[event] ?? []) listener(payload);
  }
}

const STOP_GRACE_PERIOD_MS = 3000;

/**
 * The bound for one on-demand correlated read's wait (palette-command-
 * arguments T1): the SAME bound the desktop-rpc control channel applies
 * to its own requests, so every child round trip a caller can await
 * settles by the same deadline instead of an ad-hoc per-call guess. An
 * unanswered read past it resolves `failed` — it never throws and never
 * hangs.
 */
const CHILD_QUERY_TIMEOUT_MS = DESKTOP_RPC_DEFAULT_TIMEOUT_MS;

/** How `PiSession.availableModels`/`availableThinkingLevels` classify
 * their outcome once the correlated reply (or the wait's deadline) has
 * settled. */
type ChildQueryOutcome =
  | { readonly kind: "unsupported" }
  | { readonly kind: "lost" }
  | { readonly kind: "answered"; readonly response: RpcResponse };

/** One on-demand correlated read awaiting its `response` frame. Keyed by
 * the request's correlation id; settled exactly once — by the matching
 * frame, by the wait's deadline, or by stop()/exit (a session nobody is
 * using can never answer). */
interface ChildQueryWaiter {
  readonly command: string;
  settle: (response: RpcResponse | undefined) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Set on every spawned pi process (M2 prerequisite, see
 * odd/tasks/desktop-m2-helpers.md): only with this flag does gentle-pi
 * enable RPC dialogs for ask_user_question/ask_user_choice and publish
 * subagent activity via the gentle-agents setWidget widget. Applied last
 * in start()'s env merge so neither `this.env` nor a launcher's own env
 * (e.g. ELECTRON_RUN_AS_NODE) can accidentally suppress it.
 */
const GENTLE_SHELL_INTERACTIVE_HOST_ENV = { GENTLE_SHELL_INTERACTIVE_HOST: "1" } as const;

/**
 * Owns one `gentle-shell --mode rpc` child process: spawns it through a
 * ProcessSpawner (resolved via a LauncherLocator), decodes its stdout into
 * RpcEvents, folds them into ChatState with the pure reducer, and emits
 * both out. Only depends on ports (ProcessSpawner, LauncherLocator), so it
 * needs no Node import itself and is testable with fakes — see
 * src/README.md's hexagonal main process note.
 *
 * Never throws from a public method: spawn/decode/stream failures surface
 * as `lastError` on the emitted state plus an ("error", Error) event
 * instead, because this runs inside Electron's main process, where an
 * uncaught exception takes down the whole app.
 */
export class PiSession extends TypedEmitter<PiSessionEventMap> {
  private readonly spawner: ProcessSpawner;
  private readonly locator: LauncherLocator;
  private readonly homeArgs: readonly string[];
  private readonly sessionPath: string | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string | undefined;
  private readonly onLog: (line: string) => void;

  private state: ChatState = INITIAL_CHAT_STATE;
  private process: SpawnedProcess | undefined;

  /** Whether this session still owns a live child. `process` is cleared by
   * handleExit (and stop), so it is the same live-child signal the late-reply
   * guards already rely on — exposed for the registry, which must not hand a
   * dead host's directory back as if it were still open. */
  get isAlive(): boolean {
    return this.process !== undefined && !this.stopping;
  }
  private stopping = false;
  private rpcClient: DesktopRpcClient | undefined;
  private historyRequestCounter = 0;
  /** Counts the subscription-usage requests this session has sent (T3).
   * A usage reply folds only while it is the NEWEST request's answer: a
   * late answer for an older request (out-of-order reconciliation, or an
   * answer that arrives after the chat was replaced) must never overwrite
   * the current usage. */
  private usageRequestEpoch = 0;
  /** Counts the worktree-changes requests this session has sent (desktop-rpc
   * T8b). A worktree answer folds only while it is the NEWEST request's
   * answer: the same binding rule the usage read applies, so a late answer
   * for an older request — or for a replaced chat — never overwrites the
   * current footer. */
  private worktreeRequestEpoch = 0;
  /** The desktop control channel's adoption state for THIS child's
   * lifetime (T3 correction). S10: `capabilities` is the only support
   * probe — until it succeeds for the live child, extension reads stay
   * gated (the native get_state bootstrap is safe), because on a child without the
   * bundled desktop extension a `/gentle:desktop {…}` prompt is an
   * unregistered slash string that would fall through as an ordinary
   * prompt (a model call and transcript pollution). Failed stays failed
   * for the child's lifetime; no re-probe, no timer. */
  private probeState: "idle" | "pending" | "ok" | "failed" = "idle";
  /** The methods the child advertised on the successful capabilities
   * probe (desktop-rpc T6). The probe answer is the authority on what
   * this child supports — never a hardcoded list (the list has grown
   * before). Undefined until adoption. */
  private advertisedMethods: ReadonlySet<string> | undefined;
  /** Whether an `agents_update` event has already been folded for this
   * child (desktop-rpc T6). The one `list_subagents` snapshot is the
   * INITIAL state; once an event has arrived, events own the truth and a
   * late snapshot must not regress it. */
  private agentsEventSeen = false;
  /** Set right after a `get_messages` history request is sent (reopening a
   * session with a `sessionPath`); cleared once its matching response
   * arrives. Lets `applyHistoryResponse` correlate the response by `id`
   * and ignore anything else that happens to carry `command: "get_messages"`
   * (a stale or unrelated response). */
  private pendingHistoryRequestId: string | undefined;
  /** Correlation ids for the session identity reads (desktop-rpc T4).
   * `get_session_stats` and `get_state` are ORDINARY RPC commands whose
   * answers arrive as `response` frames by `id`, exactly like history. Kept
   * apart per command so a late stats reply can never be folded as the
   * current state reply. */
  private pendingStatsRequestId: string | undefined;
  private pendingStateRequestId: string | undefined;
  private identityRequestCounter = 0;
  /** Counts the `get_commands` requests this session has sent
   * (desktop-pending-work T6, S6). The composer's slash list is whatever
   * the child answered for this pi-level command — correlated by `id` like
   * the identity reads, with its own counter and its own pending id so a
   * late or mismatched answer can never fold. Only the DEGRADED catalog
   * path (no `get_snapshot` advertised) writes through this pair. */
  private commandsRequestCounter = 0;
  private pendingCommandsRequestId: string | undefined;
  /** Counts the host-catalog (`get_snapshot`) requests this session has
   * sent (palette-host-catalog T1, S1). The answer folds only while it is
   * BOTH the newest request's answer (epoch) AND still this session's
   * client — the same binding rule the usage/worktree reads apply, so a
   * late answer for a replaced read never overwrites the current catalog. */
  private catalogRequestEpoch = 0;
  /** Counts the available-models reads (palette-command-arguments T1).
   * On-demand (the palette's own screens ask for them, the way
   * runCommand/stopHelper are asked) rather than probe-triggered: S6 pins
   * the startup and the rest of the palette unchanged, and an older child
   * that cannot answer leaves the app exactly as it is today. */
  private modelsRequestCounter = 0;
  /** Counts the available-thinking-levels reads (palette-command-
   * arguments T1). Separate from the models counter so a late models
   * reply can never settle a levels read. */
  private levelsRequestCounter = 0;
  /** The on-demand correlated reads awaiting their `response` frames,
   * keyed by correlation id (palette-command-arguments T1). See
   * ChildQueryWaiter. */
  private readonly childQueryWaiters = new Map<string, ChildQueryWaiter>();

  constructor(options: PiSessionOptions) {
    super();
    this.spawner = options.spawner;
    this.locator = options.locator;
    this.homeArgs = options.homeArgs ?? [];
    this.sessionPath = options.sessionPath;
    this.env = options.env;
    this.cwd = options.cwd;
    this.onLog = options.onLog ?? (() => undefined);
  }

  /**
   * Resolves the launcher, spawns it with `--mode rpc`, and starts streaming
   * events. Guarded against a double start: while a process is already
   * active, a second call surfaces an error instead of spawning a second
   * child (which would silently orphan the first one's stdin/stdout wiring).
   */
  start(): void {
    if (this.process) {
      this.surfaceError(new Error("PiSession: already started (a session is already active)"));
      return;
    }

    try {
      const launcher = this.locator.locate();
      const args = [
        ...launcher.args,
        ...this.homeArgs,
        "--mode",
        "rpc",
        ...(this.sessionPath ? ["--session", this.sessionPath] : []),
      ];
      const env = { ...this.env, ...(launcher.env ?? {}), ...GENTLE_SHELL_INTERACTIVE_HOST_ENV };
      const proc = this.spawner.spawn(launcher.command, args, env, this.cwd);
      this.process = proc;

      proc.onStdoutLine((line) => this.handleLine(line));
      proc.onStderrLine((line) => this.handleStderrLine(line));
      proc.onError((error) => this.surfaceError(error));
      proc.exited.then(({ code, signal, error }) => this.handleExit(code, signal, error)).catch(() => undefined);

      // The desktop-rpc control plane (U1, desktop-rpc T2) rides the same
      // child: bind the client now, because its `send` only exists once the
      // process does. A request becomes a `/gentle:desktop` prompt command
      // (docs/desktop-rpc.md transport); it bypasses prompt()'s
      // while-working guard, and its `disposition: "handled"` response is
      // never the domain answer — only the correlated `gentle-desktop-rpc`
      // widget frame settles it (handled in handleLine below).
      this.rpcClient = new DesktopRpcClient({
        send: (message) => {
          const proc = this.process;
          if (!proc || this.stopping) return; // the request surfaces its timeout instead; never throws
          this.send({ type: "prompt", message });
        },
      });

      // desktop-rpc T3 correction: control traffic is gated on the
      // capabilities probe (S10's only support probe). A REOPENED chat
      // sends ONLY its history request here; the probe follows once that
      // response has been folded (`handleLine`), because a probe reply
      // landing first would write a `/gentle:desktop` line and take
      // `get_messages` out of last position while ChatHost's bounded
      // history wait is still observing it (correction R3-001). A FRESH
      // child may emit no unsolicited startup frames. One correlated native
      // state read bootstraps identity without a model prompt; its reply
      // triggers the existing once-only capabilities probe.
      if (this.sessionPath) {
        this.requestHistory();
      } else {
        this.requestState();
      }
    } catch (error) {
      this.surfaceError(toError(error));
    }
  }

  /** Sends `get_messages` with a fresh correlation id, tracked in
   * `pendingHistoryRequestId` so the matching response (handled in
   * `applyHistoryResponse`) can be told apart from any other response. */
  private requestHistory(): void {
    const id = `history-${this.historyRequestCounter++}`;
    this.pendingHistoryRequestId = id;
    this.send({ type: "get_messages", id });
  }

  /**
   * Sends `prompt` and appends the user's message to state immediately (no
   * round trip needed to show it). M1 keeps this simple with no queue: a
   * prompt sent while the assistant is still working is rejected outright
   * (no message appended, nothing written to stdin) instead of buffered.
   */
  prompt(text: string): PromptResult {
    if (this.state.working) {
      // Declined, not a failure: report once via the return value (and the
      // state push below, for anyone reading ChatState.lastError directly)
      // rather than also emitting an "error" event — ChatHost.sendMessage
      // (T5) resolves this PromptResult straight to the renderer instead
      // of rejecting, so a second report through onError would duplicate
      // the same message.
      const reason = "Gentle is still working";
      this.state = { ...this.state, lastError: reason };
      this.emit("state", this.state);
      return { queued: false, reason };
    }

    this.state = appendUserMessage(this.state, text);
    this.emit("state", this.state);
    this.send({ type: "prompt", message: text });
    return { queued: true };
  }

  abort(): void {
    this.send({ type: "abort" });
  }

  /** Answers a pending extension_ui_request dialog and drops it from `pendingDialogs`. */
  answerDialog(id: string, answer: DialogAnswer): void {
    this.state = {
      ...this.state,
      pendingDialogs: this.state.pendingDialogs.filter((dialog) => dialog.id !== id),
    };
    this.emit("state", this.state);

    if ("cancelled" in answer) {
      this.send({ type: "extension_ui_response", id, cancelled: true });
    } else if ("confirmed" in answer) {
      this.send({ type: "extension_ui_response", id, confirmed: answer.confirmed });
    } else {
      this.send({ type: "extension_ui_response", id, value: answer.value });
    }
  }

  /**
   * Probes the child's advertised surface ONCE per child via `capabilities`
   * (desktop-rpc T3 correction; S10: capabilities is the only support
   * probe) and adopts or closes the control channel accordingly:
   *
   *   - ok → `probeState` becomes "ok" and the first usage read goes out.
   *     Later usage reads are triggered by chat lifecycle (see
   *     requestUsage) — never a re-probe, never a timer.
   *   - failure (timeout, disposed, or a server error) → `probeState`
   *     becomes "failed" for the child's LIFETIME: no further control
   *     write of any kind, and `state.usageChannelUnavailable` tells the
   *     renderer to say the channel is unavailable (a distinct state from
   *     a provider's `pending`, which means the provider has not reported
   *     yet).
   *
   * Issued from three places, all lifecycle boundaries and none a timer
   * (desktop-workspace-registry-and-diagnostics T3):
   *
   *   1. a FRESH chat's first decoded stdout frame, normally the native
   *      bootstrap get_state reply. No unsolicited startup frame or settled
   *      model turn is required.
   *   2. a REOPENED chat's history response (correction R3-001): frames
   *      that arrive while the history request is still pending prove
   *      aliveness without proving the history exchange finished, so
   *      they do NOT probe — `get_messages` keeps its last-write position
   *      while ChatHost's bounded history wait is observing it.
   *   3. the first settled turn as the FALLBACK (agent_settled), for a
   *      child whose earlier frames never made it to a probe under the
   *      rules above.
   *
   * `probeState !== "idle"` makes repeat calls no-ops (the once-only
   * guard); a failed probe stays failed for the child's lifetime.
   */
  private probeChannel(): void {
    const rpc = this.rpcClient;
    if (!rpc || this.probeState !== "idle") return;
    this.probeState = "pending";
    void rpc.probe().then((capabilities) => {
      // A probe resolved after the child died (stop/exit disposes and
      // clears the client) settles as a failure for a session nobody is
      // using: never fold state for it.
      if (this.rpcClient !== rpc) return;
      if (capabilities) {
        this.advertisedMethods = new Set(capabilities.methods);
        this.probeState = "ok";
        this.state = this.attachStopChannel(this.state);
        this.emit("state", this.state);
        // Identity first, usage last: the usage read stays the child's last
        // control write, the ordering the T3 pins observe. The command list
        // is read once, right behind the identity (it is an ordinary RPC
        // command, so it must also stay ahead of that last widget write).
        this.requestIdentity();
        this.requestCatalog();
        this.requestVocabulary();
        this.requestWorkspace();
        this.requestWorktree();
        // The usage request stays the child's LAST control write (the T3
        // ordering pin): it upgrades to the forced refresh when the child
        // advertises the method, because the read alone can leave a
        // logged-in provider pending on a desktop child (see
        // requestUsageRefresh).
        if (this.advertisedMethods?.has("refresh_subscription_usage")) this.requestUsageRefresh();
        else this.requestUsage();
        this.requestAgentSnapshot();
      } else {
        this.probeState = "failed";
        this.state = { ...this.state, usageChannelUnavailable: true };
        this.state = this.attachStopChannel(this.state);
        this.emit("state", this.state);
      }
    });
  }

  /**
   * Reads the session identity from pi's own RPC commands (desktop-rpc T4):
   * `get_session_stats` for cost, tokens and context usage, `get_state` for
   * the effective model and thinking level. Both are ordinary commands
   * correlated by `id`, never desktop-rpc prompts. Refreshes are gated on
   * the adopted channel; the fresh-child bootstrap reuses only the state read.
   */
  private requestIdentity(): void {
    if (this.probeState !== "ok") return;
    const statsId = `stats-${this.identityRequestCounter++}`;
    this.pendingStatsRequestId = statsId;
    this.send({ type: "get_session_stats", id: statsId });
    this.requestState();
  }

  /** Native read: no model invocation or extension-channel dependency. */
  private requestState(): void {
    const stateId = `state-${this.identityRequestCounter++}`;
    this.pendingStateRequestId = stateId;
    this.send({ type: "get_state", id: stateId });
  }

  /**
   * Reads the chat's command catalog ONCE, right after the capabilities
   * probe adopts the channel (palette-host-catalog T1, S1) — the same
   * place the identity/vocabulary/workspace facts are read. Exactly one
   * of two sources is used, never both and never one completing the
   * other:
   *
   *   - the host advertises `get_snapshot` → ONE desktop-rpc request
   *     with `{ sections: ["commands"] }`; the answer's
   *     `state.session.commands` (`{ items, truncated }`) folds through
   *     the fail-closed parser (pi's builtins included), or
   *   - otherwise → pi's own `get_commands` (see `requestCommands`), the
   *     explicit degradation, whose entries are carried with
   *     `runnable: false` because pi's wire publishes no execution
   *     verdict (S1: never mix the two catalogs).
   *
   * The desktop-rpc answer binds on its request epoch and on this
   * session's client: a `session_unavailable`/failed/unusable answer
   * keeps whatever catalog the chat already had — never invents entries —
   * and a late answer for a replaced read never overwrites the current
   * one.
   */
  private requestCatalog(): void {
    const rpc = this.rpcClient;
    if (!rpc || this.probeState !== "ok") return;
    if (!this.advertisedMethods?.has("get_snapshot")) {
      this.requestCommands();
      return;
    }
    const epoch = ++this.catalogRequestEpoch;
    void rpc.request("get_snapshot", { sections: ["commands"] }).then((reply) => {
      if (this.rpcClient !== rpc || epoch !== this.catalogRequestEpoch) return;
      // A failed answer (session_unavailable among them) is still an
      // answer about the catalog, but a failed one is never a catalog:
      // keep whatever the chat already had, never an invented entry.
      if (!reply.ok) return;
      const session = isRecord(reply.data) ? reply.data.state : undefined;
      const sessionState = isRecord(session) ? session.session : undefined;
      const payload = isRecord(sessionState) ? sessionState.commands : undefined;
      const commands = parseCommandCatalog(payload);
      if (!commands) return;
      this.state = { ...this.state, commands };
      this.emit("state", this.state);
    });
  }

  /**
   * Asks the child for its slash commands ONCE (`get_commands`, desktop-
   * pending-work T6, S6) — the DEGRADED catalog source, used only while
   * the child does not advertise the host's `get_snapshot` (palette-
   * host-catalog S1). This is a pi-level RPC command, NOT a desktop-rpc
   * method: it goes through the same raw command writer and the same
   * id/correlation pattern as `get_session_stats`/`get_state`, with its
   * own counter and its own pending id. Gated on the adopted channel like
   * every other control write; a failed or malformed answer leaves the
   * list absent (the palette then offers nothing — never an invented
   * entry).
   */
  private requestCommands(): void {
    if (this.probeState !== "ok") return;
    const id = `commands-${this.commandsRequestCounter++}`;
    this.pendingCommandsRequestId = id;
    this.send({ type: "get_commands", id });
  }

  /**
   * Folds a `get_commands` reply — the DEGRADED catalog source (palette-
   * host-catalog S1) — once, and only when its `id` matches the request it
   * answers (a late or mismatched answer changes nothing). The parse is
   * fail-closed (S6): a malformed frame, a non-array `commands`, or an
   * entry without a non-empty string `name` contributes nothing, and an
   * unknown `source` is dropped rather than coerced — the stored list is
   * only ever what the child answered, never repaired or extended. Every
   * carried entry gets `runnable: false`: pi's own wire publishes no
   * execution verdict, and the palette must not guess one (S1: the two
   * catalogs are never mixed, so a fallback entry is never dispatched
   * through `run_command`).
   */
  private applyCommandsResponse(state: ChatState, response: RpcResponse): ChatState {
    // A reply that lands after the child exited belongs to a session nobody
    // is using: nothing may fold (the same live-child guard as identity).
    if (!this.process) return state;
    if (response.command !== "get_commands" || response.id !== this.pendingCommandsRequestId) return state;
    this.pendingCommandsRequestId = undefined;
    if (!response.success) return state;
    const commands = parseCommandList(response.data);
    if (!commands) return state;
    return { ...state, commands };
  }

  /**
   * Folds a session identity reply, once, and only when its `id` matches the
   * request it answers: a late reply for an older request is ignored, so it
   * cannot overwrite the current chat's identity. A failed or malformed reply
   * keeps the last-known identity — U3's rule is that unavailable is never
   * rendered as zero, and inventing a value is the same mistake with a
   * friendlier face.
   */
  private applyIdentityResponse(state: ChatState, response: RpcResponse): ChatState {
    // A reply that lands after the child exited belongs to a session nobody
    // is using: nothing may fold. `handleExit` clears `process`, which is the
    // live-child signal the other late-reply guards already rely on.
    if (!this.process) return state;
    if (response.command === "get_session_stats" && response.id === this.pendingStatsRequestId) {
      this.pendingStatsRequestId = undefined;
      if (!response.success) return state;
      const parsed = parseSessionStats(response.data);
      return parsed ? { ...state, session: { ...state.session, ...parsed } } : state;
    }
    if (response.command === "get_state" && response.id === this.pendingStateRequestId) {
      this.pendingStateRequestId = undefined;
      if (!response.success) return state;
      const parsed = parseSessionState(response.data);
      return parsed ? { ...state, session: { ...state.session, ...parsed } } : state;
    }
    return state;
  }

  /**
   * Reads the published action vocabulary (desktop-rpc T7b, S7) so the action
   * rows can show the SAME glyph the terminal shows. It rides the control
   * channel and is therefore gated like every other control write: no probe,
   * no advertisement of the method, no request. A failed read leaves the
   * vocabulary absent, and an absent vocabulary means raw tool names — never
   * a category the child does not publish.
   */
  private requestVocabulary(): void {
    const rpc = this.rpcClient;
    if (!rpc || this.probeState !== "ok") return;
    if (!this.advertisedMethods?.has("tool_vocabulary")) return;
    void rpc.request("tool_vocabulary").then(
      (reply) => {
        // A reply for a session nobody is using must not fold state.
        if (this.rpcClient !== rpc || !reply.ok) return;
        const vocabulary = parseToolVocabulary(reply.data);
        if (!vocabulary) return;
        this.state = { ...this.state, toolVocabulary: vocabulary };
        this.emit("state", this.state);
      },
      // A transport-level rejection (the child exiting between probe and reply
      // is the realistic case) must degrade to "vocabulary absent" — raw tool
      // names — and never surface as an unhandled rejection in the main
      // process (advisory R3-002).
      () => undefined,
    );
  }

  /**
   * Reads the footer's workspace facts (desktop-rpc T8): the MCP inventory and
   * the session-effective profile label. Both are parameterless; the worktree
   * group is NOT requested here because it needs the workspace root, which the
   * app does not track yet — that belongs to the workspaces unit (U6a), and
   * guessing a root would report someone else's tree.
   *
   * Each answer folds independently, so a missing MCP read never costs the
   * profile or the other way round. A failed or rejected read leaves that
   * field absent, and the footer renders nothing for it.
   */
  private requestWorkspace(): void {
    const rpc = this.rpcClient;
    if (!rpc || this.probeState !== "ok") return;
    const adopt = (method: "mcp_status" | "get_active_profile"): void => {
      if (!this.advertisedMethods?.has(method)) return;
      void rpc.request(method).then(
        (reply) => {
          if (this.rpcClient !== rpc || !reply.ok) return;
          const current = this.state.workspace ?? {};
          const next =
            method === "mcp_status"
              ? (() => {
                  const mcp = parseMcpStatus(reply.data);
                  return mcp ? { ...current, mcp } : undefined;
                })()
              : (() => {
                  const profile = parseActiveProfile(reply.data);
                  return profile ? { ...current, profile } : undefined;
                })();
          if (!next) return;
          this.state = { ...this.state, workspace: next };
          this.emit("state", this.state);
        },
        // A transport rejection degrades to "not supplied", never to an
        // unhandled rejection in the main process.
        () => undefined,
      );
    };
    adopt("mcp_status");
    adopt("get_active_profile");
  }

  /**
   * Reads the worktree's changed counts for THIS session's workspace root
   * (desktop-rpc T8b): `get_worktree_changes` takes `{ root }` and answers
   * with the branch, the changed files and the added/deleted line counts the
   * child itself measured. The root is this session's own `cwd` — the
   * directory the child actually runs in, the one the workspace unit gave
   * it. The child answers only for a root of its own session, and guessing
   * one would report someone else's tree (the T8 rule that parked this
   * until T11 supplied a root), so no root known means NO request at all.
   *
   * Gated like every other control write: no adopted channel, no
   * advertisement of `get_worktree_changes`, no request.
   *
   * Triggers — the same lifecycle boundaries the other stats refresh at,
   * never a timer: the probe's success and each settled turn (changes
   * happen during turns, so a settled turn is when the counts move).
   *
   * Binding: the answer folds only while it is BOTH the newest request's
   * answer (epoch) AND still this session's client — stop()/exit dispose
   * and clear the client, so a late answer for a replaced chat can never
   * overwrite the current footer. A refused or failed answer folds as
   * unavailable (never zeros, the T8 honesty rule); a malformed ok-reply
   * folds nothing, keeping the last-known counts.
   */
  private requestWorktree(): void {
    const rpc = this.rpcClient;
    if (!rpc || this.probeState !== "ok") return;
    const root = this.cwd;
    if (!root) return;
    if (!this.advertisedMethods?.has("get_worktree_changes")) return;
    const epoch = ++this.worktreeRequestEpoch;
    void rpc.request("get_worktree_changes", { root }).then(
      (reply) => {
        if (this.rpcClient !== rpc || epoch !== this.worktreeRequestEpoch) return;
        // A refused or failed answer is still an answer about this root:
        // fold it as unavailable so the footer says so instead of showing
        // the last-known counts as if they were current.
        const worktree = reply.ok ? parseWorktreeChanges(reply.data) : unavailableWorktreeChanges(root);
        if (!worktree) return;
        this.state = { ...this.state, workspace: { ...this.state.workspace, worktree } };
        this.emit("state", this.state);
      },
      // A transport rejection (the child exiting between request and reply
      // is the realistic case) must degrade to "not supplied" — never an
      // unhandled rejection in the main process.
      () => undefined,
    );
  }

  /**
   * Asks the child for its recorded subscription-usage snapshot
   * (`get_subscription_usage`, gentle-pi docs/desktop-rpc.md) and folds the
   * validated answer into `state.usage` (desktop-rpc T3).
   *
   * GATED on the channel probe: until `capabilities` has succeeded for the
   * live child this is a no-op that writes NOTHING to the child's stdin —
   * on a child without the bundled desktop extension a `/gentle:desktop`
   * prompt would fall through as an ordinary prompt (a model call and
   * transcript pollution).
   *
   * Refresh triggers — named, never a timer loop:
   *   1. the probe's success (the first read, right after adoption), and
   *   2. each settled turn (`agent_settled`, both chat kinds) — the
   *      meaningful lifecycle boundary where the provider's response
   *      headers may have recorded new windows. The `rate_limit` event is
   *      the live path between those points; the settled turn is the
   *      reconciliation point (a client that missed an event can reconcile
   *      from the response alone).
   *
   * Binding (U3): the answer folds only while it is BOTH the newest
   * request's answer (epoch) AND still this session's client — stop()/exit
   * dispose and clear the client, so a late answer for a replaced chat can
   * never overwrite the current one. A failed, unavailable, or malformed
   * reply leaves the previous state untouched: a pending provider stays
   * pending (it says so) and unavailable is never rendered as zero.
   */
  private requestUsage(): void {
    const rpc = this.rpcClient;
    if (!rpc || this.probeState !== "ok") return;
    const epoch = ++this.usageRequestEpoch;
    void rpc.request("get_subscription_usage", {}).then((reply) => {
      if (this.rpcClient !== rpc || epoch !== this.usageRequestEpoch) return;
      if (!reply.ok) return;
      const usage = parseSubscriptionUsage(reply.data);
      if (!usage) return;
      // The read IS the whole current scope: replace state wholesale.
      this.state = { ...this.state, usage };
      this.emit("state", this.state);
    });
  }

  /**
   * Forces the child to re-fetch its subscription usage and folds the
   * validated answer into `state.usage` (`refresh_subscription_usage`,
   * docs/desktop-rpc.md "refresh_subscription_usage").
   *
   * Why it exists: the child's own start-up usage fetch is TUI-gated (it
   * only runs when the child has a UI), so a desktop child — probed here
   * through the control channel, no TUI of its own — never fetches on its
   * own. The plain read (`get_subscription_usage`) is a PURE READ of the
   * snapshots the child already recorded in memory and can therefore leave
   * a provider with a valid oauth login pending until its first settled
   * turn; the refresh delegates to the child's same auth/fetch path as the
   * panel (no second fetcher, no auth access from here).
   *
   * It mirrors `requestUsage` exactly — the same capabilities gate, the
   * same `usageRequestEpoch` binding (a refresh answer folds only while it
   * is BOTH the newest usage request's answer AND still this session's
   * client, so a late refresh can never overwrite a newer read) — with the
   * one difference that the reply is the WHOLE current scope again (the
   * post-refresh `providers`, in the read shape): it replaces state
   * wholesale, exactly like the read.
   */
  private requestUsageRefresh(): void {
    const rpc = this.rpcClient;
    if (!rpc || this.probeState !== "ok") return;
    const epoch = ++this.usageRequestEpoch;
    void rpc.request("refresh_subscription_usage", {}).then((reply) => {
      if (this.rpcClient !== rpc || epoch !== this.usageRequestEpoch) return;
      if (!reply.ok) return;
      const usage = parseSubscriptionUsage(reply.data);
      if (!usage) return;
      // The refresh reply IS the whole current scope: replace state wholesale.
      this.state = { ...this.state, usage };
      this.emit("state", this.state);
    });
  }

  /**
   * The Stop control's channel state for the chat's live child
   * (desktop-rpc T6), derived from the same capabilities gate as every
   * other control write (S10: the probe is the only support probe):
   *
   *   - unprobed → `undefined`: the renderer keeps Stop disabled without
   *     claiming anything about a channel that has not been checked yet.
   *   - probe failed → unavailable with the honest reason, the same
   *     pattern as the usage surface's channel-unavailable note.
   *   - probe ok → available only while the child actually advertised
   *     `cancel_subagent`; a channel without the method cannot stop a
   *     helper and says so instead of pretending otherwise.
   */
  private stopChannelState(): StopChannelState | undefined {
    if (this.probeState === "failed") {
      return { available: false, reason: "Channel unavailable — this child has no desktop control channel, so helpers cannot be stopped." };
    }
    if (this.probeState === "ok") {
      return this.advertisedMethods?.has("cancel_subagent")
        ? { available: true }
        : { available: false, reason: "gentle-shell does not advertise cancel_subagent on this child's control channel, so helpers cannot be stopped from here." };
    }
    return undefined;
  }

  /** Attaches the current Stop channel state to the helpers slice when it
   * differs from what is already there (the chat reducer's setWidget arm
   * rebuilds the helpers object without it, so every fold re-attaches). */
  private attachStopChannel(state: ChatState): ChatState {
    const stopChannel = this.stopChannelState();
    if (!stopChannel) return state;
    const current = state.helpers.stopChannel;
    if (current?.available === stopChannel.available && current?.reason === stopChannel.reason) return state;
    return { ...state, helpers: { ...state.helpers, stopChannel } };
  }

  /**
   * Re-applies the authoritative subagents projection and the Stop
   * channel state onto the helpers slice after a fold. The chat reducer's
   * setWidget arm replaces the helpers object wholesale from the activity
   * frame (the narrative publisher), which would drop both the projection
   * and the channel state — the projection (helpers.agents) is
   * re-overlaid onto the fresh tasks so an activity frame can never
   * regress the structured state an `agents_update` already reported
   * (desktop-rpc T6: the RPC slice owns state, the activity path
   * narrates).
   */
  private settleHelpers(state: ChatState, now: string): ChatState {
    const helpers = state.helpers;
    let nextHelpers: HelpersActivity = helpers.agents ? applyAgentState(helpers, helpers.agents, now) : helpers;
    const stopChannel = this.stopChannelState();
    if (stopChannel) {
      const current = nextHelpers.stopChannel;
      if (current?.available !== stopChannel.available || current?.reason !== stopChannel.reason) {
        nextHelpers = { ...nextHelpers, stopChannel };
      }
    }
    if (nextHelpers === helpers) return state;
    return { ...state, helpers: nextHelpers };
  }

  /**
   * Asks the child for its live subagent list ONCE (`list_subagents`,
   * gentle-pi docs/desktop-rpc.md) right after the capabilities probe
   * adopts the channel (desktop-rpc T6), and folds the validated answer
   * into `state.helpers` — the authoritative initial state for helpers
   * that ran before this chat was opened or before any activity frame
   * arrived. Gated on the probe AND on the child advertising the method;
   * a late answer after an `agents_update` event already folded is
   * dropped (events own the truth from then on), and a failed or
   * malformed reply keeps the previous state.
   */
  private requestAgentSnapshot(): void {
    const rpc = this.rpcClient;
    if (!rpc || this.probeState !== "ok" || !this.advertisedMethods?.has("list_subagents")) return;
    void rpc.request("list_subagents", {}).then((reply) => {
      if (this.rpcClient !== rpc || this.agentsEventSeen) return;
      if (!reply.ok) return;
      const agents = parseAgentList(reply.data);
      if (!agents) return;
      this.foldAgentList(agents);
    });
  }

  /** Folds a full projection list (snapshot or event) into the helpers slice. */
  private foldAgentList(agents: HelperAgentState[]): void {
    const now = new Date().toISOString();
    this.state = { ...this.state, helpers: applyAgentState(this.state.helpers, agents, now) };
    this.emit("state", this.state);
  }

  /** Folds one post-action `cancel_subagent` entry: merged into the authoritative projection list by id, then overlaid onto the tasks. */
  private foldAgentEntry(agent: HelperAgentState): void {
    const now = new Date().toISOString();
    this.state = {
      ...this.state,
      helpers: applyAgentState(this.state.helpers, mergeAgentEntry(this.state.helpers.agents, agent), now),
    };
    this.emit("state", this.state);
  }

  /**
   * Asks the child to stop one helper through gentle-pi's desktop-rpc
   * `cancel_subagent` — the owner's own stop path, never a request to the
   * model (desktop-rpc T6). Gated on the adopted channel and the child
   * advertising the method.
   *
   * Cancellation is ASYNCHRONOUS: the response is the owner's
   * post-action re-read, so for a running helper it reports the
   * still-running state and the real transition arrives later as an
   * `agents_update` event — the response is folded (it is the owner's
   * truth) but never interpreted as "stopped". An unknown or foreign id
   * is the wire's typed `not_found` and resolves `not_tracked` without
   * surfacing an error the user cannot act on; every other failure
   * resolves `unavailable`. Never throws.
   */
  async cancelHelper(id: string): Promise<StopHelperOutcome> {
    const rpc = this.rpcClient;
    if (!rpc || this.probeState !== "ok" || !this.advertisedMethods?.has("cancel_subagent")) {
      return STOP_HELPER_OUTCOME.UNAVAILABLE;
    }
    const reply = await rpc.request("cancel_subagent", { id });
    if (this.rpcClient !== rpc) return STOP_HELPER_OUTCOME.UNAVAILABLE;
    if (!reply.ok) {
      return reply.error.kind === "server_error" && reply.error.code === "not_found"
        ? STOP_HELPER_OUTCOME.NOT_TRACKED
        : STOP_HELPER_OUTCOME.UNAVAILABLE;
    }
    const agent = parseAgentEntry(reply.data);
    if (agent) this.foldAgentEntry(agent);
    return STOP_HELPER_OUTCOME.REQUESTED;
  }

  /**
   * Runs one command from the chat's catalog through the host's desktop-rpc
   * `run_command` (palette-host-catalog T3, S4) — the ONE execution path for
   * a runnable row. Gated like every other control write: no adopted
   * channel or no `run_command` advertisement answers an honest transport
   * result instead of writing to the child. The wire's answer set is closed
   * and a refusal is a SUCCESS response; the retryable
   * `session_switching` error and any other failure map into the result
   * type without ever throwing.
   */
  async runCommand(name: string, args?: string): Promise<ChatCommandRunResult> {
    const rpc = this.rpcClient;
    if (!rpc || this.probeState !== "ok") {
      return { kind: "transport", message: "The desktop control channel is unavailable — this child has no adopted control channel." };
    }
    if (!this.advertisedMethods?.has("run_command")) {
      return { kind: "transport", message: "gentle-shell does not advertise run_command on this child's control channel, so catalog commands cannot run from here." };
    }
    const reply = await rpc.request("run_command", args === undefined ? { name } : { name, args });
    // A session replaced mid-flight (stop/exit disposes and clears the
    // client): nobody is using this answer any more.
    if (this.rpcClient !== rpc) {
      return { kind: "transport", message: "The chat was replaced while the command was in flight." };
    }
    if (!reply.ok) {
      if (reply.error.kind === "server_error" && reply.error.code === "session_switching") {
        return { kind: "session_switching" };
      }
      const detail = reply.error.kind === "server_error" ? reply.error.message : reply.error.detail;
      return { kind: "transport", message: detail ?? `The host did not answer run_command (${reply.error.kind}).` };
    }
    if (isRecord(reply.data) && reply.data.executed === true) {
      // palette-command-arguments T5: the names the argument screens dispatch
      // change what the identity reads report — the effective model, the
      // thinking level, the session name. The child applies the change and
      // publishes it on its own schedule, so without this read the footer kept
      // the OLD model and level until the next settled turn happened to re-read
      // them (the owner saw it update only after a first interaction).
      if (name === "model" || name === "thinking" || name === "name") this.requestIdentity();
      return { kind: "executed" };
    }
    if (
      isRecord(reply.data) &&
      reply.data.executed === false &&
      (reply.data.reason === "terminal_only" || reply.data.reason === "unknown_command")
    ) {
      return { kind: "refused", reason: reply.data.reason };
    }
    return { kind: "transport", message: "The host answered run_command with an unusable payload." };
  }

  /** Asks the child for its REAL available-model snapshot (palette-
   * command-arguments T1, S2) through pi's own correlated
   * `get_available_models` RPC command — an ordinary command by id, never
   * a /gentle:desktop prompt, gated on the adopted control channel like
   * every other write. Resolves an AvailableModelsResult — the bounded
   * answer, `unsupported` (no adopted channel, or the child refused the
   * command), or `failed` (unanswered past the bound, the chat was
   * replaced, or a malformed success payload) — instead of throwing. The
   * list is bounded at MAX_AVAILABLE_MODELS with truncation flagged, and
   * a model with no usable display name renders as `provider/id`. */
  async availableModels(): Promise<AvailableModelsResult> {
    const outcome = await this.childQuery("get_available_models", `models-${this.modelsRequestCounter++}`);
    if (outcome.kind !== "answered") return outcome.kind === "lost" ? { kind: "failed" } : { kind: "unsupported" };
    if (!outcome.response.success) return { kind: "unsupported" };
    const parsed = parseAvailableModels(outcome.response.data);
    if (!parsed) return { kind: "failed" };
    return { kind: "ok", models: parsed.models, truncated: parsed.truncated };
  }

  /** Asks the child for its available thinking levels (palette-command-
   * arguments T1, S3) through pi's own correlated
   * `get_available_thinking_levels` RPC command — the same gating and
   * correlation as availableModels, with its own counter so a late models
   * reply can never settle a levels read. Levels outside the closed
   * THINKING_LEVEL union are DROPPED, never coerced (the fail-closed rule
   * the command catalog applies). */
  async availableThinkingLevels(): Promise<AvailableThinkingLevelsResult> {
    const outcome = await this.childQuery("get_available_thinking_levels", `levels-${this.levelsRequestCounter++}`);
    if (outcome.kind !== "answered") return outcome.kind === "lost" ? { kind: "failed" } : { kind: "unsupported" };
    if (!outcome.response.success) return { kind: "unsupported" };
    const levels = parseAvailableThinkingLevels(outcome.response.data);
    if (!levels) return { kind: "failed" };
    return { kind: "ok", levels };
  }

  /** The one on-demand correlated read (palette-command-arguments T1):
   * gated on the adopted channel and a live child (the same discipline
   * the neighbouring readers apply — before the probe is ok NOTHING is
   * written), sent with the caller's fresh correlation id, and awaited
   * until its matching `response` frame, the deadline, or the session's
   * end settles it. Never throws. */
  private childQuery(command: "get_available_models" | "get_available_thinking_levels", id: string): Promise<ChildQueryOutcome> {
    if (!this.process || this.stopping || this.probeState !== "ok") {
      return Promise.resolve({ kind: "unsupported" });
    }
    return new Promise<ChildQueryOutcome>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (response: RpcResponse | undefined): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.childQueryWaiters.delete(id);
        resolve(response === undefined ? { kind: "lost" } : { kind: "answered", response });
      };
      timer = setTimeout(() => finish(undefined), CHILD_QUERY_TIMEOUT_MS);
      this.childQueryWaiters.set(id, { command, settle: finish });
      this.send({ type: command, id });
    });
  }

  /** Settles the on-demand read whose correlated `response` frame this is
   * (palette-command-arguments T1): a frame whose id no pending waiter
   * holds — a stale, duplicate or unrelated reply — changes nothing, and
   * a frame that arrives after the child exited belongs to a session
   * nobody is using (the same live-child guard the other folds apply).
   * Never folds state: these reads answer their caller, not the reducer. */
  private settleChildQueries(response: RpcResponse): void {
    if (!this.process) return;
    const waiter = this.childQueryWaiters.get(response.id ?? "");
    if (!waiter || waiter.command !== response.command) return;
    waiter.settle(response);
  }

  /** Settles every pending on-demand child read as unanswered: the child
   * that would answer is gone (stop or exit), so a session nobody is
   * using can never satisfy a caller still awaiting its answer. */
  private settleLostChildQueries(): void {
    const waiters = [...this.childQueryWaiters.values()];
    this.childQueryWaiters.clear();
    for (const waiter of waiters) waiter.settle(undefined);
  }

  getState(): ChatState {
    return this.state;
  }

  /**
   * The desktop-rpc control-plane client for this session, bound to the
   * spawned child's stdin in start(). Undefined until the child is spawned
   * (the `send` function only exists then) and cleared again on stop/exit,
   * so a caller never writes into a dead child. Requests sent through it
   * are control traffic: a `/gentle:desktop` prompt that never touches
   * prompt()'s user-prompt working guard, whose response is never treated
   * as the domain answer (odd/tasks/desktop-rpc-client.md S10/S11).
   */
  get desktopRpc(): DesktopRpcClient | undefined {
    return this.rpcClient;
  }

  /** Graceful shutdown: close stdin, wait up to 3s for exit, then kill. */
  async stop(): Promise<void> {
    const proc = this.process;
    this.rpcClient?.dispose();
    this.rpcClient = undefined;
    this.settleLostChildQueries();
    if (!proc) return;

    this.stopping = true;
    proc.endStdin();

    const timedOut = Symbol("stop-timeout");
    const outcome = await Promise.race([
      proc.exited.then(() => "exited" as const),
      new Promise<typeof timedOut>((resolve) => {
        setTimeout(() => resolve(timedOut), STOP_GRACE_PERIOD_MS);
      }),
    ]);

    if (outcome === timedOut) {
      proc.kill();
      await proc.exited.catch(() => undefined);
    }

    this.process = undefined;
  }

  private send(command: RpcCommand): void {
    if (!this.process || this.stopping) {
      this.surfaceError(new Error("PiSession: cannot send a command (no active process)"));
      return;
    }
    this.process.writeStdin(encodeCommand(command));
  }

  private handleLine(line: string): void {
    try {
      const decoded = decodeLine(line);
      if ("kind" in decoded) return; // unknown/unmodeled line: nothing to fold or emit

      // The first decoded frame (including the native bootstrap reply)
      // proves aliveness without waiting for a model turn. While a reopened chat's
      // history request is still pending the probe waits for its response
      // instead (correction R3-001). `probeChannel` no-ops once it has
      // started or failed, so later frames never re-probe.
      if (this.process && this.probeState === "idle" && this.pendingHistoryRequestId === undefined) {
        this.probeChannel();
      }

      // The desktop-rpc control channel answers on a `gentle-desktop-rpc`
      // setWidget frame (S10/S11): feed the client and stop — this frame
      // is never chat state, so reduceChat must not see it. Any other
      // widgetKey keeps the ordinary path (helpers folding, etc.) below.
      if (
        decoded.type === "extension_ui_request" &&
        decoded.method === "setWidget" &&
        typeof decoded.widgetKey === "string" &&
        decoded.widgetKey === DESKTOP_RPC_WIDGET_KEY
      ) {
        const widgetLines = Array.isArray(decoded.widgetLines) ? (decoded.widgetLines as readonly string[]) : undefined;
        // The `rate_limit` event is the usage meters' LIVE update path
        // (T3, docs/desktop-rpc.md "rate_limit"): it arrives unsolicited
        // on this same widget channel — without a requestId, so it never
        // settles a pending request — and carries the changed snapshots.
        // They merge into this chat's own usage state (never another
        // session's: this fold reads this.state only), and only while the
        // session is still live (a frame that arrives after exit belongs
        // to a chat nobody is looking at).
        const frame = parseDesktopRpcWidget(decoded.widgetKey, widgetLines);
        // The `agents_update` event is the subagents slice's LIVE update
        // path (desktop-rpc T6, docs/desktop-rpc.md "agents_update"): the
        // full bounded projection of the active session's helpers, emitted
        // for every real TaskStore transition — not only Desktop-initiated
        // ones. It carries no requestId (events never settle requests) and
        // folds into the helpers slice like the snapshot does.
        if (frame?.kind === "event" && frame.event === "agents_update" && this.rpcClient) {
          const agents = parseAgentList(frame.data);
          if (agents) {
            this.agentsEventSeen = true;
            this.foldAgentList(agents);
          }
        }
        if (frame?.kind === "event" && frame.event === "rate_limit" && this.rpcClient) {
          const event = parseRateLimitEvent(frame.data);
          if (event) {
            this.state = { ...this.state, usage: mergeUsageProviders(this.state.usage, event.providers) };
            this.emit("state", this.state);
          }
        }
        // The `session_state_changed` event is the ODD phase indicator's
        // ONLY data path (desktop-pending-work T5, S5): a READ of what the
        // child published on this same widget channel — never inferred from
        // transcript text, never derived from a tool name. It carries no
        // requestId (events never settle requests) and folds through the
        // ordinary reducer arm, which validates the closed token set and
        // implements the owner's clear (the field omitted from `data` →
        // absent). Nothing changed means nothing is pushed.
        if (frame?.kind === "event" && frame.event === "session_state_changed" && this.rpcClient) {
          const data = isRecord(frame.data) ? frame.data : {};
          const event: RpcEvent = "oddPhase" in data ? { type: "session_state_changed", oddPhase: data.oddPhase } : { type: "session_state_changed" };
          const next = reduceChat(this.state, event);
          if (next !== this.state) {
            this.state = next;
            this.emit("state", this.state);
          }
        }
        this.rpcClient?.handleWidget(decoded.widgetKey, widgetLines);
        this.emit("event", decoded);
        return;
      }

      // `now` feeds reduceChat's setWidget helpers-retention fallback
      // (endedAt for a task gentle-pi drops after it finishes) and the
      // subagents overlay's terminal-time fill; PiSession is the impure
      // boundary, reduceChat itself stays pure.
      const now = new Date().toISOString();
      this.state = reduceChat(this.state, decoded, now);
      // desktop-rpc T3 (correction): a settled turn is a refresh trigger
      // for BOTH chat kinds — but only the probe has adopted the channel;
      // otherwise the FIRST settled turn carries the one capabilities
      // probe (a no-op once probed, pending, or failed).
      if (decoded.type === "agent_settled") {
        if (this.probeState === "ok") {
          this.requestIdentity();
          this.requestWorktree();
          this.requestUsage();
        } else this.probeChannel();
      }
      // The activity path narrates but must never regress the structured
      // state the subagents projection already reported, and the Stop
      // channel state must survive the reducer's wholesale helpers
      // replacement (desktop-rpc T6, see settleHelpers).
      this.state = this.settleHelpers(this.state, now);
      // reduceChat's "response" arm folds only a FAILED prompt response
      // (the child's own reason a turn could not run, S5); the id-
      // correlated folds below own every other response and keep priority
      // over it, so folding the get_messages history response in here,
      // right after, never fights it.
      if (decoded.type === "response") {
        const historyWasPending = this.pendingHistoryRequestId !== undefined;
        this.state = this.applyHistoryResponse(this.state, decoded);
        this.state = this.applyIdentityResponse(this.state, decoded);
        this.state = this.applyCommandsResponse(this.state, decoded);
        // The on-demand correlated reads (palette-command-arguments T1)
        // settle from the same frame — they answer their caller instead of
        // folding state.
        this.settleChildQueries(decoded);
        // Correction R3-001: the reopened chat's capabilities probe is
        // issued HERE, after the history response has landed, so the
        // child's writes are [get_messages, probe] and its last write is
        // never taken away from the bounded history wait. `probeChannel`
        // no-ops once it has started or failed, and a child that never
        // answers history still probes at its first settled turn.
        if (historyWasPending && this.pendingHistoryRequestId === undefined) this.probeChannel();
      }
      this.emit("event", decoded);
      this.emit("state", this.state);
    } catch (error) {
      this.surfaceError(toError(error));
    }
  }

  /**
   * Folds the `get_messages` history response into `state.messages`, once:
   * a response for any other command, or one whose `id` does not match
   * `pendingHistoryRequestId` (stale or unrelated), is ignored outright.
   * Never throws: a failed response surfaces as `lastError` instead of an
   * empty thread with no explanation.
   *
   * This is the INITIAL load's fold (start()'s first read of a reopened
   * session), and it keeps every live-rows guard: a live prompt's message,
   * todo panel or tool row is never clobbered by the answer that fills the
   * empty slots around it. `new`/`resume` do not run through here at all —
   * the desktop routes them through its own chat-open/new-chat session
   * paths (the session-replacement reflection was withdrawn; see
   * odd/tasks/session-replacement-reflection.md).
   */
  private applyHistoryResponse(state: ChatState, response: RpcResponse): ChatState {
    if (response.command !== "get_messages" || response.id !== this.pendingHistoryRequestId) return state;
    this.pendingHistoryRequestId = undefined;

    if (!response.success) {
      return { ...state, lastError: "Could not load this chat's history" };
    }

    const history = extractHistoryMessages(response.data);
    // The ODD task panel state is recovered from the same history (S4):
    // gentle-todo persisted its snapshot in the session file, so a reopened
    // chat gets it without any live event. A live `gentle-todo-state` event
    // that already landed while the history request was in flight is always
    // the newer snapshot, so it wins and the older snapshot in the response
    // only fills the panel when nothing live has arrived yet — mirroring the
    // live-messages rule below, which history must never clobber either.
    const answerTodo = extractTodoPanel(history);
    const todo = state.todo ?? answerTodo;
    // Tool-call detail recovery (desktop-pending-work T7, S7): a reopened
    // chat's rows are rebuilt from the same history, so args/result/error
    // survive a reload. Recovery happens ONLY while the state has no live
    // rows yet (`toolCalls` absent or empty, S5): a live row that arrived
    // while the history answer was in flight always wins — no recovered row
    // is ever written over one (the reducer, not this code, folds later
    // live events: a duplicate start is skipped and an end replaces by id).
    // An empty recovery leaves `toolCalls` absent on the initial load,
    // exactly as it was.
    const recoveredToolCalls = historyToToolCalls(history);
    let toolCalls: typeof recoveredToolCalls | undefined;
    if (state.toolCalls && state.toolCalls.length > 0) {
      toolCalls = undefined; // live rows already present: nothing is recovered over them
    } else if (recoveredToolCalls.length > 0) {
      toolCalls = recoveredToolCalls;
    } else {
      toolCalls = undefined;
    }
    // Never clobber messages a live prompt already appended while the
    // history request was still in flight — the live-rows guard (S5).
    if (state.messages.length > 0) return toolCalls ? { ...state, todo, toolCalls } : { ...state, todo };

    return toolCalls
      ? { ...state, messages: historyToMessages(history), todo, toolCalls }
      : { ...state, messages: historyToMessages(history), todo };
  }

  /**
   * Child stderr is diagnostics/warnings, not by itself evidence of a
   * failure (pi logs there routinely) — route it to the injectable logger
   * instead of surfacing it as `lastError`, which previously made routine
   * stderr output look like a fatal error to the UI.
   */
  private handleStderrLine(line: string): void {
    if (line.trim().length === 0) return;
    this.onLog(line);
  }

  /**
   * Clears `this.process` unconditionally so the next `send()` never
   * writes to a dead child's stdin (R4-001), whether the exit was clean,
   * a crash, or a spawn failure. ANY exit not requested via `stop()` —
   * including a clean `code === 0` self-exit — resets `working` and drops
   * any pending dialogs: the child that would have resolved them is gone
   * either way, so a stale "working" pill or an unanswerable dialog card
   * would otherwise strand the UI regardless of how the child exited. An
   * error is only surfaced for a non-zero exit: a spawn failure already
   * surfaced its real error via `onError` (not re-reported here), and a
   * clean self-exit is not, by itself, evidence of a failure.
   */
  private handleExit(code: number | null, signal: NodeJS.Signals | null, spawnError?: Error): void {
    this.rpcClient?.dispose();
    this.rpcClient = undefined;
    this.process = undefined;
    this.settleLostChildQueries();
    if (this.stopping) return;

    this.state = { ...this.state, working: false, pendingDialogs: [] };

    if (spawnError) {
      this.emit("state", this.state);
      return;
    }
    if (code !== 0) {
      this.surfaceError(new Error(`gentle-shell exited unexpectedly (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})`));
      return;
    }
    this.emit("state", this.state);
  }

  private surfaceError(error: Error): void {
    this.state = { ...this.state, lastError: error.message };
    this.emit("error", error);
    this.emit("state", this.state);
  }
}

/**
 * Folds a `get_commands` answer's command list — the DEGRADED catalog
 * source (palette-host-catalog S1) — fail-closed (desktop-pending-work
 * T6, S6): a non-record payload or a non-array `commands` yields
 * `undefined` (nothing folds), and an entry without a non-empty string
 * `name`, with an unknown `source`, or with a non-string `description`
 * contributes nothing, folding through the SAME closed source allow-list
 * the host catalog parser owns (`CATALOG_SOURCES`). The order is the
 * child's and is kept; `sourceInfo` and any argument hint on the wire are
 * NOT carried (there is no argument hint on this wire, and none may be
 * invented). Every carried entry gets `runnable: false`: this wire
 * publishes no execution verdict, so the palette must not guess one (S1).
 */
function parseCommandList(data: unknown): readonly ChatCommand[] | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const raw = (data as { commands?: unknown }).commands;
  if (!Array.isArray(raw)) return undefined;
  const commands: ChatCommand[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, description, source } = entry as Record<string, unknown>;
    if (typeof name !== "string" || name.length === 0) continue;
    if (typeof description !== "undefined" && typeof description !== "string") continue;
    if (typeof source !== "string" || !CATALOG_SOURCES.has(source)) continue;
    commands.push(
      description === undefined
        ? { name, runnable: false, source: source as ChatCommandSource }
        : { name, description, runnable: false, source: source as ChatCommandSource },
    );
  }
  return commands;
}

function appendUserMessage(state: ChatState, text: string): ChatState {
  const message: ChatMessage = { id: `msg-${state.messages.length}`, role: MESSAGE_ROLE.USER, text };
  return { ...state, messages: [...state.messages, message] };
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
