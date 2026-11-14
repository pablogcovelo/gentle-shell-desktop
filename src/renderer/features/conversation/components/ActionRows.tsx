import { useState } from "react";
import type { ToolCallView, ToolVocabulary } from "@shared/bridge-types";
import { resolveToolCategory } from "@shared/toolVocabulary";
import "./ActionRows.css";

export interface ActionRowsProps {
  /** The tool executions this chat has seen, newest last (ChatState.toolCalls). */
  readonly toolCalls?: readonly ToolCallView[];
  /** The vocabulary the child published. Absent until it answers
   * `tool_vocabulary`, and then every row falls back to its raw tool name —
   * the app never invents a category the child does not publish. */
  readonly vocabulary?: ToolVocabulary;
}

/**
 * The chat's non-conversational activity, as the terminal shows it: one
 * collapsed row per tool execution with the glyph the child's own vocabulary
 * assigns to it, expandable to the exact arguments and result.
 *
 * Deliberately NOT messages: a tool call never becomes a bubble, and the rows
 * live beside the thread rather than inside it, so the transcript keeps
 * meaning "what was said".
 */
export function ActionRows({ toolCalls, vocabulary }: ActionRowsProps) {
  const calls = toolCalls ?? [];
  if (calls.length === 0) return null;

  return (
    <section className="gc-action-rows" aria-label="Tool activity">
      <p className="gc-action-rows__caption">Tool activity</p>
      <ul className="gc-action-rows__list">
        {calls.map((call) => (
          <ActionRow key={call.id} call={call} vocabulary={vocabulary} />
        ))}
      </ul>
    </section>
  );
}

function ActionRow({ call, vocabulary }: { call: ToolCallView; vocabulary?: ToolVocabulary }) {
  const [open, setOpen] = useState(false);
  const entry = resolveToolCategory(vocabulary, call.toolName);
  const glyph = entry?.glyph ?? "•";
  const label = entry?.heading ?? call.toolName;
  const state = call.status === "running" ? "running" : call.isError ? "failed" : "done";

  return (
    <li className="gc-action-row" data-category={entry?.category ?? "unknown"} data-status={state}>
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
        </div>
      ) : null}
    </li>
  );
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
