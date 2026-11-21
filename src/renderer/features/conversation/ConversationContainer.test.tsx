// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CHAT_STATE, MESSAGE_ROLE, type ChatState, type ChatSummary, type Dialog, type GentleBridge, type SubscriptionUsage } from "@shared/bridge-types";
import { mockBridge, resetMockBridge, setMockChatMessages, setMockChats } from "@renderer/shared/bridge/mockBridge";
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

/** A second chat, for the tests that need the user to move on mid-request. */
const OTHER_CHAT: ChatSummary = {
  id: "chat-2",
  title: "Another task",
  cwd: "/tmp/other",
  updatedAt: "2026-09-21T09:30:00.000Z",
  messageCount: 1,
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
    // T2: the workspace pane's creation path; a default spy so "never
    // called" assertions have something to read.
    openWorkspace: vi.fn().mockResolvedValue({ hostId: "host-1", state: emptyState() }),
    sendMessage: vi.fn().mockResolvedValue({ queued: true }),
    abort: vi.fn().mockResolvedValue(undefined),
    answerDialog: vi.fn().mockResolvedValue(undefined),
    // P2: the close path the header's control reaches.
    closeChat: vi.fn().mockResolvedValue(undefined),
    removeWorkspace: vi.fn().mockResolvedValue({ directories: [], persisted: [] }),
    onState: vi.fn().mockReturnValue(() => {}),
    onError: vi.fn().mockReturnValue(() => {}),
    // T5c: the fake answers the chat.refresh path; tests that need to hold
    // the resolution open (or replace it) override this.
    refreshChat: vi.fn().mockResolvedValue(emptyState()),
    setupStatus: vi.fn().mockResolvedValue({ needsChoice: false, detection: { found: false, dir: "", hasAuth: false, hasModels: false } }),
    chooseHome: vi.fn().mockResolvedValue(undefined),
    // palette-host-catalog S4: the host's run_command path; the default
    // spy answers executed so "never called" assertions have something to
    // read, and tests override it for each refusal shape.
    runCommand: vi.fn().mockResolvedValue({ kind: "executed" }),
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
  it("routes the native command catalog from chat state into the footer", async () => {
    window.gentle = makeBridge({
      newChat: vi.fn().mockResolvedValue({ hostId: "host-1", state: {
        ...emptyState(),
        commands: [
          { name: "skill:review", source: "skill" },
          { name: "skill:test", source: "skill" },
          { name: "extension-command", source: "extension" },
          { name: "prompt-command", source: "prompt" },
        ],
      } }),
    });
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    expect(await screen.findByRole("img", { name: "Skills: 2" })).toHaveTextContent("2");
    expect(screen.getByRole("img", { name: "Extensions: 0" })).toHaveTextContent("0");
  });

  it("refuses initial adoption after a closed push and discards a resume list after close", async () => {
    let resolveOpen!: (value: { hostId: string; state: ChatState }) => void;
    let closed!: (id: string) => void;
    const onHostResolved = vi.fn();
    const bridge = makeBridge({
      openChat: vi.fn(() => new Promise<{ hostId: string; state: ChatState }>((done) => { resolveOpen = done; })),
      onClosed: vi.fn((sink) => { closed = sink; return () => {}; }),
    });
    window.gentle = bridge;
    render(<ConversationContainer activeChat={{ kind: "existing", chat: EXISTING_CHAT }} onHostResolved={onHostResolved} />);
    await act(async () => {
      closed("host-late-closed");
      resolveOpen({ hostId: "host-late-closed", state: { ...emptyState(), messages: [{ id: "late", role: MESSAGE_ROLE.ASSISTANT, text: "Closed initial response", streaming: false }] } });
    });
    expect(onHostResolved).not.toHaveBeenCalled();
    expect(screen.queryByText("Closed initial response")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });
  it("sends a typed /resume draft as plain text instead of opening the resume dialog (T10/L9)", async () => {
    // The pane's catalog carries the host's runnable resume row: the typed
    // draft is still plain text for the child — the picker is the palette
    // row's only route — and the pane says where the command really runs.
    const bridge = makeBridge({
      listChats: vi.fn().mockResolvedValue([EXISTING_CHAT, OTHER_CHAT]),
      openChat: vi.fn().mockResolvedValue({
        hostId: "host-1",
        state: { ...emptyState(), commands: [{ name: "resume", description: "Resume another session", runnable: true, source: "builtin" }] },
      }),
    });
    window.gentle = bridge;
    render(<ConversationContainer activeChat={{ kind: "existing", chat: EXISTING_CHAT }} />);
    await act(async () => {});
    // Even a padded draft is no longer intercepted: a typed slash command is
    // just a message for the child, exactly like any other draft.
    fireEvent.change(screen.getByPlaceholderText("Tell Gentle what you need…"), { target: { value: "  /resume  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(bridge.sendMessage).toHaveBeenCalledExactlyOnceWith("host-1", "/resume");
    expect(bridge.listChats).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Resume a session" })).not.toBeInTheDocument();
    // Plain text, but NOT a silent outcome any more: the pane says where the
    // host command really runs instead of letting /resume look like it ran.
    expect(await screen.findByRole("status")).toHaveTextContent(
      "/resume is a host command — run it from the command palette. It was sent to Pi as plain text.",
    );
  });

  it("says out loud that a slash name the catalog does not publish went out as a plain message", async () => {
    const bridge = makeBridge({ sendMessage: vi.fn().mockResolvedValue({ queued: true }) });
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});
    // The child's catalog for this pane lists /plan only (makeBridge default).
    fireEvent.change(screen.getByPlaceholderText("Tell Gentle what you need…"), { target: { value: "/gentle:profiles" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    // The send itself is untouched — pi keeps deciding what /text means.
    expect(bridge.sendMessage).toHaveBeenCalledExactlyOnceWith("host-1", "/gentle:profiles");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Pi reports no /gentle:profiles command for this chat — it was sent as a normal message.",
    );

    // The notice belongs to the draft that produced it: the next ordinary
    // send settles the line again, the same rule the palette's dispatches
    // already follow.
    fireEvent.change(screen.getByPlaceholderText("Tell Gentle what you need…"), { target: { value: "what changed today?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("says nothing about a draft whose name the catalog publishes, or about a pasted path", async () => {
    const bridge = makeBridge({ sendMessage: vi.fn().mockResolvedValue({ queued: true }) });
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});

    // A published command, with arguments: the catalog knows the name.
    fireEvent.change(screen.getByPlaceholderText("Tell Gentle what you need…"), { target: { value: "/plan make it so" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(bridge.sendMessage).toHaveBeenCalledWith("host-1", "/plan make it so");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    // A pasted absolute path is not a command name: the lookahead stops at the
    // second slash, so no notice ever accuses the user of a typo.
    fireEvent.change(screen.getByPlaceholderText("Tell Gentle what you need…"), { target: { value: "/home/pablo/notes.md" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(bridge.sendMessage).toHaveBeenCalledWith("host-1", "/home/pablo/notes.md");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("discards an open resume picker when the workspace changes, including late history", async () => {
    let resolveList!: (chats: ChatSummary[]) => void;
    const bridge = makeBridge({
      openChat: vi.fn().mockResolvedValue({
        hostId: "host-1",
        state: { ...emptyState(), commands: [{ name: "resume", description: "Resume another session", runnable: true, source: "builtin" }] },
      }),
      listChats: vi.fn(() => new Promise<ChatSummary[]>((done) => { resolveList = done; })),
    });
    window.gentle = bridge;
    const view = render(<ConversationContainer activeChat={{ kind: "existing", chat: EXISTING_CHAT }} />);
    await act(async () => {});
    // The picker opens through the catalog's runnable resume row: type its
    // name in the palette and run it.
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const palette = screen.getByRole("dialog", { name: "Commands" });
    fireEvent.change(within(palette).getByRole("combobox"), { target: { value: "resume" } });
    fireEvent.keyDown(within(palette).getByRole("combobox"), { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "Resume a session" })).toBeInTheDocument();
    view.rerender(<ConversationContainer activeChat={{ kind: "existing", chat: OTHER_CHAT }} />);
    await act(async () => { resolveList([EXISTING_CHAT]); });
    expect(screen.queryByRole("dialog", { name: "Resume a session" })).not.toBeInTheDocument();
    expect(bridge.sendMessage).not.toHaveBeenCalled();
    expect(bridge.runCommand).not.toHaveBeenCalled();
  });

  it("discards a pending resume list when the current host closes before history answers", async () => {
    let closed!: (id: string) => void;
    let release!: (chats: ChatSummary[]) => void;
    const bridge = makeBridge({
      openChat: vi.fn().mockResolvedValue({
        hostId: "host-1",
        state: { ...emptyState(), commands: [{ name: "resume", description: "Resume another session", runnable: true, source: "builtin" }] },
      }),
      onClosed: vi.fn((sink) => { closed = sink; return () => {}; }),
      listChats: vi.fn(() => new Promise<ChatSummary[]>((done) => { release = done; })),
    });
    window.gentle = bridge;
    render(<ConversationContainer activeChat={{ kind: "existing", chat: EXISTING_CHAT }} />);
    await act(async () => {});
    // Same palette-only way in here: Ctrl+K, the resume row, Enter.
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const palette = screen.getByRole("dialog", { name: "Commands" });
    fireEvent.change(within(palette).getByRole("combobox"), { target: { value: "resume" } });
    fireEvent.keyDown(within(palette).getByRole("combobox"), { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "Resume a session" })).toBeInTheDocument();
    await act(async () => { closed("host-1"); release([EXISTING_CHAT]); });
    expect(screen.queryByRole("dialog", { name: "Resume a session" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(bridge.sendMessage).not.toHaveBeenCalled();
    expect(bridge.runCommand).not.toHaveBeenCalled();
  });

  it("sends a typed /resume with arguments as plain text too — the local refusal is gone (T10/L9)", async () => {
    const bridge = makeBridge();
    window.gentle = bridge;
    render(<ConversationContainer activeChat={{ kind: "existing", chat: EXISTING_CHAT }} />);
    await act(async () => {});
    fireEvent.change(screen.getByPlaceholderText("Tell Gentle what you need…"), { target: { value: "/resume /private/session" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(bridge.sendMessage).toHaveBeenCalledExactlyOnceWith("host-1", "/resume /private/session");
    expect(bridge.listChats).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("sends a typed /resume as plain text even with no workspace directory known (T10/L9)", async () => {
    const bridge = makeBridge();
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});
    fireEvent.change(screen.getByPlaceholderText("Tell Gentle what you need…"), { target: { value: "/resume" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(bridge.sendMessage).toHaveBeenCalledExactlyOnceWith("host-1", "/resume");
    expect(bridge.listChats).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Resume a session" })).not.toBeInTheDocument();
  });
  it("portals the real footer into the shell slot and falls back inline", async () => {
    window.gentle = makeBridge();
    const footerTarget = document.createElement("div");
    const { container, rerender } = render(<ConversationContainer activeChat={NEW_CHAT} {...{ footerTarget }} />);
    await act(async () => {});
    expect(footerTarget.querySelector('[aria-label="Session footer"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Session footer"]')).toBeNull();
    rerender(<ConversationContainer activeChat={NEW_CHAT} />);
    expect(footerTarget.childElementCount).toBe(0);
    expect(screen.getByLabelText("Session footer")).toBeInTheDocument();
  });
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
    expect(screen.getByRole("heading", { name: "project" })).toBeInTheDocument();
  });

  // S6 (gui-design-alignment): the conversation header renders no close
  // control — the workspace close path moved to the Workspaces panel's row
  // control (App owns it). The container's close-related coverage (P2/P3,
  // R3-002/R3-003) lost its surface and is gone with it.

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

  it("renders the session identity and context in the footer when the pushed ChatState carries them", async () => {
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

    const footer = await screen.findByLabelText("Session footer");
    // S9/S10: model, thinking level and context moved out of the status line
    // into the footer's identity and context groups — one home for each fact.
    expect(footer).toHaveTextContent("Claude Sonnet 4");
    expect(footer).toHaveTextContent("medium");
    expect(footer).toHaveTextContent("30%");
    // Cost keeps its single home in the inspector's usage summary, so the
    // footer never repeats it.
    expect(footer).not.toHaveTextContent("$0.45");
    expect(screen.getByRole("region", { name: "Usage" })).toHaveTextContent("$0.45");
    // Identity is chrome, never conversation content.
    expect(screen.queryByText("Claude Sonnet 4", { selector: ".gc-message__text" })).not.toBeInTheDocument();
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

  it("renders each tool call of a turn inside that turn's bubble, and calls without a turn in their own region (S2)", async () => {
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
      messages: [
        {
          id: "msg-0",
          role: MESSAGE_ROLE.ASSISTANT,
          text: "Listing the folder.",
          streaming: false,
          parts: [{ kind: "text", text: "Listing the folder." }, { kind: "tool", toolCallId: "c1" }],
        },
      ],
      working: false,
      pendingDialogs: [],
      activity: 2,
      helpers: EMPTY_HELPERS,
      toolCalls: [
        { id: "c1", toolName: "read", args: { path: "a" }, result: "ok", isError: false, status: "done", messageId: "msg-0" },
        { id: "c2", toolName: "some_future_tool", status: "running" },
      ],
      toolVocabulary: { categories: ["read"], entries: [{ category: "read", glyph: "≡", tools: ["read"] }] },
    });

    // The call of the turn lives inside the assistant message's bubble.
    const bubble = (await screen.findByText("Listing the folder.")).closest("article");
    const row = within(bubble!).getByTestId("gc-action-row");
    // The child's vocabulary glyph, not an invented one.
    expect(within(row).getByText("≡")).toBeInTheDocument();

    // The call that belongs to no turn is never nested inside a bubble: it
    // keeps its own row in the separate region after the thread (no silent
    // loss).
    const orphans = screen.getByTestId("gc-orphan-actions");
    expect(within(orphans).getByText("some_future_tool")).toBeInTheDocument();
    expect(within(bubble!).queryByText("some_future_tool")).not.toBeInTheDocument();

    // The standalone tool activity list at the transcript end is gone (S2).
    expect(screen.queryByLabelText("Tool activity")).not.toBeInTheDocument();
    expect(screen.queryByText("Tool activity")).not.toBeInTheDocument();
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

  it("calls bridge.abort() on a double Escape while working", async () => {
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
    // S2: a single Escape never stops the agent; two inside the window do.
    fireEvent.keyDown(textarea, { key: "Escape" });
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

  it("opens real helper activity through the inspector control",  async () => {
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

    const open = await screen.findByRole("button", { name: "Open helpers" });
    fireEvent.click(open);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Look into the failing test" })).toBeInTheDocument();
  });

  it("opens helpers from the inspector, and Back to chat returns to the chat pane", async () => {
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
    fireEvent.click(await screen.findByRole("button", { name: "Open helpers" }));
    expect(screen.getByRole("heading", { name: "Look into the failing test" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: "Open helpers" }));
    // The only running helper is selected automatically, so Stop is enabled.
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    await act(async () => {});

    // The stop must carry the chat's host id: an empty address is rejected by
    // the router, which is exactly the regression this pins.
    expect(stopHelper).toHaveBeenCalledWith("host-1", "helper-a");
  });

  it("does not resurrect a closed host when its refresh resolves late", async () => {
    let pushClosed: (hostId: string) => void = () => {};
    let resolveRefresh: ((state: ChatState) => void) | undefined;
    const bridge = makeBridge({
      refreshChat: vi.fn(
        () =>
          new Promise<ChatState>((resolve) => {
            resolveRefresh = resolve;
          }),
      ),
      onClosed: vi.fn((callback: (hostId: string) => void) => {
        pushClosed = callback;
        return () => {};
      }),
    });
    window.gentle = bridge;

    // Resolve the chat once so its host and snapshot are known, then make the
    // replay path go through the pending refresh.
    const first = render(<ConversationContainer activeChat={NEW_CHAT} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());
    await act(async () => {});
    first.unmount();

    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await vi.waitFor(() => expect(bridge.refreshChat).toHaveBeenCalled());
    await act(async () => {});

    // The host is closed while its refresh is still in flight; the answer
    // that arrives afterwards must not repaint the closed host's state.
    pushClosed("host-1");
    await act(async () => {});
    resolveRefresh?.({ ...emptyState(), messages: [{ id: "late", role: MESSAGE_ROLE.ASSISTANT, text: "late answer", streaming: false }] } as ChatState);
    await act(async () => {});

    expect(screen.queryByText("late answer")).not.toBeInTheDocument();
  });

  it("keeps refusing a closed host's late refresh after many closes", async () => {
    let pushClosed: (hostId: string) => void = () => {};
    let pushState: (state: ChatState) => void = () => {};
    const bridge = makeBridge({
      onState: vi.fn((callback: (state: ChatState) => void) => {
        pushState = callback;
        return () => {};
      }),
      onClosed: vi.fn((callback: (hostId: string) => void) => {
        pushClosed = callback;
        return () => {};
      }),
    });
    window.gentle = bridge;

    render(<ConversationContainer activeChat={NEW_CHAT} {...({ activeHostId: "host-1" } as Record<string, unknown>)} />);
    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());
    await act(async () => {});

    // More closes than the renderer remembers: the trimming must never drop
    // the most recent ones, or a late answer would repaint a dead host.
    for (let index = 1; index <= 40; index += 1) pushClosed(`host-${index}`);
    await act(async () => {});

    pushState({
      hostId: "host-40",
      messages: [{ id: "late-2", role: MESSAGE_ROLE.ASSISTANT, text: "after many closes", streaming: false }],
      working: false,
      pendingDialogs: [],
      activity: 0,
      helpers: { summary: { running: 0, queued: 0, waiting: 0, finished: 0 }, tasks: [] },
    } as ChatState);
    await act(async () => {});

    expect(screen.queryByText("after many closes")).not.toBeInTheDocument();
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
      helpers: HELPERS_WITH_TASKS,
      todo: { tasks: [{ id: 1, title: "Panel task only", status: "pending" }], nextId: 2, updatedTurn: 1 },
    });
    expect(await screen.findByTestId("gc-todo-card")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open helpers" }));

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
    fireEvent.click(await screen.findByRole("button", { name: "Open helpers" }));
    expect(screen.getByRole("button", { name: "Back to chat" })).toBeInTheDocument();

    rerender(<ConversationContainer activeChat={{ kind: "existing", chat: EXISTING_CHAT }} />);

    expect(screen.getByRole("form", { name: "Composer" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back to chat" })).not.toBeInTheDocument();
  });

  // S12 (gui-design-alignment, revised): the chat pane renders only the
  // error — a keyed status is a diagnostic that belongs to the Helpers
  // pane and never enters the chat flow, nor as a transcript message.
  it("keeps a pushed keyed status in the Helpers pane and out of the chat pane", async () => {
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
      messages: [{ id: "m1", role: MESSAGE_ROLE.USER, text: "Status probe" }],
      working: false,
      pendingDialogs: [],
      activity: 0,
      helpers: HELPERS_WITH_TASKS,
      statuses: { "gentle-todo": "2 tasks open" },
    });

    // Wait for the pushed state to land before asserting what it renders —
    // otherwise the presence assertion passes on a stale pane.
    await screen.findByText("Status probe");
    // Not in the chat pane at all: no status list, no transcript entry.
    expect(screen.queryByLabelText("Session status")).not.toBeInTheDocument();
    expect(screen.queryByText("2 tasks open", { selector: ".gc-message__text" })).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "Open helpers" }));
    const statusList = await screen.findByLabelText("Session status");
    expect(statusList).toHaveTextContent("gentle-todo");
    expect(statusList).toHaveTextContent("2 tasks open");
  });

  // Same revised rule for notifications: they are diagnostics, not chat.
  it("keeps pushed child notifications in the Helpers pane and out of the chat pane", async () => {
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
      messages: [{ id: "m1", role: MESSAGE_ROLE.USER, text: "Notice probe" }],
      working: false,
      pendingDialogs: [],
      activity: 0,
      helpers: HELPERS_WITH_TASKS,
      notifications: [
        { message: "Command blocked by user", severity: "warning" },
        { message: "Disk full", severity: "error" },
      ],
    });

    await screen.findByText("Notice probe");
    // Not in the chat pane at all: no notification stack, no transcript entry.
    expect(screen.queryByLabelText("Notifications")).not.toBeInTheDocument();
    expect(screen.queryByText("Command blocked by user", { selector: ".gc-message__text" })).not.toBeInTheDocument();
    expect(screen.queryByText("Disk full", { selector: ".gc-message__text" })).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "Open helpers" }));
    const stack = await screen.findByLabelText("Notifications");
    expect(stack).toHaveTextContent("Command blocked by user");
    expect(stack).toHaveTextContent("Disk full");
  });

  // S12: the Helpers pane keeps its complete status surface — it is the
  // diagnostic pane, not the chat — pinned here so a later cleanup cannot
  // silently drop it.
  it("keeps the keyed status surface in the Helpers pane", async () => {
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
      helpers: HELPERS_WITH_TASKS,
      statuses: { "gentle-todo": "2 tasks open" },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Open helpers" }));

    const statusList = await screen.findByLabelText("Session status");
    expect(statusList).toHaveTextContent("gentle-todo");
    expect(statusList).toHaveTextContent("2 tasks open");
  });

  // R1-1: the notification stack stays reachable in the Helpers pane, so the
  // chat-pane removal cannot leave warnings like a blocked command with no
  // surface at all.
  it("keeps the notification stack in the Helpers pane", async () => {
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
      helpers: HELPERS_WITH_TASKS,
      notifications: [{ message: "Command blocked by user", severity: "warning" }],
    });

    fireEvent.click(await screen.findByRole("button", { name: "Open helpers" }));

    const stack = await screen.findByLabelText("Notifications");
    expect(stack).toHaveTextContent("Command blocked by user");
  });

  // R3-002 (gui-design-alignment): the eye renders with an EMPTY agents
  // list too, because keyed statuses and child notifications are only
  // visible in the helpers view — with no agents running they must still
  // be reachable through it.
  it("reaches a pushed keyed status and notification through the eye even with no agents (R3-002)", async () => {
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
      notifications: [{ message: "Command blocked by user", severity: "warning" }],
    });

    // The eye is present even though no agent has ever run in this chat.
    fireEvent.click(await screen.findByRole("button", { name: "Open helpers" }));
    const statusList = await screen.findByLabelText("Session status");
    expect(statusList).toHaveTextContent("gentle-todo");
    expect(statusList).toHaveTextContent("2 tasks open");
    const stack = screen.getByLabelText("Notifications");
    expect(stack).toHaveTextContent("Command blocked by user");
  });

  it("puts the task panel in the inspector beside the conversation, keeping the composer last", async () => {
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
    const inspector = screen.getByLabelText("Plan, usage and delegated agents");
    const stack = composer.closest(".gc-conversation__stack");

    // The artboard's "Workspace" layout supersedes the TUI's above-the-prompt
    // rail (desktop-m3-odd-panel S5): the three-section inspector sits BESIDE
    // the conversation, so the task panel no longer precedes the composer in
    // document order. The rule's intent still holds — the composer is the last
    // element of the conversation column, so the prompt stays within reach.
    expect(inspector).toContainElement(card);
    expect(stack).not.toContainElement(card);
    expect(stack?.lastElementChild).toBe(composer);
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

  it("does not offer a request in the window between a selection change and the new host id resolution", async () => {
    const bridge = makeBridge({
      openChat: vi.fn((id: string) =>
        id === "chat-1" ? Promise.resolve({ hostId: "host-1", state: emptyState() }) : new Promise<{ hostId: string; state: ChatState }>(() => {}),
      ),
    });
    window.gentle = bridge;

    const { rerender } = render(<ConversationContainer activeChat={{ kind: "existing", chat: CHAT_1 }} />);
    await vi.waitFor(() => expect(bridge.openChat).toHaveBeenCalledWith("chat-1"));
    await act(async () => {}); // host-1 adopted

    // In the render window right after a selection change the pane knows it
    // has no address yet, so Send is not offered at all: the previous chat's
    // host id must never become an address, and no request is fired into a
    // route main would have to refuse.
    act(() => {
      rerender(<ConversationContainer activeChat={{ kind: "existing", chat: CHAT_2 }} />);
      fireEvent.change(screen.getByPlaceholderText("Tell Gentle what you need…"), { target: { value: "hello" } });
    });

    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    act(() => {
      fireEvent.click(send);
    });

    expect(bridge.sendMessage).not.toHaveBeenCalledWith("host-1", "hello");
    expect(bridge.sendMessage).not.toHaveBeenCalled();
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

// T11 — Add workspace: the pane created through the native directory
// picker arrives ALREADY resolved (main minted its host and started its
// chat, and validated the directory first), so the container adopts the
// returned result directly instead of resolving the pane through
// bridge.newChat() again — that second resolution would spawn a SECOND
// child for the same workspace.
describe("ConversationContainer created workspace (T11)", () => {
  it("adopts a created workspace instead of resolving through bridge.newChat again", async () => {
    const bridge = makeBridge();
    window.gentle = bridge;
    const onHostResolved = vi.fn();

    render(
      <ConversationContainer
        activeChat={{ kind: "new", epoch: 7 }}
        createdWorkspace={{
          chatKey: "new-7",
          result: { hostId: "host-ws", state: { ...emptyState(), workspacePath: "/tmp/ws-demo" } },
        }}
        onHostResolved={onHostResolved}
      />,
    );

    await vi.waitFor(() => expect(onHostResolved).toHaveBeenCalledWith("host-ws"));
    // No child may be started for an already-created workspace.
    expect(bridge.newChat).not.toHaveBeenCalled();
    expect(bridge.openChat).not.toHaveBeenCalled();
    // The adopted state renders, and its directory reaches the footer.
    expect(screen.getByLabelText("Session footer")).toHaveTextContent("/tmp/ws-demo");
  });

  it("ignores a created workspace whose pane key is not the active chat", async () => {
    const bridge = makeBridge();
    window.gentle = bridge;

    render(
      <ConversationContainer
        activeChat={{ kind: "new", epoch: 2 }}
        createdWorkspace={{
          chatKey: "new-1",
          result: { hostId: "host-stale", state: { ...emptyState(), workspacePath: "/tmp/stale" } },
        }}
      />,
    );

    await vi.waitFor(() => expect(bridge.newChat).toHaveBeenCalled());
    expect(bridge.newChat).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Session footer")).toHaveTextContent("~/");
  });

  it("shows the open workspace's full path in the footer, and ~/ when none is known", async () => {
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

    // No workspace directory is known yet for a plain new chat: `~/`, not
    // an invented path.
    expect(screen.getByLabelText("Session footer")).toHaveTextContent("~/");

    // The validated directory rides on the pushed state (attached at the
    // push boundary, like hostId): the footer shows it in full. The push is
    // ADDRESSED on purpose (makeBridge's newChat resolves host-1): an
    // unaddressed push is refused by the pane's own-host gate once a host
    // is resolved — real pushes always carry the emitting host's id.
    await act(async () => {});
    pushState({ ...emptyState(), workspacePath: "/home/dev/projects/gentle", hostId: "host-1" });
    expect(await screen.findByText("/home/dev/projects/gentle")).toBeInTheDocument();
  });

  it("shows an existing chat's own cwd as the footer path — the session summary reports it", async () => {
    const bridge = makeBridge();
    window.gentle = bridge;

    render(<ConversationContainer activeChat={{ kind: "existing", chat: EXISTING_CHAT }} />);

    await vi.waitFor(() => expect(bridge.openChat).toHaveBeenCalledWith("chat-1"));
    expect(screen.getByLabelText("Session footer")).toHaveTextContent("/tmp/project");
  });

  // T8b — the worktree group rides the same pushed ChatState as every other
  // workspace fact: nothing is derived or fetched by the renderer itself.
  it("renders the footer's worktree group from the pushed workspace state", async () => {
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
    await act(async () => {});
    pushState({
      ...emptyState(),
      workspacePath: "/home/dev/projects/gentle",
      hostId: "host-1",
      workspace: {
        worktree: { root: "/home/dev/projects/gentle", branch: "main", files: ["a.ts"], added: 4, deleted: 1 },
      },
    });

    const footer = await screen.findByLabelText("Session footer");
    // The design's changes group is counts only: files, additions, deletions.
    expect(footer).toHaveTextContent("1 files");
    expect(footer).toHaveTextContent("+4");
    expect(footer).toHaveTextContent("-1");
    // The branch is not part of that group in the design footer.
    expect(footer.textContent).not.toContain("main");
  });

  it("renders no worktree group while no workspace directory is known", async () => {
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
    await act(async () => {});
    pushState({
      ...emptyState(),
      hostId: "host-1",
      workspace: {
        worktree: { root: "/home/dev/projects/gentle", branch: "main", files: ["a.ts"], added: 4, deleted: 1 },
      },
    });

    const footer = await screen.findByLabelText("Session footer");
    expect(footer).toHaveTextContent("~/");
    expect(footer.textContent).not.toContain("main");
    expect(footer.textContent).not.toContain("+4/-1");
  });
});

// T2 (S3/S4/S11) — the workspace pane: a selected workspace directory is
// always a pane with a chat. Its most recent session reopens when pi has
// one; otherwise a new chat is created for the directory through
// workspace.open — the creation path itself, never the picker, never a
// duplicated host lifecycle.
describe("ConversationContainer workspace pane (T2)", () => {
  const OLDER = { ...EXISTING_CHAT, id: "chat-older", title: "Older", cwd: "/tmp/project", updatedAt: "2026-09-21T09:00:00.000Z" };
  const NEWEST = { ...EXISTING_CHAT, id: "chat-newest", title: "Newest", cwd: "/tmp/project", updatedAt: "2026-09-21T11:00:00.000Z" };
  const ELSEWHERE = { ...EXISTING_CHAT, id: "chat-elsewhere", title: "Elsewhere", cwd: "/tmp/other", updatedAt: "2026-09-21T12:00:00.000Z" };

  it("opens a fresh workspace directly without discovering or automatically resuming history", async () => {
    const bridge = makeBridge({ listChats: vi.fn().mockResolvedValue([OLDER, ELSEWHERE, NEWEST]) });
    window.gentle = bridge;

    render(<ConversationContainer activeChat={{ kind: "workspace", directory: "/tmp/project" }} />);

    await vi.waitFor(() => expect(bridge.openWorkspace).toHaveBeenCalledWith("/tmp/project"));
    expect(bridge.newChat).not.toHaveBeenCalled();
    expect(bridge.openChat).not.toHaveBeenCalled();
    expect(bridge.listChats).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "project" })).toBeInTheDocument();
  });

  it("creates a chat for a workspace with no session through workspace.open — no picker, no duplicated lifecycle", async () => {
    const bridge = makeBridge({
      listChats: vi.fn().mockResolvedValue([]),
      openWorkspace: vi.fn().mockResolvedValue({ hostId: "host-9", state: { ...emptyState(), workspacePath: "/tmp/fresh-ws" } }),
    });
    window.gentle = bridge;

    render(<ConversationContainer activeChat={{ kind: "workspace", directory: "/tmp/fresh-ws" }} />);

    await vi.waitFor(() => expect(bridge.openWorkspace).toHaveBeenCalledWith("/tmp/fresh-ws"));
    expect(bridge.openChat).not.toHaveBeenCalled();
    expect(bridge.newChat).not.toHaveBeenCalled();
    // The pane knows its directory even before any pushed state carries it.
    expect(screen.getByRole("heading", { name: "fresh-ws" })).toBeInTheDocument();
  });

  it("surfaces a workspace that cannot be opened instead of pretending a chat opened", async () => {
    const bridge = makeBridge({
      listChats: vi.fn().mockResolvedValue([]),
      openWorkspace: vi.fn().mockRejectedValue(new Error("cannot start the child")),
    });
    window.gentle = bridge;

    render(<ConversationContainer activeChat={{ kind: "workspace", directory: "/tmp/fresh-ws" }} />);

    expect(await screen.findByRole("status")).toHaveTextContent(/cannot start the child/);
  });

  it("resolves nothing for kind none — no chat, no host, no request", async () => {
    const bridge = makeBridge();
    window.gentle = bridge;

    render(<ConversationContainer activeChat={{ kind: "none" }} />);
    await act(async () => {});

    expect(bridge.openChat).not.toHaveBeenCalled();
    expect(bridge.newChat).not.toHaveBeenCalled();
    expect(bridge.openWorkspace).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// T9 (S19/S20): the command palette lives in the container, which owns
// chatState.commands and the host id. Ctrl/Cmd+K toggles it; running a wire
// command sends "/name" to the active host; the app /resume entry opens the
// resume dialog; the old chat-search dialog is gone.
// ---------------------------------------------------------------------------

describe("ConversationContainer command palette (T9, palette-host-catalog T2)", () => {
  const PALETTE_STATE = {
    ...emptyState(),
    commands: [
      { name: "plan", description: "Make a plan", runnable: false, source: "prompt" as const },
      { name: "skill:review", runnable: false, source: "skill" as const },
      { name: "new", description: "Start a new session", runnable: true, source: "builtin" as const },
      { name: "resume", description: "Resume another session", runnable: true, source: "builtin" as const },
      { name: "compact", description: "Manually compact the session context", runnable: true, source: "builtin" as const },
      { name: "fork", description: "Fork from a previous message", runnable: false, source: "builtin" as const },
    ],
  };

  async function renderWithPalette(activeChat: ActiveChat = NEW_CHAT, overrides: Partial<Parameters<typeof makeBridge>[0]> = {}) {
    window.gentle = makeBridge({
      newChat: vi.fn().mockResolvedValue({ hostId: "host-1", state: PALETTE_STATE }),
      ...overrides,
    });
    render(<ConversationContainer activeChat={activeChat} />);
    await act(async () => {});
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    return screen.getByRole("dialog", { name: "Commands" });
  }

  it("opens the palette with Ctrl+K and closes it with Escape", async () => {
    window.gentle = makeBridge();
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});
    expect(screen.queryByRole("dialog", { name: "Commands" })).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "Commands" })).toBeInTheDocument();

    fireEvent.keyDown(
      within(screen.getByRole("dialog", { name: "Commands" })).getByRole("combobox"),
      { key: "Escape" },
    );
    expect(screen.queryByRole("dialog", { name: "Commands" })).not.toBeInTheDocument();
  });

  it("opens the palette with Cmd+K (metaKey) as well — R2-005: the dispatch must really be the meta key", async () => {
    window.gentle = makeBridge();
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(screen.getByRole("dialog", { name: "Commands" })).toBeInTheDocument();
  });

  it("refuses to open or toggle the palette through Ctrl/Cmd+K while a modal dialog is open (modalOpen)", async () => {
    window.gentle = makeBridge();
    render(<ConversationContainer activeChat={NEW_CHAT} modalOpen />);
    await act(async () => {});

    // Assert between the presses: without the guard the first press opens
    // the palette and the second would merely toggle it closed again.
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(screen.queryByRole("dialog", { name: "Commands" })).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "k", metaKey: true });

    // No second aria-modal palette stacked over the app's own dialog.
    expect(screen.queryByRole("dialog", { name: "Commands" })).not.toBeInTheDocument();
  });

  it("clears a previous refusal when a later palette command is dispatched (R4-001)", async () => {
    const bridge = makeBridge({
      newChat: vi.fn().mockResolvedValue({ hostId: "host-1", state: PALETTE_STATE }),
      sendMessage: vi.fn()
        .mockResolvedValueOnce({ queued: false, reason: "The child refused the prompt" })
        .mockResolvedValueOnce({ queued: true }),
    });
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});

    // The first run is refused; its reason surfaces in the status line.
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    fireEvent.keyDown(within(screen.getByRole("dialog", { name: "Commands" })).getByRole("combobox"), { key: "Enter" });
    expect(await screen.findByRole("status")).toHaveTextContent("The child refused the prompt");

    // The next run is dispatched: the stale refusal is cleared at that moment, and
    // its own settlement can only set the line, never clear it.
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    fireEvent.keyDown(within(screen.getByRole("dialog", { name: "Commands" })).getByRole("combobox"), { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  // R4-001: the clearing belongs to the dispatch, not to a settlement. An
  // acceptance that resolves after a NEWER refusal must leave that refusal on
  // screen: it is the last thing the child said about the command catalog.
  it("never lets a late acceptance erase a newer refusal (R4-001)", async () => {
    let resolveFirst!: (value: { queued: boolean }) => void;
    const bridge = makeBridge({
      newChat: vi.fn().mockResolvedValue({ hostId: "host-1", state: PALETTE_STATE }),
      sendMessage: vi.fn()
        .mockImplementationOnce(() => new Promise<{ queued: boolean }>((resolve) => { resolveFirst = resolve; }))
        .mockResolvedValueOnce({ queued: false, reason: "The newer command was refused" }),
    });
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    fireEvent.keyDown(within(screen.getByRole("dialog", { name: "Commands" })).getByRole("combobox"), { key: "Enter" });
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    fireEvent.keyDown(within(screen.getByRole("dialog", { name: "Commands" })).getByRole("combobox"), { key: "Enter" });
    expect(await screen.findByRole("status")).toHaveTextContent("The newer command was refused");

    await act(async () => { resolveFirst({ queued: true }); });

    expect(screen.getByRole("status")).toHaveTextContent("The newer command was refused");
  });

  // The mirror case: the OLDER run resolving refused after the newer one
  // was accepted must leave the status line empty — a stale refusal is
  // ignored, because only the newest run settles the line (R4-001).
  it("never lets a stale refusal erase a newer acceptance (R4-001)", async () => {
    let resolveFirst!: (value: { queued: boolean; reason?: string }) => void;
    const bridge = makeBridge({
      newChat: vi.fn().mockResolvedValue({ hostId: "host-1", state: PALETTE_STATE }),
      sendMessage: vi.fn()
        .mockImplementationOnce(() => new Promise<{ queued: boolean; reason?: string }>((resolve) => { resolveFirst = resolve; }))
        .mockResolvedValueOnce({ queued: true }),
    });
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    fireEvent.keyDown(within(screen.getByRole("dialog", { name: "Commands" })).getByRole("combobox"), { key: "Enter" });
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    fireEvent.keyDown(within(screen.getByRole("dialog", { name: "Commands" })).getByRole("combobox"), { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());

    // The older run's refusal arrives late: it must not set the line the
    // newer acceptance already cleared.
    await act(async () => { resolveFirst({ queued: false, reason: "The stale command was refused" }); });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("never sends a palette command to an empty host — it dismisses the palette instead (R3-004)", async () => {
    let closed!: (id: string) => void;
    const bridge = makeBridge({
      newChat: vi.fn().mockResolvedValue({ hostId: "host-1", state: PALETTE_STATE }),
      onClosed: vi.fn((sink) => { closed = sink; return () => {}; }),
    });
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});
    // The host closes under the open pane: the address becomes the empty
    // string while the command catalog is still painted.
    await act(async () => { closed("host-1"); });
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    fireEvent.keyDown(within(screen.getByRole("dialog", { name: "Commands" })).getByRole("combobox"), { key: "Enter" });

    expect(bridge.sendMessage).not.toHaveBeenCalled();
    // The launcher goes away rather than lingering as a modal that silently
    // ignores its input — and the reason is named, so the click never looks
    // like it ran something against a host that is gone.
    expect(screen.queryByRole("dialog", { name: "Commands" })).not.toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent("Open a chat before running /plan.");
  });

  // palette-host-catalog S3: the row's execution is decided by the wire's
  // `runnable` verdict and `source` — never by a client-side name list.
  // The session-replacement reflection was withdrawn: the catalog's
  // runnable /new row routes through the desktop's OWN new-chat path —
  // the same bridge.newChat() resolution the app's "New chat" action
  // uses — never through a `run_command` that replaces the session
  // in-child. The pane adopts the fresh chat's resolution like the
  // open/new effect does: empty messages, the reported host addressed.
  it("routes the catalog's runnable /new row through the bridge's new-chat path (the reflection is withdrawn)", async () => {
    const bridge = makeBridge({
      openChat: vi.fn().mockResolvedValue({ hostId: "host-1", state: PALETTE_STATE }),
      newChat: vi.fn().mockResolvedValue({ hostId: "host-2", state: emptyState() }),
      sendMessage: vi.fn().mockResolvedValue({ queued: true }),
    });
    window.gentle = bridge;
    render(<ConversationContainer activeChat={{ kind: "existing", chat: EXISTING_CHAT }} />);
    await act(async () => {});
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const palette = screen.getByRole("dialog", { name: "Commands" });
    // The builtin row comes from the host catalog (no app group any more);
    // filter to it and run it.
    expect(within(palette).getByRole("option", { name: /^\/new/ })).toBeInTheDocument();
    fireEvent.change(within(palette).getByRole("combobox"), { target: { value: "new" } });
    fireEvent.keyDown(within(palette).getByRole("combobox"), { key: "Enter" });

    expect(bridge.newChat).toHaveBeenCalledExactlyOnceWith();
    expect(bridge.runCommand).not.toHaveBeenCalled();
    expect(bridge.sendMessage).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Commands" })).not.toBeInTheDocument();
  });

  it("offers only what the host catalog carries — nothing invented for an empty catalog (S3)", async () => {
    window.gentle = makeBridge({
      newChat: vi.fn().mockResolvedValue({ hostId: "host-1", state: { ...emptyState(), commands: [] } }),
    });
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });

    expect(within(screen.getByRole("dialog", { name: "Commands" })).queryByRole("option", { name: /^\/new/ })).not.toBeInTheDocument();
  });

  it("shows a terminal-only builtin row, dispatches nothing, and says why in the status line (S3)", async () => {
    const bridge = makeBridge({
      newChat: vi.fn().mockResolvedValue({ hostId: "host-1", state: PALETTE_STATE }),
      sendMessage: vi.fn().mockResolvedValue({ queued: true }),
      runCommand: vi.fn().mockResolvedValue({ kind: "executed" }),
    });
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const palette = screen.getByRole("dialog", { name: "Commands" });
    fireEvent.change(within(palette).getByRole("combobox"), { target: { value: "fork" } });
    fireEvent.keyDown(within(palette).getByRole("combobox"), { key: "Enter" });

    expect(bridge.runCommand).not.toHaveBeenCalled();
    expect(bridge.sendMessage).not.toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "/fork runs only in pi's terminal UI — the desktop cannot dispatch it.",
    );
  });

  it("runs a non-runnable extension row as '/name' to the active host — the proven prompt path (S3)", async () => {
    const bridge = makeBridge({
      newChat: vi.fn().mockResolvedValue({ hostId: "host-1", state: PALETTE_STATE }),
      sendMessage: vi.fn().mockResolvedValue({ queued: true }),
    });
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const palette = screen.getByRole("dialog", { name: "Commands" });

    // The prompt group leads, so /plan is the row selected on open.
    fireEvent.keyDown(within(palette).getByRole("combobox"), { key: "Enter" });

    expect(bridge.sendMessage).toHaveBeenCalledExactlyOnceWith("host-1", "/plan");
    expect(bridge.runCommand).not.toHaveBeenCalled();
    // Running the command closes the palette again.
    expect(screen.queryByRole("dialog", { name: "Commands" })).not.toBeInTheDocument();
  });

  it("maps the host's refusal reasons into the status line (S4)", async () => {
    const bridge = makeBridge({
      newChat: vi.fn().mockResolvedValue({ hostId: "host-1", state: PALETTE_STATE }),
      runCommand: vi.fn()
        .mockResolvedValueOnce({ kind: "refused", reason: "terminal_only" })
        .mockResolvedValueOnce({ kind: "refused", reason: "unknown_command" }),
    });
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});

    // /new routes through the desktop's own new-chat path now; /compact is
    // a dispatched row, so its refusals still name their reasons.
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const palette = screen.getByRole("dialog", { name: "Commands" });
    fireEvent.change(within(palette).getByRole("combobox"), { target: { value: "compact" } });
    // T4 (palette-command-arguments S5): the wording no longer claims the
    // host runs the dispatched command in its terminal UI — the desktop
    // simply cannot dispatch it.
    fireEvent.keyDown(within(palette).getByRole("combobox"), { key: "Enter" });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "The host cannot dispatch /compact from the desktop.",
    );
    expect(screen.getByRole("status")).not.toHaveTextContent("terminal UI");

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const palette2 = screen.getByRole("dialog", { name: "Commands" });
    fireEvent.change(within(palette2).getByRole("combobox"), { target: { value: "compact" } });
    fireEvent.keyDown(within(palette2).getByRole("combobox"), { key: "Enter" });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "The host reports no /compact command.",
    );
  });

  it("reports session_switching as retryable and never as executed (S4)", async () => {
    const bridge = makeBridge({
      newChat: vi.fn().mockResolvedValue({ hostId: "host-1", state: PALETTE_STATE }),
      runCommand: vi.fn().mockResolvedValue({ kind: "session_switching" }),
    });
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});

    // A prior refusal is on the line; the switching answer must REPLACE it,
    // not be swallowed by it, and must not clear the line as if it ran.
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const palette = screen.getByRole("dialog", { name: "Commands" });
    fireEvent.change(within(palette).getByRole("combobox"), { target: { value: "compact" } });
    fireEvent.keyDown(within(palette).getByRole("combobox"), { key: "Enter" });
    expect(await screen.findByRole("status")).toHaveTextContent(/switching sessions/);
    expect(screen.getByRole("status")).toHaveTextContent(/retry/i);
    expect(screen.getByRole("status")).not.toHaveTextContent("executed");
  });

  it("surfaces a transport failure's message instead of throwing or dropping it (S4)", async () => {
    const bridge = makeBridge({
      newChat: vi.fn().mockResolvedValue({ hostId: "host-1", state: PALETTE_STATE }),
      runCommand: vi.fn().mockResolvedValue({ kind: "transport", message: "The child exited before answering" }),
    });
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const palette = screen.getByRole("dialog", { name: "Commands" });
    fireEvent.change(within(palette).getByRole("combobox"), { target: { value: "compact" } });
    fireEvent.keyDown(within(palette).getByRole("combobox"), { key: "Enter" });

    expect(await screen.findByRole("status")).toHaveTextContent("The child exited before answering");
  });

  it("an executed answer clears the status line (S4)", async () => {
    // The prior line is a refusal from an earlier run (a bridgeError, the
    // line the container owns): the executed answer clears exactly that.
    const bridge = makeBridge({
      newChat: vi.fn().mockResolvedValue({ hostId: "host-1", state: PALETTE_STATE }),
      runCommand: vi.fn()
        .mockResolvedValueOnce({ kind: "refused", reason: "unknown_command" })
        .mockResolvedValueOnce({ kind: "executed" }),
    });
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const palette = screen.getByRole("dialog", { name: "Commands" });
    fireEvent.change(within(palette).getByRole("combobox"), { target: { value: "compact" } });
    fireEvent.keyDown(within(palette).getByRole("combobox"), { key: "Enter" });
    expect(await screen.findByRole("status")).toHaveTextContent("The host reports no /compact command.");

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const palette2 = screen.getByRole("dialog", { name: "Commands" });
    fireEvent.change(within(palette2).getByRole("combobox"), { target: { value: "compact" } });
    fireEvent.keyDown(within(palette2).getByRole("combobox"), { key: "Enter" });

    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  // The desktop's own session paths (session-replacement-reflection,
  // withdrawn): the catalog's runnable /resume row keeps its picker, but
  // the chosen session now reopens through the bridge's chat-open path —
  // the SAME resolution the sidebar's selection uses — instead of handing
  // a session file path to `run_command` to replace the session in-child.
  it("opens the resume picker from the catalog's resume row and reopens the chosen session through the chat-open path", async () => {
    const bridge = makeBridge({
      openChat: vi.fn().mockResolvedValue({ hostId: "host-1", state: PALETTE_STATE }),
      listChats: vi.fn().mockResolvedValue([{ ...EXISTING_CHAT, path: "/tmp/project/sess-1.jsonl" }]),
    });
    window.gentle = bridge;
    render(<ConversationContainer activeChat={{ kind: "existing", chat: EXISTING_CHAT }} />);
    await act(async () => {});
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const palette = screen.getByRole("dialog", { name: "Commands" });
    expect(within(palette).getByRole("option", { name: /^\/resume/ })).toBeInTheDocument();
    fireEvent.change(within(palette).getByRole("combobox"), { target: { value: "resume" } });
    fireEvent.keyDown(within(palette).getByRole("combobox"), { key: "Enter" });

    const resumeDialog = await screen.findByRole("dialog", { name: "Resume a session" });
    expect(resumeDialog).toHaveTextContent("/tmp/project");
    expect(bridge.sendMessage).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Commands" })).not.toBeInTheDocument();

    // The picker's choice reopens the session through bridge.openChat —
    // the chat id, never a run_command dispatch (openChat's earlier call
    // is the pane's own open, before the picker).
    const openCalls = vi.mocked(bridge.openChat).mock.calls.length;
    fireEvent.click(await within(resumeDialog).findByRole("button", { name: /Refactor the store/ }));
    expect(vi.mocked(bridge.openChat).mock.calls.length).toBe(openCalls + 1);
    expect(vi.mocked(bridge.openChat).mock.lastCall).toEqual(["chat-1"]);
    expect(bridge.runCommand).not.toHaveBeenCalled();
  });

  // The reflection is withdrawn: the picker's choice reopens the session
  // through the REAL mock bridge's chat-open path — the stand-in that
  // models what the real host does — so the chosen session's transcript
  // must arrive in the pushed state and the previous session's must be
  // gone from it. A per-test fake bridge would pass trivially (the pane
  // renders whatever state the bridge resolves); the mock is the stand-in.
  it("reopening a session through the picker loads that session's transcript, and the previous session's rows are gone", async () => {
    stubHeroAnimations(1);
    resetMockBridge();
    setMockChats([
      { id: "chat-a", title: "Chat A", cwd: "/tmp/project", path: "/tmp/project/a.jsonl", updatedAt: "2026-09-21T09:00:00.000Z", messageCount: 2, state: CHAT_STATE.IDLE },
      { id: "chat-b", title: "Chat B", cwd: "/tmp/project", path: "/tmp/project/b.jsonl", updatedAt: "2026-09-21T10:00:00.000Z", messageCount: 2, state: CHAT_STATE.IDLE },
    ]);
    setMockChatMessages(
      new Map([
        ["chat-a", [
          { id: "a-1", role: MESSAGE_ROLE.USER, text: "Resumed A question" },
          { id: "a-2", role: MESSAGE_ROLE.ASSISTANT, text: "Resumed A answer", streaming: false },
        ]],
        ["chat-b", [
          { id: "b-1", role: MESSAGE_ROLE.USER, text: "Resumed B question" },
          { id: "b-2", role: MESSAGE_ROLE.ASSISTANT, text: "Resumed B answer", streaming: false },
        ]],
      ]),
    );
    window.gentle = mockBridge;
    render(<ConversationContainer activeChat={{ kind: "workspace", directory: "/tmp/project" }} />);
    await act(async () => {});

    const openResumePickerAndChoose = async (buttonName: RegExp): Promise<void> => {
      fireEvent.keyDown(document, { key: "k", ctrlKey: true });
      const palette = screen.getByRole("dialog", { name: "Commands" });
      fireEvent.change(within(palette).getByRole("combobox"), { target: { value: "resume" } });
      fireEvent.keyDown(within(palette).getByRole("combobox"), { key: "Enter" });
      const resumeDialog = await screen.findByRole("dialog", { name: "Resume a session" });
      fireEvent.click(await within(resumeDialog).findByRole("button", { name: buttonName }));
    };

    await openResumePickerAndChoose(/Chat A/);
    expect(await screen.findByText("Resumed A question")).toBeInTheDocument();
    expect(screen.getByText("Resumed A answer")).toBeInTheDocument();

    // Reopening another session swaps the pane to that session's own
    // transcript — the chat-open path loads it, and chat A's rows leave.
    await openResumePickerAndChoose(/Chat B/);
    expect(await screen.findByText("Resumed B question")).toBeInTheDocument();
    expect(screen.getByText("Resumed B answer")).toBeInTheDocument();
    expect(screen.queryByText("Resumed A question")).not.toBeInTheDocument();
    expect(screen.queryByText("Resumed A answer")).not.toBeInTheDocument();
  });

  it("leaves the removed Search chats dialog gone when Ctrl+K opens the palette", async () => {
    await renderWithPalette();
    expect(screen.queryByRole("searchbox", { name: "Search chats" })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// T3/T4 (palette-command-arguments S1–S6): the three argument screens and the
// NAME-keyed routing. The state below carries the host's REAL builtin
// entries exactly as parseCommandCatalog folds them (gentle-pi
// lib/desktop-feed.ts DESKTOP_FEED_BUILTIN_COMMANDS): `args: null` is the
// wire's "absent", so /model and /thinking carry NO args — the value is
// chosen on their screens, never typed — and only /name declares
// "<name>". Routing keyed on `entry.args` left the model and thinking
// screens dead in the shipped app; these tests pin the real payload.
// ---------------------------------------------------------------------------

describe("ConversationContainer command argument screens (T3, palette-command-arguments)", () => {
  const ARGS_STATE = {
    ...emptyState(),
    session: { modelId: "claude-sonnet-4", modelProvider: "anthropic", thinkingLevel: "medium" as const, sessionName: "Old name" },
    commands: [
      { name: "new", description: "Start a new session", runnable: true, source: "builtin" as const },
      { name: "compact", description: "Manually compact the session context", runnable: true, source: "builtin" as const },
      { name: "model", description: "Select model (opens selector UI)", runnable: true, source: "builtin" as const },
      { name: "thinking", description: "Set thinking level", runnable: true, source: "builtin" as const },
      { name: "name", description: "Set session display name", runnable: true, source: "builtin" as const, args: "<name>" },
      // The contract guard, NOT a host row: today's real catalog has no
      // runnable row that declares args without a screen (name is the only
      // one and it has one). This fixture pins the honest branch so a future
      // args-declaring builtin without a screen says so instead of
      // dispatching half a command.
      { name: "needs-value-someday", description: "Contract guard: declares args, has no screen", runnable: true, source: "builtin" as const, args: "<value>" },
    ],
  };

  const REPORTED_MODELS = [
    { provider: "openai", id: "gpt-5", label: "GPT-5" },
    { provider: "anthropic", id: "claude-sonnet-4", label: "Claude Sonnet 4" },
  ];

  function argsBridge(overrides: Partial<GentleBridge> = {}): GentleBridge {
    return makeBridge({
      newChat: vi.fn().mockResolvedValue({ hostId: "host-1", state: ARGS_STATE }),
      availableModels: vi.fn().mockResolvedValue({ kind: "ok", truncated: false, models: REPORTED_MODELS }),
      availableThinkingLevels: vi.fn().mockResolvedValue({ kind: "ok", levels: ["off", "medium", "high"] }),
      runCommand: vi.fn().mockResolvedValue({ kind: "executed" }),
      ...overrides,
    });
  }

  /** Opens the palette and runs one catalog row by name. */
  async function runRow(name: string): Promise<void> {
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const palette = screen.getByRole("dialog", { name: "Commands" });
    fireEvent.change(within(palette).getByRole("combobox"), { target: { value: name } });
    fireEvent.keyDown(within(palette).getByRole("combobox"), { key: "Enter" });
  }

  it("the model row opens the selector with the current model first and dispatches the exact provider/id", async () => {
    const bridge = argsBridge();
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});
    await runRow("model");

    const dialog = await screen.findByRole("dialog", { name: "Choose a model" });
    const options = within(dialog).getAllByRole("option");
    expect(options[0]).toHaveTextContent("Claude Sonnet 4");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveTextContent("GPT-5");
    expect(bridge.availableModels).toHaveBeenCalledWith("host-1");
    // The real catalog row carries NO args (the wire's null is dropped), so
    // nothing may claim the host cannot dispatch this name from the desktop.
    expect(screen.queryByText(/cannot dispatch/)).not.toBeInTheDocument();
    expect(bridge.runCommand).not.toHaveBeenCalled();

    fireEvent.keyDown(within(dialog).getByRole("combobox"), { key: "Enter" });
    expect(bridge.runCommand).toHaveBeenCalledExactlyOnceWith("host-1", "model", "anthropic/claude-sonnet-4");
    expect(bridge.sendMessage).not.toHaveBeenCalled();
  });

  // Separately discovered defect: with an argument screen mounted, its
  // window-level Enter claim also fired for Enter typed in the Ctrl+K
  // palette's filter over it, dispatching the mounted screen instead of
  // running the palette row. A surface may claim keys only while it is the
  // topmost open one — the palette takes precedence while it is open.
  it("the palette over a mounted screen runs its row on Enter — the screen dispatches nothing while it is not topmost", async () => {
    const bridge = argsBridge();
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});
    await runRow("model");
    expect(await screen.findByRole("dialog", { name: "Choose a model" })).toBeInTheDocument();

    // Ctrl+K reopens the palette over the mounted screen; the user types a
    // different command and presses Enter in the palette's filter.
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const palette = screen.getByRole("dialog", { name: "Commands" });
    fireEvent.change(within(palette).getByRole("combobox"), { target: { value: "compact" } });
    fireEvent.keyDown(within(palette).getByRole("combobox"), { key: "Enter" });

    // The palette ran its row; the mounted screen dispatched nothing.
    expect(bridge.runCommand).toHaveBeenCalledExactlyOnceWith("host-1", "compact");
    expect(bridge.runCommand).not.toHaveBeenCalledWith("host-1", "model", expect.anything());
    // And the run of another command clears the mounted screen (R3-003).
    expect(screen.queryByRole("dialog", { name: "Choose a model" })).not.toBeInTheDocument();
  });

  it("the model selector's filter narrows the list before dispatching", async () => {
    const bridge = argsBridge();
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});
    await runRow("model");

    const dialog = await screen.findByRole("dialog", { name: "Choose a model" });
    const input = within(dialog).getByRole("combobox", { name: "Filter models" });
    fireEvent.change(input, { target: { value: "gpt" } });
    const options = within(dialog).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("GPT-5");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(bridge.runCommand).toHaveBeenCalledExactlyOnceWith("host-1", "model", "openai/gpt-5");
  });

  it("Escape on the model screen dispatches nothing", async () => {
    const bridge = argsBridge();
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});
    await runRow("model");

    const dialog = await screen.findByRole("dialog", { name: "Choose a model" });
    fireEvent.keyDown(within(dialog).getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Choose a model" })).not.toBeInTheDocument();
    expect(bridge.runCommand).not.toHaveBeenCalled();
  });

  it("the thinking row dispatches the chosen level as args", async () => {
    const bridge = argsBridge();
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});
    await runRow("thinking");

    const dialog = await screen.findByRole("dialog", { name: "Choose a thinking level" });
    // The real catalog row carries NO args: the screen opens instead of a
    // valueless dispatch that would earn the host's refusal.
    expect(screen.queryByText(/cannot dispatch/)).not.toBeInTheDocument();
    expect(bridge.runCommand).not.toHaveBeenCalled();
    const medium = within(dialog).getByRole("option", { name: "medium" });
    expect(medium).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(medium, { key: "ArrowDown" });
    const high = within(dialog).getByRole("option", { name: "high" });
    expect(high).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(high, { key: "Enter" });
    expect(bridge.runCommand).toHaveBeenCalledExactlyOnceWith("host-1", "thinking", "high");
  });

  it("the name row prefills the session name, refuses empty, and dispatches the typed text", async () => {
    const bridge = argsBridge();
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});
    await runRow("name");

    const dialog = await screen.findByRole("dialog", { name: "Name this session" });
    const input = within(dialog).getByRole("textbox", { name: "Session name" });
    expect(input).toHaveValue("Old name");

    // The host rejects an empty name, so the screen refuses it too.
    fireEvent.change(input, { target: { value: "   " } });
    expect(within(dialog).getByRole("button", { name: "Save name" })).toBeDisabled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(bridge.runCommand).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "  New name  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(bridge.runCommand).toHaveBeenCalledExactlyOnceWith("host-1", "name", "New name");
  });

  it("a runnable row that declares args but has no screen dispatches nothing and says why (contract guard)", async () => {
    const bridge = argsBridge();
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});
    await runRow("needs-value-someday");

    expect(await screen.findByRole("status")).toHaveTextContent(
      "/needs-value-someday needs an argument (<value>) — this app has no screen for it, so nothing was dispatched.",
    );
    expect(bridge.runCommand).not.toHaveBeenCalled();
    expect(bridge.sendMessage).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("an unsupported model list degrades to the typed input with the right source label, and its text dispatches as args", async () => {
    const bridge = argsBridge({
      availableModels: vi.fn().mockResolvedValue({ kind: "unsupported" }),
    });
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});
    await runRow("model");

    const dialog = await screen.findByRole("dialog", { name: "Choose a model" });
    expect(dialog).toHaveTextContent("did not report its available models");
    expect(within(dialog).queryByRole("option")).not.toBeInTheDocument();
    const input = within(dialog).getByRole("textbox", { name: "Model" });
    fireEvent.change(input, { target: { value: "openai/gpt-5" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(bridge.runCommand).toHaveBeenCalledExactlyOnceWith("host-1", "model", "openai/gpt-5");
  });

  it("a truncated model list says it is truncated", async () => {
    const bridge = argsBridge({
      availableModels: vi.fn().mockResolvedValue({ kind: "ok", truncated: true, models: REPORTED_MODELS }),
    });
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});
    await runRow("model");

    expect(await screen.findByText(/truncated/)).toBeInTheDocument();
  });

  it("an unsupported thinking list falls back to the app's closed union and says so", async () => {
    const bridge = argsBridge({
      availableThinkingLevels: vi.fn().mockResolvedValue({ kind: "unsupported" }),
    });
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});
    await runRow("thinking");

    const dialog = await screen.findByRole("dialog", { name: "Choose a thinking level" });
    expect(dialog).toHaveTextContent("did not report its thinking levels");
    // The full closed union the app already types — including a level the
    // child's own list in the happy-path test did not carry.
    expect(within(dialog).getByRole("option", { name: "xhigh" })).toBeInTheDocument();
    const medium = within(dialog).getByRole("option", { name: "medium" });
    expect(medium).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(medium, { key: "Enter" });
    expect(bridge.runCommand).toHaveBeenCalledExactlyOnceWith("host-1", "thinking", "medium");
  });

  // The desktop's own session paths (session-replacement-reflection,
  // withdrawn): the runnable /new row routes through the bridge's new-chat
  // path — the same resolution the app's "New chat" action uses — never
  // through a `run_command` that replaces the session in-child.
  it("the /new row routes through the bridge's new-chat path, not run_command", async () => {
    const bridge = argsBridge();
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});
    await runRow("new");

    expect(bridge.newChat).toHaveBeenCalledTimes(2); // the pane's own open, then the row
    expect(bridge.runCommand).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  // R3-001 (U4 review): the screen table is keyed by NAME, and a lookup on
  // a plain object inherits Object.prototype — a runnable command named
  // `toString` passed the lookup and silently did nothing (no screen, no
  // dispatch). The lookup must be an own-property one, so such a row
  // dispatches like any other screenless runnable.
  it("a runnable builtin whose name is an inherited Object.prototype member still dispatches (R3-001)", async () => {
    const bridge = argsBridge({
      newChat: vi.fn().mockResolvedValue({
        hostId: "host-1",
        state: {
          ...ARGS_STATE,
          commands: [{ name: "toString", description: "A name the prototype chain knows", runnable: true, source: "builtin" as const }],
        },
      }),
    });
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});
    await runRow("toString");

    // No screen exists for it and it declares no args: the row dispatches.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(bridge.runCommand).toHaveBeenCalledExactlyOnceWith("host-1", "toString");
  });

  // R3-003 (U4 review): a mounted screen belongs to the command it was
  // opened for. Running ANY other command clears it first, so a later
  // command can never overlap the screen or leave it orphaned over a chat
  // the user has already moved away from.
  it("running another command while a screen is mounted clears the screen first — no orphaned dialog (R3-003)", async () => {
    const bridge = argsBridge();
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});
    await runRow("model");
    expect(await screen.findByRole("dialog", { name: "Choose a model" })).toBeInTheDocument();

    // The palette reopens over the mounted screen (Ctrl+K is not one of the
    // screen's claimed keys) and the user runs /new: the fresh chat must
    // not leave the model screen behind it. The row is CLICKED, not
    // Enter'd — while the palette is open over the screen it holds the
    // keys (topmost surface), so Enter would run the palette's highlighted
    // row, not the screen behind it.
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const palette = screen.getByRole("dialog", { name: "Commands" });
    fireEvent.change(within(palette).getByRole("combobox"), { target: { value: "new" } });
    fireEvent.click(within(palette).getByRole("option", { name: /new/i }));

    expect(bridge.newChat).toHaveBeenCalledTimes(2); // the pane's own open, then the row
    expect(screen.queryByRole("dialog", { name: "Choose a model" })).not.toBeInTheDocument();
  });

  // R4-001 (U4 review): the screen is the chosen value's home. It stays
  // mounted through the dispatch, so a retryable `session_switching`
  // answer costs the user nothing — the value is still there and one Enter
  // retries, with no re-entry through the palette and the list.
  it("a retryable session_switching result keeps the model screen and its chosen value — a retry needs no re-entry (R4-001)", async () => {
    const settles: Array<(result: unknown) => void> = [];
    const bridge = argsBridge({
      runCommand: vi.fn().mockImplementation(() => new Promise((resolve) => settles.push(resolve as (result: unknown) => void))),
    });
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});
    await runRow("model");
    const dialog = await screen.findByRole("dialog", { name: "Choose a model" });

    // The chosen value dispatches; the answer is not known yet.
    fireEvent.keyDown(within(dialog).getByRole("combobox"), { key: "Enter" });
    expect(bridge.runCommand).toHaveBeenCalledTimes(1);
    // The screen STAYS while the result is pending — closing it before the
    // answer is known would throw the chosen value away.
    expect(screen.getByRole("dialog", { name: "Choose a model" })).toBeInTheDocument();

    settles[0]?.({ kind: "session_switching" });
    await act(async () => {});
    // The retryable answer keeps the screen open and names the retry.
    expect(screen.getByRole("dialog", { name: "Choose a model" })).toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent(/switching sessions/);

    // One Enter retries the SAME value — the screen never lost it.
    fireEvent.keyDown(within(screen.getByRole("dialog", { name: "Choose a model" })).getByRole("combobox"), { key: "Enter" });
    expect(bridge.runCommand).toHaveBeenCalledTimes(2);
    expect(bridge.runCommand).toHaveBeenLastCalledWith("host-1", "model", "anthropic/claude-sonnet-4");
  });

  // Preserved behavior the R4-001 change touches: the screen's dispatch
  // ending EXECUTED is the screen's whole job done, so it still closes —
  // now on the answer, instead of synchronously at confirm time.
  it("the model screen still closes once its dispatch executes (preserved)", async () => {
    const bridge = argsBridge({ runCommand: vi.fn().mockResolvedValue({ kind: "executed" }) });
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});
    await runRow("model");
    const dialog = await screen.findByRole("dialog", { name: "Choose a model" });

    fireEvent.keyDown(within(dialog).getByRole("combobox"), { key: "Enter" });
    expect(bridge.runCommand).toHaveBeenCalledExactlyOnceWith("host-1", "model", "anthropic/claude-sonnet-4");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose a model" })).not.toBeInTheDocument());
  });

  // The real /compact row: runnable with `args: null` on the wire — like
  // /new, it dispatches at once and no screen is invented for it.
  it("the real /compact row (args absent on the wire) dispatches immediately with no value", async () => {
    const bridge = argsBridge();
    window.gentle = bridge;
    render(<ConversationContainer activeChat={NEW_CHAT} />);
    await act(async () => {});
    await runRow("compact");

    expect(bridge.runCommand).toHaveBeenCalledExactlyOnceWith("host-1", "compact");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
