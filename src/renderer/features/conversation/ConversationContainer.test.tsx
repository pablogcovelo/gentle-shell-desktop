// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CHAT_STATE, MESSAGE_ROLE, type ChatState, type ChatSummary, type GentleBridge, type SubscriptionUsage } from "@shared/bridge-types";
import { ConversationContainer, type ActiveChat } from "./ConversationContainer";

const NEW_CHAT: ActiveChat = { kind: "new" };

const EXISTING_CHAT: ChatSummary = {
  id: "chat-1",
  title: "Refactor the store",
  cwd: "/tmp/project",
  updatedAt: "2026-09-21T09:00:00.000Z",
  messageCount: 3,
  state: CHAT_STATE.IDLE,
};

const EMPTY_HELPERS = { summary: { running: 0, queued: 0, waiting: 0, finished: 0 }, tasks: [] };

function emptyState(): ChatState {
  return { messages: [], working: false, pendingDialogs: [], activity: 0, helpers: EMPTY_HELPERS };
}

function makeBridge(overrides: Partial<GentleBridge> = {}): GentleBridge {
  return {
    listChats: vi.fn().mockResolvedValue([]),
    openChat: vi.fn().mockResolvedValue(emptyState()),
    newChat: vi.fn().mockResolvedValue(emptyState()),
    sendMessage: vi.fn().mockResolvedValue({ queued: true }),
    abort: vi.fn().mockResolvedValue(undefined),
    answerDialog: vi.fn().mockResolvedValue(undefined),
    onState: vi.fn().mockReturnValue(() => {}),
    onError: vi.fn().mockReturnValue(() => {}),
    setupStatus: vi.fn().mockResolvedValue({ needsChoice: false, detection: { found: false, dir: "", hasAuth: false, hasModels: false } }),
    chooseHome: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("ConversationContainer", () => {
  it('calls bridge.newChat() for activeChat { kind: "new" } and shows "New chat" as the title', async () => {
    const bridge = makeBridge();
    window.gentle = bridge;

    render(<ConversationContainer activeChat={NEW_CHAT} />);

    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());
    expect(bridge.openChat).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "New chat" })).toBeInTheDocument();
  });

  it("calls bridge.openChat(id) for an existing activeChat and shows its title", async () => {
    const bridge = makeBridge();
    window.gentle = bridge;

    render(<ConversationContainer activeChat={{ kind: "existing", chat: EXISTING_CHAT }} />);

    await vi.waitFor(() => expect(bridge.openChat).toHaveBeenCalledWith("chat-1"));
    expect(bridge.newChat).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Refactor the store" })).toBeInTheDocument();
  });

  it("re-opens when activeChat changes", async () => {
    const bridge = makeBridge();
    window.gentle = bridge;

    const { rerender } = render(<ConversationContainer activeChat={NEW_CHAT} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalledTimes(1));

    rerender(<ConversationContainer activeChat={{ kind: "existing", chat: EXISTING_CHAT }} />);
    await vi.waitFor(() => expect(bridge.openChat).toHaveBeenCalledWith("chat-1"));
  });

  it("renders only the pushed ChatState", async () => {
    let pushState: (state: ChatState) => void = () => {};
    const bridge = makeBridge({
      onState: vi.fn((callback: (state: ChatState) => void) => {
        pushState = callback;
        return () => {};
      }),
    });
    window.gentle = bridge;

    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());

    pushState({
      messages: [{ id: "m1", role: MESSAGE_ROLE.ASSISTANT, text: "Hello there", streaming: false }],
      working: false,
      pendingDialogs: [],
      activity: 0,
      helpers: EMPTY_HELPERS,
    });

    expect(await screen.findByText("Hello there")).toBeInTheDocument();
  });

  it("renders the session identity block when the pushed ChatState carries one", async () => {
    let pushState: (state: ChatState) => void = () => {};
    const bridge = makeBridge({
      onState: vi.fn((callback: (state: ChatState) => void) => {
        pushState = callback;
        return () => {};
      }),
    });
    window.gentle = bridge;

    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());

    pushState({
      messages: [],
      working: false,
      pendingDialogs: [],
      activity: 0,
      helpers: EMPTY_HELPERS,
      session: { modelName: "Claude Sonnet 4", thinkingLevel: "medium", contextPercent: 30, sessionCost: 0.45 },
    });

    const block = await screen.findByLabelText("Session identity");
    expect(block).toHaveTextContent("Claude Sonnet 4");
    expect(block).toHaveTextContent("30%");
    expect(block).toHaveTextContent("$0.45");
    // Identity is status chrome, never conversation content.
    expect(screen.queryByText("Claude Sonnet 4")).toBe(block.querySelector("dd"));
  });

  it("renders no session identity block when the pushed ChatState carries none", async () => {
    let pushState: (state: ChatState) => void = () => {};
    const bridge = makeBridge({
      onState: vi.fn((callback: (state: ChatState) => void) => {
        pushState = callback;
        return () => {};
      }),
    });
    window.gentle = bridge;

    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());

    pushState({
      messages: [],
      working: false,
      pendingDialogs: [],
      activity: 0,
      helpers: EMPTY_HELPERS,
    });

    await vi.waitFor(() => expect(screen.queryByLabelText("Session identity")).not.toBeInTheDocument());
  });

  it("renders tool activity with the glyph the child's vocabulary assigns, and the raw name otherwise", async () => {
    let pushState: (state: ChatState) => void = () => {};
    const bridge = makeBridge({
      onState: vi.fn((callback: (state: ChatState) => void) => {
        pushState = callback;
        return () => {};
      }),
    });
    window.gentle = bridge;

    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());

    pushState({
      messages: [],
      working: false,
      pendingDialogs: [],
      activity: 2,
      helpers: EMPTY_HELPERS,
      toolCalls: [
        { id: "c1", toolName: "read", args: { path: "a" }, result: "ok", isError: false, status: "done" },
        { id: "c2", toolName: "some_future_tool", status: "running" },
      ],
      toolVocabulary: { categories: ["read"], entries: [{ category: "read", glyph: "≡", tools: ["read"] }] },
    });

    const rows = await screen.findByLabelText("Tool activity");
    expect(rows).toHaveTextContent("≡");
    // The uncovered tool keeps its raw name: no invented category.
    expect(rows).toHaveTextContent("some_future_tool");
    // Activity is chrome: the caption appears once, in its own section, and
    // never gets duplicated into the transcript.
    expect(screen.getAllByText("Tool activity")).toHaveLength(1);
  });

  it("renders the subscription-usage meters when the pushed ChatState carries usage data", async () => {
    const usage: SubscriptionUsage = {
      providers: [
        {
          provider: "openai-codex",
          status: "ok",
          plan: "pro",
          limits: [
            { name: "codex", limitReached: false, windows: [{ label: "week", usedPercent: 40, windowSeconds: 604800, resetAt: 1788777491000 }] },
          ],
        },
        { provider: "anthropic", status: "pending" },
      ],
    };
    let pushState: (state: ChatState) => void = () => {};
    const bridge = makeBridge({
      onState: vi.fn((callback: (state: ChatState) => void) => {
        pushState = callback;
        return () => {};
      }),
    });
    window.gentle = bridge;

    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());

    pushState({
      messages: [{ id: "m1", role: MESSAGE_ROLE.ASSISTANT, text: "Hello there", streaming: false }],
      working: false,
      pendingDialogs: [],
      activity: 0,
      helpers: EMPTY_HELPERS,
      usage,
    });

    expect(await screen.findByText("openai-codex")).toBeInTheDocument();
    expect(screen.getByText("anthropic")).toBeInTheDocument();
    // The meters are chrome around the transcript, never transcript rows:
    // the pushed messages are still exactly the conversation's messages.
    expect(screen.getByText("Hello there")).toBeInTheDocument();
    expect(screen.queryByText(/gentle:desktop/i)).not.toBeInTheDocument();
  });

  it("renders the channel-unavailable note when the control channel probe failed, with no meters", async () => {
    let pushState: (state: ChatState) => void = () => {};
    const bridge = makeBridge({
      onState: vi.fn((callback: (state: ChatState) => void) => {
        pushState = callback;
        return () => {};
      }),
    });
    window.gentle = bridge;

    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());

    pushState({ ...emptyState(), usageChannelUnavailable: true });

    expect(await screen.findByText(/channel unavailable/i)).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("renders no usage block when the state carries no usage data", async () => {
    let pushState: (state: ChatState) => void = () => {};
    const bridge = makeBridge({
      onState: vi.fn((callback: (state: ChatState) => void) => {
        pushState = callback;
        return () => {};
      }),
    });
    window.gentle = bridge;

    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());

    pushState({
      messages: [{ id: "m1", role: MESSAGE_ROLE.ASSISTANT, text: "Hello there", streaming: false }],
      working: false,
      pendingDialogs: [],
      activity: 0,
      helpers: EMPTY_HELPERS,
    });

    expect(await screen.findByText("Hello there")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /subscription usage/i })).not.toBeInTheDocument();
    expect(screen.queryByText("openai-codex")).not.toBeInTheDocument();
  });

  it("calls bridge.sendMessage with the trimmed draft on submit", async () => {
    const bridge = makeBridge();
    window.gentle = bridge;

    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());

    fireEvent.change(screen.getByPlaceholderText("Tell Gentle what you need…"), { target: { value: "  hi Gentle  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(bridge.sendMessage).toHaveBeenCalledWith("hi Gentle");
  });

  it("shows an onError push in the status line without adding a message", async () => {
    let pushError: (message: string) => void = () => {};
    const bridge = makeBridge({
      onError: vi.fn((callback: (message: string) => void) => {
        pushError = callback;
        return () => {};
      }),
    });
    window.gentle = bridge;

    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());

    pushError("Gentle is still working");

    expect(await screen.findByRole("status")).toHaveTextContent("Gentle is still working");
    expect(screen.queryByText(/still working/, { selector: ".gc-message__text" })).not.toBeInTheDocument();
  });

  it("shows a pushed ChatState.lastError in the status line", async () => {
    let pushState: (state: ChatState) => void = () => {};
    const bridge = makeBridge({
      onState: vi.fn((callback: (state: ChatState) => void) => {
        pushState = callback;
        return () => {};
      }),
    });
    window.gentle = bridge;

    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());

    pushState({ messages: [], working: false, pendingDialogs: [], activity: 0, helpers: EMPTY_HELPERS, lastError: "pi exited unexpectedly" });

    expect(await screen.findByRole("status")).toHaveTextContent("pi exited unexpectedly");
  });

  it("forwards a dialog answer to bridge.answerDialog with the dialog id", async () => {
    let pushState: (state: ChatState) => void = () => {};
    const bridge = makeBridge({
      onState: vi.fn((callback: (state: ChatState) => void) => {
        pushState = callback;
        return () => {};
      }),
    });
    window.gentle = bridge;

    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());

    pushState({
      messages: [],
      working: false,
      pendingDialogs: [{ id: "dlg-1", method: "confirm", title: "Delete the file?" }],
      activity: 0,
      helpers: EMPTY_HELPERS,
    });

    fireEvent.click(await screen.findByRole("button", { name: "Yes" }));

    expect(bridge.answerDialog).toHaveBeenCalledWith("dlg-1", { confirmed: true });
  });

  it("calls bridge.abort() on Escape while working", async () => {
    let pushState: (state: ChatState) => void = () => {};
    const bridge = makeBridge({
      onState: vi.fn((callback: (state: ChatState) => void) => {
        pushState = callback;
        return () => {};
      }),
    });
    window.gentle = bridge;

    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());

    pushState({ messages: [], working: true, pendingDialogs: [], activity: 0, helpers: EMPTY_HELPERS });

    const textarea = screen.getByPlaceholderText("Tell Gentle what you need…");
    await vi.waitFor(() => expect(textarea).toHaveAttribute("readonly"));
    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(bridge.abort).toHaveBeenCalled();
  });

  it("guards the open/new effect against a stale resolution when the selection changes before it settles", async () => {
    let resolveFirst: (state: ChatState) => void = () => {};
    const firstChat: ChatSummary = { ...EXISTING_CHAT, id: "chat-1", title: "First chat" };
    const secondChat: ChatSummary = { ...EXISTING_CHAT, id: "chat-2", title: "Second chat" };

    const bridge = makeBridge({
      openChat: vi.fn((id: string) => {
        if (id === "chat-1") {
          return new Promise<ChatState>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve(emptyState());
      }),
    });
    window.gentle = bridge;

    const { rerender } = render(<ConversationContainer activeChat={{ kind: "existing", chat: firstChat }} />);
    await vi.waitFor(() => expect(bridge.openChat).toHaveBeenCalledWith("chat-1"));

    rerender(<ConversationContainer activeChat={{ kind: "existing", chat: secondChat }} />);
    await vi.waitFor(() => expect(bridge.openChat).toHaveBeenCalledWith("chat-2"));

    // The stale first request resolves after the second one was already
    // requested; its state must never overwrite what belongs to chat-2.
    resolveFirst({
      messages: [{ id: "stale", role: MESSAGE_ROLE.ASSISTANT, text: "stale reply", streaming: false }],
      working: false,
      pendingDialogs: [],
      activity: 0,
      helpers: EMPTY_HELPERS,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText("stale reply")).not.toBeInTheDocument();
  });

  it("does not call sendMessage when the draft is only whitespace", async () => {
    const bridge = makeBridge();
    window.gentle = bridge;

    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());

    fireEvent.change(screen.getByPlaceholderText("Tell Gentle what you need…"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(bridge.sendMessage).not.toHaveBeenCalled();
  });

  const HELPERS_WITH_TASKS = {
    summary: { running: 1, queued: 0, waiting: 0, finished: 0 },
    tasks: [
      {
        id: "helper-1",
        agent: "researcher",
        label: "Look into the failing test",
        prompt: "p",
        status: "running" as const,
        createdAt: "2026-09-22T10:00:00.000Z",
        startedAt: "2026-09-22T10:00:00.000Z",
        turns: 1,
        toolCalls: 0,
        thread: { version: 0, dropped: 0, items: [] },
      },
    ],
  };

  it("shows the Helpers strip when the chat has tasks, and opens the Helpers tab on click", async () => {
    let pushState: (state: ChatState) => void = () => {};
    const bridge = makeBridge({
      onState: vi.fn((callback: (state: ChatState) => void) => {
        pushState = callback;
        return () => {};
      }),
    });
    window.gentle = bridge;

    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());

    expect(screen.queryByText(/Helpers ·/)).not.toBeInTheDocument();

    pushState({ messages: [], working: false, pendingDialogs: [], activity: 0, helpers: HELPERS_WITH_TASKS });

    const strip = await screen.findByText("Helpers · 1 running");
    fireEvent.click(strip);

    expect(screen.getByRole("tab", { name: "Helpers (1 running)" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "Look into the failing test" })).toBeInTheDocument();
  });

  it("switches tabs from the header, and Back to chat returns to the chat pane", async () => {
    let pushState: (state: ChatState) => void = () => {};
    const bridge = makeBridge({
      onState: vi.fn((callback: (state: ChatState) => void) => {
        pushState = callback;
        return () => {};
      }),
    });
    window.gentle = bridge;

    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());
    pushState({ messages: [], working: false, pendingDialogs: [], activity: 0, helpers: HELPERS_WITH_TASKS });
    await screen.findByText("Helpers · 1 running");

    fireEvent.click(screen.getByRole("tab", { name: "Helpers (1 running)" }));
    expect(screen.getByRole("heading", { name: "Look into the failing test" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(screen.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByPlaceholderText("Tell Gentle what you need…")).toBeInTheDocument();
  });

  it("renders the chat's own todo card from the pushed ChatState.todo, and nothing without tasks", async () => {
    let pushState: (state: ChatState) => void = () => {};
    const bridge = makeBridge({
      onState: vi.fn((callback: (state: ChatState) => void) => {
        pushState = callback;
        return () => {};
      }),
    });
    window.gentle = bridge;

    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());

    expect(screen.queryByTestId("gc-todo-card")).not.toBeInTheDocument();

    pushState({
      messages: [],
      working: false,
      pendingDialogs: [],
      activity: 0,
      helpers: EMPTY_HELPERS,
      todo: { tasks: [{ id: 1, title: "Panel task only", status: "in_progress" }], nextId: 2, updatedTurn: 1 },
    });

    expect(await screen.findByTestId("gc-todo-card")).toBeInTheDocument();
    expect(screen.getByText("Panel task only")).toBeInTheDocument();
  });

  it("keeps the todo card out of the Helpers pane", async () => {
    let pushState: (state: ChatState) => void = () => {};
    const bridge = makeBridge({
      onState: vi.fn((callback: (state: ChatState) => void) => {
        pushState = callback;
        return () => {};
      }),
    });
    window.gentle = bridge;

    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());
    pushState({
      messages: [],
      working: false,
      pendingDialogs: [],
      activity: 0,
      helpers: EMPTY_HELPERS,
      todo: { tasks: [{ id: 1, title: "Panel task only", status: "pending" }], nextId: 2, updatedTurn: 1 },
    });
    expect(await screen.findByTestId("gc-todo-card")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Helpers" }));

    expect(screen.queryByTestId("gc-todo-card")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(screen.getByTestId("gc-todo-card")).toBeInTheDocument();
  });

  it("resets to the chat pane when activeChat changes", async () => {
    let pushState: (state: ChatState) => void = () => {};
    const bridge = makeBridge({
      onState: vi.fn((callback: (state: ChatState) => void) => {
        pushState = callback;
        return () => {};
      }),
    });
    window.gentle = bridge;

    const { rerender } = render(<ConversationContainer activeChat={NEW_CHAT} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());
    pushState({ messages: [], working: false, pendingDialogs: [], activity: 0, helpers: HELPERS_WITH_TASKS });
    await screen.findByText("Helpers · 1 running");

    fireEvent.click(screen.getByRole("tab", { name: "Helpers (1 running)" }));
    expect(screen.getByRole("tab", { name: "Helpers (1 running)" })).toHaveAttribute("aria-selected", "true");

    rerender(<ConversationContainer activeChat={{ kind: "existing", chat: EXISTING_CHAT }} />);

    expect(screen.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true");
  });

  it("renders pushed keyed statuses in the status surface, never as messages", async () => {
    let pushState: (state: ChatState) => void = () => {};
    const bridge = makeBridge({
      onState: vi.fn((callback: (state: ChatState) => void) => {
        pushState = callback;
        return () => {};
      }),
    });
    window.gentle = bridge;

    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());

    pushState({
      messages: [],
      working: false,
      pendingDialogs: [],
      activity: 0,
      helpers: EMPTY_HELPERS,
      statuses: { "gentle-todo": "2 tasks open" },
    });

    const statusList = await screen.findByLabelText("Session status");
    expect(statusList).toHaveTextContent("gentle-todo");
    expect(statusList).toHaveTextContent("2 tasks open");
    // A keyed status is status chrome, not a transcript bubble.
    expect(screen.queryByText("2 tasks open", { selector: ".gc-message__text" })).not.toBeInTheDocument();
  });

  it("renders pushed notifications with their severity, never as conversation messages", async () => {
    let pushState: (state: ChatState) => void = () => {};
    const bridge = makeBridge({
      onState: vi.fn((callback: (state: ChatState) => void) => {
        pushState = callback;
        return () => {};
      }),
    });
    window.gentle = bridge;

    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());

    pushState({
      messages: [],
      working: false,
      pendingDialogs: [],
      activity: 0,
      helpers: EMPTY_HELPERS,
      notifications: [
        { message: "Command blocked by user", severity: "warning" },
        { message: "Disk full", severity: "error" },
      ],
    });

    const stack = await screen.findByLabelText("Notifications");
    expect(stack.querySelector(".gc-status-line__notification--warning")).toHaveTextContent("Command blocked by user");
    expect(stack.querySelector(".gc-status-line__notification--error")).toHaveTextContent("Disk full");
    // No bubble, no transcript entry, no placeholder in the message list.
    expect(screen.queryByText("Command blocked by user", { selector: ".gc-message__text" })).not.toBeInTheDocument();
    expect(screen.queryByText("Disk full", { selector: ".gc-message__text" })).not.toBeInTheDocument();
  });

  it("keeps the todo card above the composer, mirroring the TUI bottom widget", async () => {
    let pushState: (state: ChatState) => void = () => {};
    const bridge = makeBridge({
      onState: vi.fn((callback: (state: ChatState) => void) => {
        pushState = callback;
        return () => {};
      }),
    });
    window.gentle = bridge;

    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());
    pushState({
      messages: [],
      working: false,
      pendingDialogs: [],
      activity: 0,
      helpers: { summary: { running: 0, queued: 0, waiting: 0, finished: 0 }, tasks: [] },
      todo: { tasks: [{ id: 1, title: "Order task", status: "pending" }], nextId: 2, updatedTurn: null },
    });

    const card = await screen.findByTestId("gc-todo-card");
    const composer = screen.getByRole("form", { name: "Composer" });

    // The card must come BEFORE the composer in document order: gentle-pi's
    // bottom widget renders above the prompt, never below it (S5).
    expect(card.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
