import { useId, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "@renderer/shared/ui/atoms/Button";
import { TextField } from "@renderer/shared/ui/atoms/TextField";
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
export function Composer({ value, working, onChange, onSend, onAbort, ready = true, onPickFile }: ComposerProps) {
  // A pane that does not know its host has nowhere to send: offering an enabled
  // Send there only produces a request main must refuse, so it waits instead.
  const canSend = ready && !working && value.trim().length > 0;

  const [emojiOpen, setEmojiOpen] = useState(false);
  const emojiPanelId = useId();

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    onChange(event.target.value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Escape") {
      if (working) onAbort();
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
        <p className="gc-composer__eyebrow">Your next move</p>
        <TextField
          multiline
          rows={2}
          placeholder="Tell Gentle what you need…"
          value={value}
          readOnly={working}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
        />
        <div className="gc-composer__foot">
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
            {/** S13: no audio pipeline exists, so it stays disabled with the reason. */}
            <button
              type="button"
              className="gc-composer__tool"
              disabled
              aria-label="Microphone — this bridge has no audio capture"
              title="Microphone — this bridge has no audio capture"
            >
              <ToolIcon d={ICON_PATHS.microphone} />
            </button>
            {emojiOpen ? (
              <EmojiPanel id={emojiPanelId} onPick={handlePickEmoji} onClose={() => setEmojiOpen(false)} />
            ) : null}
          </div>
          <Button type="submit" disabled={!canSend}>
            Send
          </Button>
        </div>
      </div>
      <p className="gc-composer__hints">Enter to send · Shift+Enter for a new line · Esc to stop</p>
    </form>
  );
}
