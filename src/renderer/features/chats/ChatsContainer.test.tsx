// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { CHAT_STATE, type ChatState, type ChatSummary, type GentleBridge, type WorkspaceList } from "@shared/bridge-types";
import { ChatsContainer } from "./ChatsContainer";

function makeBridge(overrides: Partial<GentleBridge> = {}): GentleBridge {
  return {
    listChats: vi.fn().mockResolvedValue([]),
    openChat: vi.fn(),
    newChat: vi.fn(),
    sendMessage: vi.fn(),
    abort: vi.fn(),
    answerDialog: vi.fn(),
    onState: vi.fn(),
    onError: vi.fn(),
    setupStatus: vi.fn().mockResolvedValue({ needsChoice: false, detection: { found: false, dir: "", hasAuth: false, hasModels: false } }),
    chooseHome: vi.fn(),
    ...overrides,
  };
}

function makeChat(overrides: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id: "chat-1",
    title: "A chat",
    cwd: "/tmp/project",
    updatedAt: "2026-09-21T09:00:00.000Z",
    messageCount: 1,
    state: CHAT_STATE.IDLE,
    ...overrides,
  };
}

// S8: the sidebar shows chats as workspaces, so the panel's heading is the
// artboard's directory-panel heading — accessible name exactly "Workspaces"
// (the accent dot stays aria-hidden).
it("names the panel heading Workspaces", async () => {
  window.gentle = makeBridge();
  render(<ChatsContainer onSelectChat={vi.fn()} onNewChat={vi.fn()} />);
  expect(await screen.findByRole("heading", { name: "Workspaces" })).toBeInTheDocument();
});

