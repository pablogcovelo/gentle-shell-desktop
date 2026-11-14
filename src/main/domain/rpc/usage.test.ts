import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mergeUsageProviders, parseRateLimitEvent, parseSubscriptionUsage } from "./usage";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * `usage-contract.jsonl` carries the two documented wire frames of
 * gentle-pi's usage contract (`docs/desktop-rpc.md` "get_subscription_usage"
 * and "rate_limit"), verbatim. The documented examples ARE the contract's
 * canonical payload shapes — this app must parse exactly those, so the
 * tests read them off the fixture instead of re-typing them.
 */
function readFixtureEnvelope(name: string, index: number): unknown {
  const raw = readFileSync(path.join(__dirname, "__fixtures__", name), "utf8");
  const line = raw.split("\n")[index];
  if (!line) throw new Error(`fixture ${name} has no line ${index}`);
  const frame = JSON.parse(line) as { widgetLines?: string[] };
  return JSON.parse(frame.widgetLines![0]!);
}

describe("parseSubscriptionUsage", () => {
  it("parses the documented get_subscription_usage payload shape", () => {
    const envelope = readFixtureEnvelope("usage-contract.jsonl", 0) as { data?: unknown };

    expect(parseSubscriptionUsage(envelope.data)).toEqual({
      providers: [
        {
          provider: "openai-codex",
          status: "ok",
          fetchedAt: 1788600000000,
          plan: "pro",
          limits: [
            {
              name: "codex",
              limitReached: false,
              windows: [{ label: "week", usedPercent: 40, windowSeconds: 604800, resetAt: 1788777491000 }],
            },
          ],
        },
      ],
    });
  });

  it("a provider with no windows parses: an empty limits array stays empty, an absent one stays absent", () => {
    const usage = parseSubscriptionUsage({
      providers: [
        { provider: "openai-codex", status: "ok", limits: [] },
        { provider: "anthropic", status: "pending" },
      ],
    });

    expect(usage).toEqual({
      providers: [
        { provider: "openai-codex", status: "ok", limits: [] },
        { provider: "anthropic", status: "pending" },
      ],
    });
  });

  it("preserves the raw used/budget allowance numbers only when the provider reports them", () => {
    const usage = parseSubscriptionUsage({
      providers: [
        {
          provider: "nan",
          status: "ok",
          limits: [
            { name: "nan", limitReached: false, windows: [{ label: "week", usedPercent: 40, windowSeconds: 604800, resetAt: null }], used: 120, budget: 400 },
            { name: "nan", limitReached: false, windows: [] },
          ],
        },
      ],
    });

    expect(usage?.providers[0]?.limits?.[0]).toEqual({
      name: "nan",
      limitReached: false,
      windows: [{ label: "week", usedPercent: 40, windowSeconds: 604800, resetAt: null }],
      used: 120,
      budget: 400,
    });
    expect(usage?.providers[0]?.limits?.[1]).not.toHaveProperty("used");
    expect(usage?.providers[0]?.limits?.[1]).not.toHaveProperty("budget");
  });

  it("a payload whose providers value is not an array is unusable, not empty", () => {
    expect(parseSubscriptionUsage(undefined)).toBeUndefined();
    expect(parseSubscriptionUsage("nope")).toBeUndefined();
    expect(parseSubscriptionUsage({})).toBeUndefined();
    expect(parseSubscriptionUsage({ providers: "nope" })).toBeUndefined();
  });

  it("drops malformed provider entries without dropping the usable ones, and never throws", () => {
    const usage = parseSubscriptionUsage({
      providers: [
        "not an object",
        { status: "ok" }, // no provider name
        { provider: "x", status: "excellent" }, // unknown status
        { provider: "x" }, // no status
        { provider: "good", status: "ok", fetchedAt: "yesterday", plan: 42 },
      ],
    });

    expect(usage).toEqual({ providers: [{ provider: "good", status: "ok" }] });
  });

  it("drops malformed limits and windows individually, keeping the usable rest", () => {
    const usage = parseSubscriptionUsage({
      providers: [
        {
          provider: "p",
          status: "ok",
          limits: [
            "nope",
            { limitReached: false, windows: [] }, // no name
            { name: "l", windows: [] }, // no limitReached
            { name: "l", limitReached: "no", windows: [] }, // non-boolean limitReached
            { name: "l", limitReached: false, windows: "nope" }, // windows not an array
            {
              name: "good",
              limitReached: false,
              windows: [
                "nope",
                { label: "w", usedPercent: "40", windowSeconds: 604800, resetAt: null }, // non-number percent
                { label: "w", usedPercent: 40, windowSeconds: "week", resetAt: null }, // non-number seconds
                { label: "w", usedPercent: 40, windowSeconds: 604800 }, // missing resetAt
                { label: "w", usedPercent: 40, windowSeconds: 604800, resetAt: "soon" }, // non-number resetAt
                { label: "w", usedPercent: 1e400, windowSeconds: 604800, resetAt: null }, // non-finite percent
                { label: "good", usedPercent: 40, windowSeconds: 604800, resetAt: null },
                { label: "good2", usedPercent: 0, windowSeconds: 604800, resetAt: 1788777491000 },
              ],
            },
          ],
        },
      ],
    });

    expect(usage?.providers[0]?.limits).toHaveLength(1);
    expect(usage?.providers[0]?.limits?.[0]?.windows).toEqual([
      { label: "good", usedPercent: 40, windowSeconds: 604800, resetAt: null },
      { label: "good2", usedPercent: 0, windowSeconds: 604800, resetAt: 1788777491000 },
    ]);
  });

  it("an empty providers array parses as an empty (render-nothing) usage, not as malformed", () => {
    expect(parseSubscriptionUsage({ providers: [] })).toEqual({ providers: [] });
  });
});

