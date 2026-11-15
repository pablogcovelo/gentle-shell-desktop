// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import { resetWelcomeHeroIntrosForTests } from "../features/conversation/components/WelcomeHero";

// `?firstRun=0` forces mockBridge.setupStatus() to needsChoice: false (see
// mockBridge's firstRunOverride), so these tests exercise the normal chat
// layout without going through the first-run screen mockBridge shows by
// default for the browser preview.
describe("App", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "?firstRun=0");
    resetWelcomeHeroIntrosForTests();
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
