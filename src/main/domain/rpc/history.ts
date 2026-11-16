import { MESSAGE_ROLE, type ChatMessage, type ToolCallView } from "@shared/bridge-types";
import { MAX_TOOL_CALLS, boundedPayload, type ToolPayloadValue } from "./toolCalls";
import type { RpcMessage } from "./types";

/**
 * Converts a `get_messages` response's `data.messages` (pi's `AgentMessage[]`
 * on the wire — `UserMessage | AssistantMessage | ToolResultMessage | ...`,
 * decoded here defensively as `RpcMessage` like the rest of this file, per
 * the "do not over-model" scope note in chatReducer.ts) into the
 * `ChatMessage[]` the renderer's thread already understands.
 *
 * - `user`: keeps `content` as-is when it is a plain string, or the joined
 *   `text` of its `{ type: "text", text }` content parts when it is an
 *   array (image parts are skipped).
 * - `assistant`: joins the `text` of its `{ type: "text", text }` content
 *   parts only — `thinking` and `toolCall` parts never render in the
 *   M1/M2 thread (see the desktop-m1-chat-core objective: "No tool output,
 *   no thinking shown").
 * - `toolResult` and any other role: skipped entirely.
 *
 * ids are `msg-<index>`, assigned by POSITION IN THE RETURNED ARRAY (not
 * the raw index into `messages`, since a skipped entry never occupies a
 * slot) so they stay consistent with chatReducer's own
 * `msg-${state.messages.length}` scheme: seeding a chat's history with N
 * `ChatMessage`s first means the next live message the reducer appends
 * gets `msg-${N}`, continuing the same sequence with no collision or gap.
 */
export function historyToMessages(messages: readonly RpcMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const message of messages) {
    const chatMessage = toChatMessage(message, result.length);
    if (chatMessage) result.push(chatMessage);
  }
  return result;
}

function toChatMessage(message: RpcMessage, index: number): ChatMessage | undefined {
  if (message.role === MESSAGE_ROLE.USER) {
    return { id: `msg-${index}`, role: MESSAGE_ROLE.USER, text: extractText(message) };
  }
  if (message.role === MESSAGE_ROLE.ASSISTANT) {
    const text = extractText(message);
    // An assistant message whose content was only thinking/toolCall parts
    // (or whitespace-only text) has nothing left to show once those parts
    // are filtered out above: skip it like a toolResult, instead of
    // rendering an empty bubble. `result.length` in historyToMessages still
    // assigns the next id, so this never leaves a gap.
    if (text.trim().length === 0) return undefined;
    return { id: `msg-${index}`, role: MESSAGE_ROLE.ASSISTANT, text, streaming: false };
  }
  return undefined;
}

/**
 * Rebuilds the tool-call rows a reopened chat already produced, from the
 * same `get_messages` history the text projection reads (desktop-pending
 * work T7, S7): `toolCalls` used to be live-only (`tool_execution_start|end`
 * events), so a reload lost args/result/error.
 *
 * The wire shapes are pi 0.85.1's published types, read from the installed
 * package and recorded in odd/tasks/desktop-pending-work.md L11 — nothing
 * guessed, nothing invented:
 *
 * - a tool CALL is a content block of an assistant message
 *   `{ type: "toolCall", id, name, arguments }`, `arguments` already an
 *   object — it OPENS a row `{ id, toolName, args, status: "running" }`;
 * - a tool RESULT is its own message `{ role: "toolResult", toolCallId,
 *   toolName, content, details?, isError, timestamp }` — it CLOSES the row
 *   with the same `toolCallId` (`result` from the joined text content, or
 *   `details` when there is no text; `isError` from the boolean;
 *   `status: "done"`). A result whose call was never seen opens its own
 *   done row with `args` absent rather than being dropped.
 *
 * The recovered rows must look exactly like the live ones they replace, so
 * the SAME bounding applies: insertion order is kept and the last
 * MAX_TOOL_CALLS rows survive, with each payload bounded by `boundedPayload`
 * (the shared helper the live reducer path uses — see toolCalls.ts).
 *
 * Fail closed: a non-object block, a missing/non-string `id` or `name`, a
 * non-object `arguments`, a missing `toolCallId`, or a result-only row
 * without a string `toolName` each contributes nothing — never coerced.
 * The text-only projection (`historyToMessages`) is untouched: text-only
 * messages stay exactly as they were.
 */
