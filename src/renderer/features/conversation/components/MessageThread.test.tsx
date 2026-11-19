// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

  // S1 (regression): a tool row that arrives inside the thread grows it
  // WITHOUT replacing `messages`. The follow effect watched only `messages`,
  // so the reader had to scroll by hand to see the new row.
  it("follows a tool row that arrives without replacing the messages", async () => {
    const messages: ChatMessage[] = [{ id: "m1", role: MESSAGE_ROLE.USER, text: "run the tool" }];
    const running: ToolCallView[] = [{ id: "t1", toolName: "read", status: "running", messageId: "m1" }];
    // A STABLE dialogs reference: a fresh [] per render would change the
    // follow effect's dependencies on its own and hide the very regression
    // this test pins.
    const dialogs: Dialog[] = [];
    const { rerender } = render(
      <MessageThread messages={messages} dialogs={dialogs} onAnswerDialog={vi.fn()} toolCalls={[]} vocabulary={READ_VOCABULARY} />,
    );
    const thread = screen.getByTestId("gc-message-thread");
    const scrollIntoView = Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>;
    Object.defineProperty(thread, "scrollHeight", { configurable: true, value: 600 });
    Object.defineProperty(thread, "clientHeight", { configurable: true, value: 200 });
    thread.scrollTop = 400; // pinned to the end
    fireEvent.scroll(thread);
    scrollIntoView.mockClear();

    rerender(
      <MessageThread messages={messages} dialogs={dialogs} onAnswerDialog={vi.fn()} toolCalls={running} vocabulary={READ_VOCABULARY} />,
    );

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  });

  // S1: the same growth must NOT move a reader who scrolled up — following is
  // a property of the reader's position, not of the kind of content that
  // arrived.
  it("does not follow a tool row while the reader is scrolled up", async () => {
    const messages: ChatMessage[] = [{ id: "m1", role: MESSAGE_ROLE.USER, text: "run the tool" }];
    const running: ToolCallView[] = [{ id: "t1", toolName: "read", status: "running", messageId: "m1" }];
    // A STABLE dialogs reference: a fresh [] per render would change the
    // follow effect's dependencies on its own and hide the very regression
    // this test pins.
    const dialogs: Dialog[] = [];
    const { rerender } = render(
      <MessageThread messages={messages} dialogs={dialogs} onAnswerDialog={vi.fn()} toolCalls={[]} vocabulary={READ_VOCABULARY} />,
    );
    const thread = screen.getByTestId("gc-message-thread");
    const scrollIntoView = Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>;
    Object.defineProperty(thread, "scrollHeight", { configurable: true, value: 600 });
    Object.defineProperty(thread, "clientHeight", { configurable: true, value: 200 });
    thread.scrollTop = 300; // 100px of unread content below the fold
    fireEvent.scroll(thread);
    scrollIntoView.mockClear();

    rerender(
      <MessageThread messages={messages} dialogs={dialogs} onAnswerDialog={vi.fn()} toolCalls={running} vocabulary={READ_VOCABULARY} />,
    );
    // Let every queued mutation observer callback run before asserting.
    await act(async () => {
      await Promise.resolve();
    });

    expect(scrollIntoView).not.toHaveBeenCalled();
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

  it("renders a turn's tool part inside that turn's bubble, and no standalone Tool activity list (S2)", () => {
    const messages: ChatMessage[] = [
      { id: "m1", role: MESSAGE_ROLE.USER, text: "run it" },
      {
        id: "m2",
        role: MESSAGE_ROLE.ASSISTANT,
        text: "Listed the files.",
        streaming: false,
        parts: [{ kind: "text", text: "Listed the files." }, { kind: "tool", toolCallId: "c1" }],
      },
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

    // The row lives inside the assistant turn that produced it.
    const assistant = screen.getByText("Listed the files.").closest("article");
    expect(assistant).not.toBeNull();
    const row = within(assistant!).getByTestId("gc-action-row");
    // The child's vocabulary glyph, not an invented one.
    expect(within(row).getByText("≡")).toBeInTheDocument();
    expect(within(row).getByText("read")).toBeInTheDocument();

    // The user bubble carries no actions.
    const user = screen.getByText("run it").closest("article");
    expect(within(user!).queryByTestId("gc-action-row")).toBeNull();

    // No trailing group outside the bubbles and no standalone tool activity
    // list at the transcript end.
    expect(screen.queryByTestId("gc-orphan-actions")).not.toBeInTheDocument();
    expect(screen.queryByText("Tool activity")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Tool activity")).not.toBeInTheDocument();
  });

  it("keeps a second turn's rows in the second turn, with no shared trailing list (S2)", () => {
    const messages: ChatMessage[] = [
      { id: "m1", role: MESSAGE_ROLE.USER, text: "go" },
      {
        id: "m2",
        role: MESSAGE_ROLE.ASSISTANT,
        text: "First.",
        parts: [{ kind: "text", text: "First." }, { kind: "tool", toolCallId: "c1" }],
      },
      {
        id: "m3",
        role: MESSAGE_ROLE.ASSISTANT,
        text: "Second.",
        parts: [{ kind: "text", text: "Second." }, { kind: "tool", toolCallId: "c2" }],
      },
    ];
    const toolCalls: ToolCallView[] = [
      { id: "c1", toolName: "read", status: "done", messageId: "m2" },
      { id: "c2", toolName: "bash", status: "done", messageId: "m3" },
    ];

    render(<MessageThread messages={messages} dialogs={[]} onAnswerDialog={vi.fn()} toolCalls={toolCalls} vocabulary={READ_VOCABULARY} />);

    // Each turn's own row stays inside its own bubble.
    const first = screen.getByText("First.").closest("article") as HTMLElement;
    const second = screen.getByText("Second.").closest("article") as HTMLElement;
    expect(within(first).getByTestId("gc-action-row")).toHaveTextContent("read");
    expect(within(second).getByTestId("gc-action-row")).toHaveTextContent("bash");
    expect(within(first).queryByText("bash")).not.toBeInTheDocument();
    expect(within(second).queryByText("read")).not.toBeInTheDocument();

    // Nothing grows into a shared trailing list outside the turns.
    expect(screen.queryByTestId("gc-orphan-actions")).not.toBeInTheDocument();
  });

  it("keeps a text-less tool turn's rows in that turn, never at the end of the thread (S2)", () => {
    const messages: ChatMessage[] = [
      { id: "m1", role: MESSAGE_ROLE.USER, text: "run it" },
      // A turn that only ran a tool: no text, one row. The reducer and the
      // history path both keep it; the thread must not drop it here.
      { id: "m2", role: MESSAGE_ROLE.ASSISTANT, text: "", parts: [{ kind: "tool", toolCallId: "c1" }] },
      { id: "m3", role: MESSAGE_ROLE.ASSISTANT, text: "After.", parts: [{ kind: "text", text: "After." }] },
    ];
    const toolCalls: ToolCallView[] = [{ id: "c1", toolName: "bash", status: "done", messageId: "m2" }];

    render(<MessageThread messages={messages} dialogs={[]} onAnswerDialog={vi.fn()} toolCalls={toolCalls} vocabulary={READ_VOCABULARY} />);

    // No block of rows at the end: the row lives in its own turn.
    expect(screen.queryByTestId("gc-orphan-actions")).not.toBeInTheDocument();
    const rows = screen.getAllByTestId("gc-action-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("bash");
  });

  it("renders calls that belong to no turn as their own rows in a separate region after the thread (S2)", () => {
    const messages: ChatMessage[] = [
      { id: "m1", role: MESSAGE_ROLE.USER, text: "run it" },
      {
        id: "m2",
        role: MESSAGE_ROLE.ASSISTANT,
        text: "Listed the files.",
        parts: [{ kind: "text", text: "Listed the files." }, { kind: "tool", toolCallId: "c1" }],
      },
    ];
    const toolCalls: ToolCallView[] = [
      // Bound and part of the turn above.
      { id: "c1", toolName: "read", status: "done", messageId: "m2" },
      // Never bound to any turn.
      { id: "c2", toolName: "bash", status: "done" },
      // Bound to a message the thread does not contain (it was dropped).
      { id: "c3", toolName: "grep", status: "done", messageId: "gone" },
    ];

    render(<MessageThread messages={messages} dialogs={[]} onAnswerDialog={vi.fn()} toolCalls={toolCalls} />);

    // The orphan rows stay visible, inside the thread but in their own
    // clearly separate region — never nested inside a bubble.
    const orphans = screen.getByTestId("gc-orphan-actions");
    const thread = screen.getByTestId("gc-message-thread");
    expect(within(thread).getByTestId("gc-orphan-actions")).toBeInTheDocument();
    const assistant = screen.getByText("Listed the files.").closest("article") as HTMLElement;
    expect(within(assistant).queryByText("bash")).not.toBeInTheDocument();
    expect(within(assistant).queryByText("grep")).not.toBeInTheDocument();
    const rows = within(orphans).getAllByTestId("gc-action-row");
    expect(rows).toHaveLength(2);
    expect(within(orphans).getByText("bash")).toBeInTheDocument();
    expect(within(orphans).getByText("grep")).toBeInTheDocument();
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
