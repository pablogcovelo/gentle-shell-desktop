import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ChatCommand } from "@shared/bridge-types";
import "./CommandPalette.css";

/**
 * The command palette (S19, artboard design/command-palette/01-spotlight-overlay.html):
 * a centred spotlight dialog over the dimmed workspace. One input, one flat
 * list grouped by source, a selected row driven by ↑/↓/Enter/Esc and an
 * honest empty state. Rendered through a portal so the backdrop covers the
 * whole window; opens focused and returns focus on close.
 *
 * The palette owns NOTHING (palette-host-catalog S3/S5): every row is the
 * host's own catalog (`ChatState.commands`, pi's builtins included), and a
 * row's execution is decided by the container from the wire's `runnable`
 * verdict and `source` — never by a client-side name list. The palette
 * only reports the entry the user ran.
 */
export interface CommandPaletteProps {
  /** The chat's command catalog for the active chat, in the order the
   * host published it. */
  readonly commands: readonly ChatCommand[];
  /** A row was run: ConversationContainer decides between the host's
   * `run_command`, the proven `/name` prompt path and the terminal-only
   * notice, and owns the one `/resume` special case (the session picker). */
  readonly onRun: (entry: ChatCommand) => void;
  readonly onClose: () => void;
}

/** Group order (S19, S3): the wire's prompt / skill / extension groups,
 * then the builtin group AFTER extension. Empty groups are not rendered. */
const GROUP_ORDER: readonly { readonly key: ChatCommand["source"]; readonly label: string }[] = [
  { key: "prompt", label: "Prompt" },
  { key: "skill", label: "Skill" },
  { key: "extension", label: "Extension" },
  { key: "builtin", label: "Builtin" },
];