// S12: adding a workspace is a "+" at the far right of the "Workspaces"
// heading row, not a separate full-width button, and a rule separates that row
// from the workspace list.
it("puts an icon-only add control at the end of the Workspaces heading row, above a rule and the list", async () => {
  window.gentle = makeBridge();
  render(<ChatsContainer onSelectChat={vi.fn()} onNewChat={vi.fn()} onWorkspaceCreated={vi.fn()} workspaces={{ directories: ["/tmp/open"], persisted: ["/tmp/open"] }} />);

  const heading = await screen.findByRole("heading", { name: "Workspaces" });
  const add = screen.getByRole("button", { name: "Add workspace" });
  // Icon-only: the visible content is the glyph, the name comes from the label.
  expect(add.textContent?.trim()).toBe("");
  expect(heading.parentElement).toContainElement(add);

  const rule = document.querySelector(".gc-chats__divider");
  expect(rule).not.toBeNull();
  const list = screen.getByRole("list", { name: "Workspace directories" });
  expect(heading.compareDocumentPosition(rule!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(rule!.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("never discovers history or resurrects closed rows through a flat fallback or remainder", async () => {
  const bridge = makeBridge({ listChats: vi.fn().mockResolvedValue([makeChat({ title: "Closed history" }), makeChat({ id: "orphan", cwd: "", title: "Orphan history" })]) });
  window.gentle = bridge;
  const props = { onSelectChat: vi.fn(), onNewChat: vi.fn() };
  const view = render(<ChatsContainer {...props} workspaces={{ directories: ["/tmp/open"], persisted: ["/tmp/open"] }} />);
  await act(async () => {});
  expect(screen.queryByRole("button", { name: /Closed history|Orphan history/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "open — workspace" })).toBeInTheDocument();
  view.rerender(<ChatsContainer {...props} />);
  await act(async () => {});
  expect(screen.queryByRole("button", { name: /Closed history|Orphan history/ })).not.toBeInTheDocument();
  expect(bridge.listChats).not.toHaveBeenCalled();
});

it("calls onNewChat through Ctrl+N without a visible New chat button", async () => {
  window.gentle = makeBridge();
  const onNewChat = vi.fn();

  render(<ChatsContainer onSelectChat={vi.fn()} onNewChat={onNewChat} />);
  expect(screen.queryByRole("button", { name: "New chat" })).not.toBeInTheDocument();
  fireEvent.keyDown(window, { key: "n", ctrlKey: true });

  expect(onNewChat).toHaveBeenCalled();
});

it.each(["ALPH", "/tmp/alpha", "   ", "zzz"])("filters opened directory rows for query %s without consulting chat titles", async (query) => {
  const bridge = makeBridge({ listChats: vi.fn().mockResolvedValue([makeChat({ title: "Secret title" })]) });
  window.gentle = bridge;
  render(<ChatsContainer onSelectChat={vi.fn()} onNewChat={vi.fn()} workspaces={{ directories: ["/tmp/alpha", "/tmp/beta"], persisted: ["/tmp/alpha", "/tmp/beta"] }} query={query} />);
  await act(async () => {});
  expect(screen.queryByRole("button", { name: "alpha — workspace" }) !== null).toBe(query !== "zzz");
  expect(screen.queryByRole("button", { name: "beta — workspace" }) !== null).toBe(query.trim() === "");
  if (query === "zzz") expect(screen.getByText('No workspaces match "zzz".')).toBeInTheDocument();
  expect(bridge.listChats).not.toHaveBeenCalled();
});

const EMPTY_STATE: ChatState = {
  messages: [],
  working: false,
  pendingDialogs: [],
  activity: 0,
  helpers: { summary: { running: 0, queued: 0, waiting: 0, finished: 0 }, tasks: [] },
};

// T1 (S1/S2) — the Workspaces panel rows: one row per workspace directory
// (persisted UNION pi-session directories), remove on persisted rows only,
// and the add/remove/select flows through the bridge.
describe("ChatsContainer workspace registry (T1)", () => {
  const SESSION_CHAT = makeChat({ id: "chat-1", title: "A chat", cwd: "/tmp/project" });
  const WORKSPACES: WorkspaceList = { directories: ["/tmp/added", "/tmp/project"], persisted: ["/tmp/added"] };

  it("renders one row per workspace directory — a persisted directory with no chat yet is still a row", async () => {
    window.gentle = makeBridge({ listChats: vi.fn().mockResolvedValue([SESSION_CHAT]) });

    render(
      <ChatsContainer onSelectChat={vi.fn()} onNewChat={vi.fn()} workspaces={WORKSPACES} />,
    );

    expect(await screen.findByRole("button", { name: "added — workspace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "project — workspace" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /A chat/ })).not.toBeInTheDocument();
  });

  it("offers closure on every opened directory row regardless of legacy persisted metadata", async () => {
    window.gentle = makeBridge({ listChats: vi.fn().mockResolvedValue([SESSION_CHAT]) });

    render(
      <ChatsContainer onSelectChat={vi.fn()} onNewChat={vi.fn()} workspaces={WORKSPACES} />,
    );

    expect(await screen.findByRole("button", { name: "Remove workspace added" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove workspace project" })).toBeInTheDocument();
  });

  it("remove deletes only the persisted entry: bridge.removeWorkspace with the directory, the fresh list reported up, no host touched", async () => {
    const fresh: WorkspaceList = { directories: ["/tmp/project"], persisted: [] };
    const removeWorkspace = vi.fn().mockResolvedValue(fresh);
    const closeChat = vi.fn();
    const onWorkspacesChanged = vi.fn();
    window.gentle = makeBridge({ removeWorkspace, closeChat });

    render(
      <ChatsContainer
        onSelectChat={vi.fn()}
        onNewChat={vi.fn()}
        workspaces={WORKSPACES}
        onWorkspacesChanged={onWorkspacesChanged}
      />,
    );
    (await screen.findByRole("button", { name: "Remove workspace added" })).click();

    await vi.waitFor(() => expect(removeWorkspace).toHaveBeenCalledWith("/tmp/added"));
    await vi.waitFor(() => expect(onWorkspacesChanged).toHaveBeenCalledWith(fresh));
    expect(closeChat).not.toHaveBeenCalled();
  });

  it("surfaces a failed remove beside the action instead of silently keeping the row", async () => {
    window.gentle = makeBridge({ removeWorkspace: vi.fn().mockRejectedValue(new Error("disk refused")) });

    render(
      <ChatsContainer
        onSelectChat={vi.fn()}
        onNewChat={vi.fn()}
        workspaces={WORKSPACES}
        onWorkspacesChanged={vi.fn()}
      />,
    );
    (await screen.findByRole("button", { name: "Remove workspace added" })).click();

    expect(await screen.findByRole("alert")).toHaveTextContent(/disk refused/);
  });

  it("selecting a workspace row reports the directory without ever opening the native picker", async () => {
    const chooseDirectory = vi.fn();
    const onSelectWorkspace = vi.fn();
    window.gentle = makeBridge({ chooseDirectory, listChats: vi.fn().mockResolvedValue([]) });

    render(
      <ChatsContainer
        onSelectChat={vi.fn()}
        onNewChat={vi.fn()}
        workspaces={WORKSPACES}
        onSelectWorkspace={onSelectWorkspace}
        onWorkspaceCreated={vi.fn()}
      />,
    );
    (await screen.findByRole("button", { name: "added — workspace" })).click();

    expect(onSelectWorkspace).toHaveBeenCalledWith("/tmp/added");
    expect(chooseDirectory).not.toHaveBeenCalled();
  });

  it("Add workspace persists the picked directory first, reports the fresh list, then opens its pane", async () => {
    const fresh: WorkspaceList = { directories: ["/tmp/new-ws"], persisted: ["/tmp/new-ws"] };
    const addWorkspace = vi.fn().mockResolvedValue(fresh);
    const chooseDirectory = vi.fn().mockResolvedValue("/tmp/new-ws");
    const createWorkspace = vi.fn().mockResolvedValue({ hostId: "host-1", state: EMPTY_STATE });
    const onWorkspacesChanged = vi.fn();
    const onWorkspaceCreated = vi.fn();
    window.gentle = makeBridge({ chooseDirectory, addWorkspace, createWorkspace });

    render(
      <ChatsContainer
        onSelectChat={vi.fn()}
        onNewChat={vi.fn()}
        onWorkspaceCreated={onWorkspaceCreated}
        workspaces={WORKSPACES}
        onWorkspacesChanged={onWorkspacesChanged}
      />,
    );
    (await screen.findByRole("button", { name: "Add workspace" })).click();

    await vi.waitFor(() => expect(createWorkspace).toHaveBeenCalledWith("/tmp/new-ws"));
    expect(addWorkspace).toHaveBeenCalledWith("/tmp/new-ws");
    await vi.waitFor(() => expect(onWorkspacesChanged).toHaveBeenCalledWith(fresh));
    await vi.waitFor(() => expect(onWorkspaceCreated).toHaveBeenCalledWith({ hostId: "host-1", state: EMPTY_STATE }));
  });
});

it("does not adopt a workspace created after the user moved on", async () => {
  let releaseCreate: (() => void) | undefined;
  const onWorkspaceCreated = vi.fn();
  const createWorkspace = vi.fn(
    () =>
      new Promise<{ hostId: string; state: ChatState }>((resolve) => {
        releaseCreate = () => resolve({ hostId: "host-1", state: EMPTY_STATE });
      }),
  );
  window.gentle = makeBridge({
    chooseDirectory: vi.fn().mockResolvedValue("/tmp/ws-late"),
    createWorkspace,
  });

  render(
    <ChatsContainer onSelectChat={vi.fn()} onNewChat={vi.fn()} onWorkspaceCreated={onWorkspaceCreated} />,
  );
  screen.getByRole("button", { name: "Add workspace" }).click();
  await vi.waitFor(() => expect(createWorkspace).toHaveBeenCalled());

  // The user changes their mind while the creation is still running: its
  // answer must not switch the pane back and strand the chat they picked.
  fireEvent.keyDown(window, { key: "n", ctrlKey: true });
  releaseCreate?.();
  await Promise.resolve();
  await Promise.resolve();

  expect(onWorkspaceCreated).not.toHaveBeenCalled();
});

it("ignores a second Add workspace click while one is in flight", async () => {
  const chooseDirectory = vi.fn(() => new Promise<string | null>(() => {}));
  const createWorkspace = vi.fn();
  window.gentle = makeBridge({ chooseDirectory, createWorkspace });

  render(<ChatsContainer onSelectChat={vi.fn()} onNewChat={vi.fn()} onWorkspaceCreated={vi.fn()} />);
  const button = screen.getByRole("button", { name: "Add workspace" });
  button.click();
  button.click();
  await vi.waitFor(() => expect(chooseDirectory).toHaveBeenCalledTimes(1));

  expect(chooseDirectory).toHaveBeenCalledTimes(1);
});

it("does not start a creation when the user moved on during the picker", async () => {
  let releasePick: ((directory: string | null) => void) | undefined;
  const chooseDirectory = vi.fn(
    () =>
      new Promise<string | null>((resolve) => {
        releasePick = resolve;
      }),
  );
  const createWorkspace = vi.fn();
  const onWorkspaceCreated = vi.fn();
  window.gentle = makeBridge({ chooseDirectory, createWorkspace });

  render(
    <ChatsContainer onSelectChat={vi.fn()} onNewChat={vi.fn()} onWorkspaceCreated={onWorkspaceCreated} />,
  );
  screen.getByRole("button", { name: "Add workspace" }).click();
  await vi.waitFor(() => expect(chooseDirectory).toHaveBeenCalled());

  // The user gave up on the picker and opened a new chat instead: the answer
  // that arrives afterwards must not start a child nobody asked for.
  fireEvent.keyDown(window, { key: "n", ctrlKey: true });
  releasePick?.("/tmp/ws-abandoned");
  await act(async () => {});

  expect(createWorkspace).not.toHaveBeenCalled();
  expect(onWorkspaceCreated).not.toHaveBeenCalled();
});

it("closes a workspace created after the user moved on instead of orphaning it", async () => {
  let releaseCreate: (() => void) | undefined;
  const closeChat = vi.fn().mockResolvedValue(undefined);
  const onWorkspaceCreated = vi.fn();
  const createWorkspace = vi.fn(
    () =>
      new Promise<{ hostId: string; state: ChatState }>((resolve) => {
        releaseCreate = () => resolve({ hostId: "host-late", state: EMPTY_STATE });
      }),
  );
  window.gentle = makeBridge({
    chooseDirectory: vi.fn().mockResolvedValue("/tmp/ws-orphan"),
    createWorkspace,
    closeChat,
  });

  render(
    <ChatsContainer onSelectChat={vi.fn()} onNewChat={vi.fn()} onWorkspaceCreated={onWorkspaceCreated} />,
  );
  screen.getByRole("button", { name: "Add workspace" }).click();
  await vi.waitFor(() => expect(createWorkspace).toHaveBeenCalled());

  fireEvent.keyDown(window, { key: "n", ctrlKey: true });
  releaseCreate?.();
  await act(async () => {});

  // Dropping the result would leave a live child nobody can reach: the same
  // orphan this flow exists to avoid, so it is closed instead.
  expect(onWorkspaceCreated).not.toHaveBeenCalled();
  expect(closeChat).toHaveBeenCalledWith("host-late");
});
