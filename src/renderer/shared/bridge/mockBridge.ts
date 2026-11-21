import {
  CHAT_STATE,
  HELPER_STATUS,
  MESSAGE_ROLE,
  NOTIFICATION_SEVERITY,
  THINKING_LEVEL,
  type AppInfo,
  type AvailableModelsResult,
  type AvailableThinkingLevelsResult,
  type ChatCommandRunResult,
  type ChatMessage,
  type ChatNotification,
  type ChatState,
  type ChatSummary,
  type Dialog,
  type DialogAnswer,
  type GentleBridge,
  type HelperTask,
  type HelperThread,
  type HelperThreadItem,
  type HelperThreadToolItem,
  type HelpersActivity,
  type HelpersSummary,
  type HomeMode,
  type NotificationSeverity,
  type OpenChatResult,
  type PiDetection,
  type ModelOptionView,
  type PromptResult,
  type ThinkingLevel,
  type SetupStatus,
  type StopHelperOutcome,
  type WorkspaceInfo,
  type WorkspaceList,
} from "@shared/bridge-types";

/**
 * In-memory stand-in for the real preload bridge. useBridge() returns this
 * whenever window.gentle is undefined, which is always true outside
 * Electron — in particular under `pnpm dev:web`, the plain browser preview
 * the maintainer drives with automation. It fakes enough of pi's behaviour
 * to exercise the whole T4 UI without a real pi process: a streamed echo
 * reply, and three keyword-triggered scenarios so every dialog method and
 * the status line are reachable from the preview:
 *   - a message containing "?"      -> a `select` dialog
 *   - a message containing "delete" -> a `confirm` dialog
 *   - a message containing "name"   -> an `input` dialog
 *   - a message containing "fail"   -> an onError push, no reply
 *
 * T3 rewired this from T1's streamed-callback shape to the finalized
 * bridge: a single module-level ChatState that openChat/newChat reset and
 * sendMessage/abort/answerDialog mutate, pushed to subscribers through
 * onState — mirroring how the real ChatHost/PiSession only ever track one
 * "current" chat in M1.
 */
const EXAMPLE_CHATS: ChatSummary[] = [
  {
    id: "chat-readme",
    title: "Write the README intro",
    cwd: "/Users/dev/gentle-shell-desktop",
    // palette-host-catalog T3 (S5): the session file path the /resume
    // picker hands to run_command as args.
    path: "/Users/dev/.pi/agent/sessions/chat-readme.jsonl",
    updatedAt: "2026-09-21T09:15:00.000Z",
    messageCount: 4,
    state: CHAT_STATE.IDLE,
  },
  {
    id: "chat-refactor",
    title: "Refactor the session store",
    cwd: "/Users/dev/pi",
    path: "/Users/dev/.pi/agent/sessions/chat-refactor.jsonl",
    updatedAt: "2026-09-21T10:40:00.000Z",
    messageCount: 12,
    state: CHAT_STATE.NEEDS_YOU,
  },
  {
    id: "chat-migration",
    title: "Migrate the config schema",
    cwd: "/Users/dev/pi",
    path: "/Users/dev/.pi/agent/sessions/chat-migration.jsonl",
    updatedAt: "2026-09-21T11:05:00.000Z",
    messageCount: 7,
    state: CHAT_STATE.WORKING,
  },
];

const STREAM_DELAY_MS = 40;

/** Fake "we found pi on this machine" detection (T5), so the first-run
 * screen's detection card is reachable in the browser preview without a
 * real pi install. */
const FAKE_DETECTION: PiDetection = {
  found: true,
  dir: "/Users/dev/.pi/agent",
  hasAuth: true,
  hasModels: true,
};

/** The persisted home choice, mirroring appConfigStore/setupService (T5):
 * undefined means "no choice yet", so setupStatus() reports needsChoice
 * until chooseHome() is called. */
let homeChoice: HomeMode | undefined;

/**
 * `?firstRun=0`/`?firstRun=1` in the preview URL force-skips or
 * force-shows the first-run screen regardless of the persisted choice
 * above, so it can be exercised (or gotten out of the way) on demand
 * under `pnpm dev:web`. Guarded for `typeof window === "undefined"`:
 * this module's own unit tests run under vitest's Node environment,
 * which has no `window`.
 */
function firstRunOverride(): boolean | undefined {
  if (typeof window === "undefined") return undefined;
  const flag = new URLSearchParams(window.location.search).get("firstRun");
  if (flag === "0") return false;
  if (flag === "1") return true;
  return undefined;
}

