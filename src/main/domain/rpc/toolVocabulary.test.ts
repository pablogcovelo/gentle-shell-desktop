import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseToolVocabulary, resolveToolCategory } from "./toolVocabulary";

/**
 * `__fixtures__/tool-vocabulary.json` is the `data` of a real
 * `tool_vocabulary` reply captured from a live `gentle-shell --mode rpc`
 * child (as is), not a hand-written sample: the vocabulary belongs to
 * gentle-pi and is derived from the same tables its TUI renders from.
 */
const CAPTURED = JSON.parse(
  readFileSync(path.join(__dirname, "__fixtures__", "tool-vocabulary.json"), "utf8"),
) as unknown;

describe("parseToolVocabulary", () => {
  it("parses the captured payload into categories and entries", () => {
    const vocabulary = parseToolVocabulary(CAPTURED);

    expect(vocabulary?.categories).toEqual([
      "read",
      "edit",
      "write",
      "search",
      "list",
      "bash",
      "delegation",
      "rdd",
    ]);
    expect(vocabulary?.entries.length).toBe(17);
    expect(vocabulary?.entries[0]).toEqual({ category: "read", glyph: "≡", tools: ["read"] });
  });

  it("keeps a heading only when the child published one", () => {
    const vocabulary = parseToolVocabulary(CAPTURED);
    const delegating = vocabulary?.entries.find((entry) => entry.tools?.includes("subagent_run"));

    expect(delegating?.heading).toBe("Delegating");
    const read = vocabulary?.entries.find((entry) => entry.category === "read");
    expect(read?.heading).toBeUndefined();
  });

  it("certifies that `memory` is absent instead of inventing the family", () => {
    const vocabulary = parseToolVocabulary(CAPTURED);

    expect(vocabulary?.categories).not.toContain("memory");
    expect(resolveToolCategory(vocabulary, "mem_save")).toBeUndefined();
  });

  it("returns undefined for payloads that are not the documented shape", () => {
    expect(parseToolVocabulary(undefined)).toBeUndefined();
    expect(parseToolVocabulary({ categories: [], entries: {} })).toBeUndefined();
    expect(parseToolVocabulary({ categories: [1], entries: [] })).toBeUndefined();
    expect(parseToolVocabulary({ categories: [], entries: [{ category: "read" }] })).toBeUndefined();
    // An entry with neither `tools` nor `patterns` can never resolve anything.
    expect(parseToolVocabulary({ categories: ["x"], entries: [{ category: "x", glyph: "•" }] })).toBeUndefined();
  });
});

describe("resolveToolCategory", () => {
  const vocabulary = parseToolVocabulary(CAPTURED);

  it("resolves an exact tool name to its glyph and category", () => {
    expect(resolveToolCategory(vocabulary, "read")).toMatchObject({ category: "read", glyph: "≡" });
    expect(resolveToolCategory(vocabulary, "bash")).toMatchObject({ category: "bash", glyph: "$" });
    expect(resolveToolCategory(vocabulary, "subagent_cancel")).toMatchObject({
      category: "delegation",
      glyph: "⨯",
    });
  });

  it("resolves a published pattern, which is how rdd is matched", () => {
    expect(resolveToolCategory(vocabulary, "gentle_review_start")).toMatchObject({
      category: "rdd",
      glyph: "🌹",
    });
  });

  it("resolves nothing for a tool the vocabulary does not cover", () => {
    expect(resolveToolCategory(vocabulary, "some_future_tool")).toBeUndefined();
    expect(resolveToolCategory(undefined, "read")).toBeUndefined();
    expect(resolveToolCategory(vocabulary, "")).toBeUndefined();
  });
});
