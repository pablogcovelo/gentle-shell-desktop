// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CHAT_STATE, MESSAGE_ROLE, type ChatState, type ChatSummary, type Dialog, type GentleBridge, type SubscriptionUsage } from "@shared/bridge-types";
import { ConversationContainer, resetWorkspaceSnapshotsForTests, type ActiveChat } from "./ConversationContainer";
import { resetWelcomeHeroIntrosForTests } from "./components/WelcomeHero";

const NEW_CHAT: ActiveChat = { kind: "new", epoch: 0 };

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

// The welcome hero reads the Web Animations API, which jsdom does not ship;
// these fakes never resolve on their own, so an intro stays "playing" until
// the test settles it explicitly (same pattern as WelcomeHero.test.tsx).
function fakeHeroAnimations(count: number): { finished: Promise<void>; resolve: () => void }[] {
  return Array.from({ length: count }, () => {
    let resolve!: () => void;
    const finished = new Promise<void>((r) => {
      resolve = r;
    });
    return { finished, resolve };
  });
}

function stubHeroAnimations(count: number): { animations: { finished: Promise<void>; resolve: () => void }[]; getAnimations: ReturnType<typeof vi.fn> } {
  const animations = fakeHeroAnimations(count);
  const getAnimations = vi.fn(() => animations as unknown as Animation[]);
  (Element.prototype as unknown as { getAnimations?: unknown }).getAnimations = getAnimations;
  return { animations, getAnimations };
}

function makeBridge(overrides: Partial<GentleBridge> = {}): GentleBridge {
  return {
    listChats: vi.fn().mockResolvedValue([]),
    // T5b: openChat/newChat answer which host the chat was routed to plus
    // its state; the container reports that host id up and addresses every
    // later request to it.
    openChat: vi.fn().mockResolvedValue({ hostId: "host-1", state: emptyState() }),
    newChat: vi.fn().mockResolvedValue({ hostId: "host-1", state: emptyState() }),
    sendMessage: vi.fn().mockResolvedValue({ queued: true }),
    abort: vi.fn().mockResolvedValue(undefined),
    answerDialog: vi.fn().mockResolvedValue(undefined),
    onState: vi.fn().mockReturnValue(() => {}),
    onError: vi.fn().mockReturnValue(() => {}),
    // T5c: the fake answers the chat.refresh path; tests that need to hold
    // the resolution open (or replace it) override this.
    refreshChat: vi.fn().mockResolvedValue(emptyState()),
    setupStatus: vi.fn().mockResolvedValue({ needsChoice: false, detection: { found: false, dir: "", hasAuth: false, hasModels: false } }),
    chooseHome: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  resetWelcomeHeroIntrosForTests();
  // The T5c snapshot cache is module-level (the pane persists across
  // selection changes); without this reset, one test's chats, hosts and
  // states would leak into the next.
  resetWorkspaceSnapshotsForTests();
});