function emptyState(): ChatState {
  // D4 (a "working" chat with three helpers, browser-verified) fills this
  // in later; for now the mock bridge just needs a compiling, empty
  // HelpersActivity so it keeps matching the real ChatState shape.
  return {
    messages: [],
    working: false,
    pendingDialogs: [],
    activity: 0,
    helpers: { summary: { running: 0, queued: 0, waiting: 0, finished: 0 }, tasks: [] },
    // M3: a demo task list so `pnpm dev:web` can render (and browser-verify)
    // the ODD task card without a real gentle-shell child behind it.
    todo: {
      tasks: [
        { id: 1, title: "Write the feature document", status: "done" },
        { id: 2, title: "Fold the custom message into panel state", status: "done" },
        { id: 3, title: "Render the collapsible card", status: "in_progress", note: "T3" },
        { id: 4, title: "Match the styles to the theme tokens", status: "pending" },
        { id: 5, title: "Ship a dedicated panel design", status: "dropped" },
      ],
      nextId: 6,
      updatedTurn: 3,
    },
    // T2b demo data so `pnpm dev:web` exercises the keyed statuses and the
    // transient notification stack without a real gentle-shell child: two
    // status keys in the shape the wire's setStatus produces, and a
    // representative notification (severity is cycled by the "notify"
    // message keyword in sendMessage below).
    // desktop-rpc T3 demo data so `pnpm dev:web` exercises the subscription
    // usage meters without a real gentle-shell child: exactly the wire
    // shape the contract documents — one `ok` provider with its recorded
    // windows (the documented openai-codex example), and one `pending`
    // header-only provider (Anthropic) that must render as pending, never
    // as zero usage.
    usage: {
      providers: [
        { provider: "anthropic", status: "pending" },
        {
          provider: "openai-codex",
          status: "ok",
          fetchedAt: Date.now(),
          plan: "pro",
          limits: [
            {
              name: "codex",
              limitReached: false,
              windows: [
                { label: "week", usedPercent: 40, windowSeconds: 604800, resetAt: Date.now() + 3 * 24 * 60 * 60 * 1000 },
              ],
            },
          ],
        },
      ],
    },
    statuses: { "gentle-todo": "4 tasks · 1 in progress", "gentle-agents": "1 helper running" },
    // desktop-pending-work T5 (S5) demo: a published ODD phase so the
    // header's indicator is exercisable under `pnpm dev:web` without a
    // child. Only ever a token from the closed set — the renderer renders
    // its own label for it (the host's own wording is never copied).
    oddPhase: "implementing",
    notifications: [{ message: "Mock notification: this is transient feedback, not a message.", severity: NOTIFICATION_SEVERITY.INFO }],
    // desktop-rpc T4 demo identity so `pnpm dev:web` exercises the status
    // line's identity block without a child. Every field is optional and
    // rendered only when supplied: drop any one of them here to see that
    // field disappear rather than fall back to a zero.
    session: {
      // palette-command-arguments T2 (S4): the demo session name the `name`
      // screen's prefill is exercisable with.
      sessionName: "Write the README intro",
      modelId: "claude-sonnet-4-20250514",
      modelName: "Claude Sonnet 4",
      modelProvider: "anthropic",
      thinkingLevel: "medium",
      contextTokens: 60000,
      contextWindow: 200000,
      contextPercent: 30,
      sessionCost: 0.45,
      tokensTotal: 105000,
    },
    // desktop-rpc T7b demo: two executions plus the vocabulary that gives them
    // their native glyphs, so `pnpm dev:web` shows the action rows without a
    // child. The second row matches by pattern, exactly like `rdd` does.
    toolCalls: [
      { id: "call-1", toolName: "read", args: { path: "src/main/index.ts" }, result: "export {}", isError: false, status: "done" },
      { id: "call-2", toolName: "gentle_review_start", args: { scope: "staged" }, status: "running" },
    ],
    toolVocabulary: {
      categories: ["read", "rdd"],
      entries: [
        { category: "read", glyph: "≡", tools: ["read"] },
        { category: "rdd", glyph: "🌹", patterns: ["gentle_review*"], heading: "rdd" },
      ],
    },
    // palette-host-catalog (T1/S1, T2/S3) demo: a catalog in the shape the
    // host's `get_snapshot` commands section answers — pi's builtins
    // included, each with the host's own `runnable` verdict — so the palette
    // and the run_command path are exercisable under `pnpm dev:web` without
    // a child. Non-runnable extension/prompt/skill rows are the proven
    // /name prompt path; non-runnable builtins are the terminal-only rows.
    commands: [
      { name: "review", description: "Run the rdd review flow", runnable: false, source: "extension" },
      { name: "plan", description: "Turn the request into an ODD plan", runnable: false, source: "prompt" },
      { name: "skill:commit", runnable: false, source: "skill" },
      { name: "new", description: "Start a new session", runnable: true, source: "builtin" },
      { name: "resume", description: "Resume another session", runnable: true, source: "builtin" },
      { name: "fork", description: "Create a new fork from a previous user message", runnable: false, source: "builtin" },
      { name: "compact", description: "Manually compact the session context", runnable: true, source: "builtin" },
    ],
    // desktop-rpc T8 demo workspace facts: a session-effective profile label,
    // an MCP inventory, and — T8b — a plausible worktree so the footer's
    // worktree group is exercisable in the preview without a child. The group
    // renders only when a root is known (a created workspace, or an example
    // chat's own cwd); for a plain new chat the footer shows `~/` and no
    // group, exactly like the real app with no root.
    workspace: {
      profile: { label: "opensourcing", active: "opensourcing" },
      mcp: {
        health: "unknown",
        configuredStatus: "present",
        configuredNames: ["github", "linear"],
        registered: [],
        namespaces: ["mcp__github__search", "mcp__linear__issues"],
      },
      worktree: {
        root: "/Users/dev/gentle-shell-desktop",
        branch: "main",
        files: ["src/renderer/app/App.tsx", "src/shared/bridge-types.ts"],
        added: 34,
        deleted: 7,
      },
    },
  };
}

/** T8b: the demo worktree of the working chat (chat-migration) is the
 * unavailable case — the child could not read that root, so the footer
 * renders "unavailable", never zero files and zero lines. Mirrors the usage
 * demo's pending provider: one honest unavailable state beside the count.
 * The root is that chat's own demo cwd (EXAMPLE_CHATS). */