export function historyToToolCalls(messages: readonly RpcMessage[]): ToolCallView[] {
  const rows: ToolCallView[] = [];
  for (const message of messages) {
    if (message.role === MESSAGE_ROLE.ASSISTANT) {
      openToolCallRows(message.content, rows);
      continue;
    }
    if (message.role === "toolResult") {
      applyToolResultRow(message, rows);
    }
  }
  // The same cap the live path applies (chatReducer's tool_execution_* arm):
  // keep the LAST MAX_TOOL_CALLS rows in insertion order, so a recovered
  // thread is indistinguishable from the live one it replaces.
  return rows.slice(-MAX_TOOL_CALLS);
}

/** Opens one running row per well-formed toolCall block, keyed by the
 * call id both wire sides already carry. A duplicate id opens no second
 * row — the same invariant the live path enforces (chatReducer: "A
 * duplicate start must not open a second row for the same call"), so a
 * later live row for the same id always wins instead of duplicating. */
function openToolCallRows(content: unknown, rows: ToolCallView[]): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type !== "toolCall") continue;
    const { id, name, arguments: args } = block;
    if (typeof id !== "string" || typeof name !== "string") continue;
    // `arguments` is already an object on the wire (L11); anything else is
    // a shape this function does not understand — fail closed, never coerce.
    if (!isRecord(args)) continue;
    if (rows.some((row) => row.id === id)) continue;
    rows.push({ id, toolName: name, args: boundedPayload(args), status: "running" });
  }
}

/** Closes the row whose id matches the result's `toolCallId`, or opens a
 * done row for a result whose call was never seen (args absent rather than
 * dropped). `result` comes from the joined text content, or from `details`
 * when there is no text; both go through the shared `boundedPayload`. */
function applyToolResultRow(message: RpcMessage, rows: ToolCallView[]): void {
  const toolCallId = message.toolCallId;
  if (typeof toolCallId !== "string") return;
  const boundedResult = boundedToolResultPayload(message);
  const isError = typeof message.isError === "boolean" ? message.isError : undefined;

  const index = rows.findIndex((row) => row.id === toolCallId);
  const existing = rows[index];
  if (existing) {
    const closed: ToolCallView = { ...existing, result: boundedResult, isError, status: "done" };
    rows[index] = closed;
    return;
  }

  // A result without its call still becomes a row — but a row needs the
  // toolName the wire says the result message carries, so without a string
  // one there is nothing this function can build: contribute nothing.
  const toolName = message.toolName;
  if (typeof toolName !== "string") return;
  rows.push({ id: toolCallId, toolName, args: undefined, result: boundedResult, isError, status: "done" });
}

/** The result payload, bounded the same way the live path bounds it
 * (toolCalls.ts `boundedPayload`): the joined `text` of the content parts,
 * or the raw `details` when there is no text (the live end frame carries
 * one value; history splits it across `content` and `details`). */
function boundedToolResultPayload(message: RpcMessage): ToolPayloadValue | undefined {
  const content = message.content;
  if (typeof content === "string") return boundedPayload(content);
  if (Array.isArray(content)) {
    const text = content.filter(isTextBlock).map((block) => block.text).join("");
    if (text.length > 0) return boundedPayload(text);
  }
  return boundedPayload(message.details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Plain string content is kept as-is; array content keeps only `text` parts, joined. */
function extractText(message: RpcMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(isTextBlock).map((block) => block.text).join("");
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

/**
 * Safely pulls `data.messages` off a `get_messages` response's `data`
 * (typed `unknown` in `RpcResponse`). Tolerant like the rest of this
 * codec/domain layer: malformed or missing data decodes to an empty array
 * instead of throwing, and entries without a string `role` are dropped.
 */
export function extractHistoryMessages(data: unknown): readonly RpcMessage[] {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return [];
  const messages = (data as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return [];
  return messages.filter(isRpcMessage);
}

function isRpcMessage(value: unknown): value is RpcMessage {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as Record<string, unknown>).role === "string";
}
