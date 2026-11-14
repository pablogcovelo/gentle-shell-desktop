/**
 * The typed contract between the three Electron processes.
 * Lives under src/shared/ (not src/renderer/ or src/main/) because all
 * three processes import it: the Scope Rule says code used by 2+ features
 * (here, 2+ processes) belongs in a shared location, never duplicated
 * locally in one of them.
 */
export const CHAT_STATE = {
  IDLE: "idle",
  WORKING: "working",
  NEEDS_YOU: "needs-you",
} as const;

/**
 * A chat's status in the sidebar list. Named `ChatStatus`, not `ChatState`,
 * to avoid colliding with the full per-conversation `ChatState` below
 * (messages/working/pendingDialogs/lastError/activity) — two genuinely
 * different things that both wanted the name "ChatState" once this file
 * became their shared home.
 */
export type ChatStatus = (typeof CHAT_STATE)[keyof typeof CHAT_STATE];

export interface ChatSummary {
  readonly id: string;
  readonly title: string;
  /** Working directory the session was started in (pi SessionInfo.cwd). */
  readonly cwd: string;
  readonly updatedAt: string;
  readonly messageCount: number;
  readonly state: ChatStatus;
}

export const MESSAGE_ROLE = {
  USER: "user",
  ASSISTANT: "assistant",
} as const;

export type MessageRole = (typeof MESSAGE_ROLE)[keyof typeof MESSAGE_ROLE];

export interface ChatMessage {
  readonly id: string;
  readonly role: MessageRole;
  readonly text: string;
  /**
   * True while an assistant message is still streaming (between
   * message_start and message_end on the pi RPC wire). Optional so T1-era
   * call sites that never set it (mockBridge, ConversationContainer) keep
   * compiling; the chat reducer added in T2 always sets it explicitly.
   */
  readonly streaming?: boolean;
}

export const DIALOG_METHOD = {
  SELECT: "select",
  CONFIRM: "confirm",
  INPUT: "input",
  EDITOR: "editor",
} as const;

export type DialogMethod = (typeof DIALOG_METHOD)[keyof typeof DIALOG_METHOD];

/**
 * A blocking extension UI request (pi RPC `extension_ui_request` with a
 * dialog method: select, confirm, input, editor) waiting for an
 * `extension_ui_response`. Lives here, not in src/main/domain, because both
 * main (produces it from the RPC event stream) and renderer (T4 renders it
 * as a card) need the shape — the Scope Rule promotes shared-by-2+-processes
 * types out of either process folder.
 */
export interface Dialog {
  readonly id: string;
  readonly method: DialogMethod;
  readonly title: string;
  /** confirm only */
  readonly message?: string;
  /** select only */
  readonly options?: readonly string[];
  /** input only */
  readonly placeholder?: string;
  /** editor only */
  readonly prefill?: string;
}

/**
 * Mirrors pi's rpc-types.ts `RpcExtensionUIResponse`: `confirm` dialogs
 * answer with `confirmed`, `select`/`input`/`editor` answer with `value`,
 * and any dialog can be dismissed with `cancelled: true`. Lives here (not
 * src/main/domain/session/PiSession.ts, where T2 first defined it) because
 * the renderer now constructs these values too, answering a Dialog card
 * through GentleBridge.answerDialog.
 */
export type DialogAnswer = { readonly value: string } | { readonly confirmed: boolean } | { readonly cancelled: true };

/**
 * Result of `sendMessage`/`PiSession.prompt`: M1 has no queue, so a prompt
 * sent while the assistant is already working is declined outright rather
 * than buffered. Lives here (not src/main/domain/session/PiSession.ts,
 * where T2 first defined it) because GentleBridge.sendMessage (T5) now
 * resolves this value straight to the renderer instead of throwing — the
 * Scope Rule promotes it out of src/main once a second process needs the
 * shape. `reason` is set only when `queued` is false; the renderer shows
 * it in the status line, and ChatState.lastError also carries it for
 * anyone reading pushed state directly, but never both an event AND a
 * rejection ("report once" — see PiSession.prompt).
 */
export interface PromptResult {
  readonly queued: boolean;
  readonly reason?: string;
}

