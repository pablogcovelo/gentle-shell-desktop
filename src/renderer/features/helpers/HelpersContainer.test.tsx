// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GentleBridge, HelperTask, HelpersActivity } from "@shared/bridge-types";
import { HelpersContainer } from "./HelpersContainer";

const OPENED_AT = "2026-09-22T10:00:00.000Z";

function task(overrides: Partial<HelperTask> = {}): HelperTask {
  return {
    id: "task-1",
    agent: "a",
    label: "Task",
    prompt: "p",
    status: "queued",
    createdAt: "2026-09-22T10:00:00.000Z",
    turns: 0,
    toolCalls: 0,
    thread: { version: 0, dropped: 0, items: [] },
    ...overrides,
  };
}

function activity(tasks: HelperTask[], overrides: Partial<HelpersActivity> = {}): HelpersActivity {
  return {
    summary: {
      running: tasks.filter((t) => t.status === "running").length,
      queued: tasks.filter((t) => t.status === "queued").length,
      waiting: tasks.filter((t) => t.status === "waiting").length,
      finished: tasks.filter((t) => t.status === "done" || t.status === "failed" || t.status === "cancelled").length,
    },
    tasks,
    ...overrides,
  };
}

/** A fake window.gentle whose stopHelper is observable — the same pattern
 * the conversation/first-run tests use for bridge-backed actions. */
function useFakeBridge(stopHelper: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue("requested")): void {
  window.gentle = { stopHelper } as unknown as GentleBridge;
}

afterEach(() => {
  Reflect.deleteProperty(window, "gentle");
});

