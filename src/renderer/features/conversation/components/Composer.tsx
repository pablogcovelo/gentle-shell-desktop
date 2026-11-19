import { useId, useLayoutEffect, useRef, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import "./Composer.css";

export interface ComposerProps {
  readonly value: string;
  readonly working: boolean;
  readonly onChange: (value: string) => void;
  readonly onSend: () => void;
  readonly onAbort: () => void;
  /** Whether a request from this pane can be routed at all: false while the
   * chat's workspace host is still unresolved. Defaults to true so a composer
   * without a host model keeps working. */
  readonly ready?: boolean;
  /** Opens the native file picker and resolves the chosen absolute path, or
   * null when cancelled/absent. The composer INSERTS that path into the
   * draft — it never reads or uploads the file. Omitted hides the
   * attachment action entirely (a bridge without a picker). */
  readonly onPickFile?: () => Promise<string | null>;
  /** Opens the command palette owned by ConversationContainer (S19/S21):
   * the slash affordance left the composer; this quiet button is the only
   * way in. Omitted hides the button (a bare caller without the palette). */
  readonly onOpenPalette?: () => void;
}

/** The palette-open shortcut glyph depends on the platform, asked exactly
 * once at module load — no new dependency (S21). */
const IS_MAC = /mac/i.test(
  typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent,
);

/** Artboard `.composer-tool` icons, by their 24px stroke path. */
const ICON_PATHS = {
  attachment: "m21 11-8.5 8.5a6 6 0 0 1-8.5-8.5L13 2.5a4 4 0 0 1 5.7 5.7l-8.5 8.5a2 2 0 0 1-2.8-2.8L15 6.3",
  microphone: "M9 6a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0V6ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8",
} as const;

/** S2: two consecutive Escape presses inside this window stop the agent. */
const DOUBLE_ESCAPE_STOP_WINDOW_MS = 1500;

function ToolIcon({ d }: { readonly d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

/**
 * Presentational: local draft text and the bridge calls both live in
 * ConversationContainer. Enter sends (and is prevented from inserting a
 * newline), Shift+Enter inserts a newline (default textarea behaviour, left
 * alone), and two consecutive Escapes inside the stop window abort the agent
 * while it is working (S2); a single Escape keeps its non-destructive job.
 * The field is `readOnly` (not `disabled`) while working: a disabled
 * textarea would stop receiving the Escape keydown the gesture depends on.
 */
export function Composer({ value, working, onChange, onSend, onAbort, ready = true, onPickFile, onOpenPalette }: ComposerProps) {
  // A pane that does not know its host has nowhere to send: offering an enabled
  // Send there only produces a request main must refuse, so it waits instead.
  const canSend = ready && !working && value.trim().length > 0;

  const draftId = useId();
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  // Timestamp (ms) of the previous Escape handled by this composer, for the
  // S2 double-Esc stop gesture; 0 means "no previous press".
  const lastEscapeAtRef = useRef(0);

  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    const resize = (): void => {
      field.style.height = "auto";
      const max = Math.min(window.innerHeight * 0.32, 260);
      field.style.height = `${Math.max(48, Math.min(field.scrollHeight, max))}px`;
      field.style.overflowY = field.scrollHeight > max ? "auto" : "hidden";
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [value]);

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    onChange(event.target.value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // S21: the slash list and its keys are gone. Escape keeps exactly its S2
    // double-Esc stop job; every other keystroke falls through and keeps
    // typing.
    if (event.key === "Escape") {
      const now = Date.now();
      if (working && now - lastEscapeAtRef.current <= DOUBLE_ESCAPE_STOP_WINDOW_MS) {
        // S2: the second of two consecutive Escapes inside the window stops
        // the agent; reset so a later pair needs two fresh presses.
        lastEscapeAtRef.current = 0;
        onAbort();
        return;
      }
      // Either press (while idle) or first press (while working): record it
      // and keep Escape's non-destructive job — nothing is stopped here.
      lastEscapeAtRef.current = now;
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (canSend) onSend();
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (canSend) onSend();
  };

  /** Appends through the same onChange contract that owns the draft. */
  const appendToDraft = (suffix: string): void => {
    onChange(value + suffix);
  };

  /** S14: the chosen absolute path is INSERTED, never read or uploaded. */
  const handlePickFile = async (): Promise<void> => {
    if (!onPickFile) return;
    const path = await onPickFile();
    if (path === null) return;
    appendToDraft((value.length > 0 ? " " : "") + path);
  };

  return (
    <form className="gc-composer" aria-label="Composer" onSubmit={handleSubmit}>
      <div className="gc-composer__box">
        <div className="gc-composer__input-column">
        <label className="gc-composer__eyebrow" htmlFor={`${draftId}-draft`}>Your next move</label>
        <textarea
          className="gc-text-field"
          ref={fieldRef}
          id={`${draftId}-draft`}
          rows={2}
          placeholder="Tell Gentle what you need…"
          value={value}
          readOnly={working}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
        />
          <div className="gc-composer__tools">
            {onPickFile ? (
              <button
                type="button"
                className="gc-composer__tool"
                aria-label="Attachment"
                title="Attachment"
                onClick={() => void handlePickFile()}
              >
                <ToolIcon d={ICON_PATHS.attachment} />
              </button>
            ) : null}
        <div className="gc-composer__foot">
            {/** No audio pipeline exists: disclose the unavailable action. */}
            <button
              type="button"
              className="gc-composer__tool"
              disabled
              aria-label="Microphone — this bridge has no audio capture"
              title="Microphone — this bridge has no audio capture"
            >
              <ToolIcon d={ICON_PATHS.microphone} />
            </button>
          {onOpenPalette ? (
            // S21: the quiet way back into commands — opens the palette
            // ConversationContainer owns. T10 (R2-006): the visible label
            // names the FULL shortcut per platform (⌘K on macOS, Ctrl+K
            // elsewhere), not only the modifier glyph; the accessible name
            // stays "Commands".
            <button
              type="button"
              className="gc-composer__palette"
              aria-label="Commands"
              title={`Open the command palette (${IS_MAC ? "⌘K" : "Ctrl+K"})`}
              onClick={onOpenPalette}
            >
              <span aria-hidden="true">{IS_MAC ? "⌘K" : "Ctrl+K"}</span>
              Commands
            </button>
          ) : null}
          <button className="gc-composer__send" type="submit" aria-label="Send" disabled={!canSend}>
            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M4 3.5 21 12 4 20.5V14l10-2-10-2V3.5Z" /></svg>
          </button>
        </div>
          </div>
        </div>
      </div>
      <p className="gc-composer__hints">Enter to send · Shift+Enter for a new line · Esc Esc to stop the agent</p>
    </form>
  );
}
