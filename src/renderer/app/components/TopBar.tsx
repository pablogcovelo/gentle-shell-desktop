import gentleRose from "@renderer/shared/assets/gentle-rose.png";
import "./TopBar.css";

/** Native actions are omitted in previews without an OS window bridge. */
export interface WindowControls {
  readonly minimize: () => void;
  readonly toggleMaximize: () => void;
  readonly close: () => void;
}

export interface TopBarProps {
  readonly sidebarVisible: boolean;
  readonly inspectorVisible: boolean;
  readonly onToggleSidebar: () => void;
  readonly onToggleInspector: () => void;
  readonly windowControls?: WindowControls;
}

/** Final board chrome: wordmark and panel/window controls only. */
export function TopBar({ sidebarVisible, inspectorVisible, onToggleSidebar, onToggleInspector, windowControls }: TopBarProps) {
  const workspaceLabel = sidebarVisible ? "Hide workspaces" : "Show workspaces";
  const infoLabel = inspectorVisible ? "Hide general information" : "Show general information";
  return (
    <header className="gc-topbar" aria-label="Application chrome">
      <div className="gc-topbar__brand">
        <img className="gc-topbar__rose" src={gentleRose} alt="" width={24} height={24} />
        <p className="gc-topbar__wordmark">Gentle Shell Desktop</p>
      </div>
      <div className="gc-topbar__controls" role="group" aria-label="Panel visibility">
        <button type="button" className="gc-topbar__toggle" aria-expanded={sidebarVisible} aria-controls="gc-chats" aria-label={workspaceLabel} title={workspaceLabel} onClick={onToggleSidebar}>
          <PanelGlyph side="left" filled={sidebarVisible} />
        </button>
        <button type="button" className="gc-topbar__toggle" aria-expanded={inspectorVisible} aria-controls="gc-inspector" aria-label={infoLabel} title={infoLabel} onClick={onToggleInspector}>
          <PanelGlyph side="right" filled={inspectorVisible} />
        </button>
        {windowControls ? (
          <div className="gc-topbar__window" role="group" aria-label="Window controls">
            <button type="button" className="gc-topbar__window-button" aria-label="Minimize window" title="Minimize window" onClick={windowControls.minimize}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M5 17h14" /></svg>
            </button>
            <button type="button" className="gc-topbar__window-button" aria-label="Maximize window" title="Maximize window" onClick={windowControls.toggleMaximize}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="1" /></svg>
            </button>
            <button type="button" className="gc-topbar__window-button gc-topbar__window-button--close" aria-label="Close window" title="Close window" onClick={windowControls.close}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </button>
          </div>
        ) : null}
      </div>
    </header>
  );
}

function PanelGlyph({ side, filled }: { readonly side: "left" | "right"; readonly filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d={side === "left" ? "M9 4v16" : "M15 4v16"} />
      {filled ? <rect x={side === "left" ? 4 : 16} y="5" width="4" height="14" fill="currentColor" stroke="none" /> : null}
    </svg>
  );
}
