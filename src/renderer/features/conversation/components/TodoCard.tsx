import { useId, useState } from "react";
import type { TodoPanelState } from "@shared/bridge-types";
import "./TodoCard.css";

export interface TodoCardProps {
  readonly todo: TodoPanelState;
}

/**
 * One row in the collapsed summary (the TUI's `todoWorkSummary` spirit):
 * wherever the work stands, plus `done/planned` on the right.
 * `planned` mirrors the TUI: dropped tasks are off the list on purpose and
 * no longer count as open.
 */
function summarize(todo: TodoPanelState): { marker: string; text: string; done: number; planned: number } {
  const tasks = todo.tasks;
  // Terminal statuses (dropped) are excluded from the planned denominator,
  // exactly like todoWorkSummary's planned = total - dropped.
  const done = tasks.filter((task) => task.status === DONE).length;
  const planned = tasks.length - tasks.filter((task) => task.status === DROPPED).length;
  const current = tasks.find((task) => task.status === IN_PROGRESS) ?? tasks.find((task) => task.status === PENDING) ?? tasks.find((task) => task.status === BLOCKED);
  if (current) {
    return { marker: glyphFor(current.status), text: `${current.title}${current.note ? ` · ${current.note}` : ""}`, done, planned };
  }
  return { marker: glyphFor(DONE), text: `${done} done`, done, planned };
}

// The five statuses gentle-shell's todo tool writes. Anything else (a
// newer gentle-shell may add statuses like "deferred") renders neutrally
// with a bullet and plain styling rather than breaking the card.
const PENDING = "pending";
const IN_PROGRESS = "in_progress";
const BLOCKED = "blocked";
const DONE = "done";
const DROPPED = "dropped";

const GLYPHS: Readonly<Record<string, string>> = {
  [PENDING]: "○",
  [IN_PROGRESS]: "◐",
  [BLOCKED]: "⊘",
  [DONE]: "✓",
  [DROPPED]: "✕",
};

const UNKNOWN_GLYPH = "•";

function glyphFor(status: string): string {
  return GLYPHS[status] ?? UNKNOWN_GLYPH;
}

function rowClass(status: string): string {
  if (status === DONE || status === DROPPED) return "gc-todo-card__row gc-todo-card__row--dimmed";
  if (status === IN_PROGRESS) return "gc-todo-card__row gc-todo-card__row--current";
  if (status === BLOCKED) return "gc-todo-card__row gc-todo-card__row--blocked";
  if (status === PENDING) return "gc-todo-card__row";
  return "gc-todo-card__row gc-todo-card__row--unknown";
}

/**
 * Presentational: the chat's own ODD task card (M3 — see
 * odd/tasks/desktop-m3-odd-panel.md). Props only, never useBridge — the
 * container feeds it the pushed ChatState.todo of the open chat, so it is
 * never a global list.
 *
 * Collapsed it shows one summary line (`done/planned`, in the spirit of
 * gentle-pi's todoWorkSummary); a real button expands the task rows.
 * Renders nothing at all when the chat has no tasks — the TUI clears the
 * widget entirely in that case (extensions/gentle-todo.ts:252).
 */
export function TodoCard({ todo }: TodoCardProps) {
  const [expanded, setExpanded] = useState(false);
  const rowsId = useId();

  if (todo.tasks.length === 0) return null;

  const summary = summarize(todo);

  return (
    <aside className="gc-todo-card" data-testid="gc-todo-card" aria-label="Todo">
      <button
        type="button"
        className="gc-todo-card__toggle"
        aria-expanded={expanded}
        aria-controls={rowsId}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="gc-todo-card__marker" aria-hidden="true">
          {summary.marker}
        </span>
        <span className="gc-todo-card__summary-text">{summary.text}</span>
        <span className="gc-todo-card__summary-count">
          {summary.done}/{summary.planned} <span className="gc-todo-card__summary-label">todos</span>
        </span>
      </button>
      {expanded ? (
        <ul id={rowsId} className="gc-todo-card__rows">
          {todo.tasks.map((task) => (
            <li key={task.id} className={rowClass(task.status)}>
              <span className="gc-todo-card__marker" aria-hidden="true">
                {glyphFor(task.status)}
              </span>
              <span className="gc-todo-card__title">{task.title}</span>
              {task.note ? <span className="gc-todo-card__note">{task.note}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </aside>
  );
}
