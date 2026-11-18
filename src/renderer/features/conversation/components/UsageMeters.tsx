import { useEffect, useState } from "react";
import type { SubscriptionUsage, UsageLimit, UsageProvider, UsageWindow } from "@shared/bridge-types";
import "./UsageMeters.css";

/** How often a visible countdown re-reads the clock. Half the smallest unit
 * the text shows, so the label never lags a whole step behind. */
const RESET_CLOCK_INTERVAL_MS = 30_000;

export interface UsageMetersProps {
  /** The open chat's subscription usage (ChatState.usage, desktop-rpc T3).
   * Optional: absent until the first `get_subscription_usage` reply or
   * `rate_limit` event arrives. */
  readonly usage?: SubscriptionUsage;
  /** True when the desktop control channel probe failed for this chat's
   * child (T3 correction): no control traffic reaches that child, so the
   * surface must say the channel is unavailable — a distinct state from a
   * provider's `pending`, which means the provider has not reported yet. */
  readonly channelUnavailable?: boolean;
  /** `"card"` (default) is the chat-stack card; `"panel"` drops only the
   * card chrome (border, background, radius, outer padding) for the
   * InspectorPanel, whose section supplies the surface. */
  readonly variant?: "card" | "panel";
}

/**
 * Honest-state notes (desktop-rpc T3, U3 acceptance boundaries): a
 * provider with no windows NEVER renders meters — and therefore never a
 * fabricated 0%. Each note says what the wire actually told us, straight
 * from the five documented statuses:
 *   - `pending` — a header-only provider (Anthropic) until its first
 *     response records a snapshot; usage arrives with responses, so there
 *     is nothing to meter yet.
 *   - `failed` / `unavailable` — the last refresh settled empty / the
 *     provider has no usage source at all.
 *   - `stale` without windows — a recorded snapshot aged out (refreshable
 *     providers only).
 *   - `ok` without windows — the provider simply reported none.
 * Unavailable is never rendered as zero, and provider quota is never
 * inferred from anything the wire did not say.
 */
const STATUS_NOTES: Readonly<Record<string, string>> = {
  pending: "Pending — this provider reports usage with its responses; nothing recorded yet.",
  failed: "Failed — the provider's last refresh settled empty; no usage recorded.",
  unavailable: "Unavailable — this provider has no usage source.",
  stale: "Stale — the recorded snapshot is older than the refresh window.",
  ok: "No usage windows reported.",
};

/**
 * Providers worth metering: the wire sends one entry per provider in the
 * usage scope, and `status === "unavailable"` means that provider has NO
 * usage source at all — no built-in fetcher and no registered source —
 * so its block could only ever say "no usage source" and never render a
 * meter. A provider that is merely in the session/profile routing would
 * otherwise show up as a dead section next to the real ones, so such an
 * entry is dropped when it carries no windows at all (limits absent or
 * empty, or every limit's windows empty). Every other status (`pending`,
 * `failed`, `stale`, `ok`) is an honest state about a provider that does
 * have a source and is kept. Defensive boundary: an `unavailable` entry
 * that nevertheless carries windows is kept — the snapshot outranks the
 * status label.
 */
export function usageProvidersWithSource(usage?: SubscriptionUsage): readonly UsageProvider[] {
  return (usage?.providers ?? []).filter((provider) => {
    if (provider.status !== "unavailable") return true;
    const windows = (provider.limits ?? []).reduce((total, limit) => total + limit.windows.length, 0);
    return windows > 0;
  });
}

/**
 * Subscription-usage meters (desktop-rpc T3): one block per provider —
 * name above, one labeled bar per window with the real percentage, and
 * the reset instant as a secondary line. Renders NOTHING when there is no
 * usage data at all: an unavailable source must look absent, not empty.
 * Fed strictly from the pushed ChatState.usage of the open chat; the
 * `rate_limit` event keeps it live without a reload.
 */
export function UsageMeters({ usage, channelUnavailable, variant = "card" }: UsageMetersProps) {
  // The panel variant only changes presentation; the honest-state logic
  // below is shared verbatim with the card variant.
  const chrome = variant === "panel" ? "gc-usage gc-usage--panel" : "gc-usage";
  const providers = usageProvidersWithSource(usage);
  // Hooks run before every early return below, so the unavailable and empty
  // states obey the rules of hooks too. The filter is pure, so it can run
  // first and tell the clock whether anything on screen shows a countdown.
  const now = useResetClock(providers.some(showsReset));

  // The channel-unavailable state (T3 correction) reuses the same
  // honest-note path as the provider statuses below — one note, same
  // styling mechanism, distinct meaning: this says OUR control channel to
  // the child never adopted (the capabilities probe failed), so no usage
  // surface exists at all for this child. A provider's `pending`, by
  // contrast, means the provider simply has not reported yet. Red, so it
  // is visibly a failure and not a quiet empty block.
  if (channelUnavailable) {
    return (
      <section className={chrome} aria-label="Subscription usage">
        <p className="gc-usage__note gc-usage__note--channel-unavailable">
          Channel unavailable — this child has no desktop control channel, so usage cannot be read.
        </p>
      </section>
    );
  }

  if (providers.length === 0) return null;

  return (
    <section className={chrome} aria-label="Subscription usage">
      {providers.map((provider) => (
        <UsageProviderBlock key={provider.provider} provider={provider} panel={variant === "panel"} now={now} />
      ))}
    </section>
  );
}

