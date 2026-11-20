// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ToolCallView, ToolVocabulary } from "@shared/bridge-types";
import { ActionRows } from "./ActionRows";
import captured from "../../../../main/domain/rpc/__fixtures__/tool-vocabulary.json";

/**
 * The real payload a live `gentle-shell --mode rpc` child answered
 * `tool_vocabulary` with (the same fixture the main-process parser is
 * certified against), used as-is so the chips derive from the published
 * data and never from a hand-written copy of it.
 */
const VOCABULARY = captured as unknown as ToolVocabulary;

function rowFor(call: Partial<ToolCallView>) {
  const full: ToolCallView = { id: "c1", toolName: "read", status: "done", ...call };
  render(<ActionRows toolCalls={[full]} vocabulary={VOCABULARY} />);
  return screen.getByTestId("gc-action-row");
}

describe("ActionRows — vocabulary variant chips (S14)", () => {
  it("a search row lists its category's other glyphs under `also reports`", () => {
    const row = rowFor({ id: "c1", toolName: "grep" });
    fireEvent.click(within(row).getByRole("button"));

    const variants = within(row).getByTestId("gc-action-row__variants");
    expect(variants).toHaveTextContent("also reports");
    const chips = [...variants.querySelectorAll(".gc-action-row__chip")];
    expect(chips.map((chip) => chip.textContent)).toEqual(["⌕", "⌖"]);
    // The row's own glyph is marked; the other glyph is not.
    expect(chips[0]).toHaveAttribute("aria-current", "true");
    expect(chips[1]).not.toHaveAttribute("aria-current");
    // The design's own wording, with the published category string.
    expect(chips[0]).toHaveAttribute("aria-label", "search glyph ⌕");
    expect(chips[1]).toHaveAttribute("aria-label", "search glyph ⌖");
  });

  it("a delegation row lists its seven distinct glyphs under `phases`, ✉ and ☰ once each", () => {
    const row = rowFor({ id: "c1", toolName: "subagent_run" });
    fireEvent.click(within(row).getByRole("button"));

    const variants = within(row).getByTestId("gc-action-row__variants");
    expect(variants).toHaveTextContent("phases");
    const chips = [...variants.querySelectorAll(".gc-action-row__chip")];
    // The published vocabulary repeats ✉ and ☰ for a second tool each; each
    // distinct glyph still appears exactly once, in vocabulary order.
    expect(chips.map((chip) => chip.textContent)).toEqual(["→", "◎", "↩", "⨯", "✉", "↻", "☰"]);
    expect(chips[0]).toHaveAttribute("aria-current", "true");
    expect(chips[4]).toHaveAttribute("aria-label", "delegation glyph ✉");
    expect(chips[4]).not.toHaveAttribute("aria-current");
  });

  it("a single-glyph category shows no variants row", () => {
    const row = rowFor({ id: "c1", toolName: "read" });
    fireEvent.click(within(row).getByRole("button"));

    expect(within(row).queryByTestId("gc-action-row__variants")).not.toBeInTheDocument();
  });

  it("an unresolved row with no vocabulary shows no variants row", () => {
    render(
      <ActionRows
        toolCalls={[{ id: "c1", toolName: "some_future_tool", status: "done" }]}
      />,
    );
    const row = screen.getByTestId("gc-action-row");
    fireEvent.click(within(row).getByRole("button"));

    expect(within(row).queryByTestId("gc-action-row__variants")).not.toBeInTheDocument();
  });

  it("the app-owned memory fallback shows no variants row (R3-001)", () => {
    // A vocabulary that EXISTS but does not cover `mem_save` (no fixture
    // entry lists a mem_* tool): the app-owned memory entry must resolve
    // through the fallback, render the memory glyph, and stay silent —
    // that category publishes a single glyph.
    render(<ActionRows toolCalls={[{ id: "c1", toolName: "mem_save", status: "done" }]} vocabulary={VOCABULARY} />);
    const row = screen.getByTestId("gc-action-row");
    fireEvent.click(within(row).getByRole("button"));

    expect(within(row).getByText("🧠")).toBeInTheDocument();
    expect(within(row).queryByTestId("gc-action-row__variants")).not.toBeInTheDocument();
  });

  // R2-002: the `phases` label rule is deliberately data-driven — a
  // category whose published entries all carry a heading describes phases
  // of one run, delegation or not. Pinned with a NON-delegation category
  // so the rule cannot be mistaken for a delegation special case.
  it("labels `phases` a non-delegation category whose entries all carry headings (R2-002)", () => {
    const headed: ToolVocabulary = {
      categories: ["search"],
      entries: [
        { category: "search", glyph: "⌕", tools: ["grep"], heading: "Search text" },
        { category: "search", glyph: "⌖", tools: ["find"], heading: "Find files" },
      ],
    };
    render(<ActionRows toolCalls={[{ id: "c1", toolName: "grep", status: "done" }]} vocabulary={headed} />);
    const row = screen.getByTestId("gc-action-row");
    fireEvent.click(within(row).getByRole("button"));

    const variants = within(row).getByTestId("gc-action-row__variants");
    expect(variants).toHaveTextContent("phases");
    const chips = [...variants.querySelectorAll(".gc-action-row__chip")];
    expect(chips.map((chip) => chip.textContent)).toEqual(["⌕", "⌖"]);
    // The current chip still follows the resolved entry's glyph.
    expect(chips[0]).toHaveAttribute("aria-current", "true");
    expect(chips[1]).not.toHaveAttribute("aria-current");
  });
});
