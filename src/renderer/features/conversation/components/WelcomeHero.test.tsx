// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { WelcomeHero } from "./WelcomeHero";

// jsdom ships no Web Animations API and no media-query engine, so both are
// stubbed here. The hero only ever reads them through the narrow surface
// asserted below (getAnimations + the reduced-motion query), never beyond it.

interface FakeAnimation {
  readonly finished: Promise<void>;
  readonly cancel: ReturnType<typeof vi.fn>;
  readonly resolve: () => void;
}

function fakeAnimations(count: number): FakeAnimation[] {
  return Array.from({ length: count }, () => {
    let resolve!: () => void;
    const finished = new Promise<void>((r) => {
      resolve = r;
    });
    return { finished, cancel: vi.fn(() => resolve()), resolve };
  });
}

interface MotionQueryStub {
  readonly matches: boolean;
  readonly media: string;
  addEventListener: (type: "change", listener: (event: { matches: boolean }) => void) => void;
  removeEventListener: (type: "change", listener: (event: { matches: boolean }) => void) => void;
  trigger: (matches: boolean) => void;
}

function motionQuery(matches: boolean): MotionQueryStub {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  return {
    matches,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    trigger: (next) => {
      for (const listener of listeners) listener({ matches: next });
    },
  };
}

function setMotionQuery(query: MotionQueryStub): void {
  window.matchMedia = vi.fn(() => query as unknown as MediaQueryList);
}

function setAnimations(animations: readonly FakeAnimation[]): ReturnType<typeof vi.fn> {
  const getAnimations = vi.fn(() => animations as unknown as Animation[]);
  (Element.prototype as unknown as { getAnimations?: unknown }).getAnimations = getAnimations;
  return getAnimations;
}

const hadMatchMedia = "matchMedia" in window;
const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  (Element.prototype as unknown as { getAnimations?: unknown }).getAnimations = undefined;
});

afterEach(() => {
  (Element.prototype as unknown as { getAnimations?: unknown }).getAnimations = undefined;
  if (hadMatchMedia) window.matchMedia = originalMatchMedia;
  else delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  vi.restoreAllMocks();
});

function hero(): HTMLElement {
  return screen.getByTestId("gc-welcome-hero");
}

describe("WelcomeHero", () => {
  it("plays the intro and settles once every animation finishes", async () => {
    const animations = fakeAnimations(2);
    setAnimations(animations);

    render(<WelcomeHero chatKey="chat-plays" />);

    await waitFor(() => expect(hero()).toHaveAttribute("data-intro", "playing"));
    expect(hero()).toHaveClass("gc-welcome");
    expect(hero()).toHaveClass("is-playing");

    await act(async () => {
      animations.forEach((animation) => animation.resolve());
      await Promise.all(animations.map((animation) => animation.finished));
    });

    await waitFor(() => expect(hero()).toHaveAttribute("data-intro", "complete"));
    expect(hero()).not.toHaveClass("is-playing");
  });

  it("settles immediately under reduced motion without starting any animation", async () => {
    setMotionQuery(motionQuery(true));
    const getAnimations = setAnimations([]);

    render(<WelcomeHero chatKey="chat-reduced" />);

    await waitFor(() => expect(hero()).toHaveAttribute("data-intro", "complete"));
    expect(getAnimations).not.toHaveBeenCalled();
  });

  it("never replays an intro the same chat already played", async () => {
    const animations = fakeAnimations(1);
    const getAnimations = setAnimations(animations);

    const first = render(<WelcomeHero chatKey="chat-once" />);
    await waitFor(() => expect(hero()).toHaveAttribute("data-intro", "playing"));
    await act(async () => {
      animations.forEach((animation) => animation.resolve());
      await Promise.all(animations.map((animation) => animation.finished));
    });
    await waitFor(() => expect(hero()).toHaveAttribute("data-intro", "complete"));
    first.unmount();
    getAnimations.mockClear();

    render(<WelcomeHero chatKey="chat-once" />);

    await waitFor(() => expect(hero()).toHaveAttribute("data-intro", "complete"));
    expect(getAnimations).not.toHaveBeenCalled();
  });

  it("cancels an in-flight intro when the user reduces motion mid-run", async () => {
    const query = motionQuery(false);
    setMotionQuery(query);
    const animations = fakeAnimations(3);
    setAnimations(animations);

    render(<WelcomeHero chatKey="chat-midrun" />);
    await waitFor(() => expect(hero()).toHaveAttribute("data-intro", "playing"));

    await act(async () => {
      query.trigger(true);
    });

    await waitFor(() => expect(hero()).toHaveAttribute("data-intro", "complete"));
    animations.forEach((animation) => expect(animation.cancel).toHaveBeenCalled());
  });

  it("names the hero for assistive technology", () => {
    render(<WelcomeHero chatKey="chat-a11y" />);

    expect(screen.getByRole("img", { name: "Gentle Shell rose" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Gentle Shell" })).toBeInTheDocument();
    expect(screen.getByText(/You lead\. Gentle helps\./)).toBeInTheDocument();
  });
});
