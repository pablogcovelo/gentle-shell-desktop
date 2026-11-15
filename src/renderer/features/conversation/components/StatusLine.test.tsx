// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ChatNotification } from "@shared/bridge-types";
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

// The former "StatusLine session identity (desktop-rpc T4)" describe block
// was DELETED here: the owner's footer decision (desktop-workspace-shell
// S9/S10, "Implementa el footer tal cual está en el diseño") moves the
// session identity facts out of the status line into the footer, and their
// tests now live in Footer.test.tsx. Every other StatusLine test above is
// untouched.