/**
 * The full state of the currently open conversation: messages, whether the
 * assistant is working, pending dialogs awaiting an answer, the last
 * surfaced error, an activity counter for thinking/tool events (no
 * thinking or tool output is shown — see the M1 objective), and the M2
 * per-chat helpers activity (see HelpersActivity below). Moved here from
 * src/main/domain/rpc/chatReducer.ts (T2) because the renderer now
 * receives it directly as GentleBridge.onState's payload and openChat/
 * newChat's return value — the Scope Rule promotes it out of src/main once
 * a second process needs the shape.
 */
export const NOTIFICATION_SEVERITY = {
  INFO: "info",
  WARNING: "warning",
  ERROR: "error",
} as const;

/** Severity of an RPC `notify` notification, as carried by the wire's
 * `notifyType` field (rpc-extension-ui.md; the wire default when omitted is
 * "info"). Lives here (not src/main) because the renderer renders it. */
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITY)[keyof typeof NOTIFICATION_SEVERITY];

/**
 * One notification published through pi RPC's fire-and-forget `notify`
 * method. Never a conversation message and never part of the transcript:
 * it lives only in `ChatState.notifications`, in arrival order. Scoped to
 * its own chat: each PiSession folds only its own child's frames, so
 * another session's notifications are never merged in or reconstructed
 * here (single-child host today; this stays true per session).
 */
export interface ChatNotification {
  readonly message: string;
  readonly severity: NotificationSeverity;
}

export const SUBSCRIPTION_USAGE_STATUS = {
  OK: "ok",
  PENDING: "pending",
  STALE: "stale",
  FAILED: "failed",
  UNAVAILABLE: "unavailable",
} as const;

/** One of the five statuses gentle-pi's usage owner derives from facts it
 * already holds (gentle-pi docs/desktop-rpc.md "get_subscription_usage").
 * A closed union on purpose: an unknown status is dropped by the parser
 * instead of being guessed into one of these. */
export type SubscriptionUsageStatus = (typeof SUBSCRIPTION_USAGE_STATUS)[keyof typeof SUBSCRIPTION_USAGE_STATUS];

/** The closed thinking-level union pi's `get_state` reports in
 * `thinkingLevel` (pi-agent-core `ThinkingLevel`; rendered as reported,
 * never invented). Lives here for the Scope-Rule reason as the rest of
 * the wire types: main decodes it, the renderer renders it. */
export const THINKING_LEVEL = {
  OFF: "off",
  MINIMAL: "minimal",
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  XHIGH: "xhigh",
  MAX: "max",
} as const;

export type ThinkingLevel = (typeof THINKING_LEVEL)[keyof typeof THINKING_LEVEL];

/**
 * The chat's own session identity (desktop-rpc T4), decoded from pi's own
 * `get_session_stats` and `get_state` RPC replies — ordinary commands
 * correlated by `id`, never the desktop-rpc widget channel. Every field
 * is present ONLY when the child supplied it: an absent field renders as
 * nothing, never as zero, and no context window is ever guessed.
 *
 * - `sessionCost` is the SESSION's cost as the child reports it — never
 *   presented as provider quota.
 * - `tokensTotal` is the session's accumulated token total; it is NOT
 *   occupied context — the context fields come only from the child's own
 *   `contextUsage`, and stay absent when it omitted or malformed it.
 * - `contextTokens`/`contextPercent` are `number | null`: `null` is the
 *   wire's "supplied as unknown" (right after compaction), distinct from
 *   absent (`contextUsage` not supplied at all).
 * - `modelId`/`modelName`/`thinkingLevel` are the EFFECTIVE values the
 *   child reports (`get_state`), never the last requested ones.
 *
 * Lives here because main decodes it and the renderer renders it (the
 * Scope Rule: a type used by 2+ processes stays under src/shared).
 */
export interface SessionIdentityView {
  readonly modelId?: string;
  readonly modelName?: string;
  readonly modelProvider?: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly contextTokens?: number | null;
  readonly contextWindow?: number;
  readonly contextPercent?: number | null;
  readonly sessionCost?: number;
  readonly tokensTotal?: number;
}

/** One usage window as the wire carries it: label, real percentage,
 * window length, and the reset instant — `null` when the provider does not
 * report one. Modelled field-for-field, nothing added. */
export interface UsageWindow {
  readonly label: string;
  readonly usedPercent: number;
  readonly windowSeconds: number;
  readonly resetAt: number | null;
}

