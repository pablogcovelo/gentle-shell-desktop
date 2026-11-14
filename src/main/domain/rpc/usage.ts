import {
  SUBSCRIPTION_USAGE_STATUS,
  type SubscriptionUsage,
  type UsageLimit,
  type UsageProvider,
  type UsageWindow,
} from "@shared/bridge-types";

/**
 * Decoder for gentle-pi's subscription-usage wire shapes (desktop-rpc T3;
 * contract: gentle-pi `docs/desktop-rpc.md` "get_subscription_usage" and
 * "rate_limit"). Pure domain module (hexagonal main process, see
 * src/README.md): no Node or Electron imports, never throws.
 *
 * Modelling rule: the parser keeps exactly the fields the contract
 * documents — provider identity, one of five statuses, `fetchedAt` when a
 * snapshot exists, `plan` only when public, and per-limit
 * `name`/`limitReached`/windows (`label`, `usedPercent`, `windowSeconds`,
 * `resetAt`, plus the nan provider's raw `used`/`budget` allowance numbers
 * when reported). Anything else on the wire is ignored, and a field that
 * does not hold the documented type is dropped rather than coerced — the
 * UI must never render a guess. Malformed payloads return `undefined` (or
 * drop the malformed entry), so the caller keeps the previous state, same
 * standard as U1's malformed-frame handling.
 */

const USAGE_PROVIDER_STATUSES: ReadonlySet<string> = new Set(Object.values(SUBSCRIPTION_USAGE_STATUS));
const RATE_LIMIT_SOURCES: ReadonlySet<string> = new Set(["response", "refresh"]);

/**
 * Parses the `data` of a `get_subscription_usage` response into the typed
 * shape the renderer renders. Returns `undefined` when the payload is not
 * the documented shape at all (no object, or `providers` is not an array):
 * the caller must keep whatever usage state it already had instead of
 * treating this as "no usage".
 */
export function parseSubscriptionUsage(data: unknown): SubscriptionUsage | undefined {
  if (!isRecord(data) || !Array.isArray(data.providers)) return undefined;
  return { providers: data.providers.map(toUsageProvider).filter((provider): provider is UsageProvider => provider !== undefined) };
}

/**
 * Parses the `data` of a `rate_limit` event: `{ source, snapshots }` where
 * each snapshot is the same safe projection as a `get_subscription_usage`
 * provider entry (docs/desktop-rpc.md "rate_limit"). Returns `undefined`
 * for a malformed or unknown-source event; malformed snapshot entries are
 * dropped individually, keeping the usable rest.
 */
export function parseRateLimitEvent(data: unknown): SubscriptionUsage | undefined {
  if (!isRecord(data) || typeof data.source !== "string" || !RATE_LIMIT_SOURCES.has(data.source) || !Array.isArray(data.snapshots)) {
    return undefined;
  }
  return { providers: data.snapshots.map(toUsageProvider).filter((provider): provider is UsageProvider => provider !== undefined) };
}

/**
 * Merges a `rate_limit` event's changed snapshots into the usage state:
 * each snapshot replaces its provider's entry in place (the event carries
 * every changed snapshot, not the whole scope), providers the event did
 * not touch are kept, and unknown ones are appended. The
 * `get_subscription_usage` response, by contrast, IS the whole current
 * scope and replaces state wholesale (see PiSession.requestUsage).
 */
export function mergeUsageProviders(existing: SubscriptionUsage | undefined, snapshots: readonly UsageProvider[]): SubscriptionUsage {
  const providers = [...(existing?.providers ?? [])];
  for (const snapshot of snapshots) {
    const index = providers.findIndex((provider) => provider.provider === snapshot.provider);
    if (index === -1) providers.push(snapshot);
    else providers[index] = snapshot;
  }
  return { providers };
}

function toUsageProvider(value: unknown): UsageProvider | undefined {
  if (!isRecord(value) || typeof value.provider !== "string" || value.provider.length === 0) return undefined;
  if (typeof value.status !== "string" || !USAGE_PROVIDER_STATUSES.has(value.status)) return undefined;

  return {
    provider: value.provider,
    status: value.status as UsageProvider["status"],
    // `fetchedAt` is present when there is a snapshot; a present-but-wrongly
    // typed one is dropped rather than coercing a guess.
    ...(typeof value.fetchedAt === "number" && Number.isFinite(value.fetchedAt) ? { fetchedAt: value.fetchedAt } : {}),
    ...(typeof value.plan === "string" && value.plan.length > 0 ? { plan: value.plan } : {}),
    ...(Array.isArray(value.limits)
      ? { limits: value.limits.map(toUsageLimit).filter((limit): limit is UsageLimit => limit !== undefined) }
      : {}),
  };
}

function toUsageLimit(value: unknown): UsageLimit | undefined {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0 || typeof value.limitReached !== "boolean") {
    return undefined;
  }
  if (!Array.isArray(value.windows)) return undefined;

  return {
    name: value.name,
    limitReached: value.limitReached,
    windows: value.windows.map(toUsageWindow).filter((window): window is UsageWindow => window !== undefined),
    // The nan provider's raw allowance numbers, kept only when reported.
    ...(typeof value.used === "number" && Number.isFinite(value.used) ? { used: value.used } : {}),
    ...(typeof value.budget === "number" && Number.isFinite(value.budget) ? { budget: value.budget } : {}),
  };
}

function toUsageWindow(value: unknown): UsageWindow | undefined {
  if (!isRecord(value) || typeof value.label !== "string" || value.label.length === 0) return undefined;
  if (typeof value.usedPercent !== "number" || !Number.isFinite(value.usedPercent)) return undefined;
  if (typeof value.windowSeconds !== "number" || !Number.isFinite(value.windowSeconds)) return undefined;
  // `resetAt` is a number or exactly `null` (the provider does not report
  // one); anything else means the window is not trustworthy.
  if (value.resetAt !== null && (typeof value.resetAt !== "number" || !Number.isFinite(value.resetAt))) return undefined;

  return { label: value.label, usedPercent: value.usedPercent, windowSeconds: value.windowSeconds, resetAt: value.resetAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
