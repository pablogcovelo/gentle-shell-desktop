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
});
