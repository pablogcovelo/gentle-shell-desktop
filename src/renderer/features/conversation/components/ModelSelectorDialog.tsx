import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AvailableModelsResult, ModelOptionView } from "@shared/bridge-types";
import { useBridge } from "@renderer/shared/bridge/useBridge";
import "@renderer/app/components/AppDialogs.css";
import "./ModelSelectorDialog.css";

export interface ModelSelectorDialogProps {
  /** The chat's host id: the available-models read is addressed to it, the
   * same way every host request in this pane is. */
  readonly hostId: string;
  /** The chat's effective current model as the child reported it
   * (ChatState.session's modelId + modelProvider). Preselected and ordered
   * first ONLY when the child's list actually contains this exact
   * provider/id pair — a model that is not in the list is never
   * preselected, and no default is ever invented. */
  readonly currentModel?: { readonly provider?: string; readonly id?: string };
  /** Confirmed with `provider/id` (selector) or the typed text (degraded
   * input). ConversationContainer dispatches it as run_command args. */
  readonly onConfirm: (model: string) => void;
  readonly onCancel: () => void;
  /** Whether this screen is the TOPMOST open surface and may claim keys
   * at window level. Defaults to true for bare callers; the container
   * passes false while another surface (the Ctrl+K palette) is open over
   * it, so the mounted screen never dispatches an Enter the user typed
   * into the surface above it. */
  readonly active?: boolean;
}

/**
 * The /model argument screen (palette-command-arguments T3, S2): a selector
 * over the child's REAL available-model snapshot, with incremental
 * substring filtering (case-insensitive match on the label or the
 * provider/id — substring, not fuzzy, so the filter never outruns what the
 * child actually reported), the current model preselected and ordered
 * first, ↑/↓ navigation and Enter to confirm. Escape cancels without
 * dispatching.
 *
 * Degradation (S6): when the child cannot answer the list (`unsupported`,
 * `failed`, no bridge method, or an empty snapshot) the screen becomes a
 * typed input whose text goes as args, and it says so — the user is never
 * shown a typed placeholder as if it were the child's real list. An `ok`
 * snapshot with `truncated: true` says it is truncated.
 *
 * Dialog conventions follow ResumeSessionDialog: the gc-dialog shell, focus
 * on open and restored on close, Escape/Tab claimed at window level in
 * capture (isolated from the app's global shortcuts), backdrop click
 * cancels.
 */
