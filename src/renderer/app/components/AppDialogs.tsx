import { useEffect } from "react";
import type { SetupStatus } from "@shared/bridge-types";
import "./AppDialogs.css";

export const APP_DIALOG = {
  SETTINGS: "settings",
  SHORTCUTS: "shortcuts",
} as const;

export type AppDialogName = (typeof APP_DIALOG)[keyof typeof APP_DIALOG];

export interface AppDialogsProps {
  /** Which dialog is open; undefined renders nothing at all. */
  readonly dialog?: AppDialogName;
  readonly onClose: () => void;
  /** The packaged app's version, when the bridge reported one. */
  readonly appVersion?: string;
  /** What the first-run probe found, when it has answered. */
  readonly setup?: SetupStatus;
}

/**
 * The chrome's two dialogs. Both carry real content and nothing else:
 *
 * - Settings lists the facts this build actually owns — the app version and
 *   the pi installation the first-run probe found. There are no preferences
 *   to toggle yet, and inventing some would be a control that lies.
 * - Shortcuts lists the keys the app really answers, so the artboard's
 *   reserved entry point becomes documentation instead of a placeholder.
 */
export function AppDialogs({ dialog, onClose, appVersion, setup }: AppDialogsProps) {
  // Escape closes whichever dialog is open; registered only while one is.
  useEffect(() => {
    if (!dialog) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dialog, onClose]);

  if (!dialog) return null;

  const isSettings = dialog === APP_DIALOG.SETTINGS;

  return (
    <div
      className="gc-dialog-backdrop"
      // A click on the backdrop (never on the panel) dismisses.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="gc-dialog" role="dialog" aria-modal="true" aria-labelledby="gc-dialog-title">
        <header className="gc-dialog__header">
          <h2 id="gc-dialog-title">{isSettings ? "Application settings" : "Keyboard shortcuts"}</h2>
          <button type="button" className="gc-dialog__close" aria-label="Close dialog" onClick={onClose}>
            ✕
          </button>
        </header>
        {isSettings ? <SettingsBody appVersion={appVersion} setup={setup} /> : <ShortcutsBody />}
        <footer className="gc-dialog__actions">
          <button type="button" className="gc-dialog__dismiss" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

function SettingsBody({ appVersion, setup }: { readonly appVersion?: string; readonly setup?: SetupStatus }) {
  const detection = setup?.detection;
  return (
    <>
      <p className="gc-dialog__intro">
        Facts from this build. This window holds no preferences of its own — the pi home is chosen on first run.
      </p>
      <dl className="gc-dialog__facts">
        <div className="gc-dialog__fact">
          <dt>version</dt>
          <dd>{appVersion ?? "not reported by this build"}</dd>
        </div>
        <div className="gc-dialog__fact">
          <dt>pi</dt>
          <dd>
            {detection
              ? detection.found
                ? `found in ${detection.dir}`
                : "not found in the default locations"
              : "still checking"}
          </dd>
        </div>
        {detection?.found ? (
          <>
            <div className="gc-dialog__fact">
              <dt>auth</dt>
              <dd>{detection.hasAuth ? "present" : "missing"}</dd>
            </div>
            <div className="gc-dialog__fact">
              <dt>models</dt>
              <dd>{detection.hasModels ? "present" : "missing"}</dd>
            </div>
          </>
        ) : null}
      </dl>
    </>
  );
}

/** The keys this app really answers, in the order the composer documents them. */
const SHORTCUTS: readonly { readonly keys: string; readonly action: string }[] = [
  { keys: "Enter", action: "Send the message" },
  { keys: "Shift+Enter", action: "Start a new line" },
  { keys: "Esc", action: "Stop the running turn" },
  { keys: "⌘K / Ctrl+K", action: "Focus the chat search" },
  { keys: "Esc in search", action: "Clear the search" },
  { keys: "Esc in a dialog", action: "Close the dialog" },
];

function ShortcutsBody() {
  return (
    <dl className="gc-dialog__facts">
      {SHORTCUTS.map((shortcut) => (
        <div key={shortcut.keys} className="gc-dialog__fact">
          <dt>
            <kbd>{shortcut.keys}</kbd>
          </dt>
          <dd>{shortcut.action}</dd>
        </div>
      ))}
    </dl>
  );
}
