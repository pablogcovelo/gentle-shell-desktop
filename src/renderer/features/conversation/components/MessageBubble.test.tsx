// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, within } from "@testing-library/react";
import { MESSAGE_ROLE, type ChatMessage, type ToolCallView, type ToolVocabulary } from "@shared/bridge-types";
import { MessageBubble } from "./MessageBubble";

const READ_VOCABULARY: ToolVocabulary = {
  categories: ["read"],
  entries: [{ category: "read", glyph: "≡", tools: ["read"] }],
};

describe("MessageBubble", () => {
  it("renders assistant Markdown text as real HTML elements", () => {
    const message: ChatMessage = { id: "m1", role: MESSAGE_ROLE.ASSISTANT, text: "**bold**" };
    const { container } = render(<MessageBubble message={message} />);

    expect(container.querySelector(".gs-markdown strong")).toHaveTextContent("bold");
    expect(container).toHaveTextContent("el Gentleman");
    expect(container).toHaveTextContent("GENTLE");
    expect(container.querySelector("time")).toBeNull();
  });

  it("renders user text literally, without interpreting Markdown", () => {
    const message: ChatMessage = { id: "m1", role: MESSAGE_ROLE.USER, text: "**bold**" };
    const { container } = render(<MessageBubble message={message} />);

    expect(container.querySelector(".gc-message__text strong")).toBeNull();
    expect(container).toHaveTextContent("YOU");
    expect(container).toHaveTextContent("You");
    expect(container).toHaveTextContent("**bold**");
  });

  it("still applies the user/assistant bubble class", () => {
    const message: ChatMessage = { id: "m1", role: MESSAGE_ROLE.USER, text: "hi" };
    const { container } = render(<MessageBubble message={message} />);

    expect(container.querySelector(".gc-message--user")).not.toBeNull();
  });

  it("renders the message's tool actions inside the bubble body, below the text (S2)", () => {
    const message: ChatMessage = { id: "m1", role: MESSAGE_ROLE.ASSISTANT, text: "done" };
    const actions: ToolCallView[] = [{ id: "c1", toolName: "read", args: { path: "a" }, status: "done" }];
    const { container } = render(<MessageBubble message={message} actions={actions} vocabulary={READ_VOCABULARY} />);

    const body = container.querySelector(".gc-message__body") as HTMLElement;
    const rows = within(body).getByLabelText("Tool actions");
    // The child's vocabulary glyph, not an invented one.
    expect(within(rows).getByText("≡")).toBeInTheDocument();
    expect(within(rows).getByText("read")).toBeInTheDocument();
    // Below the text, still inside the message block.
    expect(rows.compareDocumentPosition(body.querySelector(".gc-message__speaker")!)).toBeTruthy();
  });

  it("renders no action rows when the message produced none", () => {
    const message: ChatMessage = { id: "m1", role: MESSAGE_ROLE.ASSISTANT, text: "done" };
    const { container } = render(<MessageBubble message={message} />);

    expect(container.querySelector(".gc-action-rows")).toBeNull();
  });
});