/** One limit group inside a provider snapshot. `used`/`budget` are the raw
 * allowance numbers the nan provider reports; absent for every other
 * provider (the parser keeps them only when the wire supplies them). */
export interface UsageLimit {
  readonly name: string;
  readonly limitReached: boolean;
  readonly windows: readonly UsageWindow[];
  readonly used?: number;
  readonly budget?: number;
}

/** One provider's recorded snapshot, exactly the safe projection the
 * desktop-rpc contract documents: `fetchedAt` present when there is a
 * snapshot, `plan` present only when public, `limits` present only when
 * the provider reported any. A header-only provider (Anthropic) is
 * `pending` with no limits until its first response records one — it must
 * render as pending, never as zero usage. */
export interface UsageProvider {
  readonly provider: string;
  readonly status: SubscriptionUsageStatus;
  readonly fetchedAt?: number;
  readonly plan?: string;
  readonly limits?: readonly UsageLimit[];
}

/** The whole subscription-usage answer: the read's current scope
 * (`get_subscription_usage`), or the changed-snapshot set of a
 * `rate_limit` event. Lives here (not src/main) because main decodes it
 * and the renderer renders it — the Scope Rule: a type used by 2+
 * processes stays under src/shared. */
export interface SubscriptionUsage {
  readonly providers: readonly UsageProvider[];
}

/** One tool execution as the wire reports it (desktop-rpc T7). `args` and
 * `result` stay `unknown` on purpose: they are the provider's own payloads,
 * carried for the action rows' detail and never interpreted here. `status`
 * comes from the execution events — a call is running until its end frame
 * arrives — never guessed from the payload. */
export interface ToolCallView {
  readonly id: string;
  readonly toolName: string;
  readonly args?: unknown;
  readonly result?: unknown;
  readonly isError?: boolean;
  readonly status: "running" | "done";
}

export interface ChatState {
  readonly messages: readonly ChatMessage[];
  readonly working: boolean;
  readonly pendingDialogs: readonly Dialog[];
  readonly lastError?: string;
  readonly activity: number;
  /** The tool executions this chat has seen (desktop-rpc T7): one row per
   * call, newest kept up to MAX_TOOL_CALLS. `args`/`result` are the
   * provider's own payloads, carried for the action rows' detail and never
   * interpreted. Optional: absent until the first tool runs. */
  readonly toolCalls?: readonly ToolCallView[];
  readonly helpers: HelpersActivity;
  /** Status entries published through pi RPC's fire-and-forget `setStatus`
   * method, keyed by the wire's `statusKey`: a frame carrying `statusText`
   * replaces that key's entry, and a frame without one clears it
   * (rpc-extension-ui.md "setStatus" — clearing IS expressible on the
   * wire). Optional: absent until an extension publishes a status, so
   * INITIAL_CHAT_STATE stays as it was. Renderer-facing (status bar);
   * never a transcript message. */
  readonly statuses?: Readonly<Record<string, string>>;
  /** Notifications from pi RPC's `notify` method, in arrival order (see
   * ChatNotification). Optional for the same reason as `statuses`. */
  readonly notifications?: readonly ChatNotification[];
  /** The chat's own ODD task-panel state (S7), decoded from the hidden
   * `gentle-todo-state` custom messages — never from transcript text, which
   * those messages never become (S3). Optional: absent until the chat's
   * session actually carries a todo state. Lives here for the same Scope
   * Rule reason as the rest of ChatState: the renderer renders it. */
  readonly todo?: TodoPanelState;
  /** The chat's subscription-usage meters (desktop-rpc T3), decoded from
   * `get_subscription_usage` replies and `rate_limit` events on the
   * `gentle-desktop-rpc` widget channel — never from the conversation
   * transcript, and bound to this chat's own session (each PiSession folds
   * only its own child's frames). Optional: absent until the first usage
   * answer or event arrives, so an unavailable source renders nothing, not
   * zero. */
  readonly usage?: SubscriptionUsage;
  /** Set when the desktop control channel probe failed for this chat's
   * child (desktop-rpc T3 correction): the child never answered
   * `capabilities`, so NO control traffic — usage reads included — may be
   * written to it, and the usage surface must say the channel is
   * unavailable rather than render meters or a pending state. Distinct
   * from a provider's `pending`, which means the provider has not reported
   * yet. Optional: absent while the channel is unprobed or working. */
  readonly usageChannelUnavailable?: boolean;
  /** The chat's own session identity (desktop-rpc T4), decoded from the
   * child's `get_session_stats` and `get_state` replies — see
   * SessionIdentityView. Optional: absent until the first correlated
   * reply arrives, and folded field-wise so a reply that supplies only
   * one half never clobbers the other. Last-known (S12): refreshed at
   * the named lifecycle boundaries, never a live push. */
  readonly session?: SessionIdentityView;
}

