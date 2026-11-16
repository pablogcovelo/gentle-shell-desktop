import {
  HELPER_STATUS,
  MESSAGE_ROLE,
  NOTIFICATION_SEVERITY,
  ODD_PHASE,
  type ChatMessage,
  type ChatNotification,
  type ChatState,
  type Dialog,
  type HelperTask,
  type HelpersActivity,
  type OddPhase,
  type ToolCallView,
  type NotificationSeverity,
} from "@shared/bridge-types";
import { emptyHelpersActivity, parseHelpersActivity } from "./helpersActivity";
import { TODO_STATE_CUSTOM_TYPE, parseTodoPanel } from "./todoPanel";
import type { AssistantMessageEvent, FireAndForgetMethod, RpcEvent, RpcExtensionUIRequest, RpcMessage } from "./types";

/**
 * The generic fire-and-forget branch of RpcExtensionUIRequest (setWidget,
 * setTitle, set_editor_text): decoded by spread, so its extra fields are
 * only known through the index signature. notify and setStatus are decoded
 * as exact members (see types.ts) and handled by their own cases in
 * applyExtensionUIRequest below — which is why they are excluded here.
 */
type GenericFireAndForgetUIRequest = {
  readonly type: "extension_ui_request";
  readonly id: string;
  readonly method: FireAndForgetMethod;
  readonly [key: string]: unknown;
};

const NOTIFICATION_SEVERITIES: ReadonlySet<string> = new Set<string>(Object.values(NOTIFICATION_SEVERITY));

/** The closed token set the `session_state_changed` reducer arm validates
 * `oddPhase` against (desktop-pending-work T5, S5): anything outside it is
 * dropped, never coerced into one of the eight. */
const ODD_PHASE_TOKENS: ReadonlySet<string> = new Set<string>(Object.values(ODD_PHASE));

function isOddPhaseToken(value: unknown): value is OddPhase {
  return typeof value === "string" && ODD_PHASE_TOKENS.has(value);
}

/**
 * How many notifications ChatState retains (desktop-rpc T2b). Chosen as a
 * small constant: ten rows is enough recent feedback to scan in the
 * renderer's transient stack, while the array cloned into every pushed
 * ChatState — which the renderer receives on every event — stays O(1)-size
 * regardless of how many notifications a child publishes. Independent
 * verification measured the unbounded list at 82 ms for 10k notifications
 * and 5248 ms for 40k, paid repeatedly on every event.
 */
export const MAX_NOTIFICATIONS = 10;

/** How many tool executions the detail list retains (desktop-rpc T7). Same
 * reasoning as MAX_NOTIFICATIONS: enough to see recent actions, small enough
 * that the state stays cheap to clone to the renderer on every event. */
export const MAX_TOOL_CALLS = 20;

/** How much of a single tool payload is kept (desktop-rpc T7, advisory
 * R4-PAYLOAD). Args and results are now carried into state, and the manager
 * re-clones the whole ChatState on every event, so one large tool output
 * would inflate every subsequent broadcast — and block the renderer when the
 * row expands. The cap bounds that; a longer payload is replaced by a marker
 * that states its real size, so nothing pretends to be complete. */
export const MAX_TOOL_PAYLOAD_CHARS = 4096;

/** The JSON subset a tool payload can be once it has crossed the wire. It is
 * the *return* shape of `boundedPayload`, so that helper never hands back an
 * unexamined `unknown`; the values themselves come from `JSON.parse`, which
 * is why the in-cap branch can carry the original value through. */
export type ToolPayloadValue =
  | string
  | number
  | boolean
  | null
  | readonly ToolPayloadValue[]
  | { readonly [key: string]: ToolPayloadValue };

/** Keeps a payload only while its serialized form stays under
 * MAX_TOOL_PAYLOAD_CHARS; a larger one becomes a marker naming its real size,
 * so the UI can say what it dropped instead of pretending to show all of it. */
function boundedPayload(value: unknown): ToolPayloadValue | undefined {
  if (value === undefined) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserializable payload]";
  }
  if (serialized.length <= MAX_TOOL_PAYLOAD_CHARS) return value as ToolPayloadValue;
  return `[truncated: ${serialized.length} chars]`;
}

