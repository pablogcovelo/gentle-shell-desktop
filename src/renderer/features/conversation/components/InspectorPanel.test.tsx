// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type {
  HelpersActivity,
  HelperTask,
  SubscriptionUsage,
  TodoPanelState,
  TodoTaskView,
  UsageProvider,
} from "@shared/bridge-types";
import { InspectorPanel } from "./InspectorPanel";

const CODEX_WITH_WINDOW: UsageProvider = {
  provider: "openai-codex",
  status: "ok",
  plan: "pro",
  limits: [
    {
      name: "codex",
      limitReached: false,
      windows: [{ label: "week", usedPercent: 40, windowSeconds: 604800, resetAt: 1788777491000 }],
    },
  ],
};

const ANTHROPIC_PENDING: UsageProvider = { provider: "anthropic", status: "pending" };

function todoTask(overrides: Partial<TodoTaskView> = {}): TodoTaskView {
  return { id: 1, title: "Plan the work", status: "pending", ...overrides };
}

function todoState(tasks: TodoTaskView[]): TodoPanelState {
  return { tasks, nextId: tasks.length + 1, updatedTurn: 3 };
}

function helperTask(overrides: Partial<HelperTask> = {}): HelperTask {
  return {
    id: "a1",
    agent: "refactorer",
    label: "Extract the reducer",
    prompt: "extract it",
    status: "running",
    createdAt: new Date().toISOString(),
    turns: 3,
    toolCalls: 7,
    thread: { version: 1, dropped: 0, items: [] },
    ...overrides,
  };
}

function helpersActivity(tasks: HelperTask[] = [], overrides: Partial<HelpersActivity> = {}): HelpersActivity {
  return {
    summary: {
      running: tasks.filter((task) => task.status === "running").length,
      queued: 0,
      waiting: 0,
      finished: tasks.filter((task) => task.status === "done" || task.status === "failed").length,
    },
    tasks,
    ...overrides,
  };
}

function renderPanel(props: {
  todo?: TodoPanelState;
  usage?: SubscriptionUsage;
  usageChannelUnavailable?: boolean;
  helpers?: HelpersActivity;
  onOpenHelpers?: () => void;
} = {}) {
  return render(
    <InspectorPanel
      todo={props.todo}
      usage={props.usage}
      usageChannelUnavailable={props.usageChannelUnavailable}
      helpers={props.helpers ?? helpersActivity()}
      onOpenHelpers={props.onOpenHelpers ?? vi.fn()}
    />,
  );
}

