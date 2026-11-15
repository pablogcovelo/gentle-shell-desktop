// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { CHAT_STATE, type ChatSummary } from "@shared/bridge-types";
import { ChatList } from "./ChatList";

const NOW = new Date("2026-09-21T12:00:00.000Z");

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

describe("ChatList", () => {
  it("renders flat directory rows without day groups, state pills or invented branches", () => {
    const chats = [
      makeChat({ id: "a", title: "Today's chat", updatedAt: "2026-09-21T09:00:00.000Z", state: CHAT_STATE.WORKING }),
      makeChat({ id: "b", title: "Old chat", updatedAt: "2026-09-10T09:00:00.000Z", state: CHAT_STATE.NEEDS_YOU }),
    ];

    render(<ChatList chats={chats} onSelect={vi.fn()} now={NOW} />);

    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Today's chat/ })).toHaveTextContent("project");
    expect(screen.queryByText("working")).not.toBeInTheDocument();
    expect(screen.queryByText("needs you")).not.toBeInTheDocument();
    expect(screen.queryByText("main")).not.toBeInTheDocument();
  });

  it("calls onSelect with the chat when an item is clicked", () => {
    const chat = makeChat({ id: "clicked" });
    const onSelect = vi.fn();

    render(<ChatList chats={[chat]} onSelect={onSelect} now={NOW} />);
    screen.getByRole("button", { name: /A chat/ }).click();

    expect(onSelect).toHaveBeenCalledWith(chat);
  });

  it("marks the selected chat as current", () => {
    const chats = [makeChat({ id: "a", title: "First" }), makeChat({ id: "b", title: "Second" })];

    render(<ChatList chats={chats} selectedId="b" onSelect={vi.fn()} now={NOW} />);

    expect(screen.getByRole("button", { name: /First/ })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: /Second/ })).toHaveAttribute("aria-current", "true");
  });

  it("renders nothing when there are no chats", () => {
    const { container } = render(<ChatList chats={[]} onSelect={vi.fn()} now={NOW} />);
    expect(container.querySelectorAll("li")).toHaveLength(0);
  });

  // S8: each row's secondary line is the chat's directory — the last path
  // segment of its cwd, on either path separator; an empty cwd renders no
  // directory at all (never an invented one).
  it("shows the chat's directory and omits it for an empty cwd", () => {
    const withDirectory = makeChat({ id: "a", title: "Alpha", cwd: "/tmp/project" });
    const windowsPath = makeChat({ id: "b", title: "Windows", cwd: "C:\\Users\\dev\\proj" });
    const withoutDirectory = makeChat({ id: "c", title: "Bare", cwd: "" });

    render(<ChatList chats={[withDirectory, windowsPath, withoutDirectory]} onSelect={vi.fn()} now={NOW} />);

    expect(screen.getByRole("button", { name: /Alpha/ })).toHaveTextContent("project");
    expect(screen.getByRole("button", { name: /Windows/ })).toHaveTextContent("proj");
    expect(screen.getByRole("button", { name: /Bare/ })).not.toHaveTextContent("tmp");
    expect(screen.getByRole("button", { name: /Bare/ })).not.toHaveTextContent("proj");
  });

  it("uses the directory as the visible row title while preserving the chat title for selection", () => {
    const chat = makeChat({ id: "a", title: "Alpha", state: CHAT_STATE.NEEDS_YOU });

    render(<ChatList chats={[chat]} onSelect={vi.fn()} now={NOW} />);

    expect(screen.getByRole("button", { name: /Alpha/ })).not.toHaveTextContent("needs you");
    expect(screen.getByRole("button", { name: /Alpha/ })).not.toHaveTextContent("Alpha");
    expect(screen.getByRole("button", { name: /Alpha/ })).toHaveTextContent("project");
  });

it("shows the branch under the selected workspace's name and nowhere else", () => {
  const chats = [
    { id: "a", title: "Project A", cwd: "/repos/alpha", updatedAt: "2026-09-21T09:00:00.000Z", messageCount: 1, state: "idle" },
    { id: "b", title: "Project B", cwd: "/repos/beta", updatedAt: "2026-09-21T09:00:00.000Z", messageCount: 1, state: "idle" },
  ] as unknown as readonly ChatSummary[];

  render(<ChatList chats={chats} selectedId="a" onSelect={() => {}} activeBranch="develop" />);

  // The branch is a fact about the OPEN workspace only; a row that is not
  // open must not carry one.
  expect(screen.getByText("develop")).toBeInTheDocument();
  expect(screen.getAllByText("develop")).toHaveLength(1);
});
});
