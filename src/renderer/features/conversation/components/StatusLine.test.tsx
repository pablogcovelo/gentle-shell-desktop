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
  it("renders nothing when there is nothing at all to show", () => {
    const { container } = render(<StatusLine />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByLabelText("Session status")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Notifications")).not.toBeInTheDocument();
  });

  it("renders the error message with role status and error severity", () => {
    render(<StatusLine error="pi exited unexpectedly" />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("pi exited unexpectedly");
    expect(status).toHaveClass("gc-status-line--error");
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

    it("renders with info severity", () => {
      render(<StatusLine statuses={{ "gentle-todo": "2 tasks open" }} />);
      expect(screen.getByLabelText("Session status")).toHaveClass("gc-status-entries--info");
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

    // S12 (gui-design-alignment): the maintainer's decision — "si solo se
    // muestran por un periodo de tiempo limitado es muy fácil que el
    // usuario se pierda estos StatusLine". Nothing here hides on a timer
    // any more: past any former window the entries are still rendered.
    it("keeps error, keyed status and notification rendered well past the former 6s window", () => {
      render(
        <StatusLine
          error="pi exited unexpectedly"
          statuses={{ "gentle-todo": "2 tasks open" }}
          notifications={[notification("Disk full", "error")]}
        />,
      );

      const farPastTheFormerWindow = 60000;
      act(() => {
        vi.advanceTimersByTime(farPastTheFormerWindow);
      });

      expect(screen.getByRole("status")).toHaveTextContent("pi exited unexpectedly");
      expect(screen.getByLabelText("Session status")).toHaveTextContent("gentle-todo");
      expect(screen.getByLabelText("Notifications")).toHaveTextContent("Disk full");
    });

    it("renders nothing when the notification list is empty", () => {
      const { container } = render(<StatusLine notifications={[]} />);
      expect(container).toBeEmptyDOMElement();
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
