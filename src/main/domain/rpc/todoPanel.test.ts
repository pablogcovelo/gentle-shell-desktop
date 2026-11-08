import { describe, expect, it } from "vitest";
import { INITIAL_CHAT_STATE, reduceChat } from "./chatReducer";
import { historyToMessages } from "./history";
import { TODO_STATE_CUSTOM_TYPE, extractTodoPanel, parseTodoPanel } from "./todoPanel";
import type { RpcMessage } from "./types";

/**
 * T1: the ODD task panel's data path. A `gentle-todo-state` custom message
 * carries the task list gentle-shell's todo tool already writes; it must
 * reach panel state and must never reach the conversation transcript.
 */

const TODO_STATE = {
  tasks: [
    { id: 1, title: "Write the spec", status: "done" },
    { id: 2, title: "Implement the panel", status: "in_progress", note: "T2" },
  ],
  nextId: 3,
  updatedTurn: 4,
};

function customTodoMessage(content: unknown = TODO_STATE, customType = TODO_STATE_CUSTOM_TYPE): RpcMessage {
  return { role: "custom", customType, content, display: false, timestamp: 0 };
}

describe("parseTodoPanel", () => {
  it("keeps tasks, nextId and updatedTurn from a valid state", () => {
    expect(parseTodoPanel(TODO_STATE)).toEqual({
      tasks: [
        { id: 1, title: "Write the spec", status: "done" },
        { id: 2, title: "Implement the panel", status: "in_progress", note: "T2" },
      ],
      nextId: 3,
      updatedTurn: 4,
    });
  });

  it("keeps an unknown task status as-is instead of dropping the task", () => {
    const parsed = parseTodoPanel({ tasks: [{ id: 7, title: "Future", status: "deferred" }], nextId: 8, updatedTurn: null });

    expect(parsed?.tasks).toEqual([{ id: 7, title: "Future", status: "deferred" }]);
  });

  it("drops a non-string note instead of failing the whole state", () => {
    const parsed = parseTodoPanel({ tasks: [{ id: 1, title: "A", status: "pending", note: 42 }], nextId: 2, updatedTurn: null });

    expect(parsed?.tasks).toEqual([{ id: 1, title: "A", status: "pending" }]);
  });

  it("returns undefined for a malformed state", () => {
    expect(parseTodoPanel(undefined)).toBeUndefined();
    expect(parseTodoPanel("not an object")).toBeUndefined();
    expect(parseTodoPanel({ tasks: "nope", nextId: 1 })).toBeUndefined();
    expect(parseTodoPanel({ tasks: [{ id: 1, status: "pending" }], nextId: 2 })).toBeUndefined();
    expect(parseTodoPanel({ tasks: [{ id: 1, title: "A", status: "pending" }] })).toBeUndefined();
  });

  it("accepts an empty task list", () => {
    expect(parseTodoPanel({ tasks: [], nextId: 1, updatedTurn: null })).toEqual({ tasks: [], nextId: 1, updatedTurn: null });
  });
});

describe("extractTodoPanel", () => {
  it("returns the last todo state in a message list, so a reload matches the newest write", () => {
    const older = { tasks: [{ id: 1, title: "Old", status: "pending" }], nextId: 2, updatedTurn: 1 };
    const newer = { tasks: [{ id: 1, title: "Old", status: "done" }], nextId: 2, updatedTurn: 2 };

    const messages: RpcMessage[] = [
      { role: "user", content: "do it", timestamp: 0 },
      customTodoMessage(older),
      { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 1 },
      customTodoMessage(newer),
    ];

    expect(extractTodoPanel(messages)?.tasks[0]?.status).toBe("done");
  });

  it("ignores custom messages that are not the todo state", () => {
    const messages: RpcMessage[] = [customTodoMessage(TODO_STATE, "gentle-something-else")];

    expect(extractTodoPanel(messages)).toBeUndefined();
  });

  it("ignores a non-custom message that happens to carry the same customType", () => {
    const messages: RpcMessage[] = [{ role: "assistant", customType: TODO_STATE_CUSTOM_TYPE, content: TODO_STATE, timestamp: 0 }];

    expect(extractTodoPanel(messages)).toBeUndefined();
  });
});

describe("reduceChat: todo panel", () => {
  it("stores the panel state from a custom message and keeps the transcript empty", () => {
    const state = reduceChat(INITIAL_CHAT_STATE, { type: "message_end", message: customTodoMessage() });

    expect(state.todo?.tasks).toHaveLength(2);
    expect(state.todo?.tasks[1]).toEqual({ id: 2, title: "Implement the panel", status: "in_progress", note: "T2" });
    expect(state.messages).toEqual([]);
  });

  it("arrives identically on message_start and message_end", () => {
    const started = reduceChat(INITIAL_CHAT_STATE, { type: "message_start", message: customTodoMessage() });
    const ended = reduceChat(started, { type: "message_end", message: customTodoMessage() });

    expect(ended.todo).toEqual(started.todo);
    expect(ended.messages).toEqual([]);
  });

  it("ignores a malformed todo message without touching the previous panel state", () => {
    const withPanel = reduceChat(INITIAL_CHAT_STATE, { type: "message_end", message: customTodoMessage() });
    const malformed = reduceChat(withPanel, { type: "message_end", message: customTodoMessage({ tasks: "nope" }) });

    expect(malformed.todo).toEqual(withPanel.todo);
  });

  it("leaves other custom messages out of both the panel and the transcript", () => {
    const state = reduceChat(INITIAL_CHAT_STATE, {
      type: "message_end",
      message: customTodoMessage(TODO_STATE, "gentle-git-notes"),
    });

    expect(state.todo).toBeUndefined();
    expect(state.messages).toEqual([]);
  });
});

describe("historyToMessages: todo panel stays out of the transcript", () => {
  it("skips the todo custom message and keeps message ids contiguous", () => {
    const messages: RpcMessage[] = [
      { role: "user", content: "do it", timestamp: 0 },
      customTodoMessage(),
      { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 1 },
    ];

    expect(historyToMessages(messages)).toEqual([
      { id: "msg-0", role: "user", text: "do it" },
      { id: "msg-1", role: "assistant", text: "done", streaming: false },
    ]);
  });

  it("still finds the panel state in the same history it was skipped from", () => {
    const messages: RpcMessage[] = [
      { role: "user", content: "do it", timestamp: 0 },
      customTodoMessage(),
    ];

    expect(extractTodoPanel(messages)?.tasks).toHaveLength(2);
  });
});