afterEach(() => {
  (Element.prototype as unknown as { getAnimations?: unknown }).getAnimations = undefined;
});

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

  it("gives every unsaved chat its own welcome intro and never replays a saved chat's", async () => {
    const { animations, getAnimations } = stubHeroAnimations(1);
    window.gentle = makeBridge();
    const hero = () => screen.getByTestId("gc-welcome-hero");
    const settle = async (): Promise<void> => {
      await act(async () => {
        for (const animation of animations) animation.resolve();
        await Promise.all(animations.map((animation) => animation.finished));
      });
      await waitFor(() => expect(hero()).toHaveAttribute("data-intro", "complete"));
    };

    const { rerender } = render(<ConversationContainer activeChat={{ kind: "new", epoch: 1 }} />);
    await waitFor(() => expect(hero()).toHaveAttribute("data-intro", "playing"));
    await settle();

    // A second unsaved chat is a distinct pane: its intro starts over instead
    // of inheriting the first one's completion.
    rerender(<ConversationContainer activeChat={{ kind: "new", epoch: 2 }} />);
    await waitFor(() => expect(hero()).toHaveAttribute("data-intro", "playing"));
    await settle();

    // The saved chat has its own identity (its id), so it plays once.
    rerender(<ConversationContainer activeChat={{ kind: "existing", chat: EXISTING_CHAT }} />);
    await waitFor(() => expect(hero()).toHaveAttribute("data-intro", "playing"));
    await settle();

    // Re-selecting the same saved chat never replays: already settled from
    // the first render on, and no animation is ever started.
    getAnimations.mockClear();
    rerender(<ConversationContainer activeChat={{ kind: "existing", chat: EXISTING_CHAT }} />);
    expect(hero()).toHaveAttribute("data-intro", "complete");
    expect(getAnimations).not.toHaveBeenCalled();
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

  it("calls bridge.sendMessage with the active host id and the trimmed draft on submit", async () => {
    const bridge = makeBridge();
    window.gentle = bridge;

    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());
    await act(async () => {}); // the open resolution's host id must be in place before the send

    fireEvent.change(screen.getByPlaceholderText("Tell Gentle what you need…"), { target: { value: "  hi Gentle  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(bridge.sendMessage).toHaveBeenCalledWith("host-1", "hi Gentle");
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
    await act(async () => {}); // the open resolution's host id must be in place before the answer

    // Pushes carry the host id (T5b): an unaddressed push cannot be proven to
    // belong to this pane once it knows which host it is.
    pushState({
      hostId: "host-1",
      messages: [],
      working: false,
      pendingDialogs: [{ id: "dlg-1", method: "confirm", title: "Delete the file?" }],
      activity: 0,
      helpers: EMPTY_HELPERS,
    });

    fireEvent.click(await screen.findByRole("button", { name: "Yes" }));

    expect(bridge.answerDialog).toHaveBeenCalledWith("host-1", "dlg-1", { confirmed: true });
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
    await act(async () => {}); // the open resolution's host id must be in place before the abort

    pushState({ hostId: "host-1", messages: [], working: true, pendingDialogs: [], activity: 0, helpers: EMPTY_HELPERS });

    const textarea = screen.getByPlaceholderText("Tell Gentle what you need…");
    await vi.waitFor(() => expect(textarea).toHaveAttribute("readonly"));
    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(bridge.abort).toHaveBeenCalledWith("host-1");
  });

  it("guards the open/new effect against a stale resolution when the selection changes before it settles", async () => {
    let resolveFirst: (result: { hostId: string; state: ChatState }) => void = () => {};
    const firstChat: ChatSummary = { ...EXISTING_CHAT, id: "chat-1", title: "First chat" };
    const secondChat: ChatSummary = { ...EXISTING_CHAT, id: "chat-2", title: "Second chat" };

    const bridge = makeBridge({
      openChat: vi.fn((id: string) => {
        if (id === "chat-1") {
          return new Promise<{ hostId: string; state: ChatState }>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve({ hostId: "host-2", state: emptyState() });
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
      hostId: "host-1",
      state: {
        messages: [{ id: "stale", role: MESSAGE_ROLE.ASSISTANT, text: "stale reply", streaming: false }],
        working: false,
        pendingDialogs: [],
        activity: 0,
        helpers: EMPTY_HELPERS,
      },
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

  it("addresses a helper stop from the Helpers pane to the active host", async () => {
    const stopHelper = vi.fn().mockResolvedValue({ cancelled: true });
    let pushState: (state: ChatState) => void = () => {};
    const bridge = makeBridge({
      stopHelper,
      onState: vi.fn((callback: (state: ChatState) => void) => {
        pushState = callback;
        return () => {};
      }),
    });
    window.gentle = bridge;

    render(<ConversationContainer activeChat={NEW_CHAT} {...({ activeHostId: "host-1" } as Record<string, unknown>)} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());
    await act(async () => {}); // the host id must be in place before the stop

    pushState({
      hostId: "host-1",
      messages: [],
      working: false,
      pendingDialogs: [],
      activity: 0,
      helpers: {
        summary: { running: 1, queued: 0, waiting: 0, finished: 0 },
        tasks: [
          {
            id: "helper-a",
            agent: "gentle-ai-worker",
            label: "Running task",
            prompt: "p",
            status: "running",
            createdAt: "2026-09-22T10:00:00.000Z",
            startedAt: "2026-09-22T10:00:00.000Z",
            turns: 1,
            toolCalls: 1,
            thread: { version: 0, dropped: 0, items: [] },
          },
        ],
        stopChannel: { available: true },
      },
    } as unknown as ChatState);
    await act(async () => {});

    fireEvent.click(screen.getByRole("tab", { name: "Helpers (1 running)" }));
    // The only running helper is selected automatically, so Stop is enabled.
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    await act(async () => {});

    // The stop must carry the chat's host id: an empty address is rejected by
    // the router, which is exactly the regression this pins.
    expect(stopHelper).toHaveBeenCalledWith("host-1", "helper-a");
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

  // T5b — routing by workspace-host identity. The `as` cast below only
  // trims the test's literal down to the fields each assertion needs; the
  // pushed ChatState's real shape is wider.
  const stateForHost = (hostId: string, patch: Partial<ChatState> = {}): ChatState =>
    ({ ...emptyState(), ...patch, hostId }) as ChatState;

  it("ignores a pushed state and a pushed error for a host other than the active one", async () => {
    let pushState: (state: ChatState) => void = () => {};
    let pushError: (message: string, hostId: string) => void = () => {};
    const bridge = makeBridge({
      onState: vi.fn((callback: (state: ChatState) => void) => {
        pushState = callback;
        return () => {};
      }),
      onError: vi.fn((callback: (message: string, hostId: string) => void) => {
        pushError = callback;
        return () => {};
      }),
    });
    window.gentle = bridge;

    render(<ConversationContainer activeChat={NEW_CHAT} {...({ activeHostId: "host-1" } as Record<string, unknown>)} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());
    await act(async () => {}); // let the open/new resolution settle before any push

    // A state and an error emitted by another live host must never replace
    // the open chat's state or surface in its status line.
    pushState(stateForHost("host-2", { messages: [{ id: "m2", role: MESSAGE_ROLE.ASSISTANT, text: "from host-2", streaming: false }] }));
    await act(async () => {});
    expect(screen.queryByText("from host-2")).not.toBeInTheDocument();
    pushError("error from host-2", "host-2");
    await act(async () => {});
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    // The active host's own state and error still land.
    pushState(stateForHost("host-1", { messages: [{ id: "m1", role: MESSAGE_ROLE.ASSISTANT, text: "from host-1", streaming: false }] }));
    expect(await screen.findByText("from host-1")).toBeInTheDocument();
    pushError("error from host-1", "host-1");
    expect(await screen.findByRole("status")).toHaveTextContent("error from host-1");
  });

  it("ignores an unaddressed push once it knows which host it is", async () => {
    let pushState: (state: ChatState) => void = () => {};
    let pushError: (message: string, hostId: string) => void = () => {};
    const bridge = makeBridge({
      onState: vi.fn((callback: (state: ChatState) => void) => {
        pushState = callback;
        return () => {};
      }),
      onError: vi.fn((callback: (message: string, hostId: string) => void) => {
        pushError = callback;
        return () => {};
      }),
    });
    window.gentle = bridge;

    render(<ConversationContainer activeChat={NEW_CHAT} {...({ activeHostId: "host-1" } as Record<string, unknown>)} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());
    await act(async () => {}); // let the open/new resolution settle before any push

    // Once the pane knows its host, a push with no host id cannot be proven
    // to be its own, so it must not replace the open chat's state.
    const untagged = stateForHost("host-1", {
      messages: [{ id: "m9", role: MESSAGE_ROLE.ASSISTANT, text: "unaddressed", streaming: false }],
    });
    delete (untagged as { hostId?: string }).hostId;
    pushState(untagged);
    await act(async () => {});
    expect(screen.queryByText("unaddressed")).not.toBeInTheDocument();

    pushError("unaddressed error", undefined as unknown as string);
    await act(async () => {});
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("carries the active host id on every request it sends", async () => {
    let pushState: (state: ChatState) => void = () => {};
    const bridge = makeBridge({
      onState: vi.fn((callback: (state: ChatState) => void) => {
        pushState = callback;
        return () => {};
      }),
    });
    window.gentle = bridge;

    render(<ConversationContainer activeChat={NEW_CHAT} {...({ activeHostId: "host-1" } as Record<string, unknown>)} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());

    fireEvent.change(screen.getByPlaceholderText("Tell Gentle what you need…"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(bridge.sendMessage).toHaveBeenCalledWith("host-1", "hi");

    pushState(stateForHost("host-1", { pendingDialogs: [{ id: "dlg-1", method: "confirm", title: "Delete the file?" } as Dialog] }));
    fireEvent.click(await screen.findByRole("button", { name: "Yes" }));
    expect(bridge.answerDialog).toHaveBeenCalledWith("host-1", "dlg-1", { confirmed: true });

    pushState(stateForHost("host-1", { working: true }));
    const textarea = screen.getByPlaceholderText("Tell Gentle what you need…");
    await vi.waitFor(() => expect(textarea).toHaveAttribute("readonly"));
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(bridge.abort).toHaveBeenCalledWith("host-1");
  });

  it("resolves and reports the host id from open/new when no activeHostId is supplied, and uses it for its requests", async () => {
    const onHostResolved = vi.fn();
    const bridge = makeBridge();
    window.gentle = bridge;

    render(<ConversationContainer activeChat={NEW_CHAT} {...({ onHostResolved } as Record<string, unknown>)} />);
    await vi.waitFor(() => expect(onHostResolved).toHaveBeenCalledWith("host-1"));
    await act(async () => {});

    fireEvent.change(screen.getByPlaceholderText("Tell Gentle what you need…"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await vi.waitFor(() => expect(bridge.sendMessage).toHaveBeenCalledWith("host-1", "hi"));
  });

  // T5c — focus and background discipline. The two-chats helper resolves
  // each chat to its own host, so a re-selected chat can take the refresh
  // path while the other host accumulates in the background.
  const chatOf = (id: string, title: string): ChatSummary => ({ ...EXISTING_CHAT, id, title });
  const CHAT_1 = chatOf("chat-1", "First chat");
  const CHAT_2 = chatOf("chat-2", "Second chat");

  function twoHostBridge(overrides: Partial<GentleBridge> = {}): {
    bridge: GentleBridge;
    pushState: (state: ChatState) => void;
    pushError: (message: string, hostId: string) => void;
    pushClosed: (hostId: string) => void;
  } {
    // The push emitters are read through `sinks` at CALL time, so a later
    // subscription (the effect re-subscribes on host-id changes) is the
    // one the test drives.
    const sinks: { pushState: (state: ChatState) => void; pushError: (message: string, hostId: string) => void; pushClosed: (hostId: string) => void } = {
      pushState: () => undefined,
      pushError: () => undefined,
      pushClosed: () => undefined,
    };
    const bridge = makeBridge({
      openChat: vi.fn((id: string) => Promise.resolve({ hostId: id === "chat-1" ? "host-1" : "host-2", state: emptyState() })),
      onState: vi.fn((callback: (state: ChatState) => void) => {
        sinks.pushState = callback;
        return () => {};
      }),
      onError: vi.fn((callback: (message: string, hostId: string) => void) => {
        sinks.pushError = callback;
        return () => {};
      }),
      // T5d: the close-report emitter, read at CALL time like the others.
      onClosed: vi.fn((callback: (hostId: string) => void) => {
        sinks.pushClosed = callback;
        return () => {};
      }),
      ...overrides,
    });
    return {
      bridge,
      pushState: (state: ChatState) => sinks.pushState(state),
      pushError: (message: string, hostId: string) => sinks.pushError(message, hostId),
      pushClosed: (hostId: string) => sinks.pushClosed(hostId),
    };
  }

  it("a push for a background host updates only that host's snapshot and does not change the focused chat's rendered state", async () => {
    // The refresh never resolves: only the cached snapshots can paint.
    const { bridge, pushState } = twoHostBridge({ refreshChat: vi.fn(() => new Promise<ChatState>(() => {})) });
    window.gentle = bridge;

    const { rerender } = render(<ConversationContainer activeChat={{ kind: "existing", chat: CHAT_1 }} />);
    await vi.waitFor(() => expect(bridge.openChat).toHaveBeenCalledWith("chat-1"));
    await act(async () => {}); // let the open resolution settle before any push

    // Open chat-2 once, so the pane knows which host owns it, then focus
    // chat-1 again: from now on its host is known and its snapshot is
    // cached, so pushes accumulate per host while it stays focused.
    rerender(<ConversationContainer activeChat={{ kind: "existing", chat: CHAT_2 }} />);
    await vi.waitFor(() => expect(bridge.openChat).toHaveBeenCalledWith("chat-2"));
    await act(async () => {}); // let chat-2's adoption settle
    rerender(<ConversationContainer activeChat={{ kind: "existing", chat: CHAT_1 }} />);
    await vi.waitFor(() => expect(bridge.refreshChat).toHaveBeenCalledWith("host-1"));
    await act(async () => {}); // let the refresh-path paint settle before any push
    pushState(stateForHost("host-1", { messages: [{ id: "m1", role: MESSAGE_ROLE.ASSISTANT, text: "focused reply", streaming: false }] }));
    expect(await screen.findByText("focused reply")).toBeInTheDocument();

    // A push from the BACKGROUND host-2 goes into host-2's snapshot only:
    // the focused workspace neither renders it nor loses its own state.
    pushState(stateForHost("host-2", { messages: [{ id: "m2", role: MESSAGE_ROLE.ASSISTANT, text: "background reply", streaming: false }] }));
    await act(async () => {});
    expect(screen.queryByText("background reply")).not.toBeInTheDocument();
    expect(screen.getByText("focused reply")).toBeInTheDocument();

    // The background snapshot accumulated: focusing chat-2 paints it.
    rerender(<ConversationContainer activeChat={{ kind: "existing", chat: CHAT_2 }} />);
    expect(await screen.findByText("background reply")).toBeInTheDocument();
    expect(screen.queryByText("focused reply")).not.toBeInTheDocument();
  });

  it("focusing a host with a cached snapshot renders it before the refresh resolves, then the refresh's answer replaces it", async () => {
    const onHostResolved = vi.fn();
    let pushState: (state: ChatState) => void = () => {};
    let resolveRefresh: ((state: ChatState) => void) | undefined;
    const bridge = makeBridge({
      openChat: vi.fn((id: string) => Promise.resolve({ hostId: id === "chat-1" ? "host-1" : "host-2", state: emptyState() })),
      refreshChat: vi.fn(
        () =>
          new Promise<ChatState>((resolve) => {
            resolveRefresh = resolve;
          }),
      ),
      onState: vi.fn((callback: (state: ChatState) => void) => {
        pushState = callback;
        return () => {};
      }),
    });
    window.gentle = bridge;

    const { rerender } = render(<ConversationContainer activeChat={{ kind: "existing", chat: CHAT_1 }} {...({ onHostResolved } as Record<string, unknown>)} />);
    await vi.waitFor(() => expect(bridge.openChat).toHaveBeenCalledWith("chat-1"));
    await act(async () => {}); // let the open resolution settle before any push
    pushState(stateForHost("host-1", { messages: [{ id: "m1", role: MESSAGE_ROLE.ASSISTANT, text: "cached reply", streaming: false }] }));
    expect(await screen.findByText("cached reply")).toBeInTheDocument();

    // Leave and come back: the cached snapshot paints BEFORE the refresh
    // resolves, and the pane re-reports the host id immediately.
    rerender(<ConversationContainer activeChat={{ kind: "existing", chat: CHAT_2 }} />);
    await vi.waitFor(() => expect(bridge.openChat).toHaveBeenCalledWith("chat-2"));
    await act(async () => {}); // let chat-2's adoption settle
    await act(async () => {
      rerender(<ConversationContainer activeChat={{ kind: "existing", chat: CHAT_1 }} />);
    });
    expect(screen.getByText("cached reply")).toBeInTheDocument();
    expect(onHostResolved).toHaveBeenCalledWith("host-1");
    expect(bridge.refreshChat).toHaveBeenCalledWith("host-1");

    // The refresh's answer then replaces the snapshot.
    resolveRefresh?.(stateForHost("host-1", { messages: [{ id: "m9", role: MESSAGE_ROLE.ASSISTANT, text: "refreshed reply", streaming: false }] }));
    expect(await screen.findByText("refreshed reply")).toBeInTheDocument();
    expect(screen.queryByText("cached reply")).not.toBeInTheDocument();
  });

  it("an error pushed by a background host does not surface in the focused workspace's status line; it surfaces when that host is focused", async () => {
    const { bridge, pushError } = twoHostBridge({ refreshChat: vi.fn(() => new Promise<ChatState>(() => {})) });
    window.gentle = bridge;

    const { rerender } = render(<ConversationContainer activeChat={{ kind: "existing", chat: CHAT_1 }} />);
    await vi.waitFor(() => expect(bridge.openChat).toHaveBeenCalledWith("chat-1"));
    await act(async () => {}); // let chat-1's adoption settle
    rerender(<ConversationContainer activeChat={{ kind: "existing", chat: CHAT_1 }} />);
    await vi.waitFor(() => expect(bridge.refreshChat).toHaveBeenCalledWith("host-1"));
    await act(async () => {}); // let the refresh-path paint settle
    rerender(<ConversationContainer activeChat={{ kind: "existing", chat: CHAT_2 }} />);
    await vi.waitFor(() => expect(bridge.openChat).toHaveBeenCalledWith("chat-2"));
    await act(async () => {}); // let chat-2's adoption settle
    rerender(<ConversationContainer activeChat={{ kind: "existing", chat: CHAT_1 }} />);
    await act(async () => {});

    // The failure belongs to the host that emitted it: while chat-1 is
    // focused, host-2's error must not surface in its status line.
    pushError("host-2 exploded", "host-2");
    await act(async () => {});
    expect(screen.queryByText("host-2 exploded")).not.toBeInTheDocument();

    // It does land in host-2's snapshot, so focusing that workspace
    // surfaces it.
    rerender(<ConversationContainer activeChat={{ kind: "existing", chat: CHAT_2 }} />);
    expect(await screen.findByText("host-2 exploded")).toBeInTheDocument();
  });

  it("a request made in the window between a selection change and the new host id resolution is refused, not sent with the previous host id", async () => {
    const bridge = makeBridge({
      openChat: vi.fn((id: string) =>
        id === "chat-1" ? Promise.resolve({ hostId: "host-1", state: emptyState() }) : new Promise<{ hostId: string; state: ChatState }>(() => {}),
      ),
      sendMessage: vi.fn().mockRejectedValue(new Error('No live workspace host for id "" (unknown or already stopped)')),
    });
    window.gentle = bridge;

    const { rerender } = render(<ConversationContainer activeChat={{ kind: "existing", chat: CHAT_1 }} />);
    await vi.waitFor(() => expect(bridge.openChat).toHaveBeenCalledWith("chat-1"));
    await act(async () => {}); // host-1 adopted

    // The rerender and the send share one act: the click lands in the
    // render window BEFORE the selection-change effects have run, which is
    // exactly the window where the previously resolved host id must not be
    // an address.
    act(() => {
      rerender(<ConversationContainer activeChat={{ kind: "existing", chat: CHAT_2 }} />);
      fireEvent.change(screen.getByPlaceholderText("Tell Gentle what you need…"), { target: { value: "hello" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });

    expect(bridge.sendMessage).not.toHaveBeenCalledWith("host-1", "hello");
    expect(bridge.sendMessage).toHaveBeenCalledWith("", "hello");
    // The refusal is explicit, not a silent misroute.
    expect(await screen.findByRole("status")).toHaveTextContent("No live workspace host");
  });

  // T5d — lifecycle. Two contract changes land here: a failed refresh no
  // longer falls back to chat.open (starting a child must never be an
  // implicit consequence of focusing a chat), and a reported close makes
  // the renderer forget the host so a later selection reopens it.
  it("a failed chat.refresh keeps the retained snapshot, surfaces the failure, and does not call openChat/newChat; an explicit re-selection then reopens through chat.open", async () => {
    const onHostResolved = vi.fn();
    let pushState: (state: ChatState) => void = () => {};
    const bridge = makeBridge({
      openChat: vi.fn((id: string) => Promise.resolve({ hostId: id === "chat-1" ? "host-1" : "host-2", state: emptyState() })),
      refreshChat: vi.fn().mockRejectedValue(new Error('No live workspace host for id "host-1" (unknown or already stopped)')),
      onState: vi.fn((callback: (state: ChatState) => void) => {
        pushState = callback;
        return () => {};
      }),
    });
    window.gentle = bridge;

    const { rerender } = render(<ConversationContainer activeChat={{ kind: "existing", chat: CHAT_1 }} {...({ onHostResolved } as Record<string, unknown>)} />);
    await vi.waitFor(() => expect(bridge.openChat).toHaveBeenCalledTimes(1));
    await act(async () => {}); // let the open resolution settle before any push
    pushState(stateForHost("host-1", { messages: [{ id: "m1", role: MESSAGE_ROLE.ASSISTANT, text: "cached reply", streaming: false }] }));
    expect(await screen.findByText("cached reply")).toBeInTheDocument();

    // Re-selecting runs the refresh; when it fails, the retained snapshot
    // stays painted and the failure is surfaced — no child is started
    // behind the user's back.
    await act(async () => {
      rerender(<ConversationContainer activeChat={{ kind: "existing", chat: CHAT_1 }} {...({ onHostResolved } as Record<string, unknown>)} />);
    });
    await vi.waitFor(() => expect(bridge.refreshChat).toHaveBeenCalledWith("host-1"));
    await act(async () => {}); // let the rejection settle
    expect(screen.getByText("cached reply")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("No live workspace host");
    expect(bridge.openChat).toHaveBeenCalledTimes(1);
    expect(bridge.newChat).not.toHaveBeenCalled();

    // The only reopen path left is an explicit user action: re-selecting
    // the chat again resolves through chat.open (which reuses a still-live
    // host on main's side, so the reopen costs no child either).
    await act(async () => {
      rerender(<ConversationContainer activeChat={{ kind: "existing", chat: CHAT_1 }} {...({ onHostResolved } as Record<string, unknown>)} />);
    });
    await vi.waitFor(() => expect(bridge.openChat).toHaveBeenCalledTimes(2));
    expect(bridge.refreshChat).toHaveBeenCalledTimes(1); // never loops the dead refresh
  });

  it("a reported close evicts the closed host's snapshot and chat mapping: re-selecting that chat resolves through chat.open again instead of painting the dead snapshot", async () => {
    // The refresh never resolves, so only the cached snapshot can paint —
    // the same arrangement the T5c snapshot tests use.
    const { bridge, pushState, pushClosed } = twoHostBridge({ refreshChat: vi.fn(() => new Promise<ChatState>(() => {})) });
    window.gentle = bridge;

    const { rerender } = render(<ConversationContainer activeChat={{ kind: "existing", chat: CHAT_1 }} />);
    await vi.waitFor(() => expect(bridge.openChat).toHaveBeenCalledWith("chat-1"));
    await act(async () => {}); // let the open resolution settle before any push
    pushState(stateForHost("host-1", { messages: [{ id: "m1", role: MESSAGE_ROLE.ASSISTANT, text: "cached reply", streaming: false }] }));
    expect(await screen.findByText("cached reply")).toBeInTheDocument();

    // Leave and come back: the cached snapshot paints and the still-live
    // host is asked for its state (the T5c refresh path, one call).
    rerender(<ConversationContainer activeChat={{ kind: "existing", chat: CHAT_2 }} />);
    await vi.waitFor(() => expect(bridge.openChat).toHaveBeenCalledWith("chat-2"));
    await act(async () => {}); // let chat-2's adoption settle
    await act(async () => {
      rerender(<ConversationContainer activeChat={{ kind: "existing", chat: CHAT_1 }} />);
    });
    await vi.waitFor(() => expect(bridge.refreshChat).toHaveBeenCalledWith("host-1"));
    expect(screen.getByText("cached reply")).toBeInTheDocument();

    // The close is reported: the snapshot and the chat→host mapping are
    // evicted, so the next selection of that chat resolves through
    // chat.open again instead of the dead host's refresh path.
    await act(async () => {
      pushClosed("host-1");
    });
    await act(async () => {
      rerender(<ConversationContainer activeChat={{ kind: "existing", chat: CHAT_1 }} />);
    });
    await vi.waitFor(() => expect(bridge.openChat).toHaveBeenCalledTimes(3));
    await act(async () => {}); // let the reopen resolution paint
    expect(bridge.refreshChat).toHaveBeenCalledTimes(1); // never asked the dead host again
    expect(screen.queryByText("cached reply")).not.toBeInTheDocument();
  });
});
