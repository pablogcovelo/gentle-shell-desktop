import type { ToolVocabulary, ToolVocabularyEntry } from "@shared/bridge-types";

export { resolveToolCategory } from "@shared/toolVocabulary";

/**
 * Decoder and resolver for gentle-pi's published action vocabulary (T7b;
 * contract: gentle-pi `docs/desktop-rpc.md` "tool_vocabulary", implemented in
 * its `lib/tool-vocabulary.ts` — the same tables its TUI renders from, so the
 * data here cannot drift from the terminal).
 *
 * The payload is data, not render: `categories` lists the vocabulary the
 * child publishes, and each `entries[]` item maps ONE glyph to either an
 * exact `tools` list or a `patterns` list of globs, optionally with a
 * `heading` the TUI shows in place of the tool name.
 *
 * Rules, same standard as the rest of this layer:
 * - model only what the contract documents, drop wrongly typed fields, and
 *   return `undefined` when the payload is not the documented shape at all;
 * - never invent a category for a tool the vocabulary does not mention — the
 *   caller renders the raw tool name instead, which is honest;
 * - `memory` is deliberately absent from the published vocabulary, and this
 *   module certifies that absence rather than filling the gap.
 *
 * Fixture provenance: `__fixtures__/tool-vocabulary.json` is the `data` of a
 * real `tool_vocabulary` reply captured from a live `gentle-shell --mode rpc`
 * child, not a hand-written sample.
 */
export function parseToolVocabulary(data: unknown): ToolVocabulary | undefined {
  if (!isRecord(data)) return undefined;
  if (!Array.isArray(data.categories) || !Array.isArray(data.entries)) return undefined;

  const categories = data.categories.filter((value): value is string => typeof value === "string");
  if (categories.length !== data.categories.length) return undefined;

  const entries: ToolVocabularyEntry[] = [];
  for (const raw of data.entries) {
    const entry = toEntry(raw);
    if (!entry) return undefined;
    entries.push(entry);
  }
  return { categories, entries };
}

function toEntry(value: unknown): ToolVocabularyEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.category !== "string" || value.category.length === 0) return undefined;
  if (typeof value.glyph !== "string" || value.glyph.length === 0) return undefined;

  const tools = toStrings(value.tools);
  const patterns = toStrings(value.patterns);
  // A matcher with neither tools nor patterns can never resolve anything, so
  // it is not part of a usable vocabulary.
  if (!tools && !patterns) return undefined;

  return {
    category: value.category,
    glyph: value.glyph,
    ...(tools ? { tools } : {}),
    ...(patterns ? { patterns } : {}),
    ...(typeof value.heading === "string" && value.heading.length > 0 ? { heading: value.heading } : {}),
  };
}

function toStrings(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every((item): item is string => typeof item === "string" && item.length > 0)) return undefined;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
