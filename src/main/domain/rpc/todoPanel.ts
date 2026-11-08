import type { TodoPanelState } from "@shared/bridge-types";
import type { RpcMessage } from "./types";

/**
 * The customType gentle-pi's todo tool stamps its state snapshots with
 * (`gentle-todo.ts` emits `{ customType: "gentle-todo-state", content:
 * state }`). These messages are `display: false`: they are machine state
 * for the ODD task panel, never conversation content.
 */
export const TODO_STATE_CUSTOM_TYPE = "gentle-todo-state";

/**
 * Decodes one todo-state snapshot defensively. Lives in the rpc domain and
 * stays dependency-free (only the shared type + the wire shape) so it is
 * testable without a process; like the rest of this layer it never throws.
 *
 * Rules that keep partial futures harmless:
 * - `tasks` must be an array and `nextId` a number, else the whole state is
 *   undefined (the reducer keeps the previous panel instead).
 * - Every task must carry a numeric `id`, a string `title` and a string
 *   `status`; anything less and the whole state is undefined, because a
 *   half-understood list is worse than the previous one.
 * - `status` is kept as-is (an unknown future status must still render);
 *   a non-string `note` is dropped instead of failing the task.
 */
export function parseTodoPanel(content: unknown): TodoPanelState | undefined {
  if (typeof content !== "object" || content === null || Array.isArray(content)) return undefined;

  const raw = content as Record<string, unknown>;
  if (!Array.isArray(raw.tasks) || typeof raw.nextId !== "number") return undefined;

  const tasks: TodoPanelState["tasks"][number][] = [];
  for (const item of raw.tasks) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;

    const task = item as Record<string, unknown>;
    if (typeof task.id !== "number" || typeof task.title !== "string" || typeof task.status !== "string") return undefined;

    // `note` is omitted entirely when it is not a string (dropped, not undefined'd).
    tasks.push(
      typeof task.note === "string"
        ? { id: task.id, title: task.title, status: task.status, note: task.note }
        : { id: task.id, title: task.title, status: task.status },
    );
  }

  const updatedTurn = typeof raw.updatedTurn === "number" ? raw.updatedTurn : null;
  return { tasks, nextId: raw.nextId, updatedTurn };
}

/**
 * Derives the panel state from a message list (a `get_messages` history, a
 * live event replay — whatever crosses the session boundary). The LAST
 * todo-state message wins, so reloading a chat recovers the newest write
 * gentle-shell made. Messages that merely carry the same customType on a
 * non-custom role are not state (only `role: "custom"` messages carry the
 * snapshot), and malformed frames are skipped rather than clobbering an
 * earlier good one.
 */
export function extractTodoPanel(messages: readonly RpcMessage[]): TodoPanelState | undefined {
  let panel: TodoPanelState | undefined;
  for (const message of messages) {
    if (message.role !== "custom" || message.customType !== TODO_STATE_CUSTOM_TYPE) continue;
    const parsed = parseTodoPanel(message.content);
    if (parsed) panel = parsed;
  }
  return panel;
}
