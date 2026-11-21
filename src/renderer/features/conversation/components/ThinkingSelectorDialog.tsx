import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { THINKING_LEVEL, type AvailableThinkingLevelsResult, type ThinkingLevel } from "@shared/bridge-types";
import { useBridge } from "@renderer/shared/bridge/useBridge";
import "@renderer/app/components/AppDialogs.css";
import "./ThinkingSelectorDialog.css";

export interface ThinkingSelectorDialogProps {
  /** The chat's host id: the available-thinking-levels read is addressed
   * to it, like every host request in this pane. */
  readonly hostId: string;
  /** The chat's effective current level (ChatState.session.thinkingLevel).
   * Preselected when the shown list contains it; a level that is not in
   * the list is never preselected. */
  readonly currentLevel?: ThinkingLevel;
  /** Confirmed with the chosen level; ConversationContainer dispatches it
   * as run_command args. */
  readonly onConfirm: (level: ThinkingLevel) => void;
  readonly onCancel: () => void;
}

/** The closed level union the app already types (S6 degradation): shown
 * only when the child cannot answer, never as if it were the child's own
 * list. */
const APP_LEVELS: readonly ThinkingLevel[] = Object.values(THINKING_LEVEL);

/** The shown list's selected index: the level the user moved to while it
 * is still in the list, else the current level when it is in the list,
 * else the first level. Pure and derived, so a late fetch can never leave
 * a stale index pointing at the wrong row. */
function deriveSelected(levels: readonly ThinkingLevel[], choice: ThinkingLevel | undefined, currentLevel: ThinkingLevel | undefined): number {
  if (choice !== undefined) {
    const chosen = levels.indexOf(choice);
    if (chosen >= 0) return chosen;
  }
  const current = currentLevel ? levels.indexOf(currentLevel) : -1;
  return current >= 0 ? current : 0;
}

/**
 * The /thinking argument screen (palette-command-arguments T3, S3): a
 * selector over exactly the levels the child reports, in the order it
 * reported them, with the current level preselected; ↑/↓ move the
 * selection, Enter confirms the FOCUSED row once the read has answered,
 * Escape cancels without dispatching.
 *
 * Degradation (S6): when the child cannot answer (`unsupported`,
 * `failed`, no bridge method, or an empty list) the screen shows the app's
 * own closed level union instead and SAYS so — the user is never told a
 * fallback list is the child's real one.
 *
 * Dialog conventions follow ResumeSessionDialog: the gc-dialog shell,
 * focus on open and restored on close, Escape/Tab claimed at window level
 * in capture, backdrop click cancels.
 */
