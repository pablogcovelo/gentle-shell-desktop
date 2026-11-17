import { describe, expect, it } from "vitest";
import { MESSAGE_ROLE, type ToolCallView } from "@shared/bridge-types";
import { INITIAL_CHAT_STATE, reduceChat } from "./chatReducer";
// The bounding constants moved to toolCalls.ts (T7: shared with the history
// recovery path); the reducer's own behavior is unchanged.
import { MAX_TOOL_PAYLOAD_CHARS } from "./toolCalls";
import { extractHistoryMessages, historyToMessages, historyToToolCalls } from "./history";
import type { RpcMessage } from "./types";

describe("historyToMessages", () => {
  it("keeps a user message's plain string content as-is", () => {
    const messages: RpcMessage[] = [{ role: "user", content: "What is 2+2?", timestamp: 0 }];

    expect(historyToMessages(messages)).toEqual([{ id: "msg-0", role: "user", text: "What is 2+2?" }]);
  });

  it("joins a user message's text content parts and skips image parts", () => {
    const messages: RpcMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at " },
          { type: "image", data: "base64", mimeType: "image/png" },
          { type: "text", text: "this" },
        ],
        timestamp: 0,
      },
    ];

    expect(historyToMessages(messages)).toEqual([{ id: "msg-0", role: "user", text: "look at this" }]);
  });

  it("joins an assistant message's text parts and skips thinking and toolCall parts", () => {
    const messages: RpcMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me think" },
          { type: "text", text: "The answer is " },
          { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
          { type: "text", text: "4." },
        ],
        timestamp: 0,
      },
    ];

    expect(historyToMessages(messages)).toEqual([
      { id: "msg-0", role: "assistant", text: "The answer is 4.", streaming: false },
    ]);
  });

  it("skips toolResult messages and any other role entirely", () => {
    const messages: RpcMessage[] = [
      { role: "user", content: "hi", timestamp: 0 },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{ type: "text", text: "output" }],
        isError: false,
        timestamp: 0,
      },
      { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 0 },
    ];

    expect(historyToMessages(messages)).toEqual([
      { id: "msg-0", role: "user", text: "hi" },
      { id: "msg-1", role: "assistant", text: "hello", streaming: false },
    ]);
  });

  it("assigns ids by position in the returned array, so a skipped toolResult never leaves a gap", () => {
    const messages: RpcMessage[] = [
      { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [], isError: false, timestamp: 0 },
      { role: "user", content: "first", timestamp: 0 },
      { role: "toolResult", toolCallId: "call_2", toolName: "bash", content: [], isError: false, timestamp: 0 },
      { role: "assistant", content: [{ type: "text", text: "second" }], timestamp: 0 },
    ];

    const result = historyToMessages(messages);

    expect(result.map((message) => message.id)).toEqual(["msg-0", "msg-1"]);
  });

  it("returns an empty array for an empty history", () => {
    expect(historyToMessages([])).toEqual([]);
  });

  it("skips an assistant message whose joined text is empty after trimming (tool-only or thinking-only content)", () => {
    const messages: RpcMessage[] = [
      { role: "user", content: "run it", timestamp: 0 },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me check" },
          { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
        ],
        timestamp: 0,
      },
      { role: "assistant", content: [{ type: "text", text: "  " }], timestamp: 0 },
      { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 0 },
    ];

    const result = historyToMessages(messages);

    expect(result).toEqual([
      { id: "msg-0", role: "user", text: "run it" },
      { id: "msg-1", role: "assistant", text: "done", streaming: false },
    ]);
  });
});

describe("extractHistoryMessages", () => {
  it("pulls the messages array out of a get_messages response's data field", () => {
    const data = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

    expect(extractHistoryMessages(data)).toEqual(data.messages);
  });

  it("returns an empty array for malformed or missing data", () => {
    expect(extractHistoryMessages(undefined)).toEqual([]);
    expect(extractHistoryMessages(null)).toEqual([]);
    expect(extractHistoryMessages("nope")).toEqual([]);
    expect(extractHistoryMessages({})).toEqual([]);
    expect(extractHistoryMessages({ messages: "nope" })).toEqual([]);
  });

  it("filters out entries without a string role", () => {
    const data = { messages: [{ role: "user", content: "hi", timestamp: 0 }, { foo: "bar" }, null, "nope"] };

    expect(extractHistoryMessages(data)).toEqual([{ role: "user", content: "hi", timestamp: 0 }]);
  });
});