// ChatState itself now lives in @shared/bridge-types (T3: the renderer
// receives it directly through GentleBridge.onState/openChat/newChat).
// Re-exported here so existing call sites in this main-process domain
// (PiSession.ts, PiSession.test.ts) can keep importing it from the
// reducer without churn.
export type { ChatState };

export const INITIAL_CHAT_STATE: ChatState = {
  messages: [],
  working: false,
  pendingDialogs: [],
  activity: 0,
  helpers: emptyHelpersActivity(),
};

/** The one widgetKey gentle-agents publishes its per-chat helpers activity under (`gentle-agents.activity/v1`). */
const HELPERS_WIDGET_KEY = "gentle-agents";

const ACTIVITY_DELTA_TYPES: ReadonlySet<AssistantMessageEvent["type"]> = new Set([
  "thinking_start",
  "thinking_delta",
  "thinking_end",
  "toolcall_start",
  "toolcall_delta",
  "toolcall_end",
]);

/**
 * Folds one decoded RPC event into chat state. Pure: same inputs, same
 * output, no I/O, no id generation from Date.now()/crypto (message ids are
 * derived from `state.messages.length`, which is unique per open call
 * because each open appends exactly one message). The optional `now` is the
 * one exception: the caller (PiSession) supplies the wall-clock time as an
 * ISO string for the `setWidget` helpers-retention fallback below instead
 * of this file reading the clock itself.
 */
export function reduceChat(state: ChatState, event: RpcEvent, now?: string): ChatState {
  switch (event.type) {
    case "agent_start":
      return { ...state, working: true };
    case "agent_end":
    case "agent_settled":
      return { ...state, working: false };
    case "message_start":
      return openAssistantMessage(state, event.message);
    case "message_update":
      return applyAssistantMessageEvent(state, event.assistantMessageEvent);
    case "message_end":
      return closeAssistantMessage(state, event.message);
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end": {
      const next = { ...state, activity: state.activity + 1 };
      // An update carries no new identity or payload: the row it belongs to
      // already exists and the end frame is what completes it.
      if (event.type === "tool_execution_update") return next;
      const calls = state.toolCalls ?? [];
      const existing = calls.find((call) => call.id === event.toolCallId);
      if (event.type === "tool_execution_start") {
        // A duplicate start must not open a second row for the same call.
        if (existing) return next;
        const started: ToolCallView = {
          id: event.toolCallId,
          toolName: event.toolName,
          args: boundedPayload(event.args),
          status: "running",
        };
        return { ...next, toolCalls: [...calls, started].slice(-MAX_TOOL_CALLS) };
      }
      const finished: ToolCallView = {
        id: event.toolCallId,
        toolName: event.toolName,
        args: existing?.args,
        result: boundedPayload(event.result),
        isError: event.isError,
        status: "done",
      };
      return {
        ...next,
        toolCalls: [...calls.filter((call) => call.id !== event.toolCallId), finished].slice(-MAX_TOOL_CALLS),
      };
    }
    case "extension_ui_request":
      return applyExtensionUIRequest(state, event, now);
    case "session_state_changed":
      return applySessionStateChanged(state, event);
    case "extension_error":
      return { ...state, lastError: event.error };
    // turn_start/turn_end and command-response envelopes carry nothing the
    // chat view needs; agent_start/agent_end/agent_settled already drive
    // `working`, and the assistant text is driven by message_*/text_* deltas.
    default:
      return state;
  }
}

function openAssistantMessage(state: ChatState, message: RpcMessage): ChatState {
  const todo = applyCustomMessage(state, message);
  if (todo) return todo;
  if (message.role !== "assistant") return state;

  const chatMessage: ChatMessage = {
    id: `msg-${state.messages.length}`,
    role: MESSAGE_ROLE.ASSISTANT,
    text: "",
    streaming: true,
  };
  return { ...state, messages: [...state.messages, chatMessage] };
}