export function ThinkingSelectorDialog({ hostId, currentLevel, onConfirm, onCancel }: ThinkingSelectorDialogProps) {
  const bridge = useBridge();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  const [result, setResult] = useState<AvailableThinkingLevelsResult>();
  // The selection is stored as a LEVEL, never an index: the list arrives
  // asynchronously, so an index would race the fetch. Derived selection:
  // the chosen level while the shown list carries it, else the current
  // level when the list carries it, else the first level (a real entry —
  // never an invented one).
  const [choice, setChoice] = useState<ThinkingLevel>();

  useEffect(() => {
    let cancelled = false;
    bridge
      .availableThinkingLevels?.(hostId)
      .then((answer) => {
        if (!cancelled) setResult(answer);
      })
      .catch(() => {
        if (!cancelled) setResult({ kind: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, hostId]);

  // Exactly what the child reported — or, only in the degraded mode, the
  // app's own closed union. Never a merge of the two.
  const reported = result?.kind === "ok" ? result.levels : [];
  const levels: readonly ThinkingLevel[] = reported.length > 0 ? reported : APP_LEVELS;
  const degraded = reported.length === 0;
  // An `ok` answer with zero entries is a real (empty) answer, not a failed
  // read: the label names each source apart, like the model screen does.
  const emptyReported = result?.kind === "ok" && result.levels.length === 0;

  const selected = deriveSelected(levels, choice, currentLevel);

  // The selection always owns focus: ↑/↓ move it (and the buttons
  // follow), Enter confirms the focused row (which the highlight
  // follows — see the focus-sync below), Escape cancels from
  // anywhere inside the dialog. The effect re-runs when the read answers
  // too: before that the list is not rendered, so a run keyed on
  // `selected` alone could focus nothing and never try again — the cause
  // of arrows reaching no handler at all. A LAYOUT effect, so the row owns
  // focus deterministically: a passive effect can be flushed after the DOM
  // update is already observable (the same mount-focus race the model
  // screen had with its filter field).
  useLayoutEffect(() => {
    const row = panel.current?.querySelector<HTMLButtonElement>(`[data-level-index="${selected}"]`);
    row?.focus();
  }, [selected, result]);

  // The list scrolls so the highlighted row stays visible (S8): the
  // browser's own scrollIntoView, nearest-block — under the shared S9
  // contract the list element itself is the scrolling one
  // (gc-dialog__list, max-height + overflow-y), and nearest-block works
  // whichever ancestor scrolls. The guard keeps jsdom — which has no
  // scrollIntoView — from throwing; the real browsers the dialog ships
  // to always have it.
  useEffect(() => {
    const row = panel.current?.querySelector<HTMLButtonElement>(`[data-level-index="${selected}"]`);
    if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
  }, [selected, result]);

  useEffect(() => {
    // On close, focus returns to the element that had it before opening —
    // guarded, because the dialog can unmount after its trigger is gone
    // (ResumeSessionDialog's convention).
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // While the read is pending no row exists yet: focus stays inside the
    // dialog on its first button (the header ✕) instead of leaking to the
    // page behind it; the row-focus effect above retargets it to the
    // highlighted row the moment the read answers.
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);

  // The highlight follows the DOM focus (the Enter rule's other half):
  // when focus lands on a row — Tab walking the list, the window
  // refocusing, any path — the selection becomes THAT row, so highlight
  // and focus can never disagree and Enter always confirms the option
  // focus actually holds. A native capture listener on the panel (not a
  // React onFocus): focus events do not bubble, and the claim must hold
  // no matter how focus moved. Focus landing on a non-row (the ✕, the
  // footer Cancel) syncs nothing — Enter on those defers to the button's
  // own click anyway.
  useEffect(() => {
    const panelEl = panel.current;
    if (!panelEl) return;
    const sync = (event: FocusEvent): void => {
      if (!(event.target instanceof HTMLElement)) return;
      const index = event.target.getAttribute("data-level-index");
      if (index === null) return;
      const level = levels[Number(index)];
      if (level !== undefined) setChoice(level);
    };
    panelEl.addEventListener("focus", sync, true);
    return () => panelEl.removeEventListener("focus", sync, true);
  }, [levels]);

  // S11: Escape, Tab, the arrows and Enter are claimed at window level in
  // capture (ResumeSessionDialog's convention, extended), so the dialog
  // cancels, traps focus and navigates no matter what holds focus —
  // including nothing at all, after the app window loses and regains focus
  // and the browser parks it on body. Other keys are left alone. A LAYOUT
  // effect, so the claim is always in sync with the committed DOM — a
  // passive effect can be flushed after a state update is already
  // observable (the read answering), and a keydown in that window would
  // hit a stale claim.
  useLayoutEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      // Only the claimed keys are stopped here: a blanket
      // stopImmediatePropagation at window capture would keep every other
      // key (typing, the caret keys) from ever reaching the list.
      if (
        event.key !== "Escape" &&
        event.key !== "Tab" &&
        event.key !== "ArrowDown" &&
        event.key !== "ArrowUp" &&
        event.key !== "Enter"
      )
        return;
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        cancelRef.current();
        return;
      }
      if (event.key === "Tab") {
        const focusables = [...(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [])];
        if (focusables.length === 0) return;
        event.preventDefault();
        const index = focusables.indexOf(document.activeElement as HTMLElement);
        const offset = event.shiftKey ? -1 : 1;
        focusables[(index + offset + focusables.length) % focusables.length]!.focus();
        return;
      }
      if (event.key === "Enter") {
        const target = event.target;
        const onListRow = target instanceof Element && target.closest('[role="listbox"]') !== null;
        // Enter on a button OUTSIDE the list (the ✕ close) is left to its
        // own native click. Enter on a row is prevented so the button's
        // native click activation does not confirm a second time.
        if (target instanceof HTMLButtonElement && !onListRow) return;
        // Enter confirms ONLY an answered read: while the read is still
        // pending the screen shows the loading status alone — no list was
        // ever shown, so there is nothing to confirm and nothing may be
        // dispatched on the user's behalf.
        if (!result) return;
        event.preventDefault();
        // The focus-sync effect keeps the highlight ON the focused row, so
        // the highlighted level IS the one focus holds — Enter confirms
        // the row the user is actually on, never a highlight focus left
        // behind by a Tab move.
        onConfirm(levels[selected]!);
        return;
      }
      // ↑/↓ move the highlighted level with wraparound (S8).
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      setChoice(levels[(selected + offset + levels.length) % levels.length]!);
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [levels, selected, onConfirm, result]);

  // S11: when the app window regains focus (clicking back into the GUI
  // after clicking outside it, or the tab becoming visible again) and the
  // dialog is open with focus parked outside it — the browser drops it on
  // body — the highlighted row takes focus back, so the arrows keep
  // working without a click inside the dialog. While the read is still
  // pending no row exists yet: the first focusable (the header ✕) keeps
  // focus inside instead. isConnected-guarded like the close-restore above;
  // a LAYOUT effect so the highlighted row it targets is never one commit
  // behind the arrows.
  useLayoutEffect(() => {
    const restore = (): void => {
      if (panel.current?.contains(document.activeElement)) return;
      const row = panel.current?.querySelector<HTMLElement>(`[data-level-index="${selected}"]`);
      if (row?.isConnected) {
        row.focus();
        return;
      }
      panel.current?.querySelector<HTMLElement>("button")?.focus();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") restore();
    };
    window.addEventListener("focus", restore);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", restore);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [selected]);

  return (
    <div role="presentation" className="gc-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div ref={panel} className="gc-dialog gc-thinking-selector" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="gc-dialog__header">
          <h2 id={titleId}>Choose a thinking level</h2>
          <button type="button" className="gc-dialog__close" aria-label="Cancel thinking level choice" onClick={onCancel}>✕</button>
        </header>
        {!result ? (
          <p role="status">Loading thinking levels…</p>
        ) : (
          <>
            <p className="gc-dialog__intro">
              {degraded
                ? emptyReported
                  ? "The pi child reported no thinking levels — the app's own levels are shown."
                  : "The pi child did not report its thinking levels — the app's own levels are shown."
                : "Levels reported by the pi child for this chat."}
            </p>
            <div className="gc-dialog__list" role="listbox" aria-label="Thinking levels">
              {levels.map((level, index) => (
                <button
                  type="button"
                  key={level}
                  data-level-index={index}
                  role="option"
                  aria-selected={index === selected}
                  className={index === selected ? "gc-dialog__row is-selected" : "gc-dialog__row"}
                  onClick={() => onConfirm(level)}
                >
                  <span className="gc-dialog__row-label">{level}</span>
                  {/* The APPLIED level (S9): driven by `currentLevel`, so
                  it survives the arrows moving the highlight. Hidden from
                  the accessibility tree — the row's own text stays its
                  whole accessible name, exactly as before. */}
                  {level === currentLevel ? (
                    <span className="gc-dialog__current" aria-hidden="true">current</span>
                  ) : null}
                </button>
              ))}
              </div>
          </>
        )}
        {/* The same single dismiss action the model screen has (S9): one
        right-aligned Cancel; the rows themselves are the confirmation, so
        there is no primary action. Present while loading too — it keeps a
        focusable inside the dialog before the read answers. */}
        <footer className="gc-dialog__actions">
          <button type="button" className="gc-dialog__dismiss" onClick={onCancel}>Cancel</button>
        </footer>
      </div>
    </div>
  );
}
