import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeLine } from "./codec";
import { INITIAL_CHAT_STATE, MAX_NOTIFICATIONS, reduceChat, type ChatState } from "./chatReducer";
import type { RpcEvent } from "./types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readFixtureEvents(name: string): RpcEvent[] {
  const raw = readFileSync(path.join(__dirname, "__fixtures__", name), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const decoded = decodeLine(line);
      if ("kind" in decoded) throw new Error(`fixture line decoded as unknown: ${line}`);
      return decoded;
    });
}

function replay(events: RpcEvent[]): ChatState {
  // Wrapped (not `events.reduce(reduceChat, ...)`) so Array.reduce's
  // numeric currentIndex never lands in reduceChat's optional `now` param.
  return events.reduce((state, event) => reduceChat(state, event), INITIAL_CHAT_STATE);
}

describe("reduceChat: working state", () => {
  it("agent_start sets working true", () => {
    const state = reduceChat(INITIAL_CHAT_STATE, { type: "agent_start" });
    expect(state.working).toBe(true);
  });

  it("agent_end sets working false", () => {
    const working = { ...INITIAL_CHAT_STATE, working: true };
    expect(reduceChat(working, { type: "agent_end" }).working).toBe(false);
  });

  it("agent_settled sets working false", () => {
    const working = { ...INITIAL_CHAT_STATE, working: true };
    expect(reduceChat(working, { type: "agent_settled" }).working).toBe(false);
  });
});