function UsageProviderBlock({ provider, panel, now }: { readonly provider: UsageProvider; readonly panel: boolean; readonly now: number }) {
  const limits = provider.limits ?? [];
  const windowCount = limits.reduce((total, limit) => total + limit.windows.length, 0);

  return (
    <div className="gc-usage__provider" data-provider={provider.provider}>
      {/* One title line: provider and plan read together, with no initials
      badge and no boxed card around them (design/slack-gentle, clq1vtao). */}
      <div className="gc-usage__provider-head">
        <span className="gc-usage__provider-name">{provider.provider}</span>
        {provider.plan ? (
          <>
            {/* The panel joins name and plan into one title line; the card
            keeps its two-part label. The separator is real text, not CSS
            content, so assistive technology reads what the eye reads. */}
            {panel ? <span className="gc-usage__plan-sep">{" · "}</span> : null}
            <span className="gc-usage__plan">{provider.plan}</span>
          </>
        ) : null}
      </div>
      {windowCount > 0 ? (
        limits.map((limit, index) => <UsageLimitGroup key={index} limit={limit} showName={limits.length > 1} now={now} panel={panel} />)
      ) : (
        <p className={`gc-usage__note gc-usage__note--${provider.status}`}>{STATUS_NOTES[provider.status] ?? "No usage windows reported."}</p>
      )}
    </div>
  );
}

/** True when this provider reports at least one reset instant, i.e. when it
 * has a countdown worth keeping current. */
function showsReset(provider: UsageProvider): boolean {
  return (provider.limits ?? []).some((limit) => limit.windows.some((window) => window.resetAt !== null));
}

/**
 * The reset text is relative, so it has to follow the clock. `rate_limit`
 * pushes keep the percentages live, but an idle conversation can keep a
 * panel open for hours and a frozen "resets in 3h 42m" would turn into a
 * false statement. The interval only runs while a countdown is on screen.
 */
function useResetClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    // Re-read on activation: the first render's value can predate it.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), RESET_CLOCK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function UsageLimitGroup({ limit, showName, now, panel }: { readonly limit: UsageLimit; readonly showName: boolean; readonly now: number; readonly panel: boolean }) {
  if (limit.windows.length === 0) return null;
  return (
    <ul className="gc-usage__windows">
      {showName ? <li className="gc-usage__limit-name">{limit.name}</li> : null}
      {limit.windows.map((window) => (
        <UsageWindowRow key={`${window.label}-${window.windowSeconds}`} window={window} now={now} panel={panel} />
      ))}
    </ul>
  );
}

function UsageWindowRow({ window, now, panel }: { readonly window: UsageWindow; readonly now: number; readonly panel: boolean }) {
  const reset = window.resetAt !== null ? formatReset(window.resetAt, now) : null;
  return (
    <li className="gc-usage__window">
      <div className="gc-usage__window-row">
        <span className="gc-usage__label">{window.label}</span>
        <span
          className="gc-usage__meter"
          role="progressbar"
          aria-label={`${window.label} usage`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={window.usedPercent}
        >
          {/* The bar's width is clamped for CSS only; the text next to it
          always shows the real percentage the wire reported. */}
          <span style={{ width: `${clampWidth(window.usedPercent)}%` }} />
        </span>
        <span className="gc-usage__percent">{window.usedPercent}%</span>
        {/* Inspector: the countdown closes the row itself. Card: unchanged,
        it keeps its quiet second line. */}
        {reset !== null && panel ? <span className="gc-usage__reset gc-usage__reset--inline">{reset}</span> : null}
      </div>
      {reset !== null && !panel ? <div className="gc-usage__reset">{reset}</div> : null}
    </li>
  );
}

function clampWidth(percent: number): number {
  return Math.max(0, Math.min(100, percent));
}

/**
 * A reset is a future instant a few minutes to a few days away, and printing
 * the instant makes the reader subtract dates to learn anything. Days/hours
 * cover the weekly windows, hours/minutes the short ones, rounded up so a
 * still-future reset never reads as zero. A snapshot can outlive its own
 * instant (no new push arrived yet), so a past one says "resets now" instead
 * of counting backwards.
 */
function formatReset(resetAt: number, now: number): string {
  const remainingMs = resetAt - now;
  if (remainingMs <= 0) return "resets now";
  const minutes = Math.ceil(remainingMs / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${minutes % 60}m`;
  return `resets in ${minutes}m`;
}
