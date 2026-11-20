// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type {
  HelpersActivity,
  HelperTask,
  SessionIdentityView,
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
  session?: SessionIdentityView;
  usage?: SubscriptionUsage;
  usageChannelUnavailable?: boolean;
  helpers?: HelpersActivity;
  onOpenHelpers?: () => void;
} = {}) {
  return render(
    <InspectorPanel
      todo={props.todo}
      session={props.session}
      usage={props.usage}
      usageChannelUnavailable={props.usageChannelUnavailable}
      helpers={props.helpers ?? helpersActivity()}
      onOpenHelpers={props.onOpenHelpers ?? vi.fn()}
    />,
  );
}

describe("InspectorPanel", () => {
  it("shows the session cost first in the Usage section, above the usage meters", () => {
    renderPanel({
      session: { modelName: "Claude Sonnet 4", thinkingLevel: "medium", sessionCost: 0.45 },
      usage: { providers: [CODEX_WITH_WINDOW] },
    });

    // One row, lowercase label and value together, in the inspector's own
    // wording — not a footer line.
    const cost = screen.getByLabelText("Total session cost in US dollars");
    expect(cost).toHaveTextContent("$0.45");
    expect(cost.closest(".gc-inspector__cost")).toHaveTextContent(/session cost\s*\$0\.45/);

    // First element of the section: the cost precedes every meter.
    const meter = screen.getByRole("progressbar", { name: /week usage/i });
    expect(cost.compareDocumentPosition(meter) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  // S8 (gui-design-alignment): each agent row is one flat line — status
  // glyph, agent name, status word. No disclosure, label, task id, last
  // step or counters.
  it("renders one flat line per agent: glyph, name, status word (S8)", () => {
    renderPanel({
      helpers: helpersActivity([
        helperTask({ id: "a1", agent: "gentle-ai-explore", status: "running", lastStep: "Reading source", turns: 3, toolCalls: 7 }),
      ]),
    });

    const row = screen.getByRole("listitem");
    expect(row).toHaveAttribute("data-status", "running");
    expect(row).toHaveTextContent("gentle-ai-explore");
    expect(row).toHaveTextContent("Running");
    expect(within(row).queryByText("Reading source")).not.toBeInTheDocument();
    expect(within(row).queryByText("3 turns · 7 tool calls")).not.toBeInTheDocument();
    expect(within(row).queryByText("a1")).not.toBeInTheDocument();
    expect(row.querySelector("details")).toBeNull();
    expect(row.querySelector("summary")).toBeNull();
  });

  // S9 (gui-design-alignment): glyph/word per status, with a safe fallback
  // for an unknown status that renders the raw status word and ○.
  it("maps each known status to its glyph and word (S9)", () => {
    renderPanel({
      helpers: helpersActivity([
        helperTask({ id: "a1", agent: "runner", status: "running" }),
        helperTask({ id: "a2", agent: "finisher", status: "done" }),
        helperTask({ id: "a3", agent: "breaker", status: "failed" }),
        helperTask({ id: "a4", agent: "stopper", status: "cancelled" }),
        helperTask({ id: "a5", agent: "starter", status: "queued" }),
        helperTask({ id: "a6", agent: "waiter", status: "waiting" }),
      ]),
    });

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(6);
    const text = (index: number) => rows[index]!.textContent;
    expect(text(0)).toContain("◐");
    expect(text(0)).toContain("Running");
    expect(text(1)).toContain("✓");
    expect(text(1)).toContain("Done");
    expect(text(2)).toContain("✕");
    expect(text(2)).toContain("Failed");
    expect(text(3)).toContain("⊘");
    expect(text(3)).toContain("Cancelled");
    expect(text(4)).toContain("○");
    expect(text(4)).toContain("Queued");
    expect(text(5)).toContain("○");
    expect(text(5)).toContain("Waiting");
  });

  it("renders an unknown status as the raw word with the ○ glyph, never an invented word (S9)", () => {
    renderPanel({
      helpers: helpersActivity([helperTask({ id: "a1", status: "timed_out" as HelperTask["status"] })]),
    });

    const row = screen.getByRole("listitem");
    expect(row.textContent).toContain("○");
    expect(row.textContent).toContain("timed_out");
    expect(row.textContent).not.toContain("Running");
  });

  // S3 (gui-design-alignment): the Todo section keeps the head meta but
  // renders neither the intro line nor the percentage progress bar.
  it("keeps the head meta but renders no intro line and no task progress bar", () => {
    renderPanel({ todo: todoState([todoTask({ id: 1, status: "done" }), todoTask({ id: 2 })]) });
    expect(screen.getByText("1/2 · 50%")).toBeInTheDocument();
    expect(screen.queryByText("A small plan. A clear next step.")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar", { name: "Task progress" })).not.toBeInTheDocument();
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

  // R3-002 (gui-design-alignment): the eye renders UNCONDITIONALLY — keyed
  // statuses and child notifications are only visible in the helpers view,
  // so an empty agents list must not leave them unreachable.
  it("keeps the eye in the Agents head even when no helpers have run in this chat (R3-002)", () => {
    const onOpenHelpers = vi.fn();
    renderPanel({ helpers: helpersActivity([]), onOpenHelpers });

    expect(screen.getByText("No delegated agents in this conversation yet.")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Open helpers" });
    expect(button).toHaveClass("gc-inspector__eye");
    expect(button.closest(".gc-inspector__head")).not.toBeNull();
    fireEvent.click(button);
    expect(onOpenHelpers).toHaveBeenCalledTimes(1);
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
    expect(rows[0]).toHaveTextContent("Running");
    expect(rows[1]).toHaveAttribute("data-status", "done");
    expect(within(rows[1]!).queryByText("Review the diff")).not.toBeInTheDocument();
    expect(rows[2]).toHaveAttribute("data-status", "failed");
    expect(rows[2]).toHaveTextContent("Failed");
    expect(rows[3]).toHaveAttribute("data-status", "waiting");
    expect(rows[3]).toHaveTextContent("Waiting");
  });

  it("never renders a helper's last step or turn/tool counters, even when the wire supplied them (S8)", () => {
    renderPanel({
      helpers: helpersActivity([helperTask({ id: "a1", lastStep: "Editing Composer.tsx", turns: 3, toolCalls: 7 })]),
    });

    expect(screen.queryByText("Editing Composer.tsx")).not.toBeInTheDocument();
    expect(screen.queryByText("3 turns · 7 tool calls")).not.toBeInTheDocument();
  });

  it("renders no last-step line when the wire did not supply one (never invented)", () => {
    renderPanel({ helpers: helpersActivity([helperTask({ id: "a1", lastStep: undefined })]) });

    expect(screen.getByRole("listitem")).not.toHaveTextContent("Editing Composer");
  });

  // S10 (gui-design-alignment): the Agents section head carries an
  // icon-only eye button, named "Open helpers", that opens the helpers
  // view; it replaces the old text button.
  it('carries an icon-only "Open helpers" eye button in the Agents head (S10)', () => {
    const onOpenHelpers = vi.fn();
    renderPanel({
      helpers: helpersActivity([helperTask({ id: "a1" })]),
      onOpenHelpers,
    });

    const button = screen.getByRole("button", { name: "Open helpers" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveAttribute("title", "Open helpers");
    expect(button).toHaveClass("gc-inspector__eye");
    expect(button.textContent).toBe("");
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.closest(".gc-inspector__head")).not.toBeNull();
    fireEvent.click(button);
    expect(onOpenHelpers).toHaveBeenCalledTimes(1);
  });
});
