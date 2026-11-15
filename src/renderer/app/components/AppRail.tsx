import "./AppRail.css";

export interface AppRailProps {
  /** Whether the chat sidebar column is currently shown. */
  readonly sidebarVisible: boolean;
  readonly onToggleSidebar: () => void;
}

/**
 * Application rail (design/slack-gentle/01-workspace.html "Workspace"):
 * the narrow column left of the directory panel. The app has exactly one
 * workspace-level section today — the chat directories — so the rail holds
 * that one item and it toggles the panel instead of pretending to switch
 * between sections the bridge cannot serve. The artboard's shortcut and
 * settings entries are design previews with no defined behavior and are not
 * rendered (no dead controls).
 */
export function AppRail({ sidebarVisible, onToggleSidebar }: AppRailProps) {
  return (
    <nav className="gc-rail" aria-label="Application">
      <button
        type="button"
        className={`gc-rail__item${sidebarVisible ? " gc-rail__item--active" : ""}`}
        aria-expanded={sidebarVisible}
        aria-controls="gc-chats"
        onClick={onToggleSidebar}
      >
        <FolderGlyph />
        <span className="gc-rail__label">Chats</span>
      </button>
    </nav>
  );
}

function FolderGlyph() {
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
      <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" />
    </svg>
  );
}
