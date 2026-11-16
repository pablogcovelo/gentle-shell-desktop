/**
 * Shared tool-call row helpers (desktop-pending-work T7, S7).
 *
 * `MAX_TOOL_CALLS`, `MAX_TOOL_PAYLOAD_CHARS` and `boundedPayload` used to
 * live in chatReducer.ts, where only the live event path used them. The
 * history recovery path (history.ts `historyToToolCalls`) must produce rows
 * that look exactly like the live ones — same 20-row cap, same 4096-char
 * bounding, same truncation marker — so both paths now import these
 * constants from this leaf module. Moving them here (rather than importing
 * them from chatReducer.ts) keeps the import graph acyclic by
 * construction: history.ts and chatReducer.ts never import each other, and
 * neither can start to, because both directions would drag in this file's
 * consumers.
 *
 * No Node, Electron or reducer imports: a pure helper both domain files
 * share (hexagonal main process, see src/README.md).
 */

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
export function boundedPayload(value: unknown): ToolPayloadValue | undefined {
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