/**
 * One task in the chat's own ODD task list, as gentle-shell's todo tool
 * writes it (`TodoTask` in gentle-pi's shell-todo). `status` stays a plain
 * string, not a closed union: gentle-shell may add statuses before this
 * app is updated (e.g. "deferred"), and an unknown one must still render
 * rather than drop the task.
 */
export interface TodoTaskView {
  readonly id: number;
  readonly title: string;
  readonly status: string;
  readonly note?: string;
}

/**
 * The chat's todo state carried by gentle-shell's hidden
 * `gentle-todo-state` custom messages (the structured snapshot gentle-pi
 * writes to the session file after every todo write). Mirrors `TodoState`
 * in shell-todo. Lives here because the renderer renders it (the M3 task
 * card) and main decodes it — the Scope Rule: a type used by 2+ processes
 * stays under src/shared. `updatedTurn` is `null` when no turn is open.
 */
export interface TodoPanelState {
  readonly tasks: readonly TodoTaskView[];
  readonly nextId: number;
  readonly updatedTurn: number | null;
}

export const HELPER_STATUS = {
  QUEUED: "queued",
  RUNNING: "running",
  WAITING: "waiting",
  DONE: "done",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

/** A subagent's lifecycle status, as reported by gentle-agents' `gentle-agents.activity/v1` widget payload. */
export type HelperStatus = (typeof HELPER_STATUS)[keyof typeof HELPER_STATUS];

/**
 * The closed status set gentle-pi's desktop-rpc subagents projection
 * documents (`docs/desktop-rpc.md` "list_subagents" field table), shared
 * with the renderer for the same Scope-Rule reason as HelperStatus. It
 * differs from the activity vocabulary on two terminal statuses
 * (`completed`/`timed_out`); src/main/domain/rpc/agents.ts maps it onto
 * HelperStatus with a documented, never-guessed mapping.
 */
export const AGENT_STATUS = {
  QUEUED: "queued",
  RUNNING: "running",
  WAITING: "waiting",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  TIMED_OUT: "timed_out",
} as const;

export type AgentStatus = (typeof AGENT_STATUS)[keyof typeof AGENT_STATUS];

/**
 * One helper's accumulated usage, exactly the projection the subagents
 * contract documents: `total` tokens, `cost`, and — once the run settled
 * — the final-assistant `input`, `output`, `cache` (read + write) and
 * `reasoning` breakdown. The breakdown fields are absent for an in-flight
 * task and for a restored finished task whose run never recorded one.
 */
export interface HelperAgentUsage {
  readonly total: number;
  readonly cost: number;
  readonly input?: number;
  readonly output?: number;
  readonly cache?: number;
  readonly reasoning?: number;
}

/**
 * One entry of gentle-pi's whitelisted subagents projection
 * (`list_subagents` snapshot, `cancel_subagent` post-action reply,
 * `agents_update` event) — the authoritative structured state of a helper
 * (status, model, usage). Lives here because main decodes it and the
 * renderer reads it back out of ChatState.helpers.
 */
export interface HelperAgentState {
  readonly id: string;
  readonly agent: string;
  readonly status: AgentStatus;
  readonly model?: string;
  readonly modelSource?: string;
  readonly fallbackFrom?: string;
  readonly thinking?: string;
  readonly lastStep?: string;
  readonly usage?: HelperAgentUsage;
}

/**
 * The desktop control channel's Stop availability for the chat's live
 * child, attached by main to the helpers slice (the Helpers tab is its
 * only consumer and ChatState.helpers is that tab's only data path).
 * `available: false` always carries `reason` — the honest note the Stop
 * control renders when it stays disabled, in the same spirit as the usage
 * surface's channel-unavailable note.
 */
export interface StopChannelState {
  readonly available: boolean;
  readonly reason?: string;
}

export interface HelperThreadTextItem {
  readonly kind: "text";
  readonly text: string;
}

export interface HelperThreadThinkingItem {
  readonly kind: "thinking";
  readonly text: string;
}

export interface HelperThreadToolItem {
  readonly kind: "tool";
  readonly callId: string;
  readonly name: string;
  readonly args?: unknown;
  readonly output?: unknown;
  readonly running?: boolean;
  readonly isError?: boolean;
}

export interface HelperThreadNoteItem {
  readonly kind: "note";
  readonly text: string;
}

/**
 * One entry in a helper's narrated thread (D3 collapses `tool` to one line
 * by default, behind a "Show tool details" toggle; `note` renders in
 * amber). Lives here (not src/main/domain) because the renderer's D3
 * Helpers tab renders it directly off ChatState.helpers.
 */
export type HelperThreadItem = HelperThreadTextItem | HelperThreadThinkingItem | HelperThreadToolItem | HelperThreadNoteItem;

export interface HelperThread {
  readonly version: number;
  readonly dropped: number;
  readonly items: readonly HelperThreadItem[];
}

/**
 * One subagent gentle-agents is tracking for the chat that started it.
 * Mirrors the `summary`/`thread` split in `gentle-agents.activity/v1`'s
 * task entries: `summary` is the whitelisted TaskRecord fields (id
 * through error), flattened here per the Const Types / Flat Interfaces
 * pattern rather than nested one level deeper than `thread`.
 */
export interface HelperTask {
  readonly id: string;
  readonly agent: string;
  readonly label: string;
  readonly prompt: string;
  readonly status: HelperStatus;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly lastStep?: string;
  readonly lastActivityAt?: string;
  readonly turns: number;
  readonly toolCalls: number;
  readonly error?: string;
  readonly thread: HelperThread;
  /** Structured state from the desktop-rpc subagents projection
   * (desktop-rpc T6): the routed model, thinking level and accumulated
   * usage the projection reports. The activity path never sets them; the
   * overlay in src/main/domain/rpc/agents.ts fills them from the
   * projection, which owns this state. */
  readonly model?: string;
  readonly thinking?: string;
  readonly usage?: HelperAgentUsage;
}

export interface HelpersSummary {
  readonly running: number;
  readonly queued: number;
  readonly waiting: number;
  readonly finished: number;
}

/**
 * The decoded, typed form of a `setWidget` request for `widgetKey:
 * "gentle-agents"` (schema `gentle-agents.activity/v1`) — see
 * src/main/domain/rpc/helpersActivity.ts's `parseHelpersActivity`. Lives
 * here (not src/main/domain/rpc) because both main (decodes it into
 * ChatState.helpers) and the D3 renderer (renders the Helpers tab off it)
 * need the shape — the Scope Rule promotes it out of src/main once a
 * second process needs it.
 */
export interface HelpersActivity {
  readonly summary: HelpersSummary;
  readonly tasks: readonly HelperTask[];
  /** The latest authoritative subagents projection from the desktop-rpc
   * channel (desktop-rpc T6): the full bounded list from a
   * `list_subagents` snapshot or an `agents_update` event, merged
   * entry-wise by `cancel_subagent` replies. The pure overlay
   * (src/main/domain/rpc/agents.ts) re-applies it onto `tasks` whenever
   * the activity path folds a frame, so the activity narrative never
   * regresses the structured state. Optional: absent until the channel is
   * adopted and answers. */
  readonly agents?: readonly HelperAgentState[];
  /** The Stop control's channel state for the chat's live child (see
   * StopChannelState). Set by main from the `capabilities` probe — not by
   * the gentle-agents widget, which is why the activity parser never
   * produces it. Attached to this slice because the Helpers tab is the
   * Stop control's only consumer and this object is its only data path. */
  readonly stopChannel?: StopChannelState;
}

/** Outcome of GentleBridge.stopHelper (desktop-rpc T6). `requested` means
 * the child accepted the stop — the helper stops ASYNCHRONOUSLY, so the UI
 * must never flip to "stopped" on this outcome alone; the row updates when
 * the following `agents_update` event reports the real transition.
 * `not_tracked` is the wire's typed `not_found` (unknown or already-terminal
 * helper, or one owned by another session): nothing was stopped and no
 * actionable error exists. `unavailable` covers every other failure —
 * unadopted channel, missing `cancel_subagent` method, timeout, or a
 * server error such as `agents_unavailable`. */
export const STOP_HELPER_OUTCOME = {
  REQUESTED: "requested",
  NOT_TRACKED: "not_tracked",
  UNAVAILABLE: "unavailable",
} as const;

export type StopHelperOutcome = (typeof STOP_HELPER_OUTCOME)[keyof typeof STOP_HELPER_OUTCOME];

/**
 * Whether the desktop app links to an existing plain pi CLI install
 * (`--link`, reusing `~/.pi/agent` or `PI_CODING_AGENT_DIR`) or keeps its
 * own isolated home (`--isolated`, `~/.gentle-shell/agent`) — the choice
 * T5's first-run screen offers. Lives here (not
 * src/main/domain/home/home.ts, where it is resolved and persisted)
 * because the renderer's first-run screen sends this same value back
 * through GentleBridge.chooseHome — the Scope Rule promotes it out of
 * src/main once a second process needs the shape.
 */
export const HOME_MODE = {
  LINK: "link",
  ISOLATED: "isolated",
} as const;

export type HomeMode = (typeof HOME_MODE)[keyof typeof HOME_MODE];

/**
 * Whether `~/.pi/agent` (or `PI_CODING_AGENT_DIR`) exists, and what a
 * plain pi CLI install left there — what the first-run screen's
 * "We found pi on this machine" detection card renders.
 */
export interface PiDetection {
  readonly found: boolean;
  readonly dir: string;
  readonly hasAuth: boolean;
  readonly hasModels: boolean;
}

/** GentleBridge.setupStatus()'s result: whether first-run should be shown
 * (no home choice persisted yet AND pi was detected) and what detectPi
 * found either way, so the screen can render its detection card even when
 * a choice already exists (defensive; App.tsx only renders the screen
 * when `needsChoice` is true). */
export interface SetupStatus {
  readonly needsChoice: boolean;
  readonly detection: PiDetection;
}

/**
 * Surface exposed on `window.gentle` by the preload script. T1 typed the
 * listChats/sendMessage skeleton; T3 finalizes the full shape and wires it
 * to the real IPC bridge (src/preload/bridge.ts) and main-process ChatHost
 * (src/main/domain/session/ChatHost.ts, src/main/ipc/registerHandlers.ts);
 * T5 adds first-run/home.
 */
export interface GentleBridge {
  listChats(): Promise<ChatSummary[]>;
  /** Opens an existing chat by id and returns its current ChatState. */
  openChat(id: string): Promise<ChatState>;
  /** Starts a fresh chat (no prior session file) and returns its initial ChatState. */
  newChat(): Promise<ChatState>;
  /** Sends a message in whichever chat is currently open. Resolves with
   * `{ queued: false, reason }` instead of rejecting when the assistant is
   * already working, so the caller reports it exactly once. */
  sendMessage(text: string): Promise<PromptResult>;
  abort(): Promise<void>;
  answerDialog(id: string, answer: DialogAnswer): Promise<void>;
  /** Subscribes to ChatState pushes for the currently open chat. Returns an unsubscribe function. */
  onState(callback: (state: ChatState) => void): () => void;
  /** Subscribes to error messages surfaced by the currently open chat. Returns an unsubscribe function. */
  onError(callback: (message: string) => void): () => void;
  /** Whether to show the first-run home-choice screen, and what pi
   * detection found. */
  setupStatus(): Promise<SetupStatus>;
  /** Persists the chosen home mode; the next spawned session and the
   * session list use it. */
  chooseHome(mode: HomeMode): Promise<void>;
  /** Asks the child to stop one helper through gentle-pi's desktop-rpc
   * `cancel_subagent` (desktop-rpc T6). Resolves with a StopHelperOutcome
   * instead of rejecting for every expectable case; the helper's real
   * transition arrives later as an `agents_update` state push, never from
   * this call's response alone. Optional: both real bridges implement it
   * (src/preload/bridge.ts, the mock bridge), and the Helpers tab treats a
   * bridge without it as the `unavailable` outcome. */
  stopHelper?(id: string): Promise<StopHelperOutcome>;
}

declare global {
  interface Window {
    gentle?: GentleBridge;
  }
}