describe("HelpersContainer", () => {
  it("selects the first running task by default", () => {
    const tasks = [
      task({ id: "1", label: "Queued task", status: "queued" }),
      task({ id: "2", label: "Running task", status: "running", startedAt: "2026-09-22T10:00:00.000Z" }),
    ];
    render(<HelpersContainer activity={activity(tasks)} onBackToChat={() => {}} openedAt={OPENED_AT} />);


    expect(screen.getByRole("heading", { name: "Running task" })).toBeInTheDocument();
  });

  it("falls back to the first task when none are running", () => {
    const tasks = [task({ id: "1", label: "Only task", status: "queued" })];
    render(<HelpersContainer activity={activity(tasks)} onBackToChat={() => {}} openedAt={OPENED_AT} />);

    expect(screen.getByRole("heading", { name: "Only task" })).toBeInTheDocument();
  });

  it("switches the thread when a different helper is selected from the list", () => {
    const tasks = [task({ id: "1", label: "First" }), task({ id: "2", label: "Second" })];
    render(<HelpersContainer activity={activity(tasks)} onBackToChat={() => {}} openedAt={OPENED_AT} />);

    fireEvent.click(screen.getByText("Second"));

    expect(screen.getByRole("heading", { name: "Second" })).toBeInTheDocument();
  });

  it("keeps the current selection across an activity update even after the selected task finishes", () => {
    const initial = [task({ id: "1", label: "First", status: "running", startedAt: "2026-09-22T10:00:00.000Z" })];
    const { rerender } = render(<HelpersContainer activity={activity(initial)} onBackToChat={() => {}} openedAt={OPENED_AT} />);
    expect(screen.getByRole("heading", { name: "First" })).toBeInTheDocument();

    const updated = [
      task({ id: "1", label: "First", status: "done", startedAt: "2026-09-22T10:00:00.000Z", endedAt: "2026-09-22T10:00:05.000Z" }),
    ];
    rerender(<HelpersContainer activity={activity(updated)} onBackToChat={() => {}} openedAt={OPENED_AT} />);

    expect(screen.getByRole("heading", { name: "First" })).toBeInTheDocument();
  });

  it("follows a newly-running task once the previously selected one is no longer in the list", () => {
    const initial = [task({ id: "1", label: "First", status: "running", startedAt: "2026-09-22T10:00:00.000Z" })];
    const { rerender } = render(<HelpersContainer activity={activity(initial)} onBackToChat={() => {}} openedAt={OPENED_AT} />);
    expect(screen.getByRole("heading", { name: "First" })).toBeInTheDocument();

    const updated = [task({ id: "2", label: "Second", status: "running", startedAt: "2026-09-22T10:00:00.000Z" })];
    rerender(<HelpersContainer activity={activity(updated)} onBackToChat={() => {}} openedAt={OPENED_AT} />);

    expect(screen.getByRole("heading", { name: "Second" })).toBeInTheDocument();
  });

  it("shows a placeholder in both panes when the chat has no helpers", () => {
    render(<HelpersContainer activity={activity([])} onBackToChat={() => {}} openedAt={OPENED_AT} />);
    expect(screen.getByText("No helpers in this chat yet.")).toBeInTheDocument();
    expect(screen.getByText("Nothing running for this chat yet.")).toBeInTheDocument();
  });

  it("calls onBackToChat from the footer button", () => {
    let called = false;
    const tasks = [task({ id: "1", label: "First" })];
    render(<HelpersContainer activity={activity(tasks)} onBackToChat={() => (called = true)} openedAt={OPENED_AT} />);

    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));

    expect(called).toBe(true);
  });

  it("hides tool details by default and shows them once the toggle is checked", () => {
    const tasks = [
      task({
        id: "1",
        label: "First",
        thread: {
          version: 0,
          dropped: 0,
          items: [{ kind: "tool", callId: "c1", name: "Read", args: { path: "x" }, output: "the output" }],
        },
      }),
    ];
    render(<HelpersContainer activity={activity(tasks)} onBackToChat={() => {}} openedAt={OPENED_AT} />);

    expect(screen.queryByText(/the output/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Show tool details" }));

    expect(screen.getByText(/the output/)).toBeInTheDocument();
  });

  it("Stop stays disabled while the control channel has not been adopted, and says why", () => {
    const tasks = [task({ id: "1", label: "First", status: "running", startedAt: OPENED_AT })];
    render(<HelpersContainer activity={activity(tasks)} onBackToChat={() => {}} openedAt={OPENED_AT} />);

    const stopButton = screen.getByRole("button", { name: "Stop" });
    expect(stopButton).toBeDisabled();
    expect(stopButton).toHaveAttribute("title", "Waiting for this chat's control channel to become ready\u2026");
  });

  it("Stop stays disabled with the channel's honest reason when the probe failed", () => {
    const tasks = [task({ id: "1", label: "First", status: "running", startedAt: OPENED_AT })];
    render(
      <HelpersContainer
        activity={activity(tasks, { stopChannel: { available: false, reason: "Channel unavailable \u2014 this child has no desktop control channel, so helpers cannot be stopped." } })}
        onBackToChat={() => {}}
        openedAt={OPENED_AT}
      />,
    );

    const stopButton = screen.getByRole("button", { name: "Stop" });
    expect(stopButton).toBeDisabled();
    expect(stopButton).toHaveAttribute(
      "title",
      "Channel unavailable \u2014 this child has no desktop control channel, so helpers cannot be stopped.",
    );
  });

  it("Stop stays disabled with the channel's reason when cancel_subagent is not advertised", () => {
    const tasks = [task({ id: "1", label: "First", status: "running", startedAt: OPENED_AT })];
    render(
      <HelpersContainer
        activity={activity(tasks, { stopChannel: { available: false, reason: "gentle-shell does not advertise cancel_subagent on this child's control channel, so helpers cannot be stopped from here." } })}
        onBackToChat={() => {}}
        openedAt={OPENED_AT}
      />,
    );

    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
  });

  it("enables Stop once the channel is adopted, for a cancellable helper only, and issues the cancel for THAT helper's id and no other", async () => {
    const stopHelper = vi.fn().mockResolvedValue("requested");
    useFakeBridge(stopHelper);
    const tasks = [
      task({ id: "helper-a", label: "Running task", status: "running", startedAt: OPENED_AT }),
      task({ id: "helper-b", label: "Queued task", status: "queued" }),
    ];
    render(<HelpersContainer activity={activity(tasks, { stopChannel: { available: true } })} onBackToChat={() => {}} openedAt={OPENED_AT} />);

    const stopButton = screen.getByRole("button", { name: "Stop" });
    expect(stopButton).toBeEnabled();

    // The default selection is the running helper: stopping issues the
    // cancel for helper-a and never for helper-b.
    fireEvent.click(stopButton);
    await waitFor(() => expect(stopHelper).toHaveBeenCalledTimes(1));
    expect(stopHelper).toHaveBeenCalledWith("helper-a");
    expect(stopHelper).not.toHaveBeenCalledWith("helper-b");
  });

  it("Stop is disabled for a helper that already finished, with its reason", () => {
    const tasks = [task({ id: "1", label: "First", status: "done", startedAt: OPENED_AT, endedAt: OPENED_AT })];
    render(<HelpersContainer activity={activity(tasks, { stopChannel: { available: true } })} onBackToChat={() => {}} openedAt={OPENED_AT} />);

    const stopButton = screen.getByRole("button", { name: "Stop" });
    expect(stopButton).toBeDisabled();
    expect(stopButton).toHaveAttribute("title", "Only queued or running helpers can be stopped.");
  });

  it("Stop is disabled for a waiting helper", () => {
    const tasks = [task({ id: "1", label: "First", status: "waiting", startedAt: OPENED_AT })];
    render(<HelpersContainer activity={activity(tasks, { stopChannel: { available: true } })} onBackToChat={() => {}} openedAt={OPENED_AT} />);

    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
  });

  it("a requested stop does not mark the helper stopped on its own \u2014 the row stays running until a state push flips it", async () => {
    const stopHelper = vi.fn().mockResolvedValue("requested");
    useFakeBridge(stopHelper);
    const tasks = [task({ id: "1", label: "Running task", status: "running", startedAt: OPENED_AT })];
    const { rerender } = render(
      <HelpersContainer activity={activity(tasks, { stopChannel: { available: true } })} onBackToChat={() => {}} openedAt={OPENED_AT} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(stopHelper).toHaveBeenCalled());

    // The outcome note explains the asynchronous stop; the helper is
    // still rendered as running.
    expect(await screen.findByText(/Stop requested \u2014 the helper stops asynchronously/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Running task" })).toBeInTheDocument();

    // The real transition arrives as a pushed state (agents_update):
    // only then does the row render stopped.
    rerender(
      <HelpersContainer
        activity={activity([task({ id: "1", label: "Running task", status: "cancelled", startedAt: OPENED_AT, endedAt: OPENED_AT })], {
          stopChannel: { available: true },
        })}
        onBackToChat={() => {}}
        openedAt={OPENED_AT}
      />,
    );
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
  });

  it("a not_tracked stop outcome renders a note the user can act on, never an error surface", async () => {
    const stopHelper = vi.fn().mockResolvedValue("not_tracked");
    useFakeBridge(stopHelper);
    const tasks = [task({ id: "1", label: "Running task", status: "running", startedAt: OPENED_AT })];
    render(<HelpersContainer activity={activity(tasks, { stopChannel: { available: true } })} onBackToChat={() => {}} openedAt={OPENED_AT} />);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(await screen.findByText(/no longer tracked \u2014 it already finished/)).toBeInTheDocument();
  });

  it("an unavailable stop outcome renders its note too", async () => {
    const stopHelper = vi.fn().mockResolvedValue("unavailable");
    useFakeBridge(stopHelper);
    const tasks = [task({ id: "1", label: "Running task", status: "running", startedAt: OPENED_AT })];
    render(<HelpersContainer activity={activity(tasks, { stopChannel: { available: true } })} onBackToChat={() => {}} openedAt={OPENED_AT} />);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(await screen.findByText(/Could not stop the helper/)).toBeInTheDocument();
  });

  it("a helper that appears in both sources renders once once merged (single id, single row)", () => {
    const merged = task({
      id: "m3a1-worker",
      label: "Audit the loaders",
      status: "done",
      model: "anthropic/claude-sonnet-4",
      usage: { total: 15234, cost: 0.0421 },
    });
    render(
      <HelpersContainer activity={activity([merged], { stopChannel: { available: true }, agents: [{ id: "m3a1-worker", agent: "worker", status: "completed" }] })} onBackToChat={() => {}} openedAt={OPENED_AT} />,
    );

    // One identity, one row: the list carries exactly ONE row for the
    // merged id (the thread pane's heading is the selected task's own
    // title, not a second list entry).
    const list = document.querySelector("ul.gc-helper-list");
    expect(list?.querySelectorAll("li")).toHaveLength(1);
    expect(screen.getAllByRole("heading", { name: "Audit the loaders" })).toHaveLength(1);
  });

  describe("the Earlier group", () => {
    function earlierTask(overrides: Partial<HelperTask> = {}): HelperTask {
      return task({ id: "earlier-1", label: "Earlier task", status: "done", endedAt: "2026-09-18T10:00:00.000Z", ...overrides });
    }

    it("folds a helper finished before openedAt into the Earlier group instead of the main list", () => {
      const tasks = [task({ id: "current-1", label: "Running task", status: "running" }), earlierTask()];
      render(<HelpersContainer activity={activity(tasks)} onBackToChat={() => {}} openedAt={OPENED_AT} />);

      expect(screen.queryByText("Earlier task")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Earlier · 1 finished/ })).toBeInTheDocument();
    });

    it("keeps a helper finished during this run out of the Earlier group", () => {
      const tasks = [task({ id: "current-1", label: "Just finished", status: "done", endedAt: "2026-09-23T10:00:00.000Z" })];
      render(<HelpersContainer activity={activity(tasks)} onBackToChat={() => {}} openedAt={OPENED_AT} />);

      expect(screen.getAllByText("Just finished").length).toBeGreaterThan(0);
      expect(screen.queryByRole("button", { name: /Earlier/ })).not.toBeInTheDocument();
    });

    it("selects and expands the Earlier group by default when it is the only content", () => {
      render(<HelpersContainer activity={activity([earlierTask()])} onBackToChat={() => {}} openedAt={OPENED_AT} />);

      expect(screen.getByRole("heading", { name: "Earlier task" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Earlier · 1 finished/ })).toHaveAttribute("aria-expanded", "true");
    });

    it("selecting an item in the Earlier group still shows its thread", () => {
      const tasks = [task({ id: "current-1", label: "Running task", status: "running" }), earlierTask()];
      render(<HelpersContainer activity={activity(tasks)} onBackToChat={() => {}} openedAt={OPENED_AT} />);

      fireEvent.click(screen.getByRole("button", { name: /Earlier · 1 finished/ }));
      fireEvent.click(screen.getByText("Earlier task"));

      expect(screen.getByRole("heading", { name: "Earlier task" })).toBeInTheDocument();
    });
  });
});
