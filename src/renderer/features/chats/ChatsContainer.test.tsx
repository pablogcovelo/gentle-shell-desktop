// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { CHAT_STATE, type ChatState, type ChatSummary, type GentleBridge } from "@shared/bridge-types";
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

it("shows a message when listChats rejects", async () => {
  window.gentle = makeBridge({ listChats: vi.fn().mockRejectedValue(new Error("bridge not ready")) });
  render(<ChatsContainer onSelectChat={vi.fn()} onNewChat={vi.fn()} />);
  expect(await screen.findByText("Chats are not available yet: bridge not ready")).toBeInTheDocument();
});

it("calls onNewChat when the New chat button is clicked", async () => {
  window.gentle = makeBridge();
  const onNewChat = vi.fn();

  render(<ChatsContainer onSelectChat={vi.fn()} onNewChat={onNewChat} />);
  screen.getByRole("button", { name: "New chat" }).click();

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

const EMPTY_STATE: ChatState = {
  messages: [],
  working: false,
  pendingDialogs: [],
  activity: 0,
  helpers: { summary: { running: 0, queued: 0, waiting: 0, finished: 0 }, tasks: [] },
};

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
  screen.getByRole("button", { name: "New chat" }).click();
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
  screen.getByRole("button", { name: "New chat" }).click();
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

  screen.getByRole("button", { name: "New chat" }).click();
  releaseCreate?.();
  await act(async () => {});

  // Dropping the result would leave a live child nobody can reach: the same
  // orphan this flow exists to avoid, so it is closed instead.
  expect(onWorkspaceCreated).not.toHaveBeenCalled();
  expect(closeChat).toHaveBeenCalledWith("host-late");
});