const UNAVAILABLE_WORKTREE_DEMO: WorkspaceInfo = {
  worktree: { root: "/Users/dev/pi", files: [], countsUnavailable: true },
};

/** Severity cycle for the mock "notify" keyword, so all three severities are reachable in the preview. */
const NOTIFY_SEVERITY_CYCLE: readonly NotificationSeverity[] = [
  NOTIFICATION_SEVERITY.INFO,
  NOTIFICATION_SEVERITY.WARNING,
  NOTIFICATION_SEVERITY.ERROR,
];
let nextNotifyIndex = 0;

function mockNotification(text: string): ChatNotification {
  const severity = NOTIFY_SEVERITY_CYCLE[nextNotifyIndex % NOTIFY_SEVERITY_CYCLE.length]!;
  nextNotifyIndex += 1;
  return { message: `Mock notify: ${text}`, severity };
}

let currentState: ChatState = emptyState();
let nextMessageId = 0;
let mockGeneration = 0;
let nextDialogId = 0;

// Opened-directory registry, independent of Pi-owned example history.
// Entries are most-recently-added first and deduplicated.
let persistedWorkspaces: string[] = [];
let exampleChats: readonly ChatSummary[] = EXAMPLE_CHATS;

/** Overrides the mock's session list (tests only; the preview always uses
 * the demo chats). Call with [] to simulate a machine with no pi
 * sessions, or undefined to restore the demo chats. */
export function setMockChats(chats: readonly ChatSummary[] | undefined): void {
  exampleChats = chats ?? EXAMPLE_CHATS;
}

/** The panel never discovers directories from saved session history. */
function workspaceUnion(): WorkspaceList {
  return { directories: [...persistedWorkspaces], persisted: [...persistedWorkspaces] };
}

// T5b — the mock implements the same host-identity contract as the real
// bridge: openChat/newChat mint (or reuse) a host id and answer it, every
// request carries the host id and is rejected for an unknown or no-longer-
// current one, and every pushed state/dialog/error carries the emitting
// host's id. The preview simulates ONE live host at a time (its module
// state is the open chat's state), so a host id that is not current is
// unknown — mirroring the real router's never-fallback rule.
let currentHostId = "";
let nextHostNumber = 1;
/** Chat id -> the host id that opened it: chat.open of an already-open
 * chat reuses that host instead of minting a second one. */
const hostIdByChat = new Map<string, string>();

/** T11 — the directory the mock's picker answers in the browser preview:
 * one fixed demo path so the Add-workspace flow is reachable without a
 * real Electron dialog. Tests override it with setMockDirectoryPick. */
export const DEMO_WORKSPACE_DIRECTORY = "/Users/dev/new-workspace";

/** T11: the mock picker's next answer — a directory path, null (the user
 * cancelled, nothing may change), or undefined (the demo default). */
let directoryPick: string | null | undefined;

/** Overrides what the mock's chooseDirectory() answers next (tests only;
 * the preview always uses the demo pick). Call with null to simulate a
 * cancelled pick, with a path to simulate a choice, or with undefined to
 * restore the demo default. */
export function setMockDirectoryPick(pick: string | null | undefined): void {
  directoryPick = pick;
}

/** Host id -> the directory it was created for (T11): how the mock reuses
 * an already-open workspace's host instead of minting a second one. */
const directoryByHostId = new Map<string, string>();
const statesByHostId = new Map<string, ChatState>();

/** Absolute-path check without node:path (this module runs in the
 * renderer, whose tsconfig has no node types): a leading separator or a
 * drive path. Mirrors what the real main process enforces through
 * validateWorkspaceDirectory. */
function isAbsolutePath(candidate: string): boolean {
  return candidate.startsWith("/") || candidate.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(candidate);
}

// ---------------------------------------------------------------------------
// The available reads (palette-command-arguments T1): the demo model list
// the mock's availableModels() answers — plain options, no invented name
// and no default-selected model (the current one is state.session's own
// identity, the T3 screen's preselection) — plus the closed thinking-level
// union. Tests override either with the setters below; `null` simulates a
// child that cannot answer (the mock answers `unsupported`), `undefined`
// restores the demo data.
// ---------------------------------------------------------------------------