function applyAssistantMessageEvent(state: ChatState, delta: AssistantMessageEvent): ChatState {
  if (delta.type === "text_delta") {
    return appendToLastAssistantMessage(state, delta.delta);
  }
  if (ACTIVITY_DELTA_TYPES.has(delta.type)) {
    return { ...state, activity: state.activity + 1 };
  }
  // text_start/text_end/thinking_start/thinking_end already covered above
  // (thinking_* bumps activity, text_* otherwise carries nothing new: the
  // running text is assembled from text_delta and finalized on message_end).
  return state;
}

function appendToLastAssistantMessage(state: ChatState, delta: string): ChatState {
  const lastIndex = state.messages.length - 1;
  const last = state.messages[lastIndex];
  if (!last || last.role !== MESSAGE_ROLE.ASSISTANT) return state;

  const updated: ChatMessage = { ...last, text: last.text + delta };
  return { ...state, messages: replaceAt(state.messages, lastIndex, updated) };
}

function closeAssistantMessage(state: ChatState, message: RpcMessage): ChatState {
  const todo = applyCustomMessage(state, message);
  if (todo) return todo;
  if (message.role !== "assistant") return state;

  const lastIndex = state.messages.length - 1;
  const last = state.messages[lastIndex];
  if (!last || last.role !== MESSAGE_ROLE.ASSISTANT) return state;

  // message_end.message is authoritative per rpc.md; resync from its text
  // content blocks when present, otherwise keep what text_delta accumulated.
  const authoritativeText = extractAssistantText(message) ?? last.text;

  // An assistant message that only ever carried thinking/toolCall parts
  // (never a text part, and no text_delta landed either) finalizes with
  // nothing to show: drop it instead of leaving an empty grey bubble in the
  // thread. Every fixture/test replayed here closes an open message with
  // message_end (see prompt-turn.jsonl and tool-only-message.jsonl); no
  // observed event flow lets a message reach agent_settled without first
  // going through message_end, so finalization removal lives here only.
  // Dropping the last element shrinks `state.messages.length` back down, so
  // the id scheme (`msg-${state.messages.length}` in openAssistantMessage)
  // reassigns the freed id to the next assistant message with no gap or
  // extra bookkeeping needed.
  if (authoritativeText.trim().length === 0) {
    return { ...state, messages: removeLast(state.messages) };
  }

  const updated: ChatMessage = { ...last, text: authoritativeText, streaming: false };
  return { ...state, messages: replaceAt(state.messages, lastIndex, updated) };
}

/**
 * A `role: "custom"` message stamped with `gentle-todo-state` carries the
 * chat's own ODD task list as machine state (see todoPanel.ts): it folds
 * into `state.todo` — on BOTH message_start and message_end (codec.ts hands
 * these messages through as either) — and never becomes a transcript
 * bubble (S3): there is no transcript append for a non-assistant message
 * here to begin with. Malformed content keeps the previous panel state
 * rather than clobbering it, mirroring helpersActivity's malformed-frame
 * rule; re-applying the same snapshot is idempotent (equal state).
 */
function applyCustomMessage(state: ChatState, message: RpcMessage): ChatState | undefined {
  if (message.role !== "custom" || message.customType !== TODO_STATE_CUSTOM_TYPE) return undefined;

  const todo = parseTodoPanel(message.content);
  if (!todo) return undefined; // keep the previous panel state untouched
  return { ...state, todo };
}

function extractAssistantText(message: RpcMessage): string | undefined {
  const content = message.content;
  if (!Array.isArray(content)) return undefined;

  return content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join("");
}

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === "text" &&
    typeof (value as Record<string, unknown>).text === "string"
  );
}

function applyExtensionUIRequest(state: ChatState, event: RpcExtensionUIRequest, now: string | undefined): ChatState {
  switch (event.method) {
    case "select":
      return pushDialog(state, { id: event.id, method: "select", title: event.title, options: event.options });
    case "confirm":
      return pushDialog(state, { id: event.id, method: "confirm", title: event.title, message: event.message });
    case "input":
      return pushDialog(state, {
        id: event.id,
        method: "input",
        title: event.title,
        placeholder: event.placeholder,
      });
    case "editor":
      return pushDialog(state, { id: event.id, method: "editor", title: event.title, prefill: event.prefill });
    case "setWidget":
      return applySetWidget(state, event, now);
    case "notify":
      return applyNotify(state, event);
    case "setStatus":
      return applySetStatus(state, event);
    default:
      // Other fire-and-forget methods: setTitle, set_editor_text.
      return state;
  }
}

