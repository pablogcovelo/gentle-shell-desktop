// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "./App";
import { resetWelcomeHeroIntrosForTests } from "../features/conversation/components/WelcomeHero";
import { resetWorkspaceSnapshotsForTests } from "../features/conversation/ConversationContainer";
import { mockBridge, resetMockBridge, setMockChats, setMockDirectoryPick } from "../shared/bridge/mockBridge";

// `?firstRun=0` forces mockBridge.setupStatus() to needsChoice: false (see
// mockBridge's firstRunOverride), so these tests exercise the normal chat
// layout without going through the first-run screen mockBridge shows by
// default for the browser preview.
describe("App", () => {
  beforeEach(async () => {
    resetMockBridge();
    window.gentle = mockBridge;
    await mockBridge.addWorkspace!("/Users/dev/gentle-shell-desktop");
    window.history.pushState({}, "", "?firstRun=0");
    resetWelcomeHeroIntrosForTests();
    // ConversationContainer's T5c snapshot cache is module-level; without
    // this reset, one test's chats, hosts and states would leak into the
    // next through the focus/refresh path.
    resetWorkspaceSnapshotsForTests();
  });

  afterEach(() => {
    window.history.pushState({}, "", "/");
    (Element.prototype as unknown as { getAnimations?: unknown }).getAnimations = undefined;
  });

  it("opens a selected saved Pi session through the existing App route only after GUI /resume", async () => {
    await mockBridge.addWorkspace?.("/Users/dev/gentle-shell-desktop");
    const openChat = vi.spyOn(mockBridge, "openChat");
    const sendMessage = vi.spyOn(mockBridge, "sendMessage");
    const listChats = vi.spyOn(mockBridge, "listChats");
    try {
      render(<App />);
      const field = await screen.findByPlaceholderText("Tell Gentle what you need…");
      await act(async () => {});
      expect(openChat).not.toHaveBeenCalled();
      const priorLists = listChats.mock.calls.length;
      fireEvent.change(field, { target: { value: "/resume" } });
      await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      const dialog = await screen.findByRole("dialog", { name: "Resume a session" });
      fireEvent.click(await within(dialog).findByRole("button", { name: /Write the README intro/ }));
      await waitFor(() => expect(openChat).toHaveBeenCalledExactlyOnceWith("chat-readme"));
      expect(listChats).toHaveBeenCalledTimes(priorLists + 1);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog", { name: "Resume a session" })).not.toBeInTheDocument();
    } finally {
      openChat.mockRestore();
      sendMessage.mockRestore();
      listChats.mockRestore();
      await mockBridge.removeWorkspace?.("/Users/dev/gentle-shell-desktop");
    }
  });

  it("header closes a resumed workspace through removeWorkspace and selects another opened directory", async () => {
    await mockBridge.removeWorkspace!("/Users/dev/gentle-shell-desktop");
    await mockBridge.addWorkspace!("/tmp/other-open");
    await mockBridge.addWorkspace!("/Users/dev/gentle-shell-desktop");
    const remove = vi.spyOn(mockBridge, "removeWorkspace");
    const close = vi.spyOn(mockBridge, "closeChat");
    const fresh = vi.spyOn(mockBridge, "newChat");
    try {
      render(<App />);
      const field = await screen.findByPlaceholderText("Tell Gentle what you need…");
      await act(async () => {});
      fireEvent.change(field, { target: { value: "/resume" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      fireEvent.click(await within(await screen.findByRole("dialog")).findByRole("button", { name: /Write the README intro/ }));
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: "Close this workspace" }));
      await screen.findByRole("heading", { name: "other-open" });
      expect(remove).toHaveBeenCalledExactlyOnceWith("/Users/dev/gentle-shell-desktop");
      expect(close).not.toHaveBeenCalled();
      expect(fresh).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "gentle-shell-desktop — workspace" })).not.toBeInTheDocument();
    } finally {
      remove.mockRestore(); close.mockRestore(); fresh.mockRestore();
      await mockBridge.removeWorkspace!("/tmp/other-open");
      await mockBridge.removeWorkspace!("/Users/dev/gentle-shell-desktop");
    }
  });

  it("a delayed background close does not steal focus or revive a closed row", async () => {
    await mockBridge.addWorkspace!("/tmp/background");
    const originalRemove = mockBridge.removeWorkspace!.bind(mockBridge);
    let release!: () => void;
    const remove = vi.spyOn(mockBridge, "removeWorkspace").mockImplementation(async (directory) => {
      const result = await originalRemove(directory);
      await new Promise<void>((done) => { release = done; });
      return result;
    });
    try {
      render(<App />);
      await screen.findByRole("heading", { name: "background" });
      fireEvent.click(screen.getByRole("button", { name: "Remove workspace background" }));
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: "gentle-shell-desktop — workspace" }));
      await screen.findByRole("heading", { name: "gentle-shell-desktop" });
      await act(async () => { release(); });
      expect(screen.getByRole("heading", { name: "gentle-shell-desktop" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "background — workspace" })).not.toBeInTheDocument();
      expect(remove).toHaveBeenCalledTimes(1);
    } finally { remove.mockRestore(); }
  });

  it("a header close invalidates an Add picker before it can reopen the closed directory", async () => {
    let release!: (directory: string) => void;
    const choose = vi.spyOn(mockBridge, "chooseDirectory").mockImplementation(() => new Promise<string>((done) => { release = done; }));
    const create = vi.spyOn(mockBridge, "createWorkspace");
    try {
      render(<App />);
      await screen.findByRole("heading", { name: "gentle-shell-desktop" });
      fireEvent.click(screen.getByRole("button", { name: "Add workspace" }));
      fireEvent.click(screen.getByRole("button", { name: "Close this workspace" }));
      await screen.findByRole("region", { name: "No workspace open" });
      await act(async () => { release("/Users/dev/gentle-shell-desktop"); });
      expect(create).not.toHaveBeenCalled();
      expect(await mockBridge.listWorkspaces!()).toEqual({ directories: [], persisted: [] });
    } finally { choose.mockRestore(); create.mockRestore(); }
  });

  it("reconciles an unsaved pane using its resolved effective directory when that directory closes", async () => {
    const newChat = vi.spyOn(mockBridge, "newChat").mockImplementation(() => mockBridge.createWorkspace!("/Users/dev/gentle-shell-desktop"));
    try {
      render(<App />);
      await screen.findByRole("heading", { name: "gentle-shell-desktop" });
      fireEvent.keyDown(window, { key: "n", ctrlKey: true });
      await waitFor(() => expect(newChat).toHaveBeenCalledTimes(1));
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: "Remove workspace gentle-shell-desktop" }));
      await screen.findByRole("region", { name: "No workspace open" });
      expect(newChat).toHaveBeenCalledTimes(1);
    } finally { newChat.mockRestore(); }
  });

  it("renders the sidebar heading and the composer placeholder", async () => {
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Workspaces" })).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Tell Gentle what you need…"),
    ).toBeInTheDocument();
  });

  // T2 (S3/S4/S11): the app no longer starts on a synthetic new chat that
  // spawns a child on first paint. It starts with NO chat; once the
  // workspace list resolves with at least one workspace, exactly one is
  // selected and its pane opens — the most recent session of the first
  // directory (persisted-first union), never a spawned child.
  it("starts with no chat and selects the first workspace's most recent session once the list resolves", async () => {
    const newChat = vi.spyOn(mockBridge, "newChat");
    try {
      render(<App />);

      expect(await screen.findByRole("heading", { name: "gentle-shell-desktop" })).toBeInTheDocument();
      // The auto-selected workspace had a session: it was reopened, and no
      // child was ever spawned for a synthetic chat.
      expect(newChat).not.toHaveBeenCalled();
    } finally {
      newChat.mockRestore();
    }
  });

  // T2 (S3/S4): with no workspace at all the center shows the placeholder
  // (plain text plus the add-workspace hint at the panel's “+”) and NO child
  // process is spawned — no synthetic chat, no creation.
  it("with no workspace at all the center shows the placeholder and no child is spawned", async () => {
    await mockBridge.removeWorkspace!("/Users/dev/gentle-shell-desktop");
    setMockChats([]);
    const newChat = vi.spyOn(mockBridge, "newChat");
    const createWorkspace = vi.spyOn(mockBridge, "createWorkspace");
    try {
      render(<App />);

      const placeholder = await screen.findByRole("region", { name: "No workspace open" });
      expect(placeholder).toHaveTextContent("No workspace is open yet.");
      expect(placeholder).toHaveTextContent("“+” in the Workspaces panel");
      expect(screen.queryByPlaceholderText("Tell Gentle what you need…")).not.toBeInTheDocument();
      expect(newChat).not.toHaveBeenCalled();
      expect(createWorkspace).not.toHaveBeenCalled();
    } finally {
      newChat.mockRestore();
      createWorkspace.mockRestore();
      setMockChats(undefined);
    }
  });

  // T2 (S3/S11): the placeholder is not a dead end — adding the first
  // workspace opens its pane, and forgetting it returns the placeholder.
  it("adding the first workspace from the placeholder opens its pane, and removing it returns to the placeholder", async () => {
    await mockBridge.removeWorkspace!("/Users/dev/gentle-shell-desktop");
    setMockChats([]);
    setMockDirectoryPick("/tmp/solo-ws");
    try {
      render(<App />);
      await screen.findByRole("region", { name: "No workspace open" });

      fireEvent.click(screen.getByRole("button", { name: "Add workspace" }));

      // The row appears immediately (persisted) and the pane opens for it.
      expect(await screen.findByRole("button", { name: "solo-ws — workspace" })).toBeInTheDocument();
      await screen.findByRole("heading", { name: "solo-ws" });
      await vi.waitFor(() => expect(screen.getByLabelText("Session footer")).toHaveTextContent("/tmp/solo-ws"));

      fireEvent.click(screen.getByRole("button", { name: "Remove workspace solo-ws" }));
      expect(await screen.findByRole("region", { name: "No workspace open" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "solo-ws" })).not.toBeInTheDocument();
    } finally {
      setMockDirectoryPick(undefined);
      // The mock's registry is module state: drop the persisted entry this
      // test added, or it leaks into later tests' unions.
      await mockBridge.removeWorkspace?.("/tmp/solo-ws");
      setMockChats(undefined);
    }
  });

  // T2 (S11): while at least one workspace remains, one is always selected.
  // Removing the active workspace's persisted entry moves the selection to
  // the next workspace — and the previous host must never answer for the
  // new pane (host-id reset on selection change). The removed directory
  // must be persisted-only (no pi session), because a session-backed row
  // stays in the union after its persisted entry is removed — remove
  // deletes ONLY the persisted entry, never a chat.
  it("removing the active workspace selects the next one, and the new pane routes to its own host", async () => {
    await mockBridge.removeWorkspace!("/Users/dev/gentle-shell-desktop");
    setMockChats([]);
    await mockBridge.addWorkspace?.("/tmp/alpha-ws");
    await mockBridge.addWorkspace?.("/tmp/beta-ws");
    try {
      render(<App />);
      // The first directory (persisted entries come most-recently-added
      // first) is auto-selected and has no session: a new chat opens for it.
      await screen.findByRole("heading", { name: "beta-ws" });

      fireEvent.click(screen.getByRole("button", { name: "Remove workspace beta-ws" }));

      expect(await screen.findByRole("heading", { name: "alpha-ws" })).toBeInTheDocument();

      const composer = screen.getByPlaceholderText("Tell Gentle what you need…");
      fireEvent.change(composer, { target: { value: "hello after removal" } });
      const send = screen.getByRole("button", { name: "Send" });
      await waitFor(() => expect(send).toBeEnabled());
      fireEvent.click(send);
      await screen.findByText("hello after removal");
      // No unknown-host refusal: the stale host id did not answer.
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    } finally {
      // The mock's registry is module state: drop the persisted entries this
      // test added, or they leak into later tests' unions.
      await mockBridge.removeWorkspace?.("/tmp/alpha-ws");
      await mockBridge.removeWorkspace?.("/tmp/beta-ws");
      setMockChats(undefined);
    }
  });

  it("every 'New chat' click is a distinct chat that plays its own welcome intro", async () => {
    // jsdom ships no Web Animations API; these fakes never resolve on their
    // own, so the intro stays "playing" until the test settles it.
    let resolve!: () => void;
    const finished = new Promise<void>((r) => {
      resolve = r;
    });
    (Element.prototype as unknown as { getAnimations?: unknown }).getAnimations = vi.fn(
      () => [{ finished }] as unknown as Animation[],
    );

    render(<App />);

    await screen.findByRole("heading", { name: "Workspaces" });
    const hero = () => screen.getByTestId("gc-welcome-hero");
    await waitFor(() => expect(hero()).toHaveAttribute("data-intro", "playing"));
    await act(async () => {
      resolve();
      await finished;
    });
    await waitFor(() => expect(hero()).toHaveAttribute("data-intro", "complete"));

    fireEvent.keyDown(window, { key: "n", ctrlKey: true });

    // A new click is a new pane: its intro starts over instead of staying
    // settled from the previous unsaved chat.
    await waitFor(() => expect(hero()).toHaveAttribute("data-intro", "playing"));
  });

  it("selecting a sidebar chat updates the conversation header directory", async () => {
    render(<App />);

    // mockBridge's example chats load asynchronously into the sidebar.
    const item = await screen.findByRole("button", { name: "gentle-shell-desktop — workspace" });
    item.click();

    expect(await screen.findByRole("heading", { name: "gentle-shell-desktop" })).toBeInTheDocument();
  });

  // T5b pin (app-level): App owns the active host id, resets it on every
  // selection change, and hands it back down — so a request sent in a chat
  // opened after a switch carries THAT chat's host id and is never
  // rejected for a stale one (mockBridge rejects unknown host ids).
  it("routes each chat's requests to its own host after switching chats", async () => {
    render(<App />);

    await screen.findByRole("heading", { name: "Workspaces" });

    const composer = () => screen.getByPlaceholderText("Tell Gentle what you need…");
    // Send is disabled until the pane knows its workspace host, so waiting for
    // it (instead of clicking into the window) removes the timing race that
    // made this test flake under load.
    const sendWhenReady = async (text: string): Promise<void> => {
      fireEvent.change(composer(), { target: { value: text } });
      const send = screen.getByRole("button", { name: "Send" });
      await waitFor(() => expect(send).toBeEnabled());
      fireEvent.click(send);
    };

    await sendWhenReady("hello first");
    // The send only lands when it carried the resolved host id; a stale or
    // unknown id would surface as a status error and no message.
    await screen.findByText("hello first");

    fireEvent.click(await screen.findByRole("button", { name: "gentle-shell-desktop — workspace" }));
    await screen.findByRole("heading", { name: "gentle-shell-desktop" });

    await sendWhenReady("hello second");
    await screen.findByText("hello second");

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  // T11 — Add workspace: the sidebar action runs the native picker through
  // the bridge; a cancelled pick changes nothing at all, and a chosen
  // directory opens the created workspace's pane (adopted directly, never
  // resolved through a second newChat that would spawn a second child).
  it("cancelling the directory picker creates nothing (no host, no chat, no state change)", async () => {
    setMockDirectoryPick(null);
    const createWorkspace = vi.spyOn(mockBridge, "createWorkspace");
    try {
      render(<App />);

      await screen.findByRole("heading", { name: "Workspaces" });
      fireEvent.click(screen.getByRole("button", { name: "Add workspace" }));

      // The cancelled pick must have run the picker and NOTHING else: no
      // create request, no chat, no state, no refusal surfaced. The initial
      // pane is the auto-selected first workspace's session (T2); it must
      // be untouched.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
      });
      expect(createWorkspace).not.toHaveBeenCalled();
      expect(screen.getByRole("heading", { name: "gentle-shell-desktop" })).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally {
      createWorkspace.mockRestore();
      setMockDirectoryPick(undefined);
    }
  });

  it("Add workspace opens the created workspace's pane with its directory in the footer, without a second child", async () => {
    setMockDirectoryPick("/tmp/app-demo-workspace");
    const createWorkspace = vi.spyOn(mockBridge, "createWorkspace");
    const newChat = vi.spyOn(mockBridge, "newChat");
    try {
      render(<App />);

      await screen.findByRole("heading", { name: "Workspaces" });
      fireEvent.click(screen.getByRole("button", { name: "Add workspace" }));

      // The chosen directory is what main receives — verbatim.
      await vi.waitFor(() => expect(createWorkspace).toHaveBeenCalledWith("/tmp/app-demo-workspace"));
      // The created pane is adopted directly: no second newChat resolution
      // may spawn another child for the same workspace. With the T2 default
      // (the initial pane reuses the first workspace's existing session and
      // the created pane is adopted), no newChat resolution happens at all.
      await vi.waitFor(() => expect(screen.getByLabelText("Session footer")).toHaveTextContent("/tmp/app-demo-workspace"));
      expect(newChat).not.toHaveBeenCalled();
    } finally {
      createWorkspace.mockRestore();
      newChat.mockRestore();
      setMockDirectoryPick(undefined);
    }
  });

  it("offers Add workspace without the removed New chat or Chat selector controls", async () => {
    render(<App />);

    expect(await screen.findByRole("button", { name: "Add workspace" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New chat" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Chat" })).not.toBeInTheDocument();
  });

  it("keeps search available through Ctrl+K without a top bar search control", async () => {
    render(<App />);

    expect(await screen.findByRole("button", { name: "gentle-shell-desktop — workspace" })).toBeInTheDocument();
    expect(within(screen.getByRole("banner", { name: "Application chrome" })).queryByRole("searchbox")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const search = screen.getByRole("searchbox", { name: "Search chats" });

    fireEvent.change(search, { target: { value: "no-such-chat-anywhere" } });

    expect(await screen.findByText(/No workspaces match/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "gentle-shell-desktop — workspace" })).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "gentle-shell" } });

    expect(await screen.findByRole("button", { name: "gentle-shell-desktop — workspace" })).toBeInTheDocument();
  });

  it("opens the settings and shortcut dialogs, and draws the window controls when the bridge offers them", async () => {
    render(<App />);

    await screen.findByRole("heading", { name: "Workspaces" });
    // The mock bridge exposes the window controls, so the chrome draws them.
    expect(screen.getByRole("button", { name: "Minimize window" })).toBeInTheDocument();

    const rail = screen.getByRole("navigation", { name: "Application" });
    expect(within(screen.getByRole("banner", { name: "Application chrome" })).queryByRole("button", { name: "Application settings" })).not.toBeInTheDocument();
    fireEvent.click(within(rail).getByRole("button", { name: "Application settings" }));
    const settings = await screen.findByRole("dialog", { name: "Application settings" });
    expect(settings).toHaveTextContent("version");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(within(rail).getByRole("button", { name: "Add quick shortcut" }));
    const shortcuts = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(shortcuts).toHaveTextContent("Shift+Enter");
  });

  it("collapses the chat directories and the plan/usage/agents panel from the top bar", async () => {
    render(<App />);

    await screen.findByRole("heading", { name: "Workspaces" });
    const shell = document.querySelector(".gc-app");
    expect(shell).not.toHaveClass("gc-app--sidebar-hidden");
    expect(shell).not.toHaveClass("gc-app--inspector-hidden");

    fireEvent.click(screen.getByRole("button", { name: "Hide workspaces" }));

    expect(shell).toHaveClass("gc-app--sidebar-hidden");
    // The toggle keeps reporting the real state it just changed.
    expect(screen.getByRole("button", { name: "Show workspaces" })).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "Hide general information" }));

    expect(shell).toHaveClass("gc-app--inspector-hidden");
    expect(screen.getByRole("button", { name: "Show general information" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("opens narrow navigation from the header and closes it with Escape", async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 600 });
    try {
      render(<App />);
      const toggle = await screen.findByRole("button", { name: "Show workspaces" });
      fireEvent.click(toggle);
      expect(screen.getByRole("button", { name: "Hide workspaces" })).toHaveAttribute("aria-expanded", "true");
      expect(document.querySelector(".gc-app")).toHaveClass("gc-app--nav-open");
      fireEvent.keyDown(window, { key: "Escape" });
      expect(document.querySelector(".gc-app")).not.toHaveClass("gc-app--nav-open");
      expect(screen.getByRole("button", { name: "Show workspaces" })).toHaveFocus();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    }
  });

  it("renders the session footer outside the body as an app-wide status line", async () => {
    render(<App />);
    const footer = await screen.findByLabelText("Session footer");
    expect(footer.closest(".gc-app__body")).toBeNull();
    expect(footer.parentElement).toHaveClass("gc-app__footer");
    expect(footer).toHaveAttribute("tabindex", "0");
  });

  it("shows the first-run screen when setupStatus reports needsChoice (no persisted home choice yet)", async () => {
    window.history.pushState({}, "", "?firstRun=1");

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Welcome to gentle shell" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Workspaces" })).not.toBeInTheDocument();
  });

  it("choosing a home in first-run switches to the normal chat layout", async () => {
    window.history.pushState({}, "", "?firstRun=1");

    render(<App />);

    const button = await screen.findByRole("button", { name: "Use my pi setup" });
    button.click();

    expect(await screen.findByRole("heading", { name: "Workspaces" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Welcome to gentle shell" })).not.toBeInTheDocument();
  });
});