const DEMO_MODELS: readonly ModelOptionView[] = [
  { provider: "anthropic", id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
  { provider: "openai", id: "gpt-5", label: "GPT-5" },
  { provider: "google", id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
];

const DEMO_THINKING_LEVELS: readonly ThinkingLevel[] = Object.values(THINKING_LEVEL);

let mockAvailableModels: readonly ModelOptionView[] | null | undefined;
let mockAvailableThinkingLevels: readonly ThinkingLevel[] | null | undefined;

/** Overrides the mock's availableModels() answer (tests only; the preview
 * always uses the demo list). Pass an array for a custom list, null to
 * simulate a child that cannot answer the read (`unsupported`), or
 * undefined to restore the demo list. */
export function setMockAvailableModels(models: readonly ModelOptionView[] | null | undefined): void {
  mockAvailableModels = models;
}

/** Overrides the mock's availableThinkingLevels() answer (tests only),
 * with the same null/undefined contract as setMockAvailableModels. */
export function setMockAvailableThinkingLevels(levels: readonly ThinkingLevel[] | null | undefined): void {
  mockAvailableThinkingLevels = levels;
}

/** The creation path the Add-workspace flow and workspace.open share
 * (T11/T1): bind a host to the directory — reusing an already-open
 * directory's host instead of minting a second child — and carry the
 * directory as workspacePath. */
async function createWorkspaceFor(directory: string): Promise<OpenChatResult> {
  helpersScenarioToken += 1; // invalidate any growth loop from a previously open chat
  const existing = [...directoryByHostId.entries()].find(([, dir]) => dir === directory)?.[0];
  if (existing !== undefined) {
    currentHostId = existing;
    setState({ ...statesByHostId.get(existing)!, hostId: existing, workspacePath: directory });
    return { hostId: existing, state: currentState };
  }
  const hostId = mintHostId();
  directoryByHostId.set(hostId, directory);
  currentHostId = hostId;
  setState({ ...emptyState(), hostId, workspacePath: directory });
  return { hostId, state: currentState };
}

const stateListeners = new Set<(state: ChatState) => void>();
const errorListeners = new Set<(message: string, hostId: string) => void>();
/** T5d: listeners told when a host is closed, so the renderer can forget
 * that host's snapshot and chat→host mapping. */
const closeListeners = new Set<(hostId: string) => void>();

function mintHostId(): string {
  return `mock-host-${nextHostNumber++}`;
}

/** Rejects anything that is not the live host: an unknown or stopped id
 * must never fall back to the open chat (U6a), in the mock as in main. */
function requireHost(hostId: string): void {
  const state = statesByHostId.get(hostId);
  if (!state) {
    throw new Error(`No live workspace host for id "${hostId}" (unknown or already stopped)`);
  }
  currentHostId = hostId;
  currentState = state;
}

/**
 * Resets every module-level mutable field mockBridge keeps (T6 follow-up).
 * mockBridge.test.ts calls this in `beforeEach` instead of just
 * `newChat()`: `newChat()` alone only resets `currentState`, leaving
 * `homeChoice` (and the accumulating listener sets/id counters) persisted
 * across tests — a test asserting `setupStatus().needsChoice` would then
 * silently depend on whether an earlier test already called chooseHome().
 * Exported (not automatic) because only tests need it: the browser preview
 * this module backs never wants its own state wiped mid-session.
 */
export function resetMockBridge(): void {
  mockGeneration += 1;
  helpersScenarioToken += 1; // invalidate any in-flight D4 growth loop
  homeChoice = undefined;
  currentState = emptyState();
  nextMessageId = 0;
  nextDialogId = 0;
  nextNotifyIndex = 0;
  currentHostId = "";
  nextHostNumber = 1;
  hostIdByChat.clear();
  directoryByHostId.clear();
  statesByHostId.clear();
  directoryPick = undefined;
  persistedWorkspaces = [];
  exampleChats = EXAMPLE_CHATS;
  mockAvailableModels = undefined;
  mockAvailableThinkingLevels = undefined;
  stateListeners.clear();
  errorListeners.clear();
  closeListeners.clear();
}

function setState(state: ChatState): void {
  currentState = state;
  if (state.hostId) statesByHostId.set(state.hostId, state);
  for (const listener of stateListeners) listener(state);
}

function makeMessage(role: ChatMessage["role"], text: string, streaming = false): ChatMessage {
  nextMessageId += 1;
  return { id: `mock-${nextMessageId}`, role, text, streaming };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function streamReply(userText: string): Promise<void> {
  const hostId = currentHostId;
  const generation = mockGeneration;
  const reply = `Got it — you said: "${userText}". This is a mock reply for the browser preview.`;
  const words = reply.split(" ");
  const assistantMessage = makeMessage(MESSAGE_ROLE.ASSISTANT, "", true);

  setState({ ...currentState, working: true, messages: [...currentState.messages, assistantMessage] });

  let text = "";
  for (const [index, word] of words.entries()) {
    await delay(STREAM_DELAY_MS);
    const state = statesByHostId.get(hostId);
    if (!state || mockGeneration !== generation) return;
    text += index === 0 ? word : ` ${word}`;
    setState({
      ...state,
      messages: state.messages.map((message) => (message.id === assistantMessage.id ? { ...message, text } : message)),
    });
  }

  const final = statesByHostId.get(hostId);
  if (!final || mockGeneration !== generation) return;
  setState({
    ...final,
    working: false,
    messages: final.messages.map((message) => message.id === assistantMessage.id ? { ...message, streaming: false } : message),
  });
}

function makeDialogForKeyword(text: string): Dialog | undefined {
  const lower = text.toLowerCase();
  nextDialogId += 1;
  const id = `mock-dialog-${nextDialogId}`;

  if (lower.includes("delete")) {
    return { id, method: "confirm", title: "Confirm this action?", message: text };
  }
  if (lower.includes("name")) {
    return { id, method: "input", title: "Gentle needs a bit more info", placeholder: "Type an answer…" };
  }
  if (lower.includes("?")) {
    return { id, method: "select", title: "Gentle needs a bit more info", options: ["Option A", "Option B", "Option C"] };
  }
  nextDialogId -= 1;
  return undefined;
}

async function openDialog(text: string): Promise<void> {
  const hostId = currentHostId;
  const generation = mockGeneration;
  const dialog = makeDialogForKeyword(text);
  if (!dialog) return;

  await delay(STREAM_DELAY_MS);
  // The dialog carries the host that asked it (T5b), so an answer can be
  // addressed without guessing.
  const state = statesByHostId.get(hostId);
  if (!state || generation !== mockGeneration) return;
  setState({ ...state, working: true, pendingDialogs: [...state.pendingDialogs, { ...dialog, hostId }] });
}

async function failReply(): Promise<void> {
  const hostId = currentHostId;
  const generation = mockGeneration;
  await delay(STREAM_DELAY_MS);
  if (!statesByHostId.has(hostId) || generation !== mockGeneration) return;
  for (const listener of errorListeners) listener("Mock error: pretend this failed for the browser preview.", hostId);
}

function describeAnswer(answer: DialogAnswer): string {
  if ("cancelled" in answer) return "Cancelled.";
  if ("confirmed" in answer) return answer.confirmed ? "Confirmed." : "Declined.";
  return `Got it: "${answer.value}".`;
}

/**
 * D4: seeds "chat-migration" (the one EXAMPLE_CHATS chat marked WORKING)
 * with helpers so the Helpers tab is reachable under `pnpm dev:web`
 * without a real gentle-agents process — a running helper with a thread
 * that grows every ~800ms (text -> thinking -> tool running -> tool done ->
 * text, repeated), a waiting helper, a done one, and two helpers already
 * finished days ago (so the "Earlier" group — see format.ts's
 * partitionHelpers, maintainer decision 2026-09-22 — has something to
 * show in the preview). Only chat-migration gets a scenario: every other
 * chat's helpers stay empty, matching emptyState().
 */
const RUNNING_TASK_ID = "mock-helper-running";
const WAITING_TASK_ID = "mock-helper-waiting";
const DONE_TASK_ID = "mock-helper-done";
const EARLIER_DONE_TASK_ID = "mock-helper-earlier-done";
const EARLIER_FAILED_TASK_ID = "mock-helper-earlier-failed";
const HELPERS_STEP_DELAY_MS = 800;
const HELPERS_SCENARIO_CYCLES = 3;

function makeHelperTask(fields: Pick<HelperTask, "id" | "agent" | "label" | "prompt" | "status"> & Partial<HelperTask>): HelperTask {
  const now = new Date().toISOString();
  return {
    createdAt: now,
    turns: 0,
    toolCalls: 0,
    thread: { version: 0, dropped: 0, items: [] },
    ...fields,
  };
}

function helpersSummaryFor(tasks: readonly HelperTask[]): HelpersSummary {
  return {
    running: tasks.filter((task) => task.status === HELPER_STATUS.RUNNING).length,
    queued: tasks.filter((task) => task.status === HELPER_STATUS.QUEUED).length,
    waiting: tasks.filter((task) => task.status === HELPER_STATUS.WAITING).length,
    finished: tasks.filter((task) => task.status === HELPER_STATUS.DONE || task.status === HELPER_STATUS.FAILED || task.status === HELPER_STATUS.CANCELLED)
      .length,
  };
}

function appendThreadItem(thread: HelperThread, item: HelperThreadItem): HelperThread {
  return { ...thread, items: [...thread.items, item] };
}

function updateLastToolItem(thread: HelperThread, patch: Partial<HelperThreadToolItem>): HelperThread {
  const lastToolIndex = thread.items.map((item) => item.kind).lastIndexOf("tool");
  if (lastToolIndex === -1) return thread;

  const items = thread.items.slice();
  items[lastToolIndex] = { ...(items[lastToolIndex] as HelperThreadToolItem), ...patch };
  return { ...thread, items };
}

const TOOL_STEPS: ReadonlyArray<{ readonly name: string; readonly args: Record<string, unknown> }> = [
  { name: "Read", args: { paths: ["src/config/schema.ts", "src/config/loader.ts", "src/config/defaults.ts"] } },
  { name: "Edit", args: { path: "src/config/schema.ts" } },
];

/** One step per ~800ms tick of the running helper's thread: a fixed script (not an infinite loop) so the mock never grows unbounded memory. */
const RUNNING_TASK_STEPS: ReadonlyArray<(thread: HelperThread, callId: string) => HelperThread> = [
  (thread) => appendThreadItem(thread, { kind: "text", text: "Migrating the config schema to the new shape." }),
  (thread) => appendThreadItem(thread, { kind: "thinking", text: "Checking which fields moved before touching the loader." }),
  (thread, callId) => {
    const step = TOOL_STEPS[thread.items.filter((item) => item.kind === "tool").length % TOOL_STEPS.length]!;
    return appendThreadItem(thread, { kind: "tool", callId, name: step.name, args: step.args, running: true });
  },
  (thread) => updateLastToolItem(thread, { running: false, output: "done" }),
  (thread) => appendThreadItem(thread, { kind: "text", text: "Schema fields migrated, updating the loader next." }),
];

let helpersScenarioToken = 0;

function updateRunningHelperThread(step: (thread: HelperThread, callId: string) => HelperThread, callId: string): void {
  const tasks = currentState.helpers.tasks.map((task) =>
    task.id === RUNNING_TASK_ID ? { ...task, thread: step(task.thread, callId), lastActivityAt: new Date().toISOString() } : task,
  );
  if (tasks === currentState.helpers.tasks) return; // the running task already left this chat (switched away)
  setState({ ...currentState, helpers: { ...currentState.helpers, tasks } });
}

async function runHelpersScenario(token: number): Promise<void> {
  let stepId = 0;
  for (let cycle = 0; cycle < HELPERS_SCENARIO_CYCLES; cycle += 1) {
    for (const step of RUNNING_TASK_STEPS) {
      await delay(HELPERS_STEP_DELAY_MS);
      if (token !== helpersScenarioToken) return;
      stepId += 1;
      updateRunningHelperThread(step, `mock-call-${stepId}`);
    }
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startHelpersScenario(): void {
  helpersScenarioToken += 1;
  const token = helpersScenarioToken;
  const now = new Date().toISOString();
  const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS).toISOString();
  const oneDayAgo = new Date(Date.now() - DAY_MS).toISOString();

  const tasks: HelperTask[] = [
    makeHelperTask({
      id: RUNNING_TASK_ID,
      agent: "general-purpose",
      label: "Migrate the config schema",
      prompt: "Move the deprecated config fields to their new location and update the loader.",
      status: HELPER_STATUS.RUNNING,
      createdAt: now,
      startedAt: now,
      turns: 1,
    }),
    makeHelperTask({
      id: WAITING_TASK_ID,
      agent: "general-purpose",
      label: "Confirm the breaking change",
      prompt: "Ask whether removing the old field name is acceptable.",
      status: HELPER_STATUS.WAITING,
      createdAt: now,
      startedAt: now,
      turns: 1,
      thread: {
        version: 0,
        dropped: 0,
        items: [
          { kind: "text", text: "Ready to drop the old `configPath` field — confirm?" },
          { kind: "note", text: "Waiting on your answer." },
        ],
      },
    }),
    makeHelperTask({
      id: DONE_TASK_ID,
      agent: "general-purpose",
      label: "Audit config readers",
      prompt: "Find every place that reads the config file directly.",
      status: HELPER_STATUS.DONE,
      createdAt: now,
      startedAt: now,
      endedAt: now,
      turns: 3,
      toolCalls: 1,
      thread: {
        version: 0,
        dropped: 0,
        items: [
          { kind: "text", text: "Auditing config readers across the codebase." },
          { kind: "tool", callId: "mock-call-audit-1", name: "Grep", args: { pattern: "readConfig" }, running: false, output: "3 matches" },
          { kind: "text", text: "Found 3 call sites, all already using the loader — no direct file reads left." },
        ],
      },
    }),
    makeHelperTask({
      id: EARLIER_DONE_TASK_ID,
      agent: "general-purpose",
      label: "Draft the migration plan",
      prompt: "Write up the plan for migrating the config schema.",
      status: HELPER_STATUS.DONE,
      createdAt: twoDaysAgo,
      startedAt: twoDaysAgo,
      endedAt: twoDaysAgo,
      turns: 2,
      toolCalls: 1,
      thread: {
        version: 0,
        dropped: 0,
        items: [{ kind: "text", text: "Drafted the migration plan for the deprecated config fields." }],
      },
    }),
    makeHelperTask({
      id: EARLIER_FAILED_TASK_ID,
      agent: "general-purpose",
      label: "Check the staging deploy",
      prompt: "Verify the staging deploy picked up the schema change.",
      status: HELPER_STATUS.FAILED,
      createdAt: oneDayAgo,
      startedAt: oneDayAgo,
      endedAt: oneDayAgo,
      turns: 1,
      toolCalls: 1,
      error: "Staging deploy webhook timed out.",
      thread: {
        version: 0,
        dropped: 0,
        items: [{ kind: "text", text: "Checking the staging deploy for the schema change." }],
      },
    }),
  ];

  const helpers: HelpersActivity = { summary: helpersSummaryFor(tasks), tasks, stopChannel: { available: true } };
  setState({ ...currentState, helpers });
  void runHelpersScenario(token);
}

/** How long the mock's Stop request leaves the helper running before the
 * async transition lands (desktop-rpc T6: a cancel_subagent response may
 * still report the helper as running; the real transition arrives later
 * as an agents_update state push — the mock mirrors exactly that so the
 * control is exercisable without a child). */
const STOP_TRANSITION_DELAY_MS = 1200;

async function stopHelper(hostId: string, id: string): Promise<StopHelperOutcome> {
  requireHost(hostId);
  const task = currentState.helpers.tasks.find((entry) => entry.id === id);
  if (!task || !CANCELLABLE_MOCK_STATUSES.has(task.status)) return "not_tracked";

  // The response resolves "requested" while the helper is STILL running;
  // the transition arrives later as a state push, like the wire's
  // agents_update event does.
  const token = helpersScenarioToken;
  setTimeout(() => {
    if (token !== helpersScenarioToken) return; // the chat was switched away
    const tasks = currentState.helpers.tasks.map((entry) =>
      entry.id === id ? { ...entry, status: HELPER_STATUS.CANCELLED, endedAt: new Date().toISOString(), lastStep: "cancelled" } : entry,
    );
    setState({ ...currentState, helpers: { ...currentState.helpers, tasks, summary: helpersSummaryFor(tasks) } });
  }, STOP_TRANSITION_DELAY_MS);
  return "requested";
}

const CANCELLABLE_MOCK_STATUSES: ReadonlySet<string> = new Set([HELPER_STATUS.QUEUED, HELPER_STATUS.RUNNING]);

/** What the preview claims to be. The real bridge asks the packaged app. */
const MOCK_APP_VERSION = "0.1.0";
/** The demo attachment the preview inserts — a path, never a file read. */
const DEMO_ATTACHMENT_PATH = "/home/dev/gentle-shell-desktop/package.json";
/** Test/deep-link override for the mock file picker (null = cancelled). */
let filePick: string | null | undefined;
/** Frameless-window state the mock can toggle; there is no OS window here. */
let maximized = false;

/** Overrides what the mock's chooseFile() answers next (tests only;
 * undefined restores the demo path, null simulates a cancelled pick). */
export function setMockFilePick(pick: string | null | undefined): void {
  filePick = pick;
}

function closeHost(hostId: string): void {
  requireHost(hostId);
  helpersScenarioToken += 1;
  for (const [chatId, owner] of hostIdByChat) {
    if (owner === hostId) hostIdByChat.delete(chatId);
  }
  directoryByHostId.delete(hostId);
  statesByHostId.delete(hostId);
  currentHostId = "";
  for (const listener of closeListeners) listener(hostId);
}

export const mockBridge: GentleBridge = {
  async listChats(): Promise<ChatSummary[]> {
    return [...exampleChats];
  },

  async openChat(id: string): Promise<OpenChatResult> {
    helpersScenarioToken += 1; // invalidate any growth loop from a previously open chat
    // An already-open chat reuses its host instead of minting a second
    // one, mirroring the real router's chat.open reuse rule.
    const hostId = hostIdByChat.get(id) ?? mintHostId();
    hostIdByChat.set(id, hostId);
    currentHostId = hostId;
    const directory = exampleChats.find((chat) => chat.id === id)?.cwd;
    if (directory) directoryByHostId.set(hostId, directory);
    setState({
      ...(statesByHostId.get(hostId) ?? emptyState()),
      hostId,
      workspacePath: directory,
      // Only the worktree is overridden: the demo keeps the profile and MCP
      // inventory the same chat already showed.
      ...(id === "chat-migration"
        ? { workspace: { ...emptyState().workspace, ...UNAVAILABLE_WORKTREE_DEMO } }
        : {}),
    });
    if (id === "chat-migration") startHelpersScenario();
    return { hostId, state: currentState };
  },

  async newChat(): Promise<OpenChatResult> {
    helpersScenarioToken += 1;
    const hostId = mintHostId();
    currentHostId = hostId;
    setState({ ...emptyState(), hostId });
    return { hostId, state: currentState };
  },

  async sendMessage(hostId: string, text: string): Promise<PromptResult> {
    requireHost(hostId);
    // Mirrors the real ChatHost/PiSession contract (T5): a declined prompt
    // resolves { queued: false, reason } instead of notifying onError, so
    // the caller reports it exactly once.
    if (currentState.working) {
      return { queued: false, reason: "Gentle is still working" };
    }

    const userMessage = makeMessage(MESSAGE_ROLE.USER, text);
    setState({ ...currentState, messages: [...currentState.messages, userMessage] });

    // Dialog and error scenarios await their own (short) delay before
    // resolving, so callers observing the resolved state right after
    // `await sendMessage(...)` already see the pushed dialog/error;
    // streamReply is intentionally fire-and-forget instead — its "working"
    // state and streamed text should render immediately, not after the
    // whole multi-word reply finishes.
    const lower = text.toLowerCase();
    if (lower.includes("fail")) {
      await failReply();
      return { queued: true };
    }
    if (lower.includes("notify")) {
      const generation = mockGeneration;
      await delay(STREAM_DELAY_MS);
      const state = statesByHostId.get(hostId);
      if (!state || generation !== mockGeneration) return { queued: true };
      setState({ ...state, notifications: [...(state.notifications ?? []), mockNotification(text)] });
      return { queued: true };
    }
    if (lower.includes("delete") || lower.includes("name") || lower.includes("?")) {
      await openDialog(text);
      return { queued: true };
    }
    void streamReply(text);
    return { queued: true };
  },

  async abort(hostId: string): Promise<void> {
    requireHost(hostId);
    setState({ ...currentState, working: false });
  },

  async answerDialog(hostId: string, id: string, answer: DialogAnswer): Promise<void> {
    requireHost(hostId);
    const remaining = currentState.pendingDialogs.filter((dialog) => dialog.id !== id);
    const acknowledgement = makeMessage(MESSAGE_ROLE.ASSISTANT, describeAnswer(answer));

    setState({
      ...currentState,
      pendingDialogs: remaining,
      working: remaining.length > 0,
      messages: [...currentState.messages, acknowledgement],
    });
  },

  // T5c: the mock keeps ONE live host's state (see the module comment at
  // the top); the refresh answers exactly that state — the same contract
  // main's router implements, the addressed host's current state as the
  // bridge holds it. requireHost refuses any other id, so a refresh never
  // falls back to "whichever chat is open".
  async refreshChat(hostId: string): Promise<ChatState> {
    requireHost(hostId);
    return currentState;
  },

  // T5d: closes exactly the addressed host — it stops answering every
  // request, its chat reuse entries are evicted so a re-open mints a
  // FRESH host, and the close is reported to onClosed listeners (the
  // renderer forgets the host on that report). No close button exists in
  // the UI; this is reachable through the bridge only.
  async closeChat(hostId: string): Promise<void> {
    closeHost(hostId);
  },

  // T11: the mock picker answers the demo pick (or a test's override);
  // null is a cancellation the caller must treat as "change nothing", so
  // only an UNSET pick falls back to the demo default — `??` would swallow
  // the null cancellation into the demo path.
  async chooseDirectory(): Promise<string | null> {
    return directoryPick === undefined ? DEMO_WORKSPACE_DIRECTORY : directoryPick;
  },

  // T11: binds a fresh host to a validated-by-main directory — in the
  // mock, main is simulated, so the directory is trusted. Mirrors the real
  // router: an already-open directory reuses its host instead of minting a
  // second child, and the created host's state carries the directory as
  // workspacePath (the footer's path).
  createWorkspace(directory: string): Promise<OpenChatResult> {
    return createWorkspaceFor(directory);
  },

  // Registry-only navigation; removing a directory closes its hosts while
  // leaving the example Pi history untouched. Open is fresh/live reuse.
  async listWorkspaces(): Promise<WorkspaceList> {
    return workspaceUnion();
  },

  async addWorkspace(directory: string): Promise<WorkspaceList> {
    if (directory.length === 0 || !isAbsolutePath(directory)) {
      throw new Error(`"${directory}" is not an absolute path — the workspace registry stores absolute directories only`);
    }
    if (!persistedWorkspaces.includes(directory)) persistedWorkspaces = [directory, ...persistedWorkspaces];
    return workspaceUnion();
  },

  async removeWorkspace(directory: string): Promise<WorkspaceList> {
    const hosts = [...directoryByHostId].filter(([, cwd]) => cwd === directory).map(([hostId]) => hostId);
    for (const hostId of hosts) closeHost(hostId);
    persistedWorkspaces = persistedWorkspaces.filter((entry) => entry !== directory);
    return workspaceUnion();
  },

  openWorkspace(directory: string): Promise<OpenChatResult> {
    // The same creation path as the Add-workspace flow (createWorkspace),
    // minus the picker — no duplicated host lifecycle logic.
    return createWorkspaceFor(directory);
  },

  onClosed(callback: (hostId: string) => void): () => void {
    closeListeners.add(callback);
    return () => closeListeners.delete(callback);
  },

  onState(callback: (state: ChatState) => void): () => void {
    stateListeners.add(callback);
    return () => stateListeners.delete(callback);
  },

  onError(callback: (message: string, hostId: string) => void): () => void {
    errorListeners.add(callback);
    return () => errorListeners.delete(callback);
  },

  async setupStatus(): Promise<SetupStatus> {
    const override = firstRunOverride();
    const needsChoice = override ?? homeChoice === undefined;
    return { needsChoice, detection: FAKE_DETECTION };
  },

  async chooseHome(mode: HomeMode): Promise<void> {
    homeChoice = mode;
  },

  // The shell's own chrome in the browser preview: the facts the footer and
  // settings dialog show, window controls that can only flip a local flag
  // (there is no OS window here), and a file picker answering the demo path.
  async appInfo(): Promise<AppInfo> {
    return { version: MOCK_APP_VERSION };
  },

  async minimizeWindow(): Promise<void> {},

  async toggleMaximizeWindow(): Promise<boolean> {
    maximized = !maximized;
    return maximized;
  },

  async closeWindow(): Promise<void> {},

  // palette-host-catalog S4: the host's `run_command` path, mocked with the
  // same closed answer set — executed, a refusal, or (never here) the
  // retryable session_switching. `new` and `resume` replace the session
  // IN-CHILD (the same host id keeps answering — how the real switch
  // behaves), so the pane's requests keep being addressed correctly.
  async runCommand(hostId: string, name: string, args?: string): Promise<ChatCommandRunResult> {
    requireHost(hostId);
    if (name === "new") {
      helpersScenarioToken += 1;
      setState({ ...emptyState(), hostId });
      return { kind: "executed" };
    }
    if (name === "resume") {
      // args is the session FILE path (S5); an unknown one answers the
      // host's refusal, never a throw.
      const chat = args === undefined ? undefined : exampleChats.find((entry) => entry.path === args);
      if (!chat) return { kind: "refused", reason: "terminal_only" };
      helpersScenarioToken += 1;
      hostIdByChat.set(chat.id, hostId);
      setState({ ...(statesByHostId.get(hostId) ?? emptyState()), hostId, workspacePath: chat.cwd });
      if (chat.id === "chat-migration") startHelpersScenario();
      return { kind: "executed" };
    }
    // Every other catalog name — the remaining builtins included — lives in
    // pi's TUI, exactly like the host's own answer set.
    return { kind: "refused", reason: "terminal_only" };
  },

  async chooseFile(): Promise<string | null> {
    return filePick === undefined ? DEMO_ATTACHMENT_PATH : filePick;
  },

  // palette-command-arguments T1 (S2/S3): the demo answers for the two
  // available reads, overridden per test with setMockAvailableModels /
  // setMockAvailableThinkingLevels (null = a child that cannot answer).
  // requireHost first, like every other host-addressed request.
  async availableModels(hostId: string): Promise<AvailableModelsResult> {
    requireHost(hostId);
    if (mockAvailableModels === null) return { kind: "unsupported" };
    return { kind: "ok", truncated: false, models: [...(mockAvailableModels ?? DEMO_MODELS)] };
  },

  async availableThinkingLevels(hostId: string): Promise<AvailableThinkingLevelsResult> {
    requireHost(hostId);
    if (mockAvailableThinkingLevels === null) return { kind: "unsupported" };
    return { kind: "ok", levels: [...(mockAvailableThinkingLevels ?? DEMO_THINKING_LEVELS)] };
  },

  stopHelper,
};
