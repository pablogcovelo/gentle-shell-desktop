// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MESSAGE_ROLE, type ChatMessage, type Dialog, type ToolCallView, type ToolVocabulary } from "@shared/bridge-types";
import { MessageThread } from "./MessageThread";

const READ_VOCABULARY: ToolVocabulary = {
  categories: ["read"],
  entries: [{ category: "read", glyph: "≡", tools: ["read"] }],
};

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe("MessageThread", () => {
  it("shows an empty-state hint when there are no messages or dialogs", () => {
    render(<MessageThread messages={[]} dialogs={[]} onAnswerDialog={vi.fn()} />);
    expect(screen.getByText("Start a conversation with Gentle.")).toBeInTheDocument();
  });

  it("renders user and assistant bubbles, then pending dialog cards, in order", () => {
    const messages: ChatMessage[] = [
      { id: "m1", role: MESSAGE_ROLE.USER, text: "Hi Gentle" },
      { id: "m2", role: MESSAGE_ROLE.ASSISTANT, text: "Hi there" },
    ];
    const dialogs: Dialog[] = [{ id: "d1", method: "confirm", title: "Delete it?" }];

    render(<MessageThread messages={messages} dialogs={dialogs} onAnswerDialog={vi.fn()} />);

    const thread = screen.getByTestId("gc-message-thread");
    const rendered = [...thread.querySelectorAll(".gc-message, .gc-dialog-card")];
    expect(rendered).toHaveLength(3);
    expect(rendered[0]).toHaveTextContent("Hi Gentle");
    expect(rendered[1]).toHaveTextContent("Hi there");
    expect(rendered[2]).toHaveTextContent("Delete it?");
  });

  // S1: the transcript follows new activity only while the reader is at the
  // bottom. Scrolling up must survive the next update instead of being
  // undone by an unconditional jump to the end.
  it("follows new activity only while the reader is at the bottom", () => {
    const first: ChatMessage[] = [
      { id: "m1", role: MESSAGE_ROLE.USER, text: "Hi Gentle" },
      { id: "m2", role: MESSAGE_ROLE.ASSISTANT, text: "Hi there" },
    ];
    const second: ChatMessage[] = [...first, { id: "m3", role: MESSAGE_ROLE.ASSISTANT, text: "One more" }];
    const third: ChatMessage[] = [...second, { id: "m4", role: MESSAGE_ROLE.ASSISTANT, text: "And another" }];
    const { rerender } = render(<MessageThread messages={first} dialogs={[]} onAnswerDialog={vi.fn()} />);
    const thread = screen.getByTestId("gc-message-thread");
    const scrollIntoView = Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>;
    scrollIntoView.mockClear();
    Object.defineProperty(thread, "scrollHeight", { configurable: true, value: 600 });
    Object.defineProperty(thread, "clientHeight", { configurable: true, value: 200 });

    // The reader scrolled up: 100px of unread content sits below the fold.
    thread.scrollTop = 300;
    fireEvent.scroll(thread);
    rerender(<MessageThread messages={second} dialogs={[]} onAnswerDialog={vi.fn()} />);

    expect(scrollIntoView).not.toHaveBeenCalled();

    // Back at the bottom, the next update follows again.
    thread.scrollTop = 400;
    fireEvent.scroll(thread);
    rerender(<MessageThread messages={third} dialogs={[]} onAnswerDialog={vi.fn()} />);

    expect(scrollIntoView).toHaveBeenCalled();
  });

  // S1 / R3-002: the pin belongs to the chat, not to the component. A reader
  // who scrolled up in one chat must not disable following in the next one.
  it("follows the next chat again after switching away from a scrolled-up one", () => {
    const first: ChatMessage[] = [
      { id: "a1", role: MESSAGE_ROLE.USER, text: "First chat" },
      { id: "a2", role: MESSAGE_ROLE.ASSISTANT, text: "Answer" },
    ];
    const second: ChatMessage[] = [
      { id: "b1", role: MESSAGE_ROLE.USER, text: "Second chat" },
      { id: "b2", role: MESSAGE_ROLE.ASSISTANT, text: "Other answer" },
    ];
    const { rerender } = render(<MessageThread messages={first} dialogs={[]} onAnswerDialog={vi.fn()} welcomeKey="chat-a" />);
    const thread = screen.getByTestId("gc-message-thread");
    const scrollIntoView = Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>;
    Object.defineProperty(thread, "scrollHeight", { configurable: true, value: 600 });
    Object.defineProperty(thread, "clientHeight", { configurable: true, value: 200 });

    thread.scrollTop = 300;
    fireEvent.scroll(thread);

    scrollIntoView.mockClear();
    rerender(<MessageThread messages={second} dialogs={[]} onAnswerDialog={vi.fn()} welcomeKey="chat-b" />);

    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("does not render an assistant bubble with empty text once it stopped streaming", () => {
    const messages: ChatMessage[] = [
      { id: "m1", role: MESSAGE_ROLE.USER, text: "run the tool" },
      { id: "m2", role: MESSAGE_ROLE.ASSISTANT, text: "", streaming: false },
      { id: "m3", role: MESSAGE_ROLE.ASSISTANT, text: "done", streaming: false },
    ];

    render(<MessageThread messages={messages} dialogs={[]} onAnswerDialog={vi.fn()} />);

    const thread = screen.getByTestId("gc-message-thread");
    const rendered = [...thread.querySelectorAll(".gc-message")];
    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toHaveTextContent("run the tool");
    expect(rendered[1]).toHaveTextContent("done");
  });

  it("still renders an empty assistant bubble while it is streaming (typing placeholder)", () => {
    const messages: ChatMessage[] = [{ id: "m1", role: MESSAGE_ROLE.ASSISTANT, text: "", streaming: true }];

    render(<MessageThread messages={messages} dialogs={[]} onAnswerDialog={vi.fn()} />);

    const thread = screen.getByTestId("gc-message-thread");
    expect(thread.querySelectorAll(".gc-message")).toHaveLength(1);
  });

  it("forwards dialog answers with the dialog id", () => {
    const dialogs: Dialog[] = [{ id: "d1", method: "confirm", title: "Delete it?" }];
    const onAnswerDialog = vi.fn();

    render(<MessageThread messages={[]} dialogs={dialogs} onAnswerDialog={onAnswerDialog} />);
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));

    expect(onAnswerDialog).toHaveBeenCalledWith("d1", { confirmed: true });
  });

  it("scrolls to the bottom only once there is something to follow", () => {
    const { rerender } = render(<MessageThread messages={[]} dialogs={[]} onAnswerDialog={vi.fn()} />);
    // An empty chat must not scroll: the welcome hero is the first thing the
    // reader meets there, and scrolling would hide it.
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();

    rerender(
      <MessageThread
        messages={[{ id: "m1", role: MESSAGE_ROLE.USER, text: "hi" }]}
        dialogs={[]}
        onAnswerDialog={vi.fn()}
      />,
    );

    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("renders a call bound to a message inside that message's bubble, and no standalone Tool activity list (S2)", () => {
    const messages: ChatMessage[] = [
      { id: "m1", role: MESSAGE_ROLE.USER, text: "run it" },
      { id: "m2", role: MESSAGE_ROLE.ASSISTANT, text: "Listed the files.", streaming: false },
    ];
    const toolCalls: ToolCallView[] = [
      { id: "c1", toolName: "read", args: { path: "a" }, status: "done", messageId: "m2" },
    ];

    render(
      <MessageThread
        messages={messages}
        dialogs={[]}
        onAnswerDialog={vi.fn()}
        toolCalls={toolCalls}
        vocabulary={READ_VOCABULARY}
      />,
    );

    // The row lives inside the assistant message that produced it.
    const assistant = screen.getByText("Listed the files.").closest("article");
    expect(assistant).not.toBeNull();
    const rows = within(assistant!).getByLabelText("Tool actions");
    // The child's vocabulary glyph, not an invented one.
    expect(within(rows).getByText("≡")).toBeInTheDocument();
    expect(within(rows).getByText("read")).toBeInTheDocument();

    // The user bubble carries no actions.
    const user = screen.getByText("run it").closest("article");
    expect(within(user!).queryByLabelText("Tool actions")).toBeNull();

    // No standalone tool activity list survives at the transcript end.
    expect(screen.queryByText("Tool activity")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Tool activity")).not.toBeInTheDocument();
  });

  it("still renders a call whose producing message cannot be resolved, attached to the last assistant message (S2 fallback)", () => {
    const messages: ChatMessage[] = [
      { id: "m1", role: MESSAGE_ROLE.USER, text: "run it" },
      { id: "m2", role: MESSAGE_ROLE.ASSISTANT, text: "Listed the files.", streaming: false },
    ];
    const toolCalls: ToolCallView[] = [
      // Never bound to any message.
      { id: "c1", toolName: "bash", status: "done" },
      // Bound to a message the thread does not contain (it was dropped).
      { id: "c2", toolName: "read", status: "done", messageId: "gone" },
    ];

    render(<MessageThread messages={messages} dialogs={[]} onAnswerDialog={vi.fn()} toolCalls={toolCalls} />);

    const assistant = screen.getByText("Listed the files.").closest("article");
    const rows = within(assistant!).getByLabelText("Tool actions");
    expect(within(rows).getByText("bash")).toBeInTheDocument();
    expect(within(rows).getByText("read")).toBeInTheDocument();

    // No silent loss, and no second group anywhere else in the thread.
    expect(screen.getAllByLabelText("Tool actions")).toHaveLength(1);
  });

  it("renders an orphan call as a trailing group inside the thread when no assistant message exists (S2 fallback)", () => {
    const messages: ChatMessage[] = [{ id: "m1", role: MESSAGE_ROLE.USER, text: "hi" }];
    const toolCalls: ToolCallView[] = [{ id: "c1", toolName: "bash", status: "done" }];

    render(<MessageThread messages={messages} dialogs={[]} onAnswerDialog={vi.fn()} toolCalls={toolCalls} />);

    const group = screen.getByLabelText("Tool actions");
    const thread = screen.getByTestId("gc-message-thread");
    // Inside the thread, but never inside a message bubble.
    expect(group.parentElement).toBe(thread);
    const user = screen.getByText("hi").closest("article");
    expect(within(user!).queryByLabelText("Tool actions")).toBeNull();
  });

  it("shows the welcome hero only when the caller owns a chat identity", () => {
    const { rerender } = render(<MessageThread messages={[]} dialogs={[]} onAnswerDialog={vi.fn()} />);
    expect(screen.queryByTestId("gc-welcome-hero")).not.toBeInTheDocument();

    rerender(
      <MessageThread messages={[]} dialogs={[]} onAnswerDialog={vi.fn()} welcomeKey="chat-hero" />,
    );

    expect(screen.getByTestId("gc-welcome-hero")).toBeInTheDocument();
  });
});
