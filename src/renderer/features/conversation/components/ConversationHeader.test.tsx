// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CONVERSATION_PANE, ConversationHeader } from "./ConversationHeader";

describe("ConversationHeader", () => {
  it("keeps the directory heading without obsolete navigation or working chrome", () => {
    render(<ConversationHeader title="project" working pane={CONVERSATION_PANE.CHAT} runningHelpersCount={2} onSelectPane={() => {}} />);
    expect(screen.getByRole("heading", { name: "project" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText("Working…")).not.toBeInTheDocument();
  });
});
