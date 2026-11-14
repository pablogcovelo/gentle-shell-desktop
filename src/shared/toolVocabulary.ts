import type { ToolVocabulary, ToolVocabularyEntry } from "./bridge-types";

/**
 * Resolver for gentle-pi's published action vocabulary (desktop-rpc T7b).
 *
 * Lives under `src/shared` because two processes need it: main parses the
 * payload and the renderer resolves each call's glyph (Scope Rule — a thing
 * used by 2+ processes is shared, not duplicated). Pure data in, data out: no
 * Node, no Electron, no React.
 *
 * Exact tool matches win over patterns, so a vocabulary that later grows a
 * specific entry for a tool keeps it. Nothing is invented: a tool the
 * vocabulary does not cover resolves to `undefined`, and the caller renders
 * the raw tool name instead of a guess.
 */
export function resolveToolCategory(
  vocabulary: ToolVocabulary | undefined,
  toolName: string,
): ToolVocabularyEntry | undefined {
  if (!vocabulary || toolName.length === 0) return undefined;
  for (const entry of vocabulary.entries) {
    if (entry.tools?.includes(toolName)) return entry;
  }
  for (const entry of vocabulary.entries) {
    if (entry.patterns?.some((pattern: string) => matchesPattern(pattern, toolName))) return entry;
  }
  return undefined;
}

/** A vocabulary pattern is a glob with a single `*` (gentle-pi's form:
 * `gentle_review*`). Anything more elaborate is compared literally. */
function matchesPattern(pattern: string, value: string): boolean {
  const star = pattern.indexOf("*");
  if (star === -1) return pattern === value;
  return value.startsWith(pattern.slice(0, star)) && value.endsWith(pattern.slice(star + 1));
}