/**
 * `session_state_changed` (desktop-pending-work T5, S5): the ODD phase
 * indicator's ONLY data path — a READ of what the child published on the
 * desktop-rpc widget channel, fed into this reducer by PiSession's
 * widget-frame arm (never decoded from stdout by codec.ts). Never inferred
 * from transcript text, never derived from a tool name.
 *
 * - A frame whose `oddPhase` is a token from the closed ODD_PHASE set sets
 *   the phase.
 * - A frame whose `oddPhase` is OMITTED clears it: unknown or cleared
 *   means the field is absent on the wire (the owner's clear), so the
 *   indicator drops by omission — never a stale phase, never a
 *   placeholder.
 * - Anything else (an unrecognized token, a non-string value) contributes
 *   nothing: dropped, never coerced.
 */
function applySessionStateChanged(state: ChatState, event: Extract<RpcEvent, { type: "session_state_changed" }>): ChatState {
  if (event.oddPhase === undefined) {
    if (state.oddPhase === undefined) return state;
    const { oddPhase: _cleared, ...withoutOddPhase } = state;
    return withoutOddPhase;
  }
  const raw = event.oddPhase;
  if (!isOddPhaseToken(raw)) return state;
  if (state.oddPhase === raw) return state;
  return { ...state, oddPhase: raw };
}

/**
 * `notify` (U1, desktop-rpc T2): carries one notification with its wire
 * severity (`notifyType`, defaulting to "info" when omitted per
 * rpc-extension-ui.md). It folds into `state.notifications` and NEVER
 * becomes a conversation message or transcript entry. Malformed frames
 * (missing/wrong-typed message, unknown severity) keep the previous state
 * instead of throwing, mirroring the helpersActivity malformed-frame rule.
 */
function applyNotify(state: ChatState, event: GenericFireAndForgetUIRequest): ChatState {
  const message = event.message;
  if (typeof message !== "string") return state;

  const notifyType = event.notifyType;
  let severity: NotificationSeverity = "info";
  if (notifyType !== undefined) {
    if (typeof notifyType !== "string" || !NOTIFICATION_SEVERITIES.has(notifyType)) return state;
    severity = notifyType as NotificationSeverity;
  }

  const notification: ChatNotification = { message, severity };
  const retained = [...(state.notifications ?? []), notification];
  // Bounded retention (desktop-rpc T2b): keep at most MAX_NOTIFICATIONS,
  // dropping oldest first, so survivors stay in arrival order. Without the
  // cap the list grows forever and the clone shipped with every state push
  // grows with it.
  return { ...state, notifications: retained.slice(-MAX_NOTIFICATIONS) };
}

/**
 * `setStatus` (U1, desktop-rpc T2): keyed by the wire's `statusKey`. A
 * frame with a string `statusText` replaces that key's entry; a frame
 * without one CLEARS the key (rpc-extension-ui.md "setStatus": clearing is
 * expressible on the wire, so it is implemented, not swallowed). Malformed
 * frames keep the previous state untouched without throwing.
 */
function applySetStatus(state: ChatState, event: GenericFireAndForgetUIRequest): ChatState {
  const statusKey = event.statusKey;
  if (typeof statusKey !== "string") return state;

  const statusText = event.statusText;
  if (statusText !== undefined) {
    if (typeof statusText !== "string") return state;
    return { ...state, statuses: { ...(state.statuses ?? {}), [statusKey]: statusText } };
  }

  if (!state.statuses || !Object.prototype.hasOwnProperty.call(state.statuses, statusKey)) return state;
  const statuses = { ...state.statuses };
  delete statuses[statusKey];
  return { ...state, statuses };
}

/**
 * `setWidget` is fire-and-forget on the wire like the other widget/status
 * methods, but the one gentle-agents publishes under `widgetKey:
 * "gentle-agents"` carries this chat's per-chat helpers activity (M2), so
 * it folds into `helpers` instead of being dropped. Any other widgetKey
 * (a different extension's own widget) is still ignored — never a global
 * list, per the M2 objective (the parent-child relation stays direct).
 */