export function CommandPalette({ commands, onRun, onClose }: CommandPaletteProps) {
  const listId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  // A leading "/" is ignored, so typing "/re" and "re" match the same rows.
  // The query matches the NAME only (owner decision, L6 of palette-host-catalog):
  // searching descriptions made every command whose prose happened to contain
  // the word win a slot — typing "new" returned skills whose description says
  // "new skill" and buried /new itself — so a command is found by what it is
  // called, never by what its prose mentions.
  const needle = query.replace(/^\//, "").trim().toLowerCase();
  const matched = commands.filter(
    (entry) => needle.length === 0 || entry.name.toLowerCase().includes(needle),
  );
  // The flat list FOLLOWS THE VISUAL ORDER (groups in GROUP_ORDER, host order
  // inside each group): the single selection index must move down the rows
  // exactly as they are painted, never skip across a group boundary.
  const visible: ChatCommand[] = [];
  for (const group of GROUP_ORDER) {
    for (const entry of matched) {
      if (entry.source === group.key) visible.push(entry);
    }
  }
  // The single selection index over the flattened visible list, clamped to
  // whatever the current filter leaves.
  const selected = Math.min(selectedIndex, Math.max(0, visible.length - 1));

  // Every filter change selects the first row again (S19).
  useEffect(() => {
    setSelectedIndex(0);
  }, [query, commands]);

  useEffect(() => {
    // On close, focus returns to the element that had it before opening.
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => {
      previous?.focus();
    };
  }, []);

  // Keep the selected row visible in long lists. jsdom ships no
  // scrollIntoView; the guard keeps tests honest instead of crashing.
  useEffect(() => {
    if (visible.length === 0) return;
    document.getElementById(`${listId}-option-${selected}`)?.scrollIntoView?.({ block: "nearest" });
  }, [listId, selected, visible.length]);

  // S11: the palette's keys are claimed at WINDOW level in capture, so a
  // keydown reaches the surface no matter what holds focus — including
  // nothing at all: after the app window loses and regains focus the
  // browser parks it on body, and the arrows must still move the selection.
  // One listener claims every key: Escape closes (isolated from the app-wide
  // Escape listeners), Tab / Shift+Tab cycle only among the palette's own
  // focusables (the input and, when shown, the Clear button) — focus never
  // escapes to the dimmed page behind the modal (S21 makes the palette the
  // only command surface, so focus lost behind the backdrop would strand the
  // user with no way back to commands) — and the list keys keep their S19
  // jobs: ↑/↓ move the selection with wraparound, Enter runs the selected
  // row once. Every other key is left alone: the field keeps typing. A
  // LAYOUT effect, so the claim is always in sync with the committed DOM —
  // a passive effect can be flushed after a state update is already
  // observable, and a keydown in that window would hit a stale claim.
  useLayoutEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (
        event.key !== "Escape" &&
        event.key !== "Tab" &&
        event.key !== "ArrowUp" &&
        event.key !== "ArrowDown" &&
        event.key !== "Enter"
      )
        return;
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        // Stop before the app-wide Escape listeners: closing the palette must
        // not also collapse the narrow navigation or another pane.
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "Tab") {
        const focusables = [
          ...(panelRef.current?.querySelectorAll<HTMLElement>("input, button:not(:disabled)") ?? []),
        ];
        if (focusables.length === 0) return;
        // Tab is always claimed inside the dialog: it cycles (two or more
        // focusables) or stays put (exactly one) — it never falls through to
        // whatever sits behind the backdrop.
        event.preventDefault();
        const index = focusables.indexOf(document.activeElement as HTMLElement);
        const offset = event.shiftKey ? -1 : 1;
        const next = focusables[(index + offset + focusables.length) % focusables.length]!;
        next.focus();
        return;
      }
      if (event.key === "Enter") {
        // R3-001/R4-001: Enter is claimed for the filter input, the list,
        // its rows and the dialog/backdrop surface — but NEVER from a
        // focused interactive control that is not a row of the list: the
        // Tab cycle parks focus on the Clear button, and pressing Enter
        // there must keep the button's native activation (clearing the
        // filter), not be swallowed for the selection (and never dispatch
        // a highlighted command instead — irreversible once run).
        // R3-001/R4-001: Enter is claimed for the filter input, the list,
        // its rows and the dialog/backdrop surface — but NEVER from a
        // focused interactive control that is not a row of the list: the
        // Tab cycle parks focus on the Clear button, and pressing Enter
        // there must keep the button's native activation (clearing the
        // filter) instead of being swallowed for the selection — a
        // swallowed clear or a dispatched command is irreversible once
        // the keydown lands.
        const target = event.target;
        const claimed =
          target === inputRef.current ||
          (target instanceof Element &&
            target.closest(
              "button, a, input, textarea, select, [role=\"button\"], [contenteditable]",
            ) === null);
        if (!claimed) return;
        event.preventDefault();
        const entry = visible[selected];
        if (entry) onRun(entry);
        return;
      }
      // ↑/↓ move the selection with wraparound.
      event.preventDefault();
      if (visible.length === 0) return;
      const offset = event.key === "ArrowDown" ? 1 : -1;
      setSelectedIndex((selected + offset + visible.length) % visible.length);
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [visible, selected, onRun, onClose]);

  // S11: when the app window regains focus (clicking back into the GUI after
  // clicking outside it, or the tab becoming visible again) and the palette
  // is open with focus parked outside it — the browser drops it on body —
  // the filter input takes focus back, so the arrows keep working without a
  // click inside the palette. isConnected-guarded like the close-restore
  // effect below.
  useEffect(() => {
    const restore = (): void => {
      if (panelRef.current?.contains(document.activeElement)) return;
      if (inputRef.current?.isConnected) inputRef.current.focus();
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

  const clearQuery = (): void => {
    setQuery("");
    inputRef.current?.focus();
  };

  const hasEntries = commands.length > 0;
  const hasMatches = visible.length > 0;

  // The body between the input and the footer: the honest no-commands note,
  // the grouped list, or the no-match note with its Clear button.
  let body: ReactNode;
  if (!hasEntries) {
    body = (
      <p className="gc-command-palette__empty" role="status">
        This conversation has not reported any commands yet. The palette lists the catalog the
        pi host publishes — its builtin commands (such as /new and /resume) alongside extension,
        prompt and skill commands.
      </p>
    );
  } else if (hasMatches) {
    body = (
      <div className="gc-command-palette__list" id={listId} role="listbox" aria-label="Commands">
        {GROUP_ORDER.map((group) => {
          const groupEntries = visible.filter((entry) => entry.source === group.key);
          if (groupEntries.length === 0) return null;
          return (
            <div key={group.key} className="gc-command-palette__group">
              <div className="gc-command-palette__group-head">
                <span className="gc-command-palette__group-name">{group.label}</span>
                <span className="gc-command-palette__group-count">{groupEntries.length}</span>
              </div>
              {groupEntries.map((entry) => {
                const index = visible.indexOf(entry);
                const isSelected = index === selected;
                return (
                  <div
                    key={`${group.key}-${entry.name}`}
                    id={`${listId}-option-${index}`}
                    role="option"
                    aria-selected={isSelected}
                    data-source={entry.source}
                    className={isSelected ? "gc-command-palette__row is-selected" : "gc-command-palette__row"}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onRun(entry)}
                  >
                    <span className="gc-command-palette__name">/{entry.name}</span>
                    {entry.description ? (
                      <span className="gc-command-palette__desc">{entry.description}</span>
                    ) : null}
                    <span className="gc-command-palette__badge">{entry.source}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  } else {
    body = (
      <div className="gc-command-palette__empty">
        <p>
          No command matches &quot;{query.trim()}&quot;
        </p>
        <button type="button" onClick={clearQuery}>
          Clear
        </button>
      </div>
    );
  }

  return createPortal(
    <div className="gc-dialog-backdrop">
      <div
        ref={panelRef}
        className="gc-command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Commands"
      >
        <div className="gc-command-palette__input">
          <span className="gc-command-palette__slash" aria-hidden="true">
            /
          </span>
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded={hasMatches}
            aria-controls={hasEntries ? listId : undefined}
            aria-activedescendant={hasMatches ? `${listId}-option-${selected}` : undefined}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="Type a command name…"
            aria-label="Filter commands"
          />
        </div>
        {body}
        <footer className="gc-command-palette__foot">
          <span className="gc-command-palette__hint">
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span className="gc-command-palette__hint">
            <kbd>↵</kbd> run
          </span>
          <span className="gc-command-palette__hint">
            <kbd>esc</kbd> close
          </span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
