import {
  MESSAGE_ROLE,
  type ChatMessage,
  type ChatState,
  type DialogAnswer,
  type PromptResult,
} from "@shared/bridge-types";
import { INITIAL_CHAT_STATE, reduceChat } from "../rpc/chatReducer";
import { decodeLine, encodeCommand } from "../rpc/codec";
import { DESKTOP_RPC_WIDGET_KEY, DesktopRpcClient, parseDesktopRpcWidget } from "../rpc/desktopRpc";
import { mergeUsageProviders, parseRateLimitEvent, parseSubscriptionUsage } from "../rpc/usage";
import { extractHistoryMessages, historyToMessages } from "../rpc/history";
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
  private stopping = false;
  private rpcClient: DesktopRpcClient | undefined;
  private historyRequestCounter = 0;
  /** Counts the subscription-usage requests this session has sent (T3).
   * A usage reply folds only while it is the NEWEST request's answer: a
   * late answer for an older request (out-of-order reconciliation, or an
   * answer that arrives after the chat was replaced) must never overwrite
   * the current usage. */
  private usageRequestEpoch = 0;
  /** The desktop control channel's adoption state for THIS child's
   * lifetime (T3 correction). S10: `capabilities` is the only support
   * probe — until it succeeds for the live child, NOTHING is written to
   * the child's stdin on our initiative, because on a child without the
   * bundled desktop extension a `/gentle:desktop {…}` prompt is an
   * unregistered slash string that would fall through as an ordinary
   * prompt (a model call and transcript pollution). Failed stays failed
   * for the child's lifetime; no re-probe, no timer. */
  private probeState: "idle" | "pending" | "ok" | "failed" = "idle";
  /** Set right after a `get_messages` history request is sent (reopening a
   * session with a `sessionPath`); cleared once its matching response
   * arrives. Lets `applyHistoryResponse` correlate the response by `id`
   * and ignore anything else that happens to carry `command: "get_messages"`
   * (a stale or unrelated response). */
  private pendingHistoryRequestId: string | undefined;

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
      // chat stays silent on stdin until the user acts
      // (ChatHost.test.ts pins that contract); its first control write is
      // the probe at its first settled turn (agent_settled, below), and
      // the `rate_limit` event is the live usage path before that — a
      // provider's first response records windows and pushes them without
      // any request. See probeChannel/requestUsage for the full trigger
      // set (never a timer).
      if (this.sessionPath) {
        this.requestHistory();
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
   * Issued from exactly two places, both lifecycle boundaries and neither
   * a timer: a REOPENED chat's start (before the history request, so
   * `get_messages` stays the child's last write), and a FRESH chat's
   * first settled turn (its start stays stdin-silent — ChatHost.test.ts
   * pins that). `probeState !== "idle"` makes repeat calls no-ops.
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
        this.probeState = "ok";
        this.requestUsage();
      } else {
        this.probeState = "failed";
        this.state = { ...this.state, usageChannelUnavailable: true };
        this.emit("state", this.state);
      }
    });
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
        if (frame?.kind === "event" && frame.event === "rate_limit" && this.rpcClient) {
          const event = parseRateLimitEvent(frame.data);
          if (event) {
            this.state = { ...this.state, usage: mergeUsageProviders(this.state.usage, event.providers) };
            this.emit("state", this.state);
          }
        }
        this.rpcClient?.handleWidget(decoded.widgetKey, widgetLines);
        this.emit("event", decoded);
        return;
      }

      // `now` feeds reduceChat's setWidget helpers-retention fallback
      // (endedAt for a task gentle-pi drops after it finishes); PiSession
      // is the impure boundary, reduceChat itself stays pure.
      this.state = reduceChat(this.state, decoded, new Date().toISOString());
      // desktop-rpc T3 (correction): a settled turn is a refresh trigger
      // for BOTH chat kinds — but only the probe has adopted the channel;
      // otherwise the FIRST settled turn carries the one capabilities
      // probe (a no-op once probed, pending, or failed).
      if (decoded.type === "agent_settled") {
        if (this.probeState === "ok") this.requestUsage();
        else this.probeChannel();
      }
      // reduceChat has no case for "response" (its default arm returns
      // state unchanged), so folding the get_messages history response in
      // here, right after, never fights it.
      if (decoded.type === "response") {
        const historyWasPending = this.pendingHistoryRequestId !== undefined;
        this.state = this.applyHistoryResponse(this.state, decoded);
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
    const todo = state.todo ?? extractTodoPanel(history);
    // Never clobber messages a live prompt already appended while the
    // history request was still in flight.
    if (state.messages.length > 0) return { ...state, todo };

    return { ...state, messages: historyToMessages(history), todo };
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

function appendUserMessage(state: ChatState, text: string): ChatState {
  const message: ChatMessage = { id: `msg-${state.messages.length}`, role: MESSAGE_ROLE.USER, text };
  return { ...state, messages: [...state.messages, message] };
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