describe("InspectorPanel", () => {
  it("keeps real agent metadata behind a collapsed disclosure", () => {
    renderPanel({ helpers: helpersActivity([helperTask({ lastStep: "Reading source" })]) });
    const summary = screen.getByText("refactorer").closest("summary")!;
    const details = summary.closest("details")!;
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(summary);
    expect(details).toHaveAttribute("open");
    expect(details).toHaveTextContent("a1");
    expect(details).toHaveTextContent("Reading source");
    expect(details).toHaveTextContent("3 turns · 7 tool calls");
  });

  it("shows derived task progress without changing the card variant", () => {
    renderPanel({ todo: todoState([todoTask({ id: 1, status: "done" }), todoTask({ id: 2 })]) });
    expect(screen.getByRole("progressbar", { name: "Task progress" })).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("1/2 · 50%")).toBeInTheDocument();
  });
  it("renders the three sections in the fixed order Todo / Usage / Agents (S3)", () => {
    renderPanel();

    expect(screen.getByRole("complementary", { name: "Plan, usage and delegated agents" })).toBeInTheDocument();
    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings).toHaveLength(3);
    expect(headings.map((heading) => heading.textContent)).toEqual(["Todo", "Usage", "Agents"]);
  });

  it("shows the todo empty note when the chat has no tasks", () => {
    renderPanel({ todo: todoState([]) });

    expect(screen.getByText("No tasks in this conversation yet.")).toBeInTheDocument();
    expect(screen.queryByTestId("gc-todo-card")).not.toBeInTheDocument();
  });

  it("shows the todo empty note when no todo state has arrived yet (S5)", () => {
    renderPanel();

    expect(screen.getByText("No tasks in this conversation yet.")).toBeInTheDocument();
  });

  it("feeds the chat's todo to the panel TodoCard when tasks exist", () => {
    renderPanel({ todo: todoState([todoTask({ id: 1, status: "done" }), todoTask({ id: 2 })]) });

    const card = screen.getByTestId("gc-todo-card");
    expect(within(card).getAllByRole("listitem")).toHaveLength(2);
  });

  it("shows the done/planned meta only when something is planned", () => {
    const withPlanned = renderPanel({ todo: todoState([todoTask({ id: 1, status: "done" }), todoTask({ id: 2 })]) });
    expect(withPlanned.container.querySelector(".gc-inspector__head")?.textContent).toContain("1/2");
    withPlanned.unmount();

    // Only a dropped task: planned is 0, so the meta must not render at all —
    // a fabricated 0/0 would misstate the plan (S5).
    const onlyDropped = renderPanel({ todo: todoState([todoTask({ id: 1, status: "dropped" })]) });
    expect(onlyDropped.container.querySelector(".gc-inspector__meta")?.textContent).not.toMatch(/\d\/\d/);
    onlyDropped.unmount();

    const noTasks = renderPanel({ todo: todoState([]) });
    expect(noTasks.container.querySelector(".gc-inspector__meta")?.textContent).not.toMatch(/\d\/\d/);
  });

  it("renders the Usage section with reserved empty space when nothing has been reported (never a fabricated 0%, S5)", () => {
    renderPanel();

    expect(screen.getByRole("heading", { name: "Usage" })).toBeInTheDocument();
    expect(screen.queryByText("No usage reported yet.")).not.toBeInTheDocument();
    expect(document.querySelector("[data-provider]")).toBeNull();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  it("keeps the Usage section rendered with an empty body when the usage object has no providers", () => {
    renderPanel({ usage: { providers: [] } });

    expect(screen.getByRole("heading", { name: "Usage" })).toBeInTheDocument();
    expect(screen.queryByText("No usage reported yet.")).not.toBeInTheDocument();
    expect(document.querySelector("[data-provider]")).toBeNull();
  });

  it("keeps the Usage section rendered when every provider is unavailable — dropped, not dead blocks", () => {
    renderPanel({ usage: { providers: [{ provider: "opencode-go", status: "unavailable" }] } });

    expect(screen.getByRole("heading", { name: "Usage" })).toBeInTheDocument();
    expect(document.querySelector("[data-provider]")).toBeNull();
    expect(screen.queryByText("No usage reported yet.")).not.toBeInTheDocument();
  });

  it("still routes the channel-unavailable failure through to the meters' red channel note", () => {
    renderPanel({ usageChannelUnavailable: true });

    const note = screen.getByText(/channel unavailable/i);
    expect(note).toHaveClass("gc-usage__note--channel-unavailable");
  });

  it("renders the usage meters when the wire supplied provider data", () => {
    renderPanel({ usage: { providers: [CODEX_WITH_WINDOW, ANTHROPIC_PENDING] } });

    expect(screen.getByText("openai-codex")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /week usage/i })).toBeInTheDocument();
    expect(screen.queryByText("No usage reported yet.")).not.toBeInTheDocument();
  });

  it("routes the channel-unavailable state through to the meters instead of the plain note", () => {
    renderPanel({ usageChannelUnavailable: true });

    expect(screen.getByText(/channel unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText("No usage reported yet.")).not.toBeInTheDocument();
  });

  it("shows the agents empty note when no helpers have run in this chat", () => {
    renderPanel({ helpers: helpersActivity([]) });

    expect(screen.getByText("No delegated agents in this conversation yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open helpers/i })).not.toBeInTheDocument();
  });

  it("renders one row per helper task and the summary meta straight from the wire (S5)", () => {
    renderPanel({
      helpers: helpersActivity([
        helperTask({ id: "a1", agent: "refactorer", status: "running", turns: 3, toolCalls: 7 }),
        helperTask({ id: "a2", agent: "reviewer", status: "done", label: "Review the diff", turns: 1, toolCalls: 2 }),
        helperTask({ id: "a3", agent: "tester", status: "failed", label: "Run the suite", turns: 2, toolCalls: 4 }),
        helperTask({ id: "a4", agent: "gater", status: "waiting", label: "Waiting on Pablo", turns: 0, toolCalls: 0 }),
      ]),
    });

    expect(screen.getByText("1 active · 2 finished")).toBeInTheDocument();
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveAttribute("data-status", "running");
    expect(rows[0]).toHaveTextContent("refactorer");
    expect(rows[0]).toHaveTextContent("running");
    expect(rows[1]).toHaveTextContent("Review the diff");
    expect(rows[1]).toHaveAttribute("data-status", "done");
    expect(rows[2]).toHaveAttribute("data-status", "failed");
    expect(rows[3]).toHaveAttribute("data-status", "waiting");
  });

  it("renders a helper's last step and turn/tool counters when the wire supplied them", () => {
    renderPanel({
      helpers: helpersActivity([helperTask({ id: "a1", lastStep: "Editing Composer.tsx", turns: 3, toolCalls: 7 })]),
    });

    expect(screen.getByText("Editing Composer.tsx")).toBeInTheDocument();
    expect(screen.getByText("3 turns · 7 tool calls")).toBeInTheDocument();
  });

  it("renders no last-step line when the wire did not supply one (never invented)", () => {
    renderPanel({ helpers: helpersActivity([helperTask({ id: "a1", lastStep: undefined })]) });

    expect(screen.getByRole("listitem")).not.toHaveTextContent("Editing Composer");
  });

  it('"Open helpers" is a real button that fires the callback (S6)', () => {
    const onOpenHelpers = vi.fn();
    renderPanel({
      helpers: helpersActivity([helperTask({ id: "a1" })]),
      onOpenHelpers,
    });

    fireEvent.click(screen.getByRole("button", { name: "Open helpers" }));
    expect(onOpenHelpers).toHaveBeenCalledTimes(1);
  });
});
