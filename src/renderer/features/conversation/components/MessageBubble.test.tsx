// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, within } from "@testing-library/react";
import { MESSAGE_ROLE, type ChatMessage, type ToolCallView, type ToolVocabulary } from "@shared/bridge-types";
import { MessageBubble } from "./MessageBubble";

const READ_VOCABULARY: ToolVocabulary = {
  categories: ["read"],
  entries: [{ category: "read", glyph: "≡", tools: ["read"] }],
};

const READ_CALL: ToolCallView = { id: "c1", toolName: "read", args: { path: "a" }, status: "done" };

describe("MessageBubble", () => {
  it("renders assistant Markdown text as real HTML elements", () => {
    const message: ChatMessage = { id: "m1", role: MESSAGE_ROLE.ASSISTANT, text: "**bold**" };
    const { container } = render(<MessageBubble message={message} />);

    expect(container.querySelector(".gs-markdown strong")).toHaveTextContent("bold");
    expect(container.querySelector("time")).toBeNull();
  });

  it("renders user text literally, without interpreting Markdown", () => {
    const message: ChatMessage = { id: "m1", role: MESSAGE_ROLE.USER, text: "**bold**" };
    const { container } = render(<MessageBubble message={message} />);

    expect(container.querySelector(".gc-message__text strong")).toBeNull();
    expect(container).toHaveTextContent("**bold**");
  });

  it("still applies the user/assistant bubble class", () => {
    const message: ChatMessage = { id: "m1", role: MESSAGE_ROLE.USER, text: "hi" };
    const { container } = render(<MessageBubble message={message} />);

    expect(container.querySelector(".gc-message--user")).not.toBeNull();
  });

  // Workspace artboard rule: the speaker reads from the shape, never from a
  // label — no avatar, no name header, no badge, in either role.
  it("pins the role to the shape alone: no speaker label, no badge, no avatar", () => {
    const user: ChatMessage = { id: "u1", role: MESSAGE_ROLE.USER, text: "hi" };
    const assistant: ChatMessage = { id: "a1", role: MESSAGE_ROLE.ASSISTANT, text: "hello" };
    const { container: userView } = render(<MessageBubble message={user} />);
    const { container: assistantView } = render(<MessageBubble message={assistant} />);

    for (const container of [userView, assistantView]) {
      expect(container.querySelector(".gc-message__avatar")).toBeNull();
      expect(container.querySelector(".gc-message__speaker")).toBeNull();
      expect(container.querySelector(".gc-message__badge")).toBeNull();
      expect(container.textContent).not.toContain("You");
      expect(container.textContent).not.toContain("el Gentleman");
    }
    // The shape carries the role: the user turn is the tinted box, the
    // assistant turn the plain full-width block.
    expect(userView.querySelector("article.gc-message--user")).not.toBeNull();
    expect(assistantView.querySelector("article.gc-message--assistant")).not.toBeNull();
  });

  it("renders the turn's tool part as one action row inside the bubble body, below the text (S2)", () => {
    const message: ChatMessage = {
      id: "m1",
      role: MESSAGE_ROLE.ASSISTANT,
      text: "done",
      parts: [{ kind: "text", text: "done" }, { kind: "tool", toolCallId: "c1" }],
    };
    const { container } = render(<MessageBubble message={message} toolCalls={[READ_CALL]} vocabulary={READ_VOCABULARY} />);

    const body = container.querySelector(".gc-message__body") as HTMLElement;
    const row = within(body).getByTestId("gc-action-row");
    // The child's vocabulary glyph, not an invented one.
    expect(within(row).getByText("≡")).toBeInTheDocument();
    expect(within(row).getByText("read")).toBeInTheDocument();
    // Below the text, still inside the message block.
    const text = body.querySelector(".gs-markdown")!;
    expect(text.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders a text → row → text turn in that DOM order inside the bubble (S1)", () => {
    const message: ChatMessage = {
      id: "m1",
      role: MESSAGE_ROLE.ASSISTANT,
      text: "Before.After.",
      parts: [{ kind: "text", text: "Before." }, { kind: "tool", toolCallId: "c1" }, { kind: "text", text: "After." }],
    };
    const { container } = render(<MessageBubble message={message} toolCalls={[READ_CALL]} vocabulary={READ_VOCABULARY} />);

    const body = container.querySelector(".gc-message__body") as HTMLElement;
    expect(body.querySelectorAll(".gs-markdown")).toHaveLength(2);
    expect(body.querySelectorAll(".gc-action-row")).toHaveLength(1);
    const before = within(body).getByText("Before.");
    const row = within(body).getByTestId("gc-action-row");
    const after = within(body).getByText("After.");
    // Text, then the row, then the continuation text — in the order the turn
    // produced them.
    expect(before.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("maps the app-owned mem_* family to the Engram memory row, after the published vocabulary (S4)", () => {
    const message: ChatMessage = {
      id: "m1",
      role: MESSAGE_ROLE.ASSISTANT,
      text: "",
      parts: [{ kind: "tool", toolCallId: "c1" }],
    };
    const { container } = render(
      <MessageBubble message={message} toolCalls={[{ id: "c1", toolName: "mem_search", status: "done" }]} />,
    );

    const row = container.querySelector("[data-testid='gc-action-row']") as HTMLElement;
    expect(row).toHaveAttribute("data-category", "memory");
    expect(within(row).getByText("Engram")).toBeInTheDocument();
    expect(within(row).getByText("🧠")).toBeInTheDocument();
  });

  it("lets a published vocabulary entry win over the memory fallback (S4)", () => {
    const message: ChatMessage = {
      id: "m1",
      role: MESSAGE_ROLE.ASSISTANT,
      text: "",
      parts: [{ kind: "tool", toolCallId: "c1" }],
    };
    const published: ToolVocabulary = {
      categories: ["memory"],
      entries: [{ category: "memory", glyph: "✦", heading: "Memory", tools: ["mem_search"] }],
    };
    const { container } = render(
      <MessageBubble message={message} toolCalls={[{ id: "c1", toolName: "mem_search", status: "done" }]} vocabulary={published} />,
    );

    const row = container.querySelector("[data-testid='gc-action-row']") as HTMLElement;
    expect(within(row).getByText("Memory")).toBeInTheDocument();
    expect(within(row).queryByText("Engram")).not.toBeInTheDocument();
  });

  it("still renders an unknown tool's raw name (S4 boundary)", () => {
    const message: ChatMessage = {
      id: "m1",
      role: MESSAGE_ROLE.ASSISTANT,
      text: "",
      parts: [{ kind: "tool", toolCallId: "c1" }],
    };
    const { container } = render(
      <MessageBubble message={message} toolCalls={[{ id: "c1", toolName: "some_future_tool", status: "done" }]} />,
    );

    const row = container.querySelector("[data-testid='gc-action-row']") as HTMLElement;
    expect(row).toHaveAttribute("data-category", "unknown");
    expect(within(row).getByText("some_future_tool")).toBeInTheDocument();
  });

  it("renders no action rows when the message produced none", () => {
    const message: ChatMessage = { id: "m1", role: MESSAGE_ROLE.ASSISTANT, text: "done" };
    const { container } = render(<MessageBubble message={message} />);

    expect(container.querySelector(".gc-action-rows")).toBeNull();
  });
});
