import { useState } from "react";
import type { ToolCallView, ToolVocabulary, ToolVocabularyEntry } from "@shared/bridge-types";
import { resolveToolCategory } from "@shared/toolVocabulary";
import "./ActionRows.css";

export interface ActionRowsProps {
  /** The rows this group shows, oldest first (ChatState.toolCalls). */
  readonly toolCalls?: readonly ToolCallView[];
  /** The vocabulary the child published. Absent until it answers
   * `tool_vocabulary`, and then every row falls back to its raw tool name or
   * the app-owned families (S4) — the app never invents a protocol category
   * the child does not publish. */
  readonly vocabulary?: ToolVocabulary;
}

/**
 * The orphan group (chat-action-rows T3, S2): rows that belong to NO turn —
 * never bound, or bound to a message the thread dropped — render here, in
 * their own clearly separate region after the thread (MessageThread), never
 * nested inside a bubble. The group is a plain labelled block, and each row
 * is a standalone `.gc-action-row` — never a `<ul>`/`<li>` list, so a group
 * of any size, including one row, announces no list. Deliberately NOT
 * messages: a tool call never becomes a bubble.
 */
export function ActionRows({ toolCalls, vocabulary }: ActionRowsProps) {
  const calls = toolCalls ?? [];
  if (calls.length === 0) return null;

  return (
    <div className="gc-action-rows" data-testid="gc-action-rows" role="group" aria-label="Tool actions">
      {calls.map((call) => (
        <ToolActionRow key={call.id} call={call} vocabulary={vocabulary} />
      ))}
    </div>
  );
}

/**
 * One standalone row for one tool execution (chat-action-rows T3, S1): it
 * renders directly in the message flow at the position of its turn's `tool`
 * part — inside the bubble that produced it (MessageBubble) or, for a call
 * that belongs to no turn, in the orphan region (ActionRows) — with the
 * glyph the vocabulary assigns, expandable to the exact arguments and
 * result, the same rows the TUI shows (S2).
 */
export function ToolActionRow({ call, vocabulary }: { call: ToolCallView; vocabulary?: ToolVocabulary }) {
  const [open, setOpen] = useState(false);
  const entry = resolveRowEntry(vocabulary, call.toolName);
  const glyph = entry?.glyph ?? "•";
  const label = entry?.heading ?? call.toolName;
  let state = "done";
  if (call.status === "running") state = "running";
  else if (call.isError) state = "failed";

  return (
    <div className="gc-action-row" data-testid="gc-action-row" data-category={entry?.category ?? "unknown"} data-status={state}>
      <button
        type="button"
        className="gc-action-row__summary"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="gc-action-row__glyph" aria-hidden="true">
          {glyph}
        </span>
        <span className="gc-action-row__label">{label}</span>
        {entry?.heading && entry.heading !== call.toolName ? (
          <code className="gc-action-row__tool">{call.toolName}</code>
        ) : null}
        <span className="gc-action-row__state">{state}</span>
      </button>
      {open ? (
        <div className="gc-action-row__detail">
          <Detail label="args" value={call.args} />
          <Detail label="result" value={call.result} />
          <Variants vocabulary={vocabulary} entry={entry} ownGlyph={glyph} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * S14 (gui-design-alignment T5): the expanded detail also shows the other
 * glyphs the row's published category renders, as quiet chips — the same
 * variants the design board lists. Derived entirely from the child's
 * vocabulary: distinct `glyph`s of every entry of the row's category, in
 * vocabulary order, first occurrence kept (the published vocabulary repeats
 * `✉` and `☰` for a second delegation tool each). The row only appears
 * when the category publishes two or more distinct glyphs, so single-glyph
 * categories (read, edit, write, list, bash, rdd) and the app-owned memory
 * fallback (no published entries) stay silent.
 */
function Variants({ vocabulary, entry, ownGlyph }: { vocabulary?: ToolVocabulary; entry?: ToolVocabularyEntry; ownGlyph: string }) {
  if (!vocabulary || !entry) return null;
  const glyphs: string[] = [];
  const entries = vocabulary.entries.filter((candidate) => candidate.category === entry.category);
  for (const candidate of entries) {
    if (!glyphs.includes(candidate.glyph)) glyphs.push(candidate.glyph);
  }
  if (glyphs.length < 2) return null;
  // `phases` when every entry of the category carries a heading (delegation
  // does); otherwise the glyphs are alternative reports, not phases.
  const label = entries.every((candidate) => candidate.heading !== undefined) ? "phases" : "also reports";
  return (
    <div className="gc-action-row__variants" data-testid="gc-action-row__variants">
      <span className="gc-action-row__variants-label">{label}</span>
      {glyphs.map((glyph) => (
        <span
          key={glyph}
          className="gc-action-row__chip"
          aria-current={glyph === ownGlyph ? "true" : undefined}
          aria-label={`${entry.category} glyph ${glyph}`}
        >
          {glyph}
        </span>
      ))}
    </div>
  );
}

/**
 * T5 (S4): the child's published vocabulary does not know memory — the app
 * owns this family — so `mem_*` falls back to the `memory` category,
 * heading `Engram`, glyph `🧠`. Resolved AFTER the published vocabulary
 * lookup, so a published entry always wins; an unknown tool still resolves
 * to `undefined` and renders its raw name (resolveToolCategory's contract
 * is untouched, and nothing is invented on the wire).
 */
const MEMORY_ENTRY: ToolVocabularyEntry = { category: "memory", glyph: "🧠", heading: "Engram" };

function resolveRowEntry(vocabulary: ToolVocabulary | undefined, toolName: string): ToolVocabularyEntry | undefined {
  return resolveToolCategory(vocabulary, toolName) ?? (toolName.startsWith("mem_") ? MEMORY_ENTRY : undefined);
}

/** Renders a payload verbatim: pretty-printed when it serializes, a plain
 * string when it does not. Nothing is summarised away. */
function Detail({ label, value }: { label: string; value: unknown }) {
  if (value === undefined) return null;
  return (
    <div className="gc-action-row__field">
      <span className="gc-action-row__field-label">{label}</span>
      <pre className="gc-action-row__field-value">{formatValue(value)}</pre>
    </div>
  );
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
