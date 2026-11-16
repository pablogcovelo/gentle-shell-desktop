import { useId, useState, useLayoutEffect, useRef, useEffect, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import type { ChatCommand } from "@shared/bridge-types";
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
  /** The slash commands the child answered for `get_commands`
   * (desktop-pending-work T6, S6), in the order it sent them. Absent or
   * empty means the child did not answer (or answered none): the list is
   * simply not available — no empty popup, no placeholder entry, and never
   * a hardcoded `/gentle:*` replica (S6/S11). */
  readonly commands?: readonly ChatCommand[];
}

/** The fixed palette: literal characters, no emoji data source. */
const EMOJIS = ["🙂", "🎉", "✅", "🚧", "❤️", "⚡", "🔍", "📌"] as const;

/** Artboard `.composer-tool` icons, by their 24px stroke path. */
const ICON_PATHS = {
  emoji: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M8 9h.01M16 9h.01M8 14s1.5 3 4 3 4-3 4-3",
  attachment: "m21 11-8.5 8.5a6 6 0 0 1-8.5-8.5L13 2.5a4 4 0 0 1 5.7 5.7l-8.5 8.5a2 2 0 0 1-2.8-2.8L15 6.3",
  microphone: "M9 6a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0V6ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8",
} as const;

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

interface EmojiPanelProps {
  readonly id: string;
  readonly onPick: (emoji: string) => void;
  readonly onClose: () => void;
}

function EmojiPanel({ id, onPick, onClose }: EmojiPanelProps) {
  return (
    <div
      className="gc-composer__emoji-panel"
      role="group"
      aria-label="Emoji"
      id={id}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      {EMOJIS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          className="gc-composer__emoji"
          aria-label={emoji}
          title={emoji}
          onClick={() => onPick(emoji)}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}

/**
 * Presentational: local draft text and the bridge calls both live in
 * ConversationContainer. Enter sends (and is prevented from inserting a
 * newline), Shift+Enter inserts a newline (default textarea behaviour, left
 * alone), Esc aborts while working. The field is `readOnly` (not
 * `disabled`) while working: a disabled textarea would stop receiving the
 * Escape keydown the abort shortcut depends on.
 */
export function Composer({ value, working, onChange, onSend, onAbort, ready = true, onPickFile, commands }: ComposerProps) {
  // A pane that does not know its host has nowhere to send: offering an enabled
  // Send there only produces a request main must refuse, so it waits instead.
  const canSend = ready && !working && value.trim().length > 0;

  const [emojiOpen, setEmojiOpen] = useState(false);
  const emojiPanelId = useId();
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  // The slash-command list (desktop-pending-work T6, S6). The token is the
  // typed text after a leading "/" while no space has been typed yet; the
  // visible entries are the child's own commands filtered by it,
  // case-insensitively, in the order received.
  const slashToken = /^\/\S*$/.test(value) ? value.slice(1) : undefined;
  const matches =
    commands && slashToken !== undefined
      ? commands.filter((command) => command.name.toLowerCase().startsWith(slashToken.toLowerCase()))
      : [];
  const commandsListId = useId();
  // Escape dismisses the list for the CURRENT token only: the next typed
  // character changes the token, so the list re-opens and re-filters, while
  // returning to the dismissed token keeps it closed.
  const [dismissedToken, setDismissedToken] = useState<string | undefined>(undefined);
  const listOpen = slashToken !== undefined && matches.length > 0 && dismissedToken !== slashToken;
  // Nothing is highlighted until an arrow key moves there; Enter only
  // completes a HIGHLIGHTED command (S6), so a freshly opened list does not
  // silently swallow a submit.
  const [activeIndex, setActiveIndex] = useState(-1);
  useEffect(() => {
    setActiveIndex(-1);
  }, [slashToken, matches.length]);

  /** Completes the draft to `/name ` — through the same onChange contract
   * that owns it; the completed token is the whole draft, since a token
   * only exists while no space has been typed. */
  const completeCommand = (name: string): void => {
    onChange(`/${name} `);
  };
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
    // While the slash list is open it owns ArrowDown/ArrowUp (highlight,
    // wrapping), Enter (complete the HIGHLIGHTED command instead of
    // submitting) and Escape (dismiss for this token) — desktop-pending-work
    // T6, S6. Every other keystroke falls through and keeps typing; the list
    // re-filters from the new draft.
    if (listOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => {
        const count = matches.length;
        if (count === 0) return -1;
        if (index < 0) return delta === 1 ? 0 : count - 1;
        return (index + delta + count) % count;
      });
      return;
    }
    if (event.key === "Escape") {
      if (listOpen) {
        setDismissedToken(slashToken);
        return;
      }
      if (working) onAbort();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const highlighted = listOpen && activeIndex >= 0 ? matches[activeIndex] : undefined;
      if (highlighted) {
        completeCommand(highlighted.name);
        return;
      }
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

  const handlePickEmoji = (emoji: string): void => {
    appendToDraft(emoji);
    setEmojiOpen(false);
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
        <label className="gc-composer__eyebrow" htmlFor={`${emojiPanelId}-draft`}>Your next move</label>
        <textarea
          className="gc-text-field"
          ref={fieldRef}
          id={`${emojiPanelId}-draft`}
          rows={2}
          placeholder="Tell Gentle what you need…"
          value={value}
          readOnly={working}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          aria-expanded={listOpen}
          aria-controls={listOpen ? commandsListId : undefined}
        />
          <div className="gc-composer__tools">
            <button
              type="button"
              className="gc-composer__tool"
              aria-label="Emoji"
              title="Emoji"
              aria-expanded={emojiOpen}
              aria-controls={emojiPanelId}
              onClick={() => setEmojiOpen((open) => !open)}
            >
              <ToolIcon d={ICON_PATHS.emoji} />
            </button>
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
            {emojiOpen ? <EmojiPanel id={emojiPanelId} onPick={handlePickEmoji} onClose={() => setEmojiOpen(false)} /> : null}
        {listOpen ? (
          // Anchored inside the composer box, just above it (the EmojiPanel
          // popup precedent), in the order the child answered. An entry
          // without a description renders only its name; no argument hint
          // exists on the wire and none is invented (S6/S11).
          <ul
            className="gc-composer__commands"
            id={commandsListId}
            role="listbox"
            aria-label="Slash commands"
          >
            {matches.map((command, index) => (
              <li
                key={command.name}
                role="option"
                id={`${commandsListId}-option-${index}`}
                aria-selected={index === activeIndex}
                className={index === activeIndex ? "gc-composer__command is-active" : "gc-composer__command"}
                // Keep the textarea focused and the draft intact; the click
                // itself completes the entry.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => completeCommand(command.name)}
              >
                <span className="gc-composer__command-name">/{command.name}</span>
                {command.description ? <span className="gc-composer__command-desc">{command.description}</span> : null}
              </li>
            ))}
          </ul>
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
          <button className="gc-composer__send" type="submit" aria-label="Send" disabled={!canSend}>
            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M4 3.5 21 12 4 20.5V14l10-2-10-2V3.5Z" /></svg>
          </button>
        </div>
          </div>
        </div>
      </div>
      <p className="gc-composer__hints">Enter to send · Shift+Enter for a new line · Esc to stop</p>
    </form>
  );
}
