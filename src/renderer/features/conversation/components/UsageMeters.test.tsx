// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import type { SubscriptionUsage, UsageProvider } from "@shared/bridge-types";
import { UsageMeters } from "./UsageMeters";

const CODEX_WINDOW_OK: UsageProvider = {
  provider: "openai-codex",
  status: "ok",
  plan: "pro",
  limits: [
    {
      name: "codex",
      limitReached: false,
      windows: [{ label: "week", usedPercent: 40, windowSeconds: 604800, resetAt: 1788777491000 }],
    },
  ],
};

const ANTHROPIC_PENDING: UsageProvider = { provider: "anthropic", status: "pending" };

const REPRESENTATIVE: SubscriptionUsage = { providers: [CODEX_WINDOW_OK, ANTHROPIC_PENDING] };

describe("UsageMeters", () => {

  it("drops only the card chrome in the panel variant (T3 inspector)", () => {
    const { container } = render(<UsageMeters usage={REPRESENTATIVE} variant="panel" />);

    expect(screen.getByText("openai-codex")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /week usage/i })).toBeInTheDocument();
    expect(screen.getByText("40%")).toBeInTheDocument();
    const section = container.querySelector(".gc-usage") as HTMLElement;
    expect(section).toHaveClass("gc-usage--panel");
    // The inspector's provider line is a plain title: no initials badge, and
    // no boxed card around its head (design/slack-gentle, comment clq1vtao).
    expect(container.querySelector(".gc-usage__mark")).toBeNull();
  });

  it("keeps the provider and its plan on one title line in the panel variant", () => {
    const { container } = render(<UsageMeters usage={{ providers: [CODEX_WINDOW_OK] }} variant="panel" />);

    const head = container.querySelector(".gc-usage__provider-head") as HTMLElement;
    expect(head).toHaveTextContent("openai-codex · pro");
    // The plan sits in the same head row as the name — one line, not a block
    // stacked under it.
    expect(head).toContainElement(screen.getByText("pro"));
  });

  it("renders nothing when there is no usage data at all", () => {
    const { container } = render(<UsageMeters />);
    expect(container).toBeEmptyDOMElement();

    const { container: emptyContainer } = render(<UsageMeters usage={{ providers: [] }} />);
    expect(emptyContainer).toBeEmptyDOMElement();
  });

  it("renders the provider name above one labeled bar per window with the real percentage", () => {
    render(<UsageMeters usage={{ providers: [CODEX_WINDOW_OK] }} />);

    expect(screen.getByText("openai-codex")).toBeInTheDocument();
    expect(screen.getByText("pro")).toBeInTheDocument();
    const meter = screen.getByRole("progressbar", { name: /week usage/i });
    expect(meter).toHaveAttribute("aria-valuenow", "40");
    expect(screen.getByText("40%")).toBeInTheDocument();
  });

  it("renders no reset line when resetAt is null (the wire's way of saying the provider does not report one)", () => {
    const noReset: SubscriptionUsage = {
      providers: [
        {
          provider: "anthropic",
          status: "ok",
          limits: [{ name: "claude", limitReached: false, windows: [{ label: "5h", usedPercent: 25, windowSeconds: 18000, resetAt: null }] }],
        },
      ],
    };
    render(<UsageMeters usage={noReset} />);

    expect(screen.getByRole("progressbar", { name: /5h usage/i })).toBeInTheDocument();
    expect(screen.queryByText(/resets/)).not.toBeInTheDocument();
  });

  it("a pending provider says so and never renders a bar, a percentage, or a fabricated 0%", () => {
    render(<UsageMeters usage={REPRESENTATIVE} />);

    const pendingBlock = document.querySelector('[data-provider="anthropic"]') as HTMLElement;
    expect(pendingBlock).not.toBeNull();
    expect(within(pendingBlock).queryByRole("progressbar")).not.toBeInTheDocument();
    expect(within(pendingBlock).getByText(/pending/i)).toBeInTheDocument();

    // Nowhere in the whole block does a fabricated zero percentage appear.
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
    expect(screen.queryByText("0 %")).not.toBeInTheDocument();
  });

  it("a failed provider keeps its honest note instead of meters; an unavailable provider with no windows never renders", () => {
    const broken: SubscriptionUsage = {
      providers: [
        { provider: "openai-codex", status: "failed" },
        { provider: "nan", status: "unavailable" },
      ],
    };
    render(<UsageMeters usage={broken} />);

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByText(/failed/i)).toBeInTheDocument();
    // The unavailable provider is dropped entirely: with no windows it could
    // only ever say "no usage source", so it renders nothing at all.
    expect(document.querySelector('[data-provider="nan"]')).toBeNull();
    expect(screen.queryByText(/no usage source/i)).not.toBeInTheDocument();
  });

  it("renders only the provider with a usage source: an unavailable provider with no windows is dropped", () => {
    const mixed: SubscriptionUsage = {
      providers: [ANTHROPIC_PENDING, { provider: "opencode-go", status: "unavailable" }],
    };
    render(<UsageMeters usage={mixed} />);

    expect(document.querySelector('[data-provider="anthropic"]')).not.toBeNull();
    expect(document.querySelector('[data-provider="opencode-go"]')).toBeNull();
    expect(screen.queryByText(/no usage source/i)).not.toBeInTheDocument();
  });

  it("keeps an unavailable provider that nevertheless carries a window — the snapshot outranks the status label", () => {
    const snapshot: SubscriptionUsage = {
      providers: [
        {
          provider: "opencode-go",
          status: "unavailable",
          limits: [
            {
              name: "go",
              limitReached: false,
              windows: [{ label: "day", usedPercent: 12, windowSeconds: 86400, resetAt: null }],
            },
          ],
        },
      ],
    };
    render(<UsageMeters usage={snapshot} />);

    expect(document.querySelector('[data-provider="opencode-go"]')).not.toBeNull();
    expect(screen.getByText("12%")).toBeInTheDocument();
  });

  it("a failed channel probe renders the channel-unavailable note — distinct from pending, with no meters", () => {
    render(<UsageMeters channelUnavailable />);

    expect(screen.getByRole("region", { name: "Subscription usage" })).toBeInTheDocument();
    expect(screen.getByText(/channel unavailable/i)).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    // Distinct from pending: the pending wording never appears.
    expect(screen.queryByText(/pending/i)).not.toBeInTheDocument();
  });

  it("renders the channel-unavailable note even if stale usage data somehow exists", () => {
    render(<UsageMeters usage={{ providers: [CODEX_WINDOW_OK] }} channelUnavailable />);

    expect(screen.getByText(/channel unavailable/i)).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("an already-rendered meter shows the rate_limit event's updated percentage without a reload", () => {
    const updated: SubscriptionUsage = {
      providers: [
        {
          provider: "openai-codex",
          status: "ok",
          plan: "pro",
          limits: [
            {
              name: "codex",
              limitReached: false,
              windows: [{ label: "week", usedPercent: 90, windowSeconds: 604800, resetAt: 1788777491000 }],
            },
          ],
        },
      ],
    };

    const { rerender } = render(<UsageMeters usage={{ providers: [CODEX_WINDOW_OK] }} />);
    expect(screen.getByText("40%")).toBeInTheDocument();

    rerender(<UsageMeters usage={updated} />);
    expect(screen.queryByText("40%")).not.toBeInTheDocument();
    expect(screen.getByText("90%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /week usage/i })).toHaveAttribute("aria-valuenow", "90");
  });

  // The reset line became a compact countdown instead of a full timestamp
  // (design/slack-gentle, comment clq1vtao). Fake timers pin "now" so the
  // relative text is deterministic; nothing below reads the real clock.
  describe("reset countdown", () => {
    // The desktop-rpc usage contract fixture's `fetchedAt`.
    const FIXED_NOW = 1788600000000;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(FIXED_NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const HOURS_AHEAD: UsageProvider = {
      provider: "anthropic",
      status: "ok",
      limits: [
        {
          name: "claude",
          limitReached: false,
          // 3 hours and 42 minutes from FIXED_NOW.
          windows: [{ label: "5h", usedPercent: 25, windowSeconds: 18000, resetAt: FIXED_NOW + 222 * 60_000 }],
        },
      ],
    };

    it("shows the reset as a compact relative time, never a full timestamp", () => {
      render(<UsageMeters usage={{ providers: [CODEX_WINDOW_OK] }} />);

      // 1788777491000 is 2 days, 1 hour and 19 minutes after FIXED_NOW.
      expect(screen.getByText("resets in 2d 1h")).toBeInTheDocument();
      expect(screen.queryByText(`resets ${new Date(1788777491000).toLocaleString()}`)).not.toBeInTheDocument();
    });

    it("uses hours and minutes for a window that resets within a day", () => {
      render(<UsageMeters usage={{ providers: [HOURS_AHEAD] }} />);

      expect(screen.getByText("resets in 3h 42m")).toBeInTheDocument();
    });

    it("says the window resets now instead of counting backwards once the instant has passed", () => {
      const elapsed: UsageProvider = {
        provider: "anthropic",
        status: "ok",
        limits: [
          {
            name: "claude",
            limitReached: false,
            windows: [{ label: "5h", usedPercent: 25, windowSeconds: 18000, resetAt: FIXED_NOW - 60_000 }],
          },
        ],
      };

      render(<UsageMeters usage={{ providers: [elapsed] }} />);

      expect(screen.getByText("resets now")).toBeInTheDocument();
    });

    it("keeps the countdown current while the panel stays open", () => {
      render(<UsageMeters usage={{ providers: [HOURS_AHEAD] }} />);
      expect(screen.getByText("resets in 3h 42m")).toBeInTheDocument();

      act(() => {
        // Vitest's fake timers advance the mocked system clock together with
        // the interval queue, so one advance covers both.
        vi.advanceTimersByTime(180_000);
      });

      expect(screen.getByText("resets in 3h 39m")).toBeInTheDocument();
    });

    it("folds the countdown into the meter row in the inspector and keeps the card's second line", () => {
      const inspector = render(<UsageMeters usage={{ providers: [HOURS_AHEAD] }} variant="panel" />);
      expect(inspector.container.querySelector(".gc-usage__window-row .gc-usage__reset")).not.toBeNull();

      const card = render(<UsageMeters usage={{ providers: [HOURS_AHEAD] }} />);
      expect(card.container.querySelector(".gc-usage__window-row .gc-usage__reset")).toBeNull();
    });
  });
});
