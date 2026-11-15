import type { SubscriptionUsage, UsageLimit, UsageProvider, UsageWindow } from "@shared/bridge-types";
import "./UsageMeters.css";

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

  const providers = usage?.providers ?? [];
  if (providers.length === 0) return null;

  return (
    <section className={chrome} aria-label="Subscription usage">
      {providers.map((provider) => (
        <UsageProviderBlock key={provider.provider} provider={provider} panel={variant === "panel"} />
      ))}
    </section>
  );
}

function UsageProviderBlock({ provider, panel }: { readonly provider: UsageProvider; readonly panel: boolean }) {
  const limits = provider.limits ?? [];
  const windowCount = limits.reduce((total, limit) => total + limit.windows.length, 0);

  return (
    <div className="gc-usage__provider" data-provider={provider.provider}>
      <div className="gc-usage__provider-head">
        {panel && <span className="gc-usage__mark" aria-hidden="true">{provider.provider.slice(0, 2).toUpperCase()}</span>}
        {panel ? (
          <div>
            <span className="gc-usage__provider-name">{provider.provider}</span>
            {provider.plan ? <span className="gc-usage__plan">{provider.plan}</span> : null}
          </div>
        ) : <>
          <span className="gc-usage__provider-name">{provider.provider}</span>
          {provider.plan ? <span className="gc-usage__plan">{provider.plan}</span> : null}
        </>}
      </div>
      {windowCount > 0 ? (
        limits.map((limit, index) => <UsageLimitGroup key={index} limit={limit} showName={limits.length > 1} />)
      ) : (
        <p className={`gc-usage__note gc-usage__note--${provider.status}`}>{STATUS_NOTES[provider.status] ?? "No usage windows reported."}</p>
      )}
    </div>
  );
}

function UsageLimitGroup({ limit, showName }: { readonly limit: UsageLimit; readonly showName: boolean }) {
  if (limit.windows.length === 0) return null;
  return (
    <ul className="gc-usage__windows">
      {showName ? <li className="gc-usage__limit-name">{limit.name}</li> : null}
      {limit.windows.map((window) => (
        <UsageWindowRow key={`${window.label}-${window.windowSeconds}`} window={window} />
      ))}
    </ul>
  );
}

function UsageWindowRow({ window }: { readonly window: UsageWindow }) {
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
      </div>
      {window.resetAt !== null ? <div className="gc-usage__reset">{formatReset(window.resetAt)}</div> : null}
    </li>
  );
}

function clampWidth(percent: number): number {
  return Math.max(0, Math.min(100, percent));
}

function formatReset(resetAt: number): string {
  return `resets ${new Date(resetAt).toLocaleString()}`;
}
