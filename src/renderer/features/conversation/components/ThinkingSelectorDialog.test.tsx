// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AvailableThinkingLevelsResult, GentleBridge } from "@shared/bridge-types";
import { mockBridge } from "@renderer/shared/bridge/mockBridge";
import { ThinkingSelectorDialog } from "./ThinkingSelectorDialog";

function bridgeWith(result: AvailableThinkingLevelsResult): GentleBridge {
  return { ...mockBridge, availableThinkingLevels: vi.fn().mockResolvedValue(result) };
}

/** The row's own level text: the shared row markup wraps the level in a
 * label span, and the applied-level pill ("current") sits beside it, so
 * the raw textContent of a marked row is the level PLUS the pill. */
function levelText(option: HTMLElement): string {
  return option.querySelector(".gc-dialog__row-label")?.textContent ?? "";
}

describe("ThinkingSelectorDialog", () => {
  it("lists exactly the child's levels with the current one preselected, and confirms it", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    window.gentle = bridgeWith({ kind: "ok", levels: ["off", "medium", "high"] });
    render(<ThinkingSelectorDialog hostId="host-1" currentLevel="medium" onConfirm={onConfirm} onCancel={onCancel} />);

    const dialog = await screen.findByRole("dialog", { name: "Choose a thinking level" });
    const options = await within(dialog).findAllByRole("option");
    // Exactly what the child reported, in its own order — nothing added.
    expect(options.map(levelText)).toEqual(["off", "medium", "high"]);
    expect(options[1]).toHaveAttribute("aria-selected", "true");

    // Enter confirms the preselected level.
    fireEvent.keyDown(options[1]!, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith("medium");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("moves the selection with the arrow keys and dispatches the newly chosen level", async () => {
    const onConfirm = vi.fn();
    window.gentle = bridgeWith({ kind: "ok", levels: ["off", "medium", "high"] });
    render(<ThinkingSelectorDialog hostId="host-1" currentLevel="medium" onConfirm={onConfirm} onCancel={vi.fn()} />);
    const options = await screen.findAllByRole("option");
    fireEvent.keyDown(options[1]!, { key: "ArrowDown" });
    expect(options[2]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(options[2]!, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith("high");
  });

  // The loading screen shows only the status line — the list does not
  // exist yet — so Enter has nothing to confirm and must dispatch
  // nothing: a level the user never saw must never be applied.
  it("confirms nothing with Enter while the read has not answered — the loading screen has no list", async () => {
    const onConfirm = vi.fn();
    window.gentle = { ...mockBridge, availableThinkingLevels: vi.fn().mockImplementation(() => new Promise(() => {})) };
    render(<ThinkingSelectorDialog hostId="host-1" currentLevel="medium" onConfirm={onConfirm} onCancel={vi.fn()} />);

    // The screen shows only the loading status; no option was ever shown.
    expect(screen.getByText("Loading thinking levels…")).toBeInTheDocument();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Choose a thinking level" }), { key: "Enter" });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // Tab moves DOM focus onto a specific option; the highlight follows it,
  // so Enter confirms the FOCUSED row — never the highlight focus left
  // behind on the previously selected row.
  it("after Tab lands focus on an option, Enter confirms that option, not the previously highlighted row", async () => {
    const onConfirm = vi.fn();
    window.gentle = bridgeWith({ kind: "ok", levels: ["off", "medium", "high"] });
    render(<ThinkingSelectorDialog hostId="host-1" currentLevel="medium" onConfirm={onConfirm} onCancel={vi.fn()} />);
    const options = await screen.findAllByRole("option");
    expect(options[1]).toHaveAttribute("aria-selected", "true");

    // The dialog's own Tab trap moves focus onto the next option ("high").
    options[1]!.focus();
    fireEvent.keyDown(options[1]!, { key: "Tab" });
    expect(options[2]).toHaveFocus();

    fireEvent.keyDown(options[2]!, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith("high");
  });

  it("moves the selection with the arrows no matter which element holds focus", async () => {
    const onConfirm = vi.fn();
    window.gentle = bridgeWith({ kind: "ok", levels: ["off", "medium", "high"] });
    render(<ThinkingSelectorDialog hostId="host-1" currentLevel="medium" onConfirm={onConfirm} onCancel={vi.fn()} />);
    const options = await screen.findAllByRole("option");
    expect(options[1]).toHaveAttribute("aria-selected", "true");

    // Dispatched on the dialog root with no row focused: the dialog's own
    // keyboard handling must not depend on the list (or any row) holding
    // focus (L8 failure 2).
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Choose a thinking level" }), { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[2]).toHaveAttribute("aria-selected", "true");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("moves the selection with the arrows even when nothing in the dialog holds focus — the keydown is dispatched on document.body (S11)", async () => {
    const onConfirm = vi.fn();
    window.gentle = bridgeWith({ kind: "ok", levels: ["off", "medium", "high"] });
    render(<ThinkingSelectorDialog hostId="host-1" currentLevel="medium" onConfirm={onConfirm} onCancel={vi.fn()} />);
    const options = await screen.findAllByRole("option");
    expect(options[1]).toHaveAttribute("aria-selected", "true");

    // Park focus on body: no row holds it.
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    // The keydown is dispatched on document.body — where the browser parks
    // focus after the app window loses and regains it.
    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[2]).toHaveAttribute("aria-selected", "true");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("restores focus to the highlighted row when the app window regains focus, and the arrows still navigate (S11)", async () => {
    window.gentle = bridgeWith({ kind: "ok", levels: ["off", "medium", "high"] });
    render(<ThinkingSelectorDialog hostId="host-1" currentLevel="medium" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    await screen.findAllByRole("option");

    // The app window loses focus (a click outside the GUI) — the browser
    // parks focus on body — and then the window regains it.
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent(window, new Event("focus"));

    expect(screen.getAllByRole("option")[1]).toHaveFocus();
    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[2]).toHaveAttribute("aria-selected", "true");
  });

  it("scrolls the newly selected row into view when arrows move the selection", async () => {
    const calls: Array<{ element: Element | undefined; arg: unknown }> = [];
    const spy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(function (this: Element, arg) {
        calls.push({ element: this, arg });
      });
    try {
      // The full reported union overflows the list: under the shared S9
      // scroll contract the gc-dialog__list element is the scrolling one
      // (max-height + overflow-y), and nearest-block scrollIntoView on the
      // row keeps it visible either way.
      window.gentle = bridgeWith({ kind: "ok", levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] });
      render(<ThinkingSelectorDialog hostId="host-1" currentLevel="off" onConfirm={vi.fn()} onCancel={vi.fn()} />);
      await screen.findAllByRole("option");
      calls.length = 0; // drop the initial mount scroll

      fireEvent.keyDown(screen.getByRole("dialog", { name: "Choose a thinking level" }), { key: "ArrowDown" });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.element).toBe(screen.getAllByRole("option")[1]);
      expect(calls[0]!.arg).toEqual({ block: "nearest" });
    } finally {
      spy.mockRestore();
    }
  });

  // R3-004: the arrows must not move the hidden choice while the read is
  // still pending — Enter is already gated on the answer, and a choice
  // moved invisibly behind the loading line would preselect the wrong row
  // the moment the answer lands.
  it("ignores the arrows while the read has not answered — the pending screen cannot move the hidden choice (R3-004)", async () => {
    const onConfirm = vi.fn();
    let answer!: (result: AvailableThinkingLevelsResult) => void;
    window.gentle = {
      ...mockBridge,
      availableThinkingLevels: vi.fn().mockImplementation(
        () => new Promise<AvailableThinkingLevelsResult>((done) => { answer = done; }),
      ),
    };
    render(<ThinkingSelectorDialog hostId="host-1" currentLevel="medium" onConfirm={onConfirm} onCancel={vi.fn()} />);
    expect(screen.getByText("Loading thinking levels…")).toBeInTheDocument();

    // The user taps an arrow while the screen still shows the loading line.
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Choose a thinking level" }), { key: "ArrowDown" });

    // The read answers late, in a NON-canonical order (the app's own union
    // order disagrees with the child's): the selection must still be the
    // CURRENT level — the hidden choice was never moved.
    await act(async () => {
      answer({ kind: "ok", levels: ["high", "medium", "off"] });
    });
    const options = await screen.findAllByRole("option");
    expect(options[1]).toHaveAttribute("aria-selected", "true"); // medium
    expect(options[1]).toHaveFocus();
  });

  // R3-005: the focus-sync listener was a passive effect while the
  // row-focus effect is a layout effect, so on the render where the
  // asynchronous answer arrives the stale levels mapping could win and
  // move the highlight onto a row focus never held. With the sync at
  // layout time as well, focus and the levels mapping always come from
  // the same render — pinned here with a child list in a NON-canonical
  // order, where the app's own union order disagrees with the child's.
  it("keeps the highlight on the focused current level when the child reports a non-canonical order (R3-005)", async () => {
    const onConfirm = vi.fn();
    window.gentle = bridgeWith({ kind: "ok", levels: ["high", "medium", "off"] });
    render(<ThinkingSelectorDialog hostId="host-1" currentLevel="high" onConfirm={onConfirm} onCancel={vi.fn()} />);

    const options = await screen.findAllByRole("option");
    expect(options[0]).toHaveTextContent("high");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[0]).toHaveFocus();
    fireEvent.keyDown(options[0]!, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith("high");
  });

  it("cancels with Escape and confirms nothing", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    window.gentle = bridgeWith({ kind: "ok", levels: ["off", "medium", "high"] });
    render(<ThinkingSelectorDialog hostId="host-1" currentLevel="medium" onConfirm={onConfirm} onCancel={onCancel} />);
    await screen.findByRole("option", { name: "medium" });
    fireEvent.keyDown(screen.getByRole("option", { name: "medium" }), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("selects the first reported level when the current one is not in the child's list", async () => {
    window.gentle = bridgeWith({ kind: "ok", levels: ["off", "medium", "high"] });
    render(<ThinkingSelectorDialog hostId="host-1" currentLevel="max" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const options = await screen.findAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  });

  // An `ok` answer with zero entries is a real answer, not a failed read:
  // the empty-list label must not name the failed-read source.
  it("an ok answer with no levels shows the app's union with the empty-list label, not the failed-read one", async () => {
    const onConfirm = vi.fn();
    window.gentle = bridgeWith({ kind: "ok", levels: [] });
    render(<ThinkingSelectorDialog hostId="host-1" currentLevel="medium" onConfirm={onConfirm} onCancel={vi.fn()} />);

    const options = await screen.findAllByRole("option");
    expect(options.map(levelText)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(screen.getByText(/reported no thinking levels/)).toBeInTheDocument();
    expect(screen.queryByText(/did not report its thinking levels/)).not.toBeInTheDocument();
  });

  it("falls back to the app's closed level union when the bridge has no availableThinkingLevels method at all (R2-001/R3-001)", async () => {
    const onConfirm = vi.fn();
    // A bridge that simply lacks the method — the short-circuit case: the
    // optional call yields undefined, and the documented degradation must
    // still settle instead of the dialog sitting on "Loading…" forever.
    const { availableThinkingLevels: _omitted, ...bridgeWithoutMethod } = mockBridge;
    window.gentle = bridgeWithoutMethod as GentleBridge;
    render(<ThinkingSelectorDialog hostId="host-1" currentLevel="medium" onConfirm={onConfirm} onCancel={vi.fn()} />);

    expect(await screen.findByText(/did not report its thinking levels/)).toBeInTheDocument();
    expect(screen.queryByText("Loading thinking levels…")).not.toBeInTheDocument();
    const options = screen.getAllByRole("option");
    expect(options.map(levelText)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    fireEvent.keyDown(options[3]!, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith("medium");
  });

  it.each(["unsupported", "failed"] as const)("falls back to the app's closed level union when the child cannot answer (%s), and says so", async (kind) => {
    const onConfirm = vi.fn();
    window.gentle = bridgeWith({ kind });
    render(<ThinkingSelectorDialog hostId="host-1" currentLevel="medium" onConfirm={onConfirm} onCancel={vi.fn()} />);

    expect(await screen.findByText(/did not report its thinking levels/)).toBeInTheDocument();
    // The closed union the app already types: every pi level, nothing invented.
    const options = screen.getAllByRole("option");
    expect(options.map(levelText)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    const medium = options[3];
    expect(medium).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(medium!, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith("medium");
  });

  it("has the footer Cancel action — present while loading too — and it cancels from there", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    window.gentle = bridgeWith({ kind: "ok", levels: ["off", "medium", "high"] });
    render(<ThinkingSelectorDialog hostId="host-1" currentLevel="medium" onConfirm={onConfirm} onCancel={onCancel} />);

    // The footer exists before the read answers (the loading state) and
    // carries the same single dismiss action the model screen has: one
    // right-aligned Cancel in the shared gc-dialog__actions slot.
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel.closest("footer")).toHaveClass("gc-dialog__actions");
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("marks the applied level with the current pill independently of the highlight", async () => {
    window.gentle = bridgeWith({ kind: "ok", levels: ["off", "medium", "high"] });
    render(<ThinkingSelectorDialog hostId="host-1" currentLevel="medium" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const options = await screen.findAllByRole("option");
    expect(within(options[1]!).getByText("current")).toBeInTheDocument();

    // Arrow away from the applied level: the highlight moves, the applied
    // mark stays where the level is — the two are distinct (S9).
    fireEvent.keyDown(options[1]!, { key: "ArrowDown" });
    const moved = screen.getAllByRole("option");
    expect(moved[2]).toHaveAttribute("aria-selected", "true");
    expect(within(moved[1]!).getByText("current")).toBeInTheDocument();
    expect(within(moved[2]!).queryByText("current")).not.toBeInTheDocument();
  });

  it("keeps focus inside the dialog while loading and retargets it to the highlighted row when the read answers", async () => {
    window.gentle = bridgeWith({ kind: "ok", levels: ["off", "medium", "high"] });
    render(<ThinkingSelectorDialog hostId="host-1" currentLevel="medium" onConfirm={vi.fn()} onCancel={vi.fn()} />);

    // While "Loading thinking levels…" shows, focus must already be
    // inside the modal — never left on the page behind it.
    const dialog = screen.getByRole("dialog", { name: "Choose a thinking level" });
    expect(dialog.contains(document.activeElement)).toBe(true);

    // When the answer lands, focus retargets to the highlighted row.
    const options = await screen.findAllByRole("option");
    expect(options[1]).toHaveFocus();
  });

  it("traps Tab across the dialog's own focusables, the footer Cancel included", async () => {
    window.gentle = bridgeWith({ kind: "ok", levels: ["off", "medium", "high"] });
    render(<ThinkingSelectorDialog hostId="host-1" currentLevel="medium" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const close = await screen.findByRole("button", { name: "Cancel thinking level choice" });
    const rows = await screen.findAllByRole("option");
    const footerCancel = screen.getByRole("button", { name: "Cancel" });

    // From the header ✕, Tab reaches the first row; from the footer
    // Cancel — the last focusable — it wraps back to the header ✕. Focus
    // never escapes to the dimmed page behind. (keyDown does not move
    // focus by itself: each anchor is focused first, like the model
    // screen's trap test does.)
    close.focus();
    fireEvent.keyDown(close, { key: "Tab" });
    expect(rows[0]).toHaveFocus();
    footerCancel.focus();
    fireEvent.keyDown(footerCancel, { key: "Tab" });
    expect(close).toHaveFocus();
  });

  it("the list obeys the shared dialog list contract, not a screen-only stylesheet", async () => {
    window.gentle = bridgeWith({ kind: "ok", levels: ["off", "medium", "high"] });
    render(<ThinkingSelectorDialog hostId="host-1" currentLevel="medium" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(await screen.findByRole("listbox", { name: "Thinking levels" })).toHaveClass("gc-dialog__list");
  });

});
