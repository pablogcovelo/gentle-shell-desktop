import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_AVAILABLE_MODELS, parseAvailableModels, parseAvailableThinkingLevels, parseSessionStats, parseSessionState } from "./sessionStats";

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
      // palette-command-arguments T2: the documented frame's own sessionName,
      // now decoded instead of dropped.
      sessionName: "my-feature-work",
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

    expect(parseSessionState({ ...documented, model: null })).toEqual({ thinkingLevel: "medium", sessionName: "my-feature-work" });
    expect(parseSessionState({ ...documented, model: undefined })).toEqual({ thinkingLevel: "medium", sessionName: "my-feature-work" });
  });

  // S5 (desktop-workspace-registry-and-diagnostics): the isolated home with
  // no signed-in model answers "model":{"id":"unknown","name":"unknown"}.
  // That literal wire value must never reach the UI's label: the parser
  // normalizes it (and the documented null) into NO model identity, and —
  // because a successful get_state reply is an explicit statement about the
  // model — a reply that says "no model" also clears a previously folded one.
  it("normalizes the literal unknown model (isolated home) into NO model identity, never the word unknown", () => {
    const documented = readFixtureLine(1).data as Record<string, unknown>;

    const unknownModel = parseSessionState({
      ...documented,
      model: { id: "unknown", name: "unknown", provider: "anthropic" },
    });
    expect(unknownModel).toEqual({ thinkingLevel: "medium", sessionName: "my-feature-work" });
  });

  it("clears a previously folded model when a later get_state answers model null (an explicit no-model statement)", () => {
    const documented = readFixtureLine(1).data as Record<string, unknown>;

    // The parser itself cannot see the previous identity; the CLEARS are the
    // mechanism the caller's merge uses (PiSession spreads the parsed
    // partial over state.session), so the null-model answer carries explicit
    // undefined model fields instead of silently omitting them.
    const noModel = parseSessionState({ ...documented, model: null });
    expect(noModel?.modelId).toBeUndefined();
    expect(noModel?.modelName).toBeUndefined();
    expect(noModel?.modelProvider).toBeUndefined();
    expect(noModel?.thinkingLevel).toBe("medium");
  });

  // palette-command-arguments T2 (S4): the wire carries the session's own
  // name in `get_state`'s `sessionName` — the prefill for the `name`
  // screen. A non-empty string is the name; anything else (absent, empty,
  // non-string) is NOT a name and must never be turned into one.
  it("decodes the session name the child reports, and never turns an empty string into a name", () => {
    const documented = readFixtureLine(1).data as Record<string, unknown>;

    expect(parseSessionState({ ...documented, sessionName: "Write the README intro" })).toEqual({
      modelId: "claude-sonnet-4-20250514",
      modelName: "Claude Sonnet 4",
      modelProvider: "anthropic",
      thinkingLevel: "medium",
      sessionName: "Write the README intro",
    });
    // Empty is not a name: no name is supplied, nothing is invented.
    const empty = parseSessionState({ ...documented, sessionName: "" }); // eslint-disable-line @typescript-eslint/no-unnecessary-condition
    expect(empty?.sessionName).toBeUndefined();
    // A non-string value is not the documented shape for the field either.
    const wrongType = parseSessionState({ ...documented, sessionName: 42 });
    expect(wrongType?.sessionName).toBeUndefined();
  });

  it("clears a previously folded session name when a later get_state answers without one (an explicit no-name statement)", () => {
    const documented = readFixtureLine(1).data as Record<string, unknown>;

    // The parser cannot see the previous identity; the CLEAR is the
    // mechanism the caller's merge uses (PiSession spreads the parsed
    // partial over state.session), so a nameless get_state answer carries
    // an explicit undefined sessionName instead of silently omitting it.
    // (Spreading `sessionName: undefined` over the documented frame is
    // exactly what the wire does for an unnamed session: the key serializes
    // as absent, and the parser sees data.sessionName === undefined.)
    const noName = parseSessionState({ ...documented, sessionName: undefined });
    expect(noName).toHaveProperty("sessionName", undefined);
  });

  it("keeps a model with only an id, and drops a wrongly typed model instead of guessing", () => {
    const documented = readFixtureLine(1).data as Record<string, unknown>;

    expect(parseSessionState({ ...documented, model: { id: "some-model" } })).toEqual({
      modelId: "some-model",
      thinkingLevel: "medium",
      sessionName: "my-feature-work",
    });
    expect(parseSessionState({ ...documented, model: { name: "no id" } })).toEqual({ thinkingLevel: "medium", sessionName: "my-feature-work" });
    expect(parseSessionState({ ...documented, model: "claude" })).toEqual({ thinkingLevel: "medium", sessionName: "my-feature-work" });
  });
});