describe("parseRateLimitEvent", () => {
  it("parses the documented rate_limit event snapshots", () => {
    const envelope = readFixtureEnvelope("usage-contract.jsonl", 1) as { data?: unknown };

    expect(parseRateLimitEvent(envelope.data)).toEqual({
      providers: [
        {
          provider: "anthropic",
          status: "ok",
          fetchedAt: 1788600000000,
          limits: [
            {
              name: "claude",
              limitReached: false,
              windows: [
                { label: "5h", usedPercent: 25, windowSeconds: 18000, resetAt: null },
                { label: "week", usedPercent: 90, windowSeconds: 604800, resetAt: null },
              ],
            },
          ],
        },
      ],
    });
  });

  it("a malformed or unknown-source event is unusable, not empty", () => {
    expect(parseRateLimitEvent(undefined)).toBeUndefined();
    expect(parseRateLimitEvent({})).toBeUndefined();
    expect(parseRateLimitEvent({ source: "response" })).toBeUndefined();
    expect(parseRateLimitEvent({ source: "response", snapshots: "nope" })).toBeUndefined();
    expect(parseRateLimitEvent({ source: "hacked", snapshots: [] })).toBeUndefined();
  });

  it("drops malformed snapshot entries individually, keeping the usable rest", () => {
    const event = parseRateLimitEvent({
      source: "refresh",
      snapshots: ["nope", { provider: "p", status: "nope" }, { provider: "good", status: "pending" }],
    });

    expect(event).toEqual({ providers: [{ provider: "good", status: "pending" }] });
  });
});

describe("mergeUsageProviders", () => {
  it("upserts each snapshot by provider, keeping the providers the event did not touch", () => {
    const existing = {
      providers: [
        { provider: "openai-codex", status: "ok" as const, plan: "pro" },
        { provider: "anthropic", status: "pending" as const },
      ],
    };

    const merged = mergeUsageProviders(existing, [
      { provider: "anthropic", status: "ok", limits: [{ name: "claude", limitReached: false, windows: [] }] },
    ]);

    expect(merged.providers).toEqual([
      { provider: "openai-codex", status: "ok", plan: "pro" },
      { provider: "anthropic", status: "ok", limits: [{ name: "claude", limitReached: false, windows: [] }] },
    ]);
  });

  it("appends providers the previous usage did not know about", () => {
    const merged = mergeUsageProviders(undefined, [{ provider: "nan", status: "ok" }]);
    expect(merged.providers).toEqual([{ provider: "nan", status: "ok" }]);
  });
});
