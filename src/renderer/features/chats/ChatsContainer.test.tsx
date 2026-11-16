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

it("shows a message when listChats rejects", async () => {
  window.gentle = makeBridge({ listChats: vi.fn().mockRejectedValue(new Error("bridge not ready")) });
  render(<ChatsContainer onSelectChat={vi.fn()} onNewChat={vi.fn()} />);
  expect(await screen.findByText("Chats are not available yet: bridge not ready")).toBeInTheDocument();
});

it("calls onNewChat through Ctrl+N without a visible New chat button", async () => {
  window.gentle = makeBridge();
  const onNewChat = vi.fn();

  render(<ChatsContainer onSelectChat={vi.fn()} onNewChat={onNewChat} />);
  expect(screen.queryByRole("button", { name: "New chat" })).not.toBeInTheDocument();
  fireEvent.keyDown(window, { key: "n", ctrlKey: true });

  expect(onNewChat).toHaveBeenCalled();
});

it("calls onSelectChat with the chat when a list item is clicked", async () => {
  const chat: ChatSummary = {
    id: "chat-1",
    title: "Refactor the store",
    cwd: "/tmp/project",
    updatedAt: "2026-09-21T09:00:00.000Z",
    messageCount: 3,
    state: CHAT_STATE.IDLE,
  };
  window.gentle = makeBridge({ listChats: vi.fn().mockResolvedValue([chat]) });
  const onSelectChat = vi.fn();

  render(<ChatsContainer onSelectChat={onSelectChat} onNewChat={vi.fn()} />);
  (await screen.findByRole("button", { name: /Refactor the store/ })).click();

  expect(onSelectChat).toHaveBeenCalledWith(chat);
});

it("renders a directory row without a state pill", async () => {
  const chat = makeChat({ id: "chat-1", title: "Alpha", cwd: "/tmp/project" });
  window.gentle = makeBridge({ listChats: vi.fn().mockResolvedValue([chat]) });

  render(<ChatsContainer onSelectChat={vi.fn()} onNewChat={vi.fn()} />);
  const row = await screen.findByRole("button", { name: /Alpha/ });

  expect(row).toHaveTextContent("project");
  expect(row).not.toHaveTextContent("idle");
});

it("renders no directory when the chat's cwd is empty", async () => {
  const chat = makeChat({ id: "chat-1", title: "Alpha", cwd: "" });
  window.gentle = makeBridge({ listChats: vi.fn().mockResolvedValue([chat]) });

  render(<ChatsContainer onSelectChat={vi.fn()} onNewChat={vi.fn()} />);
  const row = await screen.findByRole("button", { name: /Alpha/ });

  expect(row).not.toHaveTextContent("tmp");
  expect(row).toHaveTextContent("Alpha");
  expect(row).not.toHaveTextContent("idle");
});

it("filters chats by title, case-insensitively", async () => {
  const alpha = makeChat({ id: "a", title: "Alpha chat" });
  const beta = makeChat({ id: "b", title: "Beta chat" });
  window.gentle = makeBridge({ listChats: vi.fn().mockResolvedValue([alpha, beta]) });

  render(<ChatsContainer onSelectChat={vi.fn()} onNewChat={vi.fn()} query="ALPH" />);

  expect(await screen.findByRole("button", { name: /Alpha chat/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Beta chat/ })).not.toBeInTheDocument();
});

it("filters chats by their directory", async () => {
  const alpha = makeChat({ id: "a", title: "Alpha chat", cwd: "/home/dev/gentle-core" });
  const beta = makeChat({ id: "b", title: "Beta chat", cwd: "/home/dev/shell" });
  window.gentle = makeBridge({ listChats: vi.fn().mockResolvedValue([alpha, beta]) });

  render(<ChatsContainer onSelectChat={vi.fn()} onNewChat={vi.fn()} query="gentle-core" />);

  expect(await screen.findByRole("button", { name: /Alpha chat/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Beta chat/ })).not.toBeInTheDocument();
});

it("renders every chat for a blank query", async () => {
  const alpha = makeChat({ id: "a", title: "Alpha chat" });
  const beta = makeChat({ id: "b", title: "Beta chat" });
  window.gentle = makeBridge({ listChats: vi.fn().mockResolvedValue([alpha, beta]) });

  render(<ChatsContainer onSelectChat={vi.fn()} onNewChat={vi.fn()} query="   " />);

  expect(await screen.findByRole("button", { name: /Alpha chat/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Beta chat/ })).toBeInTheDocument();
});

it("reports when no chat matches the query", async () => {
  const alpha = makeChat({ id: "a", title: "Alpha chat" });
  window.gentle = makeBridge({ listChats: vi.fn().mockResolvedValue([alpha]) });

  render(<ChatsContainer onSelectChat={vi.fn()} onNewChat={vi.fn()} query="zzz" />);

  expect(await screen.findByText('No chats match "zzz".')).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Alpha chat/ })).not.toBeInTheDocument();
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
    expect(await screen.findByRole("button", { name: /A chat/ })).toBeInTheDocument();
  });

  it("shows the remove action on persisted rows only — a session-only row has nothing persisted to forget", async () => {
    window.gentle = makeBridge({ listChats: vi.fn().mockResolvedValue([SESSION_CHAT]) });

    render(
      <ChatsContainer onSelectChat={vi.fn()} onNewChat={vi.fn()} workspaces={WORKSPACES} />,
    );

    expect(await screen.findByRole("button", { name: "Remove workspace added" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove workspace project" })).not.toBeInTheDocument();
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