function applySetWidget(state: ChatState, event: GenericFireAndForgetUIRequest, now: string | undefined): ChatState {
  if (event.widgetKey !== HELPERS_WIDGET_KEY) return state;

  const widgetLines = Array.isArray(event.widgetLines) ? toStringArray(event.widgetLines) : undefined;
  const parsed = parseHelpersActivity(widgetLines);
  // undefined means "malformed frame": keep the previous helpers state
  // rather than clobbering it with nothing (see helpersActivity.ts).
  if (!parsed) return state;

  const helpers: HelpersActivity = { summary: parsed.summary, tasks: mergeHelperTasks(state.helpers.tasks, parsed.tasks, now) };
  return { ...state, helpers };
}

/**
 * gentle-pi keeps a task's record in its in-memory store only while it is
 * running; once it finishes the record moves to disk and the next
 * `gentle-agents.activity/v1` frame simply omits it (`summary.finished`
 * still counts it, but `tasks` no longer carries it). Without this merge
 * the Helpers tab would show the finished count going up while the task
 * itself vanishes from the list.
 *
 * - A task present in `nextTasks` always replaces its previous record
 *   outright (the frame is authoritative for anything it still reports).
 * - A task from `previousTasks` missing from `nextTasks` is retained with
 *   its last known record: `running`/`waiting`/`queued` is promoted to
 *   `done` with `endedAt` filled from `now` (only if it didn't already have
 *   one), and `failed`/`cancelled`/`done` is kept exactly as it was — a
 *   terminal status is never re-derived.
 */
function mergeHelperTasks(previousTasks: readonly HelperTask[], nextTasks: readonly HelperTask[], now: string | undefined): HelperTask[] {
  const nextIds = new Set(nextTasks.map((task) => task.id));
  const retained = previousTasks.filter((task) => !nextIds.has(task.id)).map((task) => retainDroppedTask(task, now));
  return orderHelperTasks([...nextTasks, ...retained]);
}

const NON_TERMINAL_HELPER_STATUSES: ReadonlySet<HelperTask["status"]> = new Set([
  HELPER_STATUS.RUNNING,
  HELPER_STATUS.WAITING,
  HELPER_STATUS.QUEUED,
]);

function retainDroppedTask(task: HelperTask, now: string | undefined): HelperTask {
  if (!NON_TERMINAL_HELPER_STATUSES.has(task.status)) return task;
  return { ...task, status: HELPER_STATUS.DONE, endedAt: task.endedAt ?? now };
}

/** running, then waiting, then queued, then finished (done/failed/cancelled) sorted by `endedAt` desc. */
export function orderHelperTasks(tasks: readonly HelperTask[]): HelperTask[] {
  const running: HelperTask[] = [];
  const waiting: HelperTask[] = [];
  const queued: HelperTask[] = [];
  const finished: HelperTask[] = [];

  for (const task of tasks) {
    switch (task.status) {
      case HELPER_STATUS.RUNNING:
        running.push(task);
        break;
      case HELPER_STATUS.WAITING:
        waiting.push(task);
        break;
      case HELPER_STATUS.QUEUED:
        queued.push(task);
        break;
      default:
        finished.push(task);
    }
  }

  finished.sort(compareEndedAtDesc);
  return [...running, ...waiting, ...queued, ...finished];
}

function compareEndedAtDesc(a: HelperTask, b: HelperTask): number {
  const aEnded = a.endedAt ?? "";
  const bEnded = b.endedAt ?? "";
  if (aEnded === bEnded) return 0;
  return aEnded > bEnded ? -1 : 1;
}

function toStringArray(value: readonly unknown[]): readonly string[] {
  return value.filter((item): item is string => typeof item === "string");
}

function pushDialog(state: ChatState, dialog: Dialog): ChatState {
  return { ...state, pendingDialogs: [...state.pendingDialogs, dialog] };
}

function replaceAt<T>(items: readonly T[], index: number, value: T): T[] {
  const copy = items.slice();
  copy[index] = value;
  return copy;
}

function removeLast<T>(items: readonly T[]): T[] {
  return items.slice(0, -1);
}