export function ModelSelectorDialog({ hostId, currentModel, onConfirm, onCancel, active = true }: ModelSelectorDialogProps) {
  const bridge = useBridge();
  const titleId = useId();
  const listId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  const [result, setResult] = useState<AvailableModelsResult>();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  // The highlighted row, kept in state (not carried by focus): the dialog's
  // keyboard handling works whichever child element holds focus (S8), and
  // this ref lets the list scroll it into view.
  const selectedRowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    // R2-001/R3-001/R3-003: the documented degradation for a bridge that
    // LACKS the method. The optional call short-circuits before
    // .then/.catch — without the settle below, `result` would stay
    // undefined and the screen would sit on "Loading…" forever. Without
    // the method the read cannot be made, so the screen settles into the
    // same degraded typed-input state the `unsupported` arm produces.
    const read = bridge.availableModels?.(hostId);
    if (read) {
      read
        .then((answer) => {
          if (!cancelled) setResult(answer);
        })
        .catch(() => {
          // A failed read degrades honestly: the typed input mode, not a
          // fake list.
          if (!cancelled) setResult({ kind: "failed" });
        });
    } else {
      setResult({ kind: "failed" });
    }
    return () => {
      cancelled = true;
    };
  }, [bridge, hostId]);

  // The current-model equality test, defined ONCE (R2-002): the ordering
  // memo and the `current` pill below must answer the same question about
  // the same exact provider/id pair.
  const matchesCurrent = (entry: ModelOptionView): boolean =>
    currentModel?.provider !== undefined &&
    currentModel?.id !== undefined &&
    entry.provider === currentModel.provider &&
    entry.id === currentModel.id;

  // The child's order with the current model hoisted first — only when the
  // list actually contains that exact provider/id pair.
  const ordered = useMemo<readonly ModelOptionView[]>(() => {
    if (!result || result.kind !== "ok") return [];
    return [...result.models.filter(matchesCurrent), ...result.models.filter((entry) => !matchesCurrent(entry))];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, currentModel?.provider, currentModel?.id]);

  // Selector mode only for a non-empty child snapshot; everything else is
  // the degraded typed input (S6).
  const listMode = ordered.length > 0;
  // The degraded mode is the only one whose footer carries a primary
  // action ("Use model"); loading and selector modes show the single
  // Cancel action the thinking screen has (S9).
  const degradedInput = result !== undefined && !listMode;
  const needle = query.trim().toLowerCase();
  const visible = listMode
    ? ordered.filter(
        (entry) =>
          needle.length === 0 ||
          entry.label.toLowerCase().includes(needle) ||
          `${entry.provider}/${entry.id}`.toLowerCase().includes(needle),
      )
    : [];
  const selected = Math.min(selectedIndex, Math.max(0, visible.length - 1));

  // Every filter change selects the first row again.
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // The list scrolls so the highlighted row stays visible (S8): the
  // browser's own scrollIntoView, nearest-block, so it works whether the
  // scrolling element is the list (max-height 320px) or an ancestor. The
  // guard keeps jsdom — which has no scrollIntoView — from throwing; the
  // real browsers the dialog ships to always have it.
  useEffect(() => {
    const row = selectedRowRef.current;
    if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
    // R3-002: the effect also re-runs on a FILTER change, not only on a
    // selection change. When the visible rows change while the selected
    // index stays put (e.g. the first match of a new filter on a list the
    // user has scrolled down), the selected row can be offscreen and Enter
    // would confirm a row the user cannot see — the re-run brings it back
    // into view.
  }, [selected, query]);

  useEffect(() => {
    // On close, focus returns to the element that had it before opening —
    // guarded, because the dialog can unmount after its trigger is gone
    // (ResumeSessionDialog's convention).
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // While the read is pending the field is not rendered: focus stays
    // inside the dialog on its first button (the header ✕) instead of
    // leaking to the page behind it; the effect below retargets it to
    // the filter input the moment the read answers.
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);

  // The field renders only once the read has answered (loading shows a
  // status line instead); it takes focus the moment it appears. A LAYOUT
  // effect, so the field wins deterministically: a passive effect can be
  // flushed after the DOM update is already observable (the mount-focus
  // race that intermittently lost the field's focus to the header ✕).
  useLayoutEffect(() => {
    if (result) inputRef.current?.focus();
  }, [result]);

  // S11: Escape, Tab, the arrows and Enter are claimed at window level in
  // capture (ResumeSessionDialog's convention, extended), so the dialog
  // cancels, traps focus and navigates no matter what holds focus —
  // including nothing at all, after the app window loses and regains focus
  // and the browser parks it on body. Other keys are left alone — the
  // filter field keeps typing. A LAYOUT effect, so the claim is always in
  // sync with the committed DOM — a passive effect can be flushed after a
  // state update is already observable (the read answering), and a keydown
  // in that window would hit a stale claim (the degraded mode, an empty
  // typed value) and confirm nothing.
  useLayoutEffect(() => {
    // A surface claims keys ONLY while it is the topmost open one: while
    // another surface (the Ctrl+K palette) is open over this screen the
    // claim is lifted entirely, so Enter typed into that surface's filter
    // reaches it and never dispatches this screen's hidden choice.
    if (!active) return;
    const keydown = (event: KeyboardEvent): void => {
      // Only the claimed keys are stopped here: a blanket
      // stopImmediatePropagation at window capture would keep every other
      // key (typing, the caret keys) from ever reaching the input.
      if (
        event.key !== "Escape" &&
        event.key !== "Tab" &&
        event.key !== "ArrowDown" &&
        event.key !== "ArrowUp" &&
        event.key !== "Enter"
      )
        return;
      // The arrows are only claimed by the list (S8): in the degraded
      // typed-input mode they are left alone.
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !listMode) return;
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        cancelRef.current();
        return;
      }
      if (event.key === "Tab") {
        const focusables = [...(panel.current?.querySelectorAll<HTMLElement>("input, button:not(:disabled)") ?? [])];
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
        // Enter on a button OUTSIDE the list (the ✕ close and footer
        // actions) is left to its own native click: those buttons confirm
        // or cancel themselves, and handling it here too would dispatch
        // twice.
        if (target instanceof HTMLButtonElement && !onListRow) return;
        event.preventDefault();
        if (listMode) {
          const entry = visible[selected];
          if (entry) onConfirm(`${entry.provider}/${entry.id}`);
          return;
        }
        // In the degraded mode Enter confirms the typed text; an empty
        // typed value is refused — dispatching no value is the thing this
        // screen exists to avoid.
        const text = query.trim();
        if (text.length > 0) onConfirm(text);
        return;
      }
      // ↑/↓ move the highlighted option with wraparound (S8).
      event.preventDefault();
      if (visible.length === 0) return;
      const offset = event.key === "ArrowDown" ? 1 : -1;
      setSelectedIndex((selected + offset + visible.length) % visible.length);
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [active, listMode, visible, selected, query, onConfirm]);

  // S11: when the app window regains focus (clicking back into the GUI
  // after clicking outside it, or the tab becoming visible again) and the
  // dialog is open with focus parked outside it — the browser drops it on
  // body — the filter input takes focus back, so the arrows keep working
  // without a click inside the dialog. While the read is still pending the
  // field does not exist yet: the first focusable (the header ✕) keeps
  // focus inside instead. isConnected-guarded like the close-restore above.
  useEffect(() => {
    const restore = (): void => {
      if (panel.current?.contains(document.activeElement)) return;
      if (inputRef.current?.isConnected) {
        inputRef.current.focus();
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
  }, []);

  const confirmEntry = (entry: ModelOptionView): void => {
    onConfirm(`${entry.provider}/${entry.id}`);
  };

  const emptySnapshot = result?.kind === "ok" && result.models.length === 0;

  return (
    <div role="presentation" className="gc-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div ref={panel} className="gc-dialog gc-model-selector" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="gc-dialog__header">
          <h2 id={titleId}>Choose a model</h2>
          <button type="button" className="gc-dialog__close" aria-label="Cancel model choice" onClick={onCancel}>✕</button>
        </header>
        {!result ? (
          <p role="status">Loading models…</p>
        ) : listMode ? (
          <>
            <p className="gc-dialog__intro">
              Models reported by the pi child for this chat.
              {result.kind === "ok" && result.truncated ? <span className="gc-model-selector__truncated"> The list is truncated — the child reported more models than shown here.</span> : null}
            </p>
            <div className="gc-model-selector__input">
              <input
                ref={inputRef}
                role="combobox"
                aria-expanded={visible.length > 0}
                aria-controls={listId}
                aria-activedescendant={visible.length > 0 ? `${listId}-option-${selected}` : undefined}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="Filter models…"
                aria-label="Filter models"
              />
            </div>
            {visible.length === 0 ? (
              <p className="gc-model-selector__empty">No model matches &quot;{query.trim()}&quot;</p>
            ) : (
              <div className="gc-dialog__list" id={listId} role="listbox" aria-label="Models">
                {visible.map((entry, index) => (
                  <div
                    key={`${entry.provider}/${entry.id}`}
                    id={`${listId}-option-${index}`}
                    ref={index === selected ? selectedRowRef : undefined}
                    role="option"
                    aria-selected={index === selected}
                    className={index === selected ? "gc-dialog__row is-selected" : "gc-dialog__row"}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => confirmEntry(entry)}
                  >
                    <span className="gc-dialog__row-label">{entry.label}</span>
                    {matchesCurrent(entry) ? (
                      <span className="gc-dialog__current" aria-hidden="true">current</span>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            {/* S6: the child could not answer the list, so this field's text
            is the value — the screen says which source it is showing. */}
            <p className="gc-dialog__intro">
              {emptySnapshot
                ? "The pi child reported no models — type one as provider/id."
                : "The pi child did not report its available models — type one as provider/id."}
            </p>
            <div className="gc-model-selector__input">
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="provider/id"
                aria-label="Model"
              />
            </div>
          </>
        )}
        {/* S9: the same footer as every dialog — one right-aligned Cancel.
        Only the degraded mode adds a primary action beside it. */}
        <footer className="gc-dialog__actions">
          <button type="button" className="gc-dialog__dismiss" onClick={onCancel}>Cancel</button>
          {degradedInput ? (
            <button
              type="button"
              className="gc-dialog__dismiss gc-model-selector__confirm"
              disabled={query.trim().length === 0}
              onClick={() => {
                const text = query.trim();
                if (text.length > 0) onConfirm(text);
              }}
            >
              Use model
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