describe("reduceChat: assistant message streaming", () => {
  it("message_start for an assistant message opens a new empty streaming message", () => {
    const state = reduceChat(INITIAL_CHAT_STATE, {
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    expect(state.messages).toEqual([{ id: "msg-0", role: "assistant", text: "", streaming: true }]);
  });

  it("message_start for a non-assistant message is a no-op", () => {
    const state = reduceChat(INITIAL_CHAT_STATE, {
      type: "message_start",
      message: { role: "toolResult", content: [] },
    });
    expect(state).toBe(INITIAL_CHAT_STATE);
  });

  it("text_delta appends to the currently open assistant message", () => {
    let state = reduceChat(INITIAL_CHAT_STATE, {
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    state = reduceChat(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello " },
    });
    state = reduceChat(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "world" },
    });
    expect(state.messages[0]?.text).toBe("Hello world");
    expect(state.messages[0]?.streaming).toBe(true);
  });

  it("text_delta with no open assistant message is a no-op", () => {
    const state = reduceChat(INITIAL_CHAT_STATE, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "orphaned" },
    });
    expect(state).toBe(INITIAL_CHAT_STATE);
  });

  it("message_end finalizes text from the authoritative message content and clears streaming", () => {
    let state = reduceChat(INITIAL_CHAT_STATE, {
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    state = reduceChat(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
    });
    state = reduceChat(state, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Hello world" }] },
    });
    expect(state.messages).toEqual([{ id: "msg-0", role: "assistant", text: "Hello world", streaming: false }]);
  });

  it("message_end without text content blocks keeps the accumulated delta text", () => {
    let state = reduceChat(INITIAL_CHAT_STATE, {
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    state = reduceChat(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "kept" },
    });
    state = reduceChat(state, { type: "message_end", message: { role: "assistant" } });
    expect(state.messages[0]?.text).toBe("kept");
    expect(state.messages[0]?.streaming).toBe(false);
  });

  it("a tool-only assistant message stays present while streaming (typing placeholder)", () => {
    let state = reduceChat(INITIAL_CHAT_STATE, {
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    state = reduceChat(state, {
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "bash" },
    });
    expect(state.messages).toEqual([{ id: "msg-0", role: "assistant", text: "", streaming: true }]);
  });

  it("message_end drops an assistant message that finalizes with empty trimmed text (tool-only or thinking-only content)", () => {
    let state = reduceChat(INITIAL_CHAT_STATE, {
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    state = reduceChat(state, {
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "bash" },
    });
    state = reduceChat(state, {
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { id: "call_1", name: "bash", arguments: {} } },
    });
    state = reduceChat(state, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: {} }],
      },
    });
    expect(state.messages).toEqual([]);
  });

  it("message_end drops an assistant message whose authoritative text is only whitespace", () => {
    let state = reduceChat(INITIAL_CHAT_STATE, {
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    state = reduceChat(state, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "   " }] },
    });
    expect(state.messages).toEqual([]);
  });

  it("message_end dropping an empty assistant message keeps ids contiguous for the next message", () => {
    let state = reduceChat(INITIAL_CHAT_STATE, {
      type: "message_start",
      message: { role: "user", content: [] },
    });
    state = { ...state, messages: [{ id: "msg-0", role: "user" as const, text: "hi" }] };
    state = reduceChat(state, {
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    expect(state.messages[1]?.id).toBe("msg-1");
    state = reduceChat(state, {
      type: "message_end",
      message: { role: "assistant", content: [] },
    });
    expect(state.messages).toEqual([{ id: "msg-0", role: "user", text: "hi" }]);

    state = reduceChat(state, {
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    expect(state.messages[1]?.id).toBe("msg-1");
  });
});

describe("reduceChat: thinking, toolcall, tool_execution never touch messages", () => {
  it.each([
    { type: "thinking_start" as const, contentIndex: 0 },
    { type: "thinking_delta" as const, contentIndex: 0, delta: "..." },
    { type: "thinking_end" as const, contentIndex: 0, content: "..." },
    { type: "toolcall_start" as const, contentIndex: 1, id: "call_1", toolName: "bash" },
    { type: "toolcall_delta" as const, contentIndex: 1, delta: "{}" },
    { type: "toolcall_end" as const, contentIndex: 1, toolCall: {} },
  ])("$type bumps activity but leaves messages untouched", (assistantMessageEvent) => {
    const before = { ...INITIAL_CHAT_STATE, messages: [{ id: "msg-0", role: "assistant" as const, text: "" }] };
    const after = reduceChat(before, { type: "message_update", assistantMessageEvent });
    expect(after.messages).toBe(before.messages);
    expect(after.activity).toBe(before.activity + 1);
  });

  it.each(["tool_execution_start", "tool_execution_update", "tool_execution_end"] as const)(
    "%s bumps activity but leaves messages untouched",
    (type) => {
      const before = { ...INITIAL_CHAT_STATE, messages: [{ id: "msg-0", role: "assistant" as const, text: "" }] };
      const event: RpcEvent =
        type === "tool_execution_end"
          ? { type, toolCallId: "call_1", toolName: "bash", isError: false }
          : { type, toolCallId: "call_1", toolName: "bash" };
      const after = reduceChat(before, event);
      expect(after.messages).toBe(before.messages);
      expect(after.activity).toBe(before.activity + 1);
    },
  );
});

describe("reduceChat: extension UI dialogs", () => {
  it("pushes a select dialog", () => {
    const state = reduceChat(INITIAL_CHAT_STATE, {
      type: "extension_ui_request",
      id: "dlg-1",
      method: "select",
      title: "Allow?",
      options: ["Allow", "Block"],
    });
    expect(state.pendingDialogs).toEqual([{ id: "dlg-1", method: "select", title: "Allow?", options: ["Allow", "Block"] }]);
  });

  it("pushes a confirm dialog with its message", () => {
    const state = reduceChat(INITIAL_CHAT_STATE, {
      type: "extension_ui_request",
      id: "dlg-2",
      method: "confirm",
      title: "Clear session?",
      message: "All messages will be lost.",
    });
    expect(state.pendingDialogs).toEqual([
      { id: "dlg-2", method: "confirm", title: "Clear session?", message: "All messages will be lost." },
    ]);
  });

  it("pushes an input dialog with its placeholder", () => {
    const state = reduceChat(INITIAL_CHAT_STATE, {
      type: "extension_ui_request",
      id: "dlg-3",
      method: "input",
      title: "Enter a value",
      placeholder: "type something...",
    });
    expect(state.pendingDialogs).toEqual([
      { id: "dlg-3", method: "input", title: "Enter a value", placeholder: "type something..." },
    ]);
  });

  it("pushes an editor dialog with its prefill", () => {
    const state = reduceChat(INITIAL_CHAT_STATE, {
      type: "extension_ui_request",
      id: "dlg-4",
      method: "editor",
      title: "Edit",
      prefill: "line 1",
    });
    expect(state.pendingDialogs).toEqual([{ id: "dlg-4", method: "editor", title: "Edit", prefill: "line 1" }]);
  });

  it("ignores fire-and-forget methods that carry no chat state (setTitle)", () => {
    const state = reduceChat(INITIAL_CHAT_STATE, {
      type: "extension_ui_request",
      id: "dlg-5",
      method: "setTitle",
      title: "Untitled",
    });
    expect(state).toBe(INITIAL_CHAT_STATE);
  });
});

describe("reduceChat: keyed statuses and notifications (U1, desktop-rpc T2)", () => {
  function decodedEvent(value: Record<string, unknown>): RpcEvent {
    const decoded = decodeLine(JSON.stringify(value));
    if ("kind" in decoded) throw new Error("expected a decoded extension_ui_request");
    return decoded;
  }

  function setStatus(id: string, fields: Record<string, unknown>): RpcEvent {
    return decodedEvent({ type: "extension_ui_request", id, method: "setStatus", ...fields });
  }

  function notify(id: string, fields: Record<string, unknown>): RpcEvent {
    return decodedEvent({ type: "extension_ui_request", id, method: "notify", ...fields });
  }

  it("folds a setStatus frame into state.statuses keyed by its wire statusKey", () => {
    const state = reduceChat(INITIAL_CHAT_STATE, setStatus("u-1", { statusKey: "gentle-todo", statusText: "2 tasks open" }));
    expect(state.statuses).toEqual({ "gentle-todo": "2 tasks open" });
  });

  it("a second setStatus for the same key replaces the entry instead of duplicating it", () => {
    let state = reduceChat(INITIAL_CHAT_STATE, setStatus("u-1", { statusKey: "gentle-todo", statusText: "2 tasks open" }));
    state = reduceChat(state, setStatus("u-2", { statusKey: "gentle-todo", statusText: "1 task open" }));
    expect(state.statuses).toEqual({ "gentle-todo": "1 task open" });
  });

  it("a setStatus frame without statusText clears that key and keeps other keys", () => {
    let state = reduceChat(INITIAL_CHAT_STATE, setStatus("u-1", { statusKey: "gentle-todo", statusText: "2 tasks open" }));
    state = reduceChat(state, setStatus("u-2", { statusKey: "other-ext", statusText: "busy" }));
    state = reduceChat(state, setStatus("u-3", { statusKey: "gentle-todo" }));
    expect(state.statuses).toEqual({ "other-ext": "busy" });
  });

  it("a clear for a key that was never set leaves the state object untouched", () => {
    const state = reduceChat(INITIAL_CHAT_STATE, setStatus("u-1", { statusKey: "never-set" }));
    expect(state).toBe(INITIAL_CHAT_STATE);
  });

  it("a notify frame carries its message and wire severity into state.notifications", () => {
    let state = reduceChat(INITIAL_CHAT_STATE, notify("u-1", { message: "Command blocked by user", notifyType: "warning" }));
    state = reduceChat(state, notify("u-2", { message: "Sync finished" }));
    state = reduceChat(state, notify("u-3", { message: "Disk full", notifyType: "error" }));
    expect(state.notifications).toEqual([
      { message: "Command blocked by user", severity: "warning" },
      { message: "Sync finished", severity: "info" },
      { message: "Disk full", severity: "error" },
    ]);
  });

  it("neither setStatus nor notify ever adds a conversation message", () => {
    const before = { ...INITIAL_CHAT_STATE, messages: [{ id: "msg-0", role: "assistant" as const, text: "hi" }] };
    const state = reduceChat(
      reduceChat(before, setStatus("u-1", { statusKey: "k", statusText: "v" })),
      notify("u-2", { message: "note", notifyType: "warning" }),
    );
    expect(state.messages).toBe(before.messages);
  });

  it("ignores a malformed setStatus frame (missing or non-string statusKey, non-string statusText) without throwing", () => {
    const noKey = { type: "extension_ui_request", id: "u-1", method: "setStatus", statusText: "x" } as unknown as RpcEvent;
    const badKey = { type: "extension_ui_request", id: "u-2", method: "setStatus", statusKey: 7 } as unknown as RpcEvent;
    const badText = {
      type: "extension_ui_request",
      id: "u-3",
      method: "setStatus",
      statusKey: "gentle-todo",
      statusText: 42,
    } as unknown as RpcEvent;
    expect(reduceChat(INITIAL_CHAT_STATE, noKey)).toBe(INITIAL_CHAT_STATE);
    expect(reduceChat(INITIAL_CHAT_STATE, badKey)).toBe(INITIAL_CHAT_STATE);
    expect(reduceChat(INITIAL_CHAT_STATE, badText)).toBe(INITIAL_CHAT_STATE);
  });

  it("ignores a malformed notify frame (missing message, wrong-typed or unknown severity) without throwing", () => {
    const noMessage = { type: "extension_ui_request", id: "u-1", method: "notify", notifyType: "info" } as unknown as RpcEvent;
    const badMessage = { type: "extension_ui_request", id: "u-2", method: "notify", message: true } as unknown as RpcEvent;
    const badSeverity = {
      type: "extension_ui_request",
      id: "u-3",
      method: "notify",
      message: "hi",
      notifyType: "urgent",
    } as unknown as RpcEvent;
    expect(reduceChat(INITIAL_CHAT_STATE, noMessage)).toBe(INITIAL_CHAT_STATE);
    expect(reduceChat(INITIAL_CHAT_STATE, badMessage)).toBe(INITIAL_CHAT_STATE);
    expect(reduceChat(INITIAL_CHAT_STATE, badSeverity)).toBe(INITIAL_CHAT_STATE);
  });

  it("caps state.notifications at MAX_NOTIFICATIONS, dropping the oldest first", () => {
    let state = INITIAL_CHAT_STATE;
    for (let i = 1; i <= MAX_NOTIFICATIONS + 1; i += 1) {
      state = reduceChat(state, notify(`u-${i}`, { message: `n-${i}` }));
    }
    expect(state.notifications!.map((notification) => notification.message)).toEqual(
      Array.from({ length: MAX_NOTIFICATIONS }, (_, i) => `n-${i + 2}`),
    );
  });

  it("keeps the arrival order of the survivors while the cap is exceeded repeatedly", () => {
    let state = INITIAL_CHAT_STATE;
    for (let i = 1; i <= MAX_NOTIFICATIONS * 2; i += 1) {
      state = reduceChat(state, notify(`u-${i}`, { message: `n-${i}`, notifyType: "info" }));
    }
    expect(state.notifications!.map((notification) => notification.message)).toEqual(
      Array.from({ length: MAX_NOTIFICATIONS }, (_, i) => `n-${MAX_NOTIFICATIONS + 1 + i}`),
    );
    expect(state.notifications!.every((notification) => notification.severity === "info")).toBe(true);
  });

  it("never folds a gentle-desktop-rpc setWidget frame into chat state (interception lives in PiSession)", () => {
    const desktop = decodedEvent({
      type: "extension_ui_request",
      id: "u-1",
      method: "setWidget",
      widgetKey: "gentle-desktop-rpc",
      widgetLines: ['{"schema":"gentle-shell.desktop-rpc/v1","kind":"response","requestId":"r-1","data":{"ok":true}}'],
    });
    expect(reduceChat(INITIAL_CHAT_STATE, desktop)).toBe(INITIAL_CHAT_STATE);
  });

  it("replays the status-notify fixture: statuses end cleared, notifications keep severity, transcript untouched", () => {
    const state = replay(readFixtureEvents("status-notify.jsonl"));
    expect(state.statuses).toEqual({});
    expect(state.notifications).toEqual([
      { message: "Command blocked by user", severity: "warning" },
      { message: "Sync finished", severity: "info" },
    ]);
    expect(state.messages).toEqual([]);
    expect(state.helpers).toEqual({ summary: { running: 0, queued: 0, waiting: 0, finished: 0 }, tasks: [] });
    expect(state.pendingDialogs).toEqual([]);
  });
});

describe("reduceChat: errors and unhandled events", () => {
  it("extension_error sets lastError", () => {
    const state = reduceChat(INITIAL_CHAT_STATE, {
      type: "extension_error",
      extensionPath: "/ext.ts",
      event: "tool_call",
      error: "boom",
    });
    expect(state.lastError).toBe("boom");
  });

  it("turn_start/turn_end/response are no-ops", () => {
    expect(reduceChat(INITIAL_CHAT_STATE, { type: "turn_start" })).toBe(INITIAL_CHAT_STATE);
    expect(reduceChat(INITIAL_CHAT_STATE, { type: "turn_end" })).toBe(INITIAL_CHAT_STATE);
    expect(
      reduceChat(INITIAL_CHAT_STATE, { type: "response", command: "prompt", success: true }),
    ).toBe(INITIAL_CHAT_STATE);
  });
});

describe("reduceChat: fixture replays", () => {
  it("a prompt turn with thinking, a tool call and streamed text ends with only the final assistant text visible", () => {
    const state = replay(readFixtureEvents("prompt-turn.jsonl"));
    expect(state.messages).toEqual([
      { id: "msg-0", role: "assistant", text: "The README describes Gentle Shell.", streaming: false },
    ]);
    expect(state.working).toBe(false);
    expect(state.pendingDialogs).toEqual([]);
    expect(state.lastError).toBeUndefined();
    // 3 thinking + 3 toolcall + 3 tool_execution deltas.
    expect(state.activity).toBe(9);
  });

  it("a turn whose assistant message only calls a tool leaves no empty message behind after message_end", () => {
    const state = replay(readFixtureEvents("tool-only-message.jsonl"));
    expect(state.messages).toEqual([]);
    expect(state.working).toBe(false);
  });

  it("a select dialog mid-turn surfaces in pendingDialogs and leaves the agent working", () => {
    const state = replay(readFixtureEvents("select-dialog.jsonl"));
    expect(state.working).toBe(true);
    expect(state.pendingDialogs).toEqual([
      { id: "dlg-1", method: "select", title: "Allow dangerous command?", options: ["Allow", "Block"] },
    ]);
  });

  it("an extension_error settles into lastError once the agent settles", () => {
    const state = replay(readFixtureEvents("extension-error.jsonl"));
    expect(state.lastError).toBe("Cannot read properties of undefined (reading 'foo')");
    expect(state.working).toBe(false);
  });

  it("replays the helpers-activity fixture, skipping the malformed frame and ignoring the other extension's widget", () => {
    const state = replay(readFixtureEvents("helpers-activity.jsonl"));

    // Order is running, waiting, queued, then finished (task-2 is still
    // "waiting" so it ranks above the finished task-1, per the helpers
    // retention/ordering rules in the setWidget branch).
    expect(state.helpers).toEqual({
      summary: { running: 0, queued: 0, waiting: 1, finished: 1 },
      tasks: [
        {
          id: "task-2",
          agent: "writer",
          label: "Draft the summary",
          prompt: "Write it up",
          status: "waiting",
          createdAt: "2026-09-22T10:00:02.000Z",
          turns: 1,
          toolCalls: 0,
          thread: { version: 1, dropped: 0, items: [{ kind: "note", text: "Needs your input." }] },
        },
        {
          id: "task-1",
          agent: "researcher",
          label: "Research the API",
          prompt: "Look into the auth flow",
          status: "done",
          createdAt: "2026-09-22T10:00:00.000Z",
          startedAt: "2026-09-22T10:00:01.000Z",
          endedAt: "2026-09-22T10:00:30.000Z",
          turns: 3,
          toolCalls: 1,
          thread: {
            version: 3,
            dropped: 0,
            items: [
              { kind: "text", text: "Starting research." },
              { kind: "tool", callId: "call-1", name: "Read", args: { path: "rpc.md" }, output: "...", running: false, isError: false },
              { kind: "text", text: "Done — the auth flow uses RPC extension UI requests." },
            ],
          },
        },
      ],
    });
  });
});

describe("reduceChat: helpers widget (gentle-agents)", () => {
  it("INITIAL_CHAT_STATE starts with an empty helpers activity", () => {
    expect(INITIAL_CHAT_STATE.helpers).toEqual({ summary: { running: 0, queued: 0, waiting: 0, finished: 0 }, tasks: [] });
  });

  it("replaces helpers with the parsed activity from a setWidget request for widgetKey gentle-agents", () => {
    const payload = JSON.stringify({
      schema: "gentle-agents.activity/v1",
      summary: { running: 1, queued: 0, waiting: 0, finished: 0 },
      tasks: [
        {
          summary: {
            id: "task-1",
            agent: "researcher",
            label: "Research",
            prompt: "Do it",
            status: "running",
            createdAt: "2026-09-22T10:00:00.000Z",
            turns: 0,
            toolCalls: 0,
          },
          thread: { version: 0, dropped: 0, items: [] },
        },
      ],
    });

    const decoded = decodeLine(
      JSON.stringify({ type: "extension_ui_request", id: "ui-1", method: "setWidget", widgetKey: "gentle-agents", widgetLines: [payload] }),
    );
    if ("kind" in decoded) throw new Error("expected a decoded extension_ui_request");

    const state = reduceChat(INITIAL_CHAT_STATE, decoded);

    expect(state.helpers.summary).toEqual({ running: 1, queued: 0, waiting: 0, finished: 0 });
    expect(state.helpers.tasks).toHaveLength(1);
    expect(state.helpers.tasks[0]?.id).toBe("task-1");
  });

  it("ignores a setWidget request for a different widgetKey, leaving helpers untouched", () => {
    const decoded = decodeLine(
      JSON.stringify({
        type: "extension_ui_request",
        id: "ui-2",
        method: "setWidget",
        widgetKey: "some-other-extension",
        widgetLines: ["irrelevant"],
      }),
    );
    if ("kind" in decoded) throw new Error("expected a decoded extension_ui_request");

    const state = reduceChat(INITIAL_CHAT_STATE, decoded);

    expect(state).toBe(INITIAL_CHAT_STATE);
  });

  it("keeps the previous helpers state when the gentle-agents widget frame is malformed", () => {
    const validPayload = JSON.stringify({
      schema: "gentle-agents.activity/v1",
      summary: { running: 1, queued: 0, waiting: 0, finished: 0 },
      tasks: [],
    });
    const validDecoded = decodeLine(
      JSON.stringify({ type: "extension_ui_request", id: "ui-1", method: "setWidget", widgetKey: "gentle-agents", widgetLines: [validPayload] }),
    );
    if ("kind" in validDecoded) throw new Error("expected a decoded extension_ui_request");
    const afterValid = reduceChat(INITIAL_CHAT_STATE, validDecoded);

    const malformedDecoded = decodeLine(
      JSON.stringify({ type: "extension_ui_request", id: "ui-2", method: "setWidget", widgetKey: "gentle-agents", widgetLines: ["{not valid json"] }),
    );
    if ("kind" in malformedDecoded) throw new Error("expected a decoded extension_ui_request");
    const afterMalformed = reduceChat(afterValid, malformedDecoded);

    expect(afterMalformed.helpers).toEqual(afterValid.helpers);
  });
});

describe("reduceChat: helpers retention (gentle-pi drops finished tasks from its in-memory store)", () => {
  function setWidgetEvent(id: string, payload: unknown) {
    const decoded = decodeLine(
      JSON.stringify({
        type: "extension_ui_request",
        id,
        method: "setWidget",
        widgetKey: "gentle-agents",
        widgetLines: [JSON.stringify(payload)],
      }),
    );
    if ("kind" in decoded) throw new Error("expected a decoded extension_ui_request");
    return decoded;
  }

  function taskFrame(summary: ChatState["helpers"]["summary"], tasks: readonly unknown[]) {
    return { schema: "gentle-agents.activity/v1", summary, tasks };
  }

  it("keeps a task gentle-pi drops after it finishes, marked done with endedAt set and its thread intact", () => {
    const runningFrame = taskFrame({ running: 1, queued: 0, waiting: 0, finished: 0 }, [
      {
        summary: {
          id: "task-1",
          agent: "researcher",
          label: "Research",
          prompt: "Do it",
          status: "running",
          createdAt: "2026-09-22T10:00:00.000Z",
          startedAt: "2026-09-22T10:00:01.000Z",
          turns: 2,
          toolCalls: 1,
        },
        thread: { version: 2, dropped: 0, items: [{ kind: "text", text: "Working on it." }] },
      },
    ]);
    const runningState = reduceChat(INITIAL_CHAT_STATE, setWidgetEvent("ui-1", runningFrame));

    const droppedFrame = taskFrame({ running: 0, queued: 0, waiting: 0, finished: 1 }, []);
    const state = reduceChat(runningState, setWidgetEvent("ui-2", droppedFrame), "2026-09-22T11:00:00.000Z");

    expect(state.helpers.summary).toEqual({ running: 0, queued: 0, waiting: 0, finished: 1 });
    expect(state.helpers.tasks).toHaveLength(1);
    expect(state.helpers.tasks[0]).toMatchObject({
      id: "task-1",
      status: "done",
      endedAt: "2026-09-22T11:00:00.000Z",
      thread: { version: 2, dropped: 0, items: [{ kind: "text", text: "Working on it." }] },
    });
  });

  it("replaces a retained task's record once it reappears in a later frame instead of keeping the stale one", () => {
    const runningFrame = taskFrame({ running: 1, queued: 0, waiting: 0, finished: 0 }, [
      {
        summary: {
          id: "task-1",
          agent: "researcher",
          label: "Research",
          prompt: "Do it",
          status: "running",
          createdAt: "2026-09-22T10:00:00.000Z",
          turns: 0,
          toolCalls: 0,
        },
        thread: { version: 0, dropped: 0, items: [] },
      },
    ]);
    const runningState = reduceChat(INITIAL_CHAT_STATE, setWidgetEvent("ui-1", runningFrame));
    const droppedState = reduceChat(
      runningState,
      setWidgetEvent("ui-2", taskFrame({ running: 0, queued: 0, waiting: 0, finished: 1 }, [])),
      "2026-09-22T11:00:00.000Z",
    );
    expect(droppedState.helpers.tasks[0]?.status).toBe("done");

    const reappearedFrame = taskFrame({ running: 1, queued: 0, waiting: 0, finished: 0 }, [
      {
        summary: {
          id: "task-1",
          agent: "researcher",
          label: "Research",
          prompt: "Do it",
          status: "running",
          createdAt: "2026-09-22T10:00:00.000Z",
          turns: 3,
          toolCalls: 2,
        },
        thread: { version: 3, dropped: 0, items: [{ kind: "text", text: "Resumed." }] },
      },
    ]);
    const state = reduceChat(droppedState, setWidgetEvent("ui-3", reappearedFrame), "2026-09-22T12:00:00.000Z");

    expect(state.helpers.tasks).toHaveLength(1);
    expect(state.helpers.tasks[0]).toMatchObject({
      id: "task-1",
      status: "running",
      endedAt: undefined,
      turns: 3,
      thread: { version: 3, dropped: 0, items: [{ kind: "text", text: "Resumed." }] },
    });
  });

  it("keeps a failed task's status and endedAt as-is when a later frame drops it (never promotes a terminal status to done)", () => {
    const failedFrame = taskFrame({ running: 0, queued: 0, waiting: 0, finished: 1 }, [
      {
        summary: {
          id: "task-1",
          agent: "researcher",
          label: "Research",
          prompt: "Do it",
          status: "failed",
          createdAt: "2026-09-22T10:00:00.000Z",
          endedAt: "2026-09-22T10:05:00.000Z",
          error: "boom",
          turns: 1,
          toolCalls: 0,
        },
        thread: { version: 1, dropped: 0, items: [] },
      },
    ]);
    const failedState = reduceChat(INITIAL_CHAT_STATE, setWidgetEvent("ui-1", failedFrame));

    const droppedFrame = taskFrame({ running: 0, queued: 0, waiting: 0, finished: 0 }, []);
    const state = reduceChat(failedState, setWidgetEvent("ui-2", droppedFrame), "2026-09-22T11:00:00.000Z");

    expect(state.helpers.tasks).toHaveLength(1);
    expect(state.helpers.tasks[0]).toMatchObject({
      id: "task-1",
      status: "failed",
      endedAt: "2026-09-22T10:05:00.000Z",
      error: "boom",
    });
  });

  it("does not retain tasks across independent chat states (a new/switched session starts from a clean helpers list)", () => {
    const runningFrame = taskFrame({ running: 1, queued: 0, waiting: 0, finished: 0 }, [
      {
        summary: {
          id: "old-chat-task",
          agent: "researcher",
          label: "Research",
          prompt: "Do it",
          status: "running",
          createdAt: "2026-09-22T10:00:00.000Z",
          turns: 0,
          toolCalls: 0,
        },
        thread: { version: 0, dropped: 0, items: [] },
      },
    ]);
    // A first chat's session drops its running task without it ever reappearing.
    const oldChatState = reduceChat(INITIAL_CHAT_STATE, setWidgetEvent("ui-1", runningFrame));
    reduceChat(oldChatState, setWidgetEvent("ui-2", taskFrame({ running: 0, queued: 0, waiting: 0, finished: 1 }, [])), "2026-09-22T11:00:00.000Z");

    // A new/switched session starts PiSession's ChatState fresh at
    // INITIAL_CHAT_STATE (see PiSession.ts), never from the previous chat's
    // state object, so its first frame must not see "old-chat-task" at all.
    const newSessionFrame = taskFrame({ running: 1, queued: 0, waiting: 0, finished: 0 }, [
      {
        summary: {
          id: "new-chat-task",
          agent: "writer",
          label: "Write",
          prompt: "Do it",
          status: "running",
          createdAt: "2026-09-22T12:00:00.000Z",
          turns: 0,
          toolCalls: 0,
        },
        thread: { version: 0, dropped: 0, items: [] },
      },
    ]);
    const newSessionState = reduceChat(INITIAL_CHAT_STATE, setWidgetEvent("ui-3", newSessionFrame));

    expect(newSessionState.helpers.tasks.map((task) => task.id)).toEqual(["new-chat-task"]);
  });

  it("orders tasks running, waiting, queued, then finished by endedAt desc", () => {
    function task(id: string, status: string, endedAt?: string) {
      return {
        summary: {
          id,
          agent: "a",
          label: "l",
          prompt: "p",
          status,
          createdAt: "2026-09-22T09:00:00.000Z",
          endedAt,
          turns: 0,
          toolCalls: 0,
        },
        thread: { version: 0, dropped: 0, items: [] },
      };
    }

    const frame = taskFrame({ running: 1, queued: 1, waiting: 1, finished: 3 }, [
      task("done-older", "done", "2026-09-22T10:00:00.000Z"),
      task("queued-1", "queued"),
      task("done-newer", "done", "2026-09-22T10:30:00.000Z"),
      task("running-1", "running"),
      task("failed-1", "failed", "2026-09-22T10:15:00.000Z"),
      task("waiting-1", "waiting"),
    ]);

    const state = reduceChat(INITIAL_CHAT_STATE, setWidgetEvent("ui-1", frame));

    expect(state.helpers.tasks.map((t) => t.id)).toEqual([
      "running-1",
      "waiting-1",
      "queued-1",
      "done-newer",
      "failed-1",
      "done-older",
    ]);
  });
});

describe("tool execution detail (desktop-rpc T7)", () => {
  function start(toolCallId: string, toolName: string, args?: unknown): RpcEvent {
    return { type: "tool_execution_start", toolCallId, toolName, args };
  }
  function end(toolCallId: string, toolName: string, result: unknown, isError = false): RpcEvent {
    return { type: "tool_execution_end", toolCallId, toolName, result, isError };
  }

  it("pairs a start with its end into one row, keeping args and result verbatim", () => {
    const args = { path: "README.md" };
    const result = { lines: 42 };
    const afterStart = reduceChat(INITIAL_CHAT_STATE, start("c1", "read", args));
    expect(afterStart.toolCalls).toEqual([{ id: "c1", toolName: "read", args, status: "running" }]);

    const afterEnd = reduceChat(afterStart, end("c1", "read", result));
    expect(afterEnd.toolCalls).toEqual([
      { id: "c1", toolName: "read", args, result, isError: false, status: "done" },
    ]);
    // The activity counter keeps behaving as before: the fold is additive.
    expect(afterEnd.activity).toBe(afterStart.activity + 1);
  });

  it("an update adds no row and keeps the call running until its end arrives", () => {
    const started = reduceChat(INITIAL_CHAT_STATE, start("c1", "bash"));
    const updated = reduceChat(started, { type: "tool_execution_update", toolCallId: "c1", toolName: "bash" });

    expect(updated.toolCalls).toEqual([{ id: "c1", toolName: "bash", args: undefined, status: "running" }]);
    expect(updated.activity).toBe(started.activity + 1);
  });

  it("a duplicate start never opens a second row for the same call", () => {
    const once = reduceChat(INITIAL_CHAT_STATE, start("c1", "read", { path: "a" }));
    const twice = reduceChat(once, start("c1", "read", { path: "b" }));

    expect(twice.toolCalls).toHaveLength(1);
    expect(twice.toolCalls?.[0]?.args).toEqual({ path: "a" });
  });

  it("an end for a call whose start was never seen still yields a done row", () => {
    const state = reduceChat(INITIAL_CHAT_STATE, end("c9", "grep", "match", true));

    expect(state.toolCalls).toEqual([
      { id: "c9", toolName: "grep", args: undefined, result: "match", isError: true, status: "done" },
    ]);
  });

  it("keeps the newest MAX_TOOL_CALLS rows so a long session cannot grow without limit", () => {
    let state: ChatState = INITIAL_CHAT_STATE;
    for (let index = 0; index < 25; index += 1) state = reduceChat(state, start(`c${index}`, "read"));

    expect(state.toolCalls).toHaveLength(20);
    expect(state.toolCalls?.[0]?.id).toBe("c5");
    expect(state.toolCalls?.[19]?.id).toBe("c24");
  });

  it("never invents an error flag or a result the wire did not carry", () => {
    const started = reduceChat(INITIAL_CHAT_STATE, start("c1", "read", { path: "a" }));
    expect(started.toolCalls?.[0]?.isError).toBeUndefined();
    expect(started.toolCalls?.[0]?.result).toBeUndefined();
  });
});
