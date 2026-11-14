// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ChatNotification, SessionIdentityView } from "@shared/bridge-types";
import { StatusLine } from "./StatusLine";

function notification(message: string, severity: ChatNotification["severity"]): ChatNotification {
  return { message, severity };
}

describe("StatusLine", () => {
  it("renders nothing when there is no error", () => {
    const { container } = render(<StatusLine />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the error message with role status", () => {
    render(<StatusLine error="pi exited unexpectedly" />);
    expect(screen.getByRole("status")).toHaveTextContent("pi exited unexpectedly");
  });

  describe("keyed statuses (desktop-rpc T2b)", () => {
    it("renders one entry per key, with its key and text", () => {
      render(<StatusLine statuses={{ "gentle-todo": "2 tasks open", "other-ext": "busy" }} />);

      const list = screen.getByLabelText("Session status");
      expect(list).toHaveTextContent("gentle-todo");
      expect(list).toHaveTextContent("2 tasks open");
      expect(list).toHaveTextContent("other-ext");
      expect(list).toHaveTextContent("busy");
    });

    it("replaces the entry in place when the same key arrives again, never duplicating it", () => {
      const { rerender } = render(<StatusLine statuses={{ "gentle-todo": "2 tasks open" }} />);
      rerender(<StatusLine statuses={{ "gentle-todo": "1 task open" }} />);

      const entries = screen.getAllByText(/task/);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toHaveTextContent("1 task open");
      expect(screen.queryByText("2 tasks open")).not.toBeInTheDocument();
    });

    it("drops the entry when the wire clears that key, keeping other keys", () => {
      const { rerender } = render(<StatusLine statuses={{ "gentle-todo": "2 tasks open", "other-ext": "busy" }} />);
      rerender(<StatusLine statuses={{ "other-ext": "busy" }} />);

      expect(screen.queryByText("gentle-todo")).not.toBeInTheDocument();
      expect(screen.getByText("other-ext")).toBeInTheDocument();
    });

    it("renders nothing when the status map is empty — nothing is invented", () => {
      const { container } = render(<StatusLine statuses={{}} />);
      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByLabelText("Session status")).not.toBeInTheDocument();
    });
  });

  describe("notifications (desktop-rpc T2b)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
      cleanup();
    });

    it("renders each notification distinguishably by severity", () => {
      render(
        <StatusLine
          notifications={[
            notification("Sync finished", "info"),
            notification("Command blocked by user", "warning"),
            notification("Disk full", "error"),
          ]}
        />,
      );

      const stack = screen.getByLabelText("Notifications");
      expect(stack.querySelector(".gc-status-line__notification--info")).toHaveTextContent("Sync finished");
      expect(stack.querySelector(".gc-status-line__notification--warning")).toHaveTextContent("Command blocked by user");
      expect(stack.querySelector(".gc-status-line__notification--error")).toHaveTextContent("Disk full");
    });

    it("hides the transient stack NOTIFICATION_VISIBLE_MS after the newest arrival, and shows a later one again", () => {
      const { rerender } = render(<StatusLine notifications={[notification("Disk full", "error")]} />);
      expect(screen.getByLabelText("Notifications")).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(6000);
      });
      expect(screen.queryByLabelText("Notifications")).not.toBeInTheDocument();

      // A new arrival restarts visibility: the transient feedback is
      // rendered again and clears again — never a growing history.
      rerender(<StatusLine notifications={[notification("Sync finished", "info")]} />);
      expect(screen.getByLabelText("Notifications")).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(6000);
      });
      expect(screen.queryByLabelText("Notifications")).not.toBeInTheDocument();
    });

    it("restarts the visibility window when a notification arrives while one is already showing", () => {
      const { rerender } = render(<StatusLine notifications={[notification("Disk full", "error")]} />);

      act(() => {
        vi.advanceTimersByTime(5000);
      });
      rerender(<StatusLine notifications={[notification("Disk full", "error"), notification("Sync finished", "info")]} />);

      act(() => {
        vi.advanceTimersByTime(5000);
      });
      // Only 5s since the newest arrival — still visible.
      expect(screen.getByLabelText("Notifications")).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.queryByLabelText("Notifications")).not.toBeInTheDocument();
    });
  });
});

describe("StatusLine session identity (desktop-rpc T4)", () => {
  const FULL_IDENTITY: SessionIdentityView = {
    modelId: "claude-sonnet-4-20250514",
    modelName: "Claude Sonnet 4",
    modelProvider: "anthropic",
    thinkingLevel: "medium",
    contextTokens: 60000,
    contextWindow: 200000,
    contextPercent: 30,
    sessionCost: 0.45,
    tokensTotal: 105000,
  };

  it("renders the model, thinking level, context percentage and session cost the child reported", () => {
    render(<StatusLine session={FULL_IDENTITY} />);

    const block = screen.getByLabelText("Session identity");
    expect(block).toHaveTextContent("Claude Sonnet 4");
    expect(block).toHaveTextContent("medium");
    expect(block).toHaveTextContent("30%");
    expect(block).toHaveTextContent("$0.45");
  });

  it("falls back to the model id when the child supplies no display name", () => {
    render(<StatusLine session={{ ...FULL_IDENTITY, modelName: undefined }} />);

    expect(screen.getByLabelText("Session identity")).toHaveTextContent("claude-sonnet-4-20250514");
  });

  it("renders nothing for a field the child did not supply, and never renders it as zero", () => {
    render(<StatusLine session={{ sessionCost: 0.45 }} />);

    const block = screen.getByLabelText("Session identity");
    expect(block).toHaveTextContent("$0.45");
    expect(within(block).queryByText("context")).not.toBeInTheDocument();
    expect(within(block).queryByText("model")).not.toBeInTheDocument();
    expect(within(block).queryByText("thinking")).not.toBeInTheDocument();
  });

  it("renders nothing for a context supplied as unknown (null right after compaction)", () => {
    render(<StatusLine session={{ contextTokens: null, contextWindow: 200000, contextPercent: null }} />);

    expect(screen.queryByLabelText("Session identity")).not.toBeInTheDocument();
  });

  it("renders a supplied zero cost as zero — unavailable and zero stay distinct", () => {
    render(<StatusLine session={{ sessionCost: 0 }} />);

    expect(screen.getByLabelText("Session identity")).toHaveTextContent("$0");
  });

  it("renders nothing at all when the child supplies no renderable identity fields", () => {
    const { container } = render(<StatusLine session={{ tokensTotal: 105000 }} />);

    expect(screen.queryByLabelText("Session identity")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });
});