// NOTE (desktop-pending-work T7, S7): the tool shapes below are pi
// 0.85.1's PUBLISHED message types — a tool CALL is a content block of an
// assistant message `{ type: "toolCall", id, name, arguments }` (arguments
// already an object) and a tool RESULT is its own message
// `{ role: "toolResult", toolCallId, toolName, content, details?, isError,
// timestamp }` — as recorded in odd/tasks/desktop-pending-work.md L11 from
// the installed package. This repository has NO captured `get_messages`
// payload containing tool parts, so this data is written inline from those
// published types; it is not a fixture claiming to be a capture.
describe("historyToToolCalls (desktop-pending-work T7, S7)", () => {
  it("a call with its result becomes one done row carrying args, result and isError: false", () => {
    const messages: RpcMessage[] = [
      { role: "user", content: "run ls", timestamp: 0 },
      {
        role: MESSAGE_ROLE.ASSISTANT,
        content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } }],
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{ type: "text", text: "file.txt\n" }],
        isError: false,
        timestamp: 0,
      },
    ];

    expect(historyToToolCalls(messages)).toEqual([
      { id: "call_1", toolName: "bash", args: { command: "ls" }, result: "file.txt\n", isError: false, status: "done" },
    ]);
  });

  it("a failed result sets isError: true and status: 'done'", () => {
    const messages: RpcMessage[] = [
      {
        role: MESSAGE_ROLE.ASSISTANT,
        content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "nope" } }],
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{ type: "text", text: "command not found" }],
        isError: true,
        timestamp: 0,
      },
    ];

    expect(historyToToolCalls(messages)).toEqual([
      {
        id: "call_1",
        toolName: "bash",
        args: { command: "nope" },
        result: "command not found",
        isError: true,
        status: "done",
      },
    ]);
  });

  it("a result without its call still becomes a done row, with args absent", () => {
    const messages: RpcMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call_9",
        toolName: "grep",
        content: [{ type: "text", text: "match" }],
        isError: false,
        timestamp: 0,
      },
    ];

    expect(historyToToolCalls(messages)).toEqual([
      { id: "call_9", toolName: "grep", args: undefined, result: "match", isError: false, status: "done" },
    ]);
  });

  it("a call with no result yet stays running, carrying its args", () => {
    const messages: RpcMessage[] = [
      {
        role: MESSAGE_ROLE.ASSISTANT,
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.md" } }],
        timestamp: 0,
      },
    ];

    expect(historyToToolCalls(messages)).toEqual([
      { id: "call_1", toolName: "read", args: { path: "a.md" }, status: "running" },
    ]);
  });

  it("preserves insertion order and keeps only the last 20 rows (the live path's MAX_TOOL_CALLS cap)", () => {
    const messages: RpcMessage[] = [];
    for (let index = 0; index < 25; index += 1) {
      messages.push({
        role: MESSAGE_ROLE.ASSISTANT,
        content: [{ type: "toolCall", id: `call_${index}`, name: "read", arguments: { index } }],
        timestamp: 0,
      });
      messages.push({
        role: "toolResult",
        toolCallId: `call_${index}`,
        toolName: "read",
        content: [{ type: "text", text: `out ${index}` }],
        isError: false,
        timestamp: 0,
      });
    }

    const rows: ToolCallView[] = historyToToolCalls(messages);

    expect(rows).toHaveLength(20);
    expect(rows.map((row) => row.id)).toEqual(Array.from({ length: 20 }, (_, i) => `call_${i + 5}`));
    expect(rows[0]).toMatchObject({ status: "done", result: "out 5" });
  });

  it("bounds an oversized payload by the same amount as the live path, with the same truncation marker", () => {
    const big = "x".repeat(MAX_TOOL_PAYLOAD_CHARS + 100);
    const messages: RpcMessage[] = [
      {
        role: MESSAGE_ROLE.ASSISTANT,
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: big } }],
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: big }],
        isError: false,
        timestamp: 0,
      },
    ];

    const recovered = historyToToolCalls(messages);

    // The live path's own bounding, computed by the reducer from
    // tool_execution_start events for the SAME payloads — the exact shapes
    // a recovered row replaces must equal. The recovered `args` bound the
    // `arguments` OBJECT, the recovered `result` the raw text string.
    const liveArgs = reduceChat(INITIAL_CHAT_STATE, {
      type: "tool_execution_start",
      toolCallId: "live",
      toolName: "read",
      args: { path: big },
    });
    const liveResult = reduceChat(INITIAL_CHAT_STATE, {
      type: "tool_execution_start",
      toolCallId: "live",
      toolName: "read",
      args: big,
    });

    expect(typeof recovered[0]?.args).toBe("string");
    expect(recovered[0]?.args).toEqual(liveArgs.toolCalls?.[0]?.args);
    expect(recovered[0]?.args).toMatch(/^\[truncated: \d+ chars\]$/);
    expect(recovered[0]?.result).toEqual(liveResult.toolCalls?.[0]?.args);
    expect(recovered[0]?.result).toMatch(/^\[truncated: \d+ chars\]$/);
    // The marker states the real size instead of pretending to be complete.
    const marker = Number(/\[truncated: (\d+) chars\]/.exec(String(recovered[0]?.args))?.[1]);
    expect(marker).toBeGreaterThan(MAX_TOOL_PAYLOAD_CHARS);
    expect(String(recovered[0]?.args).length).toBeLessThan(MAX_TOOL_PAYLOAD_CHARS);
  });

  it("falls back to details when a result carries no text content", () => {
    const messages: RpcMessage[] = [
      {
        role: MESSAGE_ROLE.ASSISTANT,
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.md" } }],
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [],
        details: { lines: 3 },
        isError: false,
        timestamp: 0,
      },
    ];

    expect(historyToToolCalls(messages)).toEqual([
      { id: "call_1", toolName: "read", args: { path: "a.md" }, result: { lines: 3 }, isError: false, status: "done" },
    ]);
  });

  it("a result with neither text nor details closes the row without inventing one", () => {
    const messages: RpcMessage[] = [
      {
        role: MESSAGE_ROLE.ASSISTANT,
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.md" } }],
        timestamp: 0,
      },
      { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [], isError: false, timestamp: 0 },
    ];

    expect(historyToToolCalls(messages)).toEqual([
      { id: "call_1", toolName: "read", args: { path: "a.md" }, isError: false, status: "done" },
    ]);
  });

  it("malformed blocks and entries contribute nothing, never coerced", () => {
    const messages: RpcMessage[] = [
      // An assistant message without array content opens no row.
      { role: MESSAGE_ROLE.ASSISTANT, content: "plain string", timestamp: 0 },
      // A non-object toolCall block contributes nothing.
      {
        role: MESSAGE_ROLE.ASSISTANT,
        content: ["not-a-block", null, { type: "toolCall", id: "call_a", name: "bash", arguments: {} }],
        timestamp: 0,
      },
      // Missing/non-string id or name, or a non-object arguments, each
      // contribute nothing.
      { role: MESSAGE_ROLE.ASSISTANT, content: [{ type: "toolCall", name: "bash", arguments: {} }], timestamp: 0 },
      {
        role: MESSAGE_ROLE.ASSISTANT,
        content: [{ type: "toolCall", id: 7, name: "bash", arguments: {} }],
        timestamp: 0,
      },
      { role: MESSAGE_ROLE.ASSISTANT, content: [{ type: "toolCall", id: "call_b", arguments: {} }], timestamp: 0 },
      {
        role: MESSAGE_ROLE.ASSISTANT,
        content: [{ type: "toolCall", id: "call_c", name: "bash", arguments: "not-an-object" }],
        timestamp: 0,
      },
      // A toolResult without a string toolCallId contributes nothing.
      { role: "toolResult", toolName: "bash", content: [], isError: false, timestamp: 0 },
      {
        role: "toolResult",
        toolCallId: 7,
        toolName: "bash",
        content: [{ type: "text", text: "lost" }],
        isError: false,
        timestamp: 0,
      },
      // A result-only row still needs a string toolName to exist.
      { role: "toolResult", toolCallId: "call_d", content: [], isError: false, timestamp: 0 },
      // The one well-formed call survives untouched.
      {
        role: MESSAGE_ROLE.ASSISTANT,
        content: [{ type: "toolCall", id: "call_a", name: "bash", arguments: {} }],
        timestamp: 0,
      },
    ];

    expect(historyToToolCalls(messages)).toEqual([{ id: "call_a", toolName: "bash", args: {}, status: "running" }]);
  });

  it("an empty history produces no rows", () => {
    expect(historyToToolCalls([])).toEqual([]);
  });

  it("carries the enclosing assistant message id so a reopened chat keeps the same grouping (S2)", () => {
    const messages: RpcMessage[] = [
      { role: "user", content: "run ls", timestamp: 0 },
      {
        role: MESSAGE_ROLE.ASSISTANT,
        content: [
          { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
          { type: "text", text: "listed" },
        ],
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{ type: "text", text: "file.txt\n" }],
        isError: false,
        timestamp: 0,
      },
    ];

    const rows = historyToToolCalls(messages);

    expect(rows[0]?.messageId).toBe("msg-1");
    // The binding is the id the enclosing message actually carries in the
    // thread, under the same positional scheme historyToMessages uses.
    expect(historyToMessages(messages).map((message) => message.id)).toContain("msg-1");
  });

  it("a call inside an assistant message the text projection drops stays unbound (the renderer's fallback owns it)", () => {
    const messages: RpcMessage[] = [
      {
        role: MESSAGE_ROLE.ASSISTANT,
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
        timestamp: 0,
      },
    ];

    expect(historyToToolCalls(messages)[0]?.messageId).toBeUndefined();
  });

  it("a result-only row has no enclosing assistant message and stays unbound", () => {
    const messages: RpcMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call_9",
        toolName: "grep",
        content: [{ type: "text", text: "match" }],
        isError: false,
        timestamp: 0,
      },
    ];

    expect(historyToToolCalls(messages)[0]?.messageId).toBeUndefined();
  });

  it("leaves the text-only message projection untouched: the same history still yields the same ChatMessages", () => {
    const messages: RpcMessage[] = [
      { role: "user", content: "run ls", timestamp: 0 },
      {
        role: MESSAGE_ROLE.ASSISTANT,
        content: [
          { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
          { type: "text", text: "done" },
        ],
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{ type: "text", text: "file.txt" }],
        isError: false,
        timestamp: 0,
      },
    ];

    expect(historyToMessages(messages)).toEqual([
      { id: "msg-0", role: "user", text: "run ls" },
      { id: "msg-1", role: MESSAGE_ROLE.ASSISTANT, text: "done", streaming: false },
    ]);
  });
});
