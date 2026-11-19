// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CHAT_STATE, type ChatSummary } from "@shared/bridge-types";
import { ChatList, type WorkspaceGroup } from "./ChatList";

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

describe("ChatList workspace groups (T1)", () => {
  const groups: WorkspaceGroup[] = [
    { directory: "/tmp/added", chats: [], persisted: true },
    { directory: "/tmp/project", chats: [makeChat({ id: "a", title: "Alpha", cwd: "/tmp/project" })], persisted: false },
  ];

  it("renders one workspace row per directory and its chat rows underneath", () => {
    render(<ChatList chats={[]} groups={groups} onSelect={vi.fn()} />);

    expect(screen.getByRole("button", { name: "added — workspace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "project — workspace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Alpha/ })).toBeInTheDocument();
  });

  it("marks the selected chat's workspace row current", () => {
    render(<ChatList chats={[makeChat({ id: "a", cwd: "/tmp/project" })]} groups={groups} selectedId="a" onSelect={vi.fn()} />);

    expect(screen.getByRole("button", { name: "project — workspace" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "added — workspace" })).not.toHaveAttribute("aria-current");
  });

  it("keeps the remove action on persisted rows only — a session-only row has nothing persisted to forget", () => {
    render(<ChatList chats={[]} groups={groups} onSelect={vi.fn()} onRemoveWorkspace={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Remove workspace added" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove workspace project" })).not.toBeInTheDocument();
  });

  // S4: the highlight box is the row, so the selected workspace's close
  // control sits inside the box's top-right corner instead of in a separate
  // column that made the right inset differ from the left one.
  it("draws the selected workspace highlight on the row itself, around its close control", () => {
    const persistedGroups: WorkspaceGroup[] = [
      { directory: "/tmp/added", chats: [], persisted: true },
      { directory: "/tmp/project", chats: [makeChat({ id: "a", title: "Alpha", cwd: "/tmp/project" })], persisted: true },
    ];

    render(<ChatList chats={[makeChat({ id: "a", cwd: "/tmp/project" })]} groups={persistedGroups} selectedId="a" onSelect={vi.fn()} onRemoveWorkspace={vi.fn()} />);

    const row = screen.getByRole("button", { name: "project — workspace" }).closest("li");
    expect(row).toHaveClass("gc-workspace-row", "gc-workspace-row--selected");
    expect(row).toContainElement(screen.getByRole("button", { name: "Remove workspace project" }));
  });

  it("reports the picked workspace directory without touching chat selection", () => {
    const onSelectWorkspace = vi.fn();
    render(<ChatList chats={[]} groups={groups} onSelect={vi.fn()} onSelectWorkspace={onSelectWorkspace} />);

    fireEvent.click(screen.getByRole("button", { name: "added — workspace" }));

    expect(onSelectWorkspace).toHaveBeenCalledWith("/tmp/added");
  });

  it("reports the directory to forget when a persisted row's remove action is clicked", () => {
    const onRemoveWorkspace = vi.fn();
    render(<ChatList chats={[]} groups={groups} onSelect={vi.fn()} onRemoveWorkspace={onRemoveWorkspace} />);

    fireEvent.click(screen.getByRole("button", { name: "Remove workspace added" }));

    expect(onRemoveWorkspace).toHaveBeenCalledWith("/tmp/added");
  });

  it("renders chats that belong to no workspace group flat underneath the groups", () => {
    const stray = makeChat({ id: "stray", title: "Stray", cwd: "" });
    render(<ChatList chats={[stray]} groups={groups} onSelect={vi.fn()} />);

    expect(screen.getByRole("button", { name: /Stray/ })).toBeInTheDocument();
  });
});

it("shows every workspace's branch from the registry, not only the selected one", () => {
  const chats = [
    { id: "a", title: "Project A", cwd: "/repos/alpha", updatedAt: "2026-09-21T09:00:00.000Z", messageCount: 1, state: "idle" },
    { id: "b", title: "Project B", cwd: "/repos/beta", updatedAt: "2026-09-21T09:00:00.000Z", messageCount: 1, state: "idle" },
  ] as unknown as readonly ChatSummary[];

  render(
    <ChatList
      chats={chats}
      selectedId="a"
      onSelect={() => {}}
      branches={{ "/repos/alpha": "develop", "/repos/beta": "main" }}
    />,
  );

  // A branch is a fact about each workspace, not about the open one: every
  // row the registry answered for carries its own.
  expect(screen.getByText("develop")).toBeInTheDocument();
  expect(screen.getByText("main")).toBeInTheDocument();
});

it("shows no branch for a workspace the registry answered nothing for", () => {
  const chats = [
    { id: "a", title: "Project A", cwd: "/repos/alpha", updatedAt: "2026-09-21T09:00:00.000Z", messageCount: 1, state: "idle" },
  ] as unknown as readonly ChatSummary[];

  render(<ChatList chats={chats} selectedId="a" onSelect={() => {}} branches={{}} />);

  expect(document.querySelector(".gc-chat-list-item__branch")).toBeNull();
});
});
