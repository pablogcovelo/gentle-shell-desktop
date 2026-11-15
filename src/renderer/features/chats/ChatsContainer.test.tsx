// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
