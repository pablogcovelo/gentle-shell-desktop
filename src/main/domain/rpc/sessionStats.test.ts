import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSessionStats, parseSessionState } from "./sessionStats";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * `session-stats.jsonl` carries the two documented wire frames of pi's own
 * RPC protocol (docs/rpc.md "get_session_stats" and "get_state"), verbatim
 * down to the documented example values, with the correlation `id` the
 * protocol lets every command carry. The documented examples ARE the
 * canonical payload shapes — this app must parse exactly those, so the
 * tests read them off the fixture instead of re-typing them.
 */
function readFixtureLine(index: number): Record<string, unknown> {
  const raw = readFileSync(path.join(__dirname, "__fixtures__", "session-stats.jsonl"), "utf8");
  const line = raw.split("\n")[index];
  if (!line) throw new Error(`fixture session-stats.jsonl has no line ${index}`);
  return JSON.parse(line) as Record<string, unknown>;
}

describe("parseSessionStats (get_session_stats, docs/rpc.md)", () => {
  it("parses the documented payload: tokens total, session cost and the child's own context usage", () => {
    const frame = readFixtureLine(0);

    expect(parseSessionStats(frame.data)).toEqual({
      tokensTotal: 105000,
      sessionCost: 0.45,
      contextTokens: 60000,
      contextWindow: 200000,
      contextPercent: 30,
    });
  });

  it("ignores a payload whose required core fields are missing or wrongly typed, without throwing", () => {
    const documented = readFixtureLine(0).data as Record<string, unknown>;

    expect(parseSessionStats(undefined)).toBeUndefined();
    expect(parseSessionStats("nope")).toBeUndefined();
    // `cost` is a number on the wire; a string is not the documented shape.
    expect(parseSessionStats({ ...documented, cost: "0.45" })).toBeUndefined();
    // `tokens` carries the five documented numeric fields; a wrong-typed
    // member is not the documented shape.
    expect(parseSessionStats({ ...documented, tokens: { ...(documented.tokens as Record<string, unknown>), total: "105000" } })).toBeUndefined();
    expect(parseSessionStats({ ...documented, tokens: undefined })).toBeUndefined();
  });

  it("keeps the cost and tokens when only contextUsage is malformed, and never invents context from tokens", () => {
    const documented = readFixtureLine(0).data as Record<string, unknown>;

    // contextUsage wrongly typed → context fields are simply not supplied.
    const malformedContext = parseSessionStats({ ...documented, contextUsage: { tokens: "60000" } });
    expect(malformedContext).toEqual({ tokensTotal: 105000, sessionCost: 0.45 });
    expect(malformedContext).not.toHaveProperty("contextPercent");
    expect(malformedContext).not.toHaveProperty("contextWindow");
    expect(malformedContext).not.toHaveProperty("contextTokens");

    // contextUsage omitted entirely → same: nothing guessed, no fallback
    // context window, no percentage derived from the accumulated tokens.
    const omittedContext = parseSessionStats({ ...documented, contextUsage: undefined });
    expect(omittedContext).toEqual({ tokensTotal: 105000, sessionCost: 0.45 });
  });

  it("keeps contextUsage supplied as unknown (right after compaction): null stays null, never zero", () => {
    const documented = readFixtureLine(0).data as Record<string, unknown>;

    const postCompaction = parseSessionStats({
      ...documented,
      contextUsage: { tokens: null, contextWindow: 200000, percent: null },
    });
    expect(postCompaction).toEqual({ tokensTotal: 105000, sessionCost: 0.45, contextTokens: null, contextWindow: 200000, contextPercent: null });
  });

  it("keeps a supplied zero cost as zero — supplied zero and unsupplied stay distinct", () => {
    const documented = readFixtureLine(0).data as Record<string, unknown>;

    expect(parseSessionStats({ ...documented, cost: 0 })).toMatchObject({ sessionCost: 0 });
  });
});

describe("parseSessionState (get_state, docs/rpc.md)", () => {
  it("parses the documented payload: the effective model and thinking level the child reports", () => {
    const frame = readFixtureLine(1);

    expect(parseSessionState(frame.data)).toEqual({
      modelId: "claude-sonnet-4-20250514",
      modelName: "Claude Sonnet 4",
      modelProvider: "anthropic",
      thinkingLevel: "medium",
    });
  });

  it("ignores a payload whose thinkingLevel is missing or outside the closed union, without throwing", () => {
    const documented = readFixtureLine(1).data as Record<string, unknown>;

    expect(parseSessionState(undefined)).toBeUndefined();
    expect(parseSessionState("nope")).toBeUndefined();
    expect(parseSessionState({ ...documented, thinkingLevel: undefined })).toBeUndefined();
    // The wire's thinking level is a closed union; an unknown member is
    // not something this app may invent a rendering for.
    expect(parseSessionState({ ...documented, thinkingLevel: "extreme" })).toBeUndefined();
  });

  it("accepts model null (documented) and keeps the thinking level, inventing no model identity", () => {
    const documented = readFixtureLine(1).data as Record<string, unknown>;

    expect(parseSessionState({ ...documented, model: null })).toEqual({ thinkingLevel: "medium" });
    expect(parseSessionState({ ...documented, model: undefined })).toEqual({ thinkingLevel: "medium" });
  });

  it("keeps a model with only an id, and drops a wrongly typed model instead of guessing", () => {
    const documented = readFixtureLine(1).data as Record<string, unknown>;

    expect(parseSessionState({ ...documented, model: { id: "some-model" } })).toEqual({
      modelId: "some-model",
      thinkingLevel: "medium",
    });
    expect(parseSessionState({ ...documented, model: { name: "no id" } })).toEqual({ thinkingLevel: "medium" });
    expect(parseSessionState({ ...documented, model: "claude" })).toEqual({ thinkingLevel: "medium" });
  });
});
