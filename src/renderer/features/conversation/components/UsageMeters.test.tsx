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

  it("failed and unavailable providers keep their honest note instead of meters", () => {
    const broken: SubscriptionUsage = {
      providers: [
        { provider: "openai-codex", status: "failed" },
        { provider: "nan", status: "unavailable" },
      ],
    };
    render(<UsageMeters usage={broken} />);

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByText(/failed/i)).toBeInTheDocument();
    expect(screen.getByText(/no usage source/i)).toBeInTheDocument();
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
