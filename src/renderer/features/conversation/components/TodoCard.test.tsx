// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { TodoPanelState, TodoTaskView } from "@shared/bridge-types";
import { TodoCard } from "./TodoCard";

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