// ---------------------------------------------------------------------------
// The available reads (palette-command-arguments T1): pi's own
// `get_available_models` and `get_available_thinking_levels` replies —
// ordinary RPC commands correlated by `id`, the same family of decoders as
// get_state/get_session_stats above. Same modelling rule: keep exactly the
// documented fields, drop a wrongly typed entry rather than coercing, and
// return `undefined` when the payload is not the documented shape at all.
// ---------------------------------------------------------------------------

describe("parseAvailableModels (get_available_models, palette-command-arguments T1)", () => {
  /** pi-ai's `Model`: identified by `provider` + `id`, displayed by `name`. */
  function model(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic", ...overrides };
  }

  it("parses the documented payload: every entry identified by provider/id and labelled by its own name", () => {
    const parsed = parseAvailableModels({ models: [model(), model({ id: "gpt-5", name: "GPT-5", provider: "openai" })] });

    expect(parsed).toEqual({
      models: [
        { provider: "anthropic", id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
        { provider: "openai", id: "gpt-5", label: "GPT-5" },
      ],
      truncated: false,
    });
  });

  it("renders a model with no usable display name as provider/id — the identity string the selector confirms, never an invented name", () => {
    const parsed = parseAvailableModels({
      models: [model({ name: "" }), model({ name: undefined, id: "mystery-model", provider: "openai" })],
    });

    expect(parsed?.models).toEqual([
      { provider: "anthropic", id: "claude-sonnet-4-20250514", label: "anthropic/claude-sonnet-4-20250514" },
      { provider: "openai", id: "mystery-model", label: "openai/mystery-model" },
    ]);
  });

  it("drops entries without a non-empty string id or provider, and a non-record entry, fail-closed", () => {
    const parsed = parseAvailableModels({
      models: [
        model(),
        model({ id: "" }), // empty id
        model({ id: undefined }), // no id at all
        model({ provider: "" }), // empty provider
        model({ provider: 42 }), // non-string provider
        "not-a-record",
      ],
    });

    expect(parsed?.models).toEqual([{ provider: "anthropic", id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" }]);
  });

  it("yields undefined when the payload is not the documented shape (no object, or a non-array models)", () => {
    expect(parseAvailableModels(undefined)).toBeUndefined();
    expect(parseAvailableModels("nope")).toBeUndefined();
    expect(parseAvailableModels({ models: "not-an-array" })).toBeUndefined();
    expect(parseAvailableModels({})).toBeUndefined();
  });

  it("an empty models array is a valid answer: the empty ok list, truncated: false", () => {
    expect(parseAvailableModels({ models: [] })).toEqual({ models: [], truncated: false });
  });

  it("bounds the list and flags the truncation rather than silently clipping", () => {
    const oversized = Array.from({ length: MAX_AVAILABLE_MODELS + 25 }, (_, index) =>
      model({ id: `model-${index}`, name: undefined }),
    );
    const parsed = parseAvailableModels({ models: oversized });

    expect(parsed?.models).toHaveLength(MAX_AVAILABLE_MODELS);
    expect(parsed?.truncated).toBe(true);
    // What is kept is the list's own HEAD, in the child's order.
    expect(parsed?.models[0]).toEqual({ provider: "anthropic", id: "model-0", label: "anthropic/model-0" });
    expect(parsed?.models[MAX_AVAILABLE_MODELS - 1]).toEqual({
      provider: "anthropic",
      id: `model-${MAX_AVAILABLE_MODELS - 1}`,
      label: `anthropic/model-${MAX_AVAILABLE_MODELS - 1}`,
    });
  });
});

describe("parseAvailableThinkingLevels (get_available_thinking_levels, palette-command-arguments T1)", () => {
  it("parses the documented payload, keeping only members of the closed THINKING_LEVEL union", () => {
    expect(parseAvailableThinkingLevels({ levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] })).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("drops a member outside the closed union and a non-string member, instead of coercing them", () => {
    expect(parseAvailableThinkingLevels({ levels: ["medium", "extreme", 42, null, "max"] })).toEqual(["medium", "max"]);
  });

  it("yields undefined when the payload is not the documented shape (no object, or a non-array levels)", () => {
    expect(parseAvailableThinkingLevels(undefined)).toBeUndefined();
    expect(parseAvailableThinkingLevels("nope")).toBeUndefined();
    expect(parseAvailableThinkingLevels({ levels: "medium" })).toBeUndefined();
    expect(parseAvailableThinkingLevels({})).toBeUndefined();
  });

  it("an empty levels array is a valid answer: the child offers nothing, and nothing is invented for it", () => {
    expect(parseAvailableThinkingLevels({ levels: [] })).toEqual([]);
  });
});
