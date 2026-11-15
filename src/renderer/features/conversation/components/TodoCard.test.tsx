// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { TodoPanelState, TodoTaskView } from "@shared/bridge-types";
import { TodoCard, todoProgress } from "./TodoCard";

function task(overrides: Partial<TodoTaskView> = {}): TodoTaskView {
  return { id: 1, title: "Plan the work", status: "pending", ...overrides };
}

function state(tasks: TodoTaskView[]): TodoPanelState {
  return { tasks, nextId: tasks.length + 1, updatedTurn: 3 };
}

describe("TodoCard", () => {
  it("renders nothing at all when the chat has no tasks (the TUI clears the widget)", () => {
    const { container } = render(<TodoCard todo={state([])} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a collapsed one-line summary with the done/planned count", () => {
    render(
      <TodoCard
        todo={state([
          task({ id: 1, title: "Wire the codec", status: "done" }),
          task({ id: 2, title: "Render the card", status: "in_progress" }),
          task({ id: 3, title: "Test the card", status: "pending" }),
          task({ id: 4, title: "Old attempt", status: "dropped" }),
        ])}
      />,
    );

    const toggle = screen.getByRole("button", { name: /todos/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("1/3");
    // Collapsed: no rows yet.
    expect(screen.queryByText("Test the card")).not.toBeInTheDocument();
  });

  it("expanding shows the rows with marker, title and note", () => {
    render(
      <TodoCard
        todo={state([
          task({ id: 1, title: "Wait on review", status: "blocked", note: "waiting for Pablo" }),
          task({ id: 2, title: "Ship it", status: "pending" }),
        ])}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /todos/i }));

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("⊘");
    expect(rows[0]).toHaveTextContent("Wait on review");
    expect(rows[0]).toHaveTextContent("waiting for Pablo");
    expect(rows[1]).toHaveTextContent("Ship it");
    expect(rows[1]).not.toHaveTextContent(":Any note");
  });

  it("de-emphasises a done task the way the TUI does (strikethrough row)", () => {
    render(<TodoCard todo={state([task({ id: 1, title: "All finished", status: "done" })])} />);

    fireEvent.click(screen.getByRole("button", { name: /todos/i }));
    const row = screen.getByRole("listitem");
    expect(row).toHaveClass("gc-todo-card__row--dimmed");
    expect(row).toHaveTextContent("✓");
    expect(screen.queryByText(/in_progress/)).not.toBeInTheDocument();
  });

  it("renders a row neutrally for an unknown status instead of crashing or dropping it", () => {
    render(<TodoCard todo={state([task({ id: 7, title: "Deferred work", status: "deferred" })])} />);

    fireEvent.click(screen.getByRole("button", { name: /todos/i }));
    const row = screen.getByRole("listitem");
    expect(row).toHaveTextContent("Deferred work");
    expect(row).toHaveClass("gc-todo-card__row--unknown");
    expect(row).toHaveTextContent("•");
  });

  it("marks the in-progress task as current in the collapsed summary", () => {
    render(
      <TodoCard
        todo={state([
          task({ id: 1, title: "Render the card", status: "in_progress" }),
          task({ id: 2, title: "Test the card", status: "pending" }),
        ])}
      />,
    );

    const toggle = screen.getByRole("button", { name: /todos/i });
    expect(toggle).toHaveTextContent("◐");
    expect(toggle).toHaveTextContent("Render the card");
    expect(toggle).toHaveTextContent("0/2");
  });
});

describe("TodoCard panel variant (T3 inspector)", () => {
  it("renders the task rows always visible with no toggle and no summary line", () => {
    render(
      <TodoCard
        variant="panel"
        todo={state([
          task({ id: 1, title: "Wire the codec", status: "done" }),
          task({ id: 2, title: "Render the card", status: "in_progress" }),
        ])}
      />,
    );

    expect(screen.getByTestId("gc-todo-card")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Wire the codec")).toBeInTheDocument();
    // No toggle button and no summary line in the panel variant.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/todos/)).not.toBeInTheDocument();
  });

  it("keeps the glyph and dimmed row rules unchanged in the panel variant", () => {
    render(<TodoCard variant="panel" todo={state([task({ id: 1, title: "All finished", status: "done" })])} />);

    const row = screen.getByRole("listitem");
    expect(row).toHaveClass("gc-todo-card__row--dimmed");
    expect(row).toHaveTextContent("✓");
  });
});

describe("todoProgress (shared with InspectorPanel, T3)", () => {
  it("counts done and planned (planned excludes dropped) with a rounded percent", () => {
    expect(todoProgress(state([
      task({ id: 1, status: "done" }),
      task({ id: 2, status: "done" }),
      task({ id: 3, status: "pending" }),
      task({ id: 4, status: "in_progress" }),
      task({ id: 5, status: "dropped" }),
    ]))).toEqual({ done: 2, planned: 4, percent: 50 });
  });

  it("returns null percent when nothing is planned — never a fabricated 0%", () => {
    expect(todoProgress(state([task({ id: 1, status: "dropped" })]))).toEqual({ done: 0, planned: 0, percent: null });
  });

  it("is consistent with the card's own summary count", () => {
    const tasks = state([
      task({ id: 1, status: "done" }),
      task({ id: 2, status: "pending" }),
    ]);
    render(<TodoCard todo={tasks} />);

    const progress = todoProgress(tasks);
    expect(screen.getByTestId("gc-todo-card")).toHaveTextContent(`${progress.done}/${progress.planned}`);
  });
});

describe("TodoCard derived percentage (T9)", () => {
  it("shows the percentage derived from the task counts, not a stored value", () => {
    render(
      <TodoCard
        todo={state([
          task({ id: 1, status: "done" }),
          task({ id: 2, status: "done" }),
          task({ id: 3, status: "pending" }),
          task({ id: 4, status: "in_progress" }),
        ])}
      />,
    );

    expect(screen.getByTestId("gc-todo-card")).toHaveTextContent("2/4 · 50%");
  });

  it("shows no percentage when nothing is planned, instead of a fabricated 0%", () => {
    render(
      <TodoCard
        todo={state([task({ id: 1, status: "dropped" }), task({ id: 2, status: "dropped" })])}
      />,
    );

    expect(screen.getByTestId("gc-todo-card")).not.toHaveTextContent("%");
  });
});
