// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CONVERSATION_PANE, ConversationHeader } from "./ConversationHeader";

describe("ConversationHeader", () => {
  it("keeps the directory heading without obsolete navigation or working chrome", () => {
    render(<ConversationHeader title="project" working pane={CONVERSATION_PANE.CHAT} runningHelpersCount={2} onSelectPane={() => {}} />);
    expect(screen.getByRole("heading", { name: "project" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText("Working…")).not.toBeInTheDocument();
  });

  it("offers a close control for the workspace whose host this pane addresses (P2)", () => {
    const onCloseWorkspace = vi.fn();
    render(<ConversationHeader title="project" canCloseWorkspace onCloseWorkspace={onCloseWorkspace} />);

    fireEvent.click(screen.getByRole("button", { name: "Close this workspace" }));
    expect(onCloseWorkspace).toHaveBeenCalledTimes(1);
  });

  it("renders no close control before the pane knows which host it addresses", () => {
    render(<ConversationHeader title="project" canCloseWorkspace={false} onCloseWorkspace={() => {}} />);

    expect(screen.queryByRole("button", { name: "Close this workspace" })).not.toBeInTheDocument();
  });

  // T5 (desktop-pending-work S5): the phase indicator renders the app's own
  // label for the token the child published through `session_state_changed`
  // — chrome next to the workspace title, not a control: no click affordance
  // and no role of its own.
  it("renders the app's own label for the phase the child published, as chrome — not a control", () => {
    render(<ConversationHeader title="project" oddPhase="implementing" />);

    expect(screen.getByText("Implementing")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Implementing" })).not.toBeInTheDocument();
  });

  it("renders no phase indicator when no phase was published", () => {
    render(<ConversationHeader title="project" />);

    expect(screen.queryByText("Exploring")).not.toBeInTheDocument();
  });

  it("drops the indicator when the published phase is cleared by omission, keeping the close control", () => {
    const view = render(
      <ConversationHeader title="project" oddPhase="exploring" canCloseWorkspace onCloseWorkspace={() => {}} />,
    );
    expect(screen.getByText("Exploring")).toBeInTheDocument();

    view.rerender(<ConversationHeader title="project" canCloseWorkspace onCloseWorkspace={() => {}} />);

    expect(screen.queryByText("Exploring")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close this workspace" })).toBeInTheDocument();
  });
});
