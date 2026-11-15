// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import { resetWelcomeHeroIntrosForTests } from "../features/conversation/components/WelcomeHero";
import { resetWorkspaceSnapshotsForTests } from "../features/conversation/ConversationContainer";
import { mockBridge, setMockDirectoryPick } from "../shared/bridge/mockBridge";

// `?firstRun=0` forces mockBridge.setupStatus() to needsChoice: false (see
// mockBridge's firstRunOverride), so these tests exercise the normal chat
// layout without going through the first-run screen mockBridge shows by
// default for the browser preview.
describe("App", () => {
  beforeEach(() => {
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

  it("renders the sidebar heading and the composer placeholder", async () => {
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Chats" })).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Tell Gentle what you need…"),
    ).toBeInTheDocument();
  });

  it('opens a fresh "New chat" by default', async () => {
    render(<App />);

    expect(await screen.findAllByRole("heading", { name: "New chat" })).toHaveLength(1);
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

    await screen.findByRole("heading", { name: "Chats" });
    const hero = () => screen.getByTestId("gc-welcome-hero");
    await waitFor(() => expect(hero()).toHaveAttribute("data-intro", "playing"));
    await act(async () => {
      resolve();
      await finished;
    });
    await waitFor(() => expect(hero()).toHaveAttribute("data-intro", "complete"));

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));

    // A new click is a new pane: its intro starts over instead of staying
    // settled from the previous unsaved chat.
    await waitFor(() => expect(hero()).toHaveAttribute("data-intro", "playing"));
  });

  it("selecting a sidebar chat updates the conversation header title", async () => {
    render(<App />);

    // mockBridge's example chats load asynchronously into the sidebar.
    const item = await screen.findByRole("button", { name: /Write the README intro/ });
    item.click();

    expect(await screen.findByRole("heading", { name: "Write the README intro" })).toBeInTheDocument();
  });

  // T5b pin (app-level): App owns the active host id, resets it on every
  // selection change, and hands it back down — so a request sent in a chat
  // opened after a switch carries THAT chat's host id and is never
  // rejected for a stale one (mockBridge rejects unknown host ids).
  it("routes each chat's requests to its own host after switching chats", async () => {
    render(<App />);

    await screen.findByRole("heading", { name: "Chats" });

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

    fireEvent.click(await screen.findByRole("button", { name: /Write the README intro/ }));
    await screen.findByRole("heading", { name: "Write the README intro" });

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

      await screen.findByRole("heading", { name: "Chats" });
      fireEvent.click(screen.getByRole("button", { name: "Add workspace" }));

      // The cancelled pick must have run the picker and NOTHING else: no
      // create request, no chat, no state, no refusal surfaced.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
      });
      expect(createWorkspace).not.toHaveBeenCalled();
      expect(screen.getByRole("heading", { name: "New chat" })).toBeInTheDocument();
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

      await screen.findByRole("heading", { name: "Chats" });
      fireEvent.click(screen.getByRole("button", { name: "Add workspace" }));

      // The chosen directory is what main receives — verbatim.
      await vi.waitFor(() => expect(createWorkspace).toHaveBeenCalledWith("/tmp/app-demo-workspace"));
      // The created pane is adopted directly: no second newChat resolution
      // may spawn another child for the same workspace. The initial pane's
      // single resolution is the only one.
      await vi.waitFor(() => expect(screen.getByLabelText("Session footer")).toHaveTextContent("/tmp/app-demo-workspace"));
      expect(newChat).toHaveBeenCalledTimes(1);
    } finally {
      createWorkspace.mockRestore();
      newChat.mockRestore();
      setMockDirectoryPick(undefined);
    }
  });

  it("the sidebar offers Add workspace beside New chat (T11)", async () => {
    render(<App />);

    expect(await screen.findByRole("button", { name: "Add workspace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New chat" })).toBeInTheDocument();
  });

  it("collapses the chat directories and the plan/usage/agents panel from the top bar", async () => {
    render(<App />);

    await screen.findByRole("heading", { name: "Chats" });
    const shell = document.querySelector(".gc-app");
    expect(shell).not.toHaveClass("gc-app--sidebar-hidden");
    expect(shell).not.toHaveClass("gc-app--inspector-hidden");

    fireEvent.click(screen.getByRole("button", { name: "Hide chats" }));

    expect(shell).toHaveClass("gc-app--sidebar-hidden");
    // The toggle keeps reporting the real state it just changed.
    expect(screen.getByRole("button", { name: "Show chats" })).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "Hide plan, usage and agents" }));

    expect(shell).toHaveClass("gc-app--inspector-hidden");
    expect(screen.getByRole("button", { name: "Show plan, usage and agents" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("shows the first-run screen when setupStatus reports needsChoice (no persisted home choice yet)", async () => {
    window.history.pushState({}, "", "?firstRun=1");

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Welcome to gentle shell" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Chats" })).not.toBeInTheDocument();
  });

  it("choosing a home in first-run switches to the normal chat layout", async () => {
    window.history.pushState({}, "", "?firstRun=1");

    render(<App />);

    const button = await screen.findByRole("button", { name: "Use my pi setup" });
    button.click();

    expect(await screen.findByRole("heading", { name: "Chats" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Welcome to gentle shell" })).not.toBeInTheDocument();
  });
});
