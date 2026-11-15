import { useEffect, useRef } from "react";
import gentleRose from "@renderer/shared/assets/gentle-rose.png";
import "./TopBar.css";

/** The window's own actions, present only where the bridge exposes them
 * (Electron); the browser preview has no OS window to act on. */
export interface WindowControls {
  readonly minimize: () => void;
  readonly toggleMaximize: () => void;
  readonly close: () => void;
}

export interface TopBarProps {
  /** Whether the chat sidebar column is currently shown. */
  readonly sidebarVisible: boolean;
  /** Whether the plan/usage/agents panel is currently shown. */
  readonly inspectorVisible: boolean;
  readonly onToggleSidebar: () => void;
  readonly onToggleInspector: () => void;
  /** The sidebar's search text: one filter, owned by the shell. */
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly onOpenSettings: () => void;
  readonly onOpenShortcuts: () => void;
  /** Absent outside Electron, where the OS frame already provides them. */
  readonly windowControls?: WindowControls;
}

/**
 * App chrome row (design/slack-gentle/01-workspace.html "Workspace"): rose and
 * wordmark, the search box, then the shell's controls — settings, shortcuts,
 * the two panel toggles and the window's own buttons.
 *
 * The bar is the window's drag region once the frame is gone, so every
 * interactive child opts out of dragging explicitly.
 */
export function TopBar({
  sidebarVisible,
  inspectorVisible,
  onToggleSidebar,
  onToggleInspector,
  query,
  onQueryChange,
  onOpenSettings,
  onOpenShortcuts,
  windowControls,
}: TopBarProps) {
  const searchRef = useRef<HTMLInputElement>(null);

  // ⌘K / Ctrl+K focuses the search, and Escape clears it — the keyboard route
  // the artboard's kbd hint promises.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <header className="gc-topbar">
      <div className="gc-topbar__brand">
        <img className="gc-topbar__rose" src={gentleRose} alt="" width={24} height={24} />
        <p className="gc-topbar__wordmark">
          Gentle Shell <span className="gc-topbar__wordmark-suffix">Desktop</span>
        </p>
      </div>

      <div className="gc-topbar__search">
        <SearchGlyph />
        <input
          ref={searchRef}
          type="search"
          className="gc-topbar__search-input"
          aria-label="Search chats"
          placeholder="Search chats…"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onQueryChange("");
          }}
        />
        <kbd className="gc-topbar__search-kbd">⌘K</kbd>
      </div>

      <div className="gc-topbar__controls" role="group" aria-label="Application controls">
        <button
          type="button"
          className="gc-topbar__toggle"
          aria-label="Open settings"
          title="Settings"
          onClick={onOpenSettings}
        >
          <SettingsGlyph />
        </button>
        <button
          type="button"
          className="gc-topbar__toggle"
          aria-label="Open keyboard shortcuts"
          title="Keyboard shortcuts"
          onClick={onOpenShortcuts}
        >
          <KeyboardGlyph />
        </button>
        <button
          type="button"
          className="gc-topbar__toggle"
          aria-expanded={sidebarVisible}
          aria-controls="gc-chats"
          aria-label={sidebarVisible ? "Hide chats" : "Show chats"}
          title={sidebarVisible ? "Hide chats" : "Show chats"}
          onClick={onToggleSidebar}
        >
          <PanelGlyph side="left" filled={sidebarVisible} />
        </button>
        <button
          type="button"
          className="gc-topbar__toggle"
          aria-expanded={inspectorVisible}
          aria-controls="gc-inspector"
          aria-label={inspectorVisible ? "Hide plan, usage and agents" : "Show plan, usage and agents"}
          title={inspectorVisible ? "Hide plan, usage and agents" : "Show plan, usage and agents"}
          onClick={onToggleInspector}
        >
          <PanelGlyph side="right" filled={inspectorVisible} />
        </button>
        {windowControls ? (
          <div className="gc-topbar__window" role="group" aria-label="Window controls">
            <button
              type="button"
              className="gc-topbar__window-button"
              aria-label="Minimize window"
              title="Minimize"
              onClick={windowControls.minimize}
            >
              <MinimizeGlyph />
            </button>
            <button
              type="button"
              className="gc-topbar__window-button"
              aria-label="Maximize window"
              title="Maximize"
              onClick={windowControls.toggleMaximize}
            >
              <MaximizeGlyph />
            </button>
            <button
              type="button"
              className="gc-topbar__window-button gc-topbar__window-button--close"
              aria-label="Close window"
              title="Close"
              onClick={windowControls.close}
            >
              <CloseGlyph />
            </button>
          </div>
        ) : null}
      </div>
    </header>
  );
}

/** A framed panel with the side it toggles highlighted while it is shown. */
function PanelGlyph({ side, filled }: { readonly side: "left" | "right"; readonly filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d={side === "left" ? "M9 4v16" : "M15 4v16"} />
      {filled ? (
        <rect x={side === "left" ? 4 : 16} y="5" width="4" height="14" fill="currentColor" stroke="none" />
      ) : null}
    </svg>
  );
}

function SearchGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function SettingsGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 7.1 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 3 15H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 7.1a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 3V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 16.9 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 21 9h.09a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1.06Z" />
    </svg>
  );
}

function KeyboardGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
    </svg>
  );
}

function MinimizeGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M5 17h14" />
    </svg>
  );
}

function MaximizeGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="1" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}
