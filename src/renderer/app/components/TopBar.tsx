import gentleRose from "@renderer/shared/assets/gentle-rose.png";
import "./TopBar.css";

export interface TopBarProps {
  /** Whether the chat sidebar column is currently shown. */
  readonly sidebarVisible: boolean;
  /** Whether the plan/usage/agents panel is currently shown. */
  readonly inspectorVisible: boolean;
  readonly onToggleSidebar: () => void;
  readonly onToggleInspector: () => void;
}

/**
 * App chrome row (design/slack-gentle/01-workspace.html "Workspace"): the
 * rose plus the wordmark on the left, the two panel-visibility toggles on the
 * right. The artboard's window controls, search box and session summary are
 * deliberately absent — the window is framed by the OS, the app has no search,
 * and session facts live in the footer and status line (one home per datum).
 *
 * Both toggles are real: they collapse the sidebar and the inspector columns.
 * Nothing here is a preview placeholder.
 */
export function TopBar({ sidebarVisible, inspectorVisible, onToggleSidebar, onToggleInspector }: TopBarProps) {
  return (
    <header className="gc-topbar">
      <div className="gc-topbar__brand">
        <img className="gc-topbar__rose" src={gentleRose} alt="" width={24} height={24} />
        <p className="gc-topbar__wordmark">
          Gentle Shell <span className="gc-topbar__wordmark-suffix">Desktop</span>
        </p>
      </div>
      <div className="gc-topbar__controls" role="group" aria-label="Panel visibility">
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
        <rect
          x={side === "left" ? 4 : 16}
          y="5"
          width="4"
          height="14"
          fill="currentColor"
          stroke="none"
        />
      ) : null}
    </svg>
  );
}
