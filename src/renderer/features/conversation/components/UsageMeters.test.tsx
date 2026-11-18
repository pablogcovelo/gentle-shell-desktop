// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
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

  it("renders the reset instant as a secondary line when the wire supplies one", () => {
    render(<UsageMeters usage={{ providers: [CODEX_WINDOW_OK] }} />);

    const expected = `resets ${new Date(1788777491000).toLocaleString()}`;
    expect(screen.getByText(expected)).toBeInTheDocument();
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
});
