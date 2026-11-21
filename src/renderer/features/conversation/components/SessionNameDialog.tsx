import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import "@renderer/app/components/AppDialogs.css";
import "./SessionNameDialog.css";

export interface SessionNameDialogProps {
  /** The chat's current session name (ChatState.session.sessionName) as
   * the prefill. Undefined when the child reported none: the field opens
   * empty and still refuses an empty value. */
  readonly initialName?: string;
  /** Confirmed with the typed text (trimmed); ConversationContainer
   * dispatches it as run_command args. */
  readonly onConfirm: (name: string) => void;
  readonly onCancel: () => void;
}

/**
 * The /name argument screen (palette-command-arguments T3, S4): a small
 * text input prefilled with the session's current name. The host rejects
 * an empty name, so the screen cannot send one: confirm stays disabled
 * for an empty or whitespace-only value and Enter does nothing. Escape
 * cancels without dispatching.
 *
 * Dialog conventions follow ResumeSessionDialog: the gc-dialog shell,
 * focus on open and restored on close, Escape/Tab claimed at window level
 * in capture, backdrop click cancels.
 */
export function SessionNameDialog({ initialName, onConfirm, onCancel }: SessionNameDialogProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  const [value, setValue] = useState(initialName ?? "");
  const trimmed = value.trim();
  const valid = trimmed.length > 0;

  useEffect(() => {
    // On close, focus returns to the element that had it before opening.
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => {
      previous?.focus();
    };
  }, []);

  // Escape and Tab are claimed at window level (ResumeSessionDialog's
  // convention) so the dialog cancels from any element inside it and focus
  // never escapes to the dimmed page behind. Other keys are left alone.
  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      // Only the two claimed keys are stopped here: a blanket
      // stopImmediatePropagation at window capture would keep every other
      // key (Enter, typing) from ever reaching the input.
      if (event.key !== "Escape" && event.key !== "Tab") return;
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        cancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = [...(panel.current?.querySelectorAll<HTMLElement>("input, button:not(:disabled)") ?? [])];
      if (focusables.length === 0) return;
      event.preventDefault();
      const index = focusables.indexOf(document.activeElement as HTMLElement);
      const offset = event.shiftKey ? -1 : 1;
      focusables[(index + offset + focusables.length) % focusables.length]!.focus();
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, []);

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (valid) onConfirm(trimmed);
  };

  return (
    <div role="presentation" className="gc-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div ref={panel} className="gc-dialog gc-session-name" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="gc-dialog__header">
          <h2 id={titleId}>Name this session</h2>
          <button type="button" className="gc-dialog__close" aria-label="Cancel rename" onClick={onCancel}>✕</button>
        </header>
        <p className="gc-dialog__intro">A name for this chat — the host refuses an empty one.</p>
        <div className="gc-session-name__field">
          <input
            ref={inputRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={handleInputKeyDown}
            autoComplete="off"
            spellCheck={false}
            aria-label="Session name"
          />
        </div>
        <footer className="gc-dialog__actions">
          <button type="button" className="gc-dialog__dismiss" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="gc-dialog__dismiss gc-session-name__confirm"
            disabled={!valid}
            onClick={() => {
              if (valid) onConfirm(trimmed);
            }}
          >
            Save name
          </button>
        </footer>
      </div>
    </div>
  );
}
