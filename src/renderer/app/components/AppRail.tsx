import "./AppRail.css";

export interface AppRailProps {
  readonly sidebarVisible: boolean;
  readonly onToggleSidebar: () => void;
  readonly onOpenSettings: () => void;
  readonly onOpenShortcuts: () => void;
}

/** Board-equivalent rail actions backed by the shell's real dialogs. */
export function AppRail({ sidebarVisible, onToggleSidebar, onOpenSettings, onOpenShortcuts }: AppRailProps) {
  return (
    <nav className="gc-rail" aria-label="Application">
      <button type="button" className="gc-rail__item gc-rail__item--active" aria-expanded={sidebarVisible} aria-controls="gc-chats" onClick={onToggleSidebar}>
        <RailGlyph kind="folder" />
        <span className="gc-rail__label">Workspaces</span>
      </button>
      <div className="gc-rail__tools">
        <RailTools onOpenSettings={onOpenSettings} onOpenShortcuts={onOpenShortcuts} />
      </div>
    </nav>
  );
}

/** Reused in the narrow sidebar, where the rail is not displayed. */
export function RailTools({ onOpenSettings, onOpenShortcuts }: Pick<AppRailProps, "onOpenSettings" | "onOpenShortcuts">) {
  return <>
    <button type="button" className="gc-rail__action" aria-label="Add quick shortcut" title="Keyboard shortcuts" onClick={onOpenShortcuts}><RailGlyph kind="plus" /></button>
    <button type="button" className="gc-rail__action" aria-label="Application settings" title="Application settings" onClick={onOpenSettings}><RailGlyph kind="settings" /></button>
  </>;
}

function RailGlyph({ kind }: { readonly kind: "folder" | "plus" | "settings" }) {
  const paths = {
    folder: "M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z",
    plus: "M12 5v14M5 12h14",
    settings: "m9 3-.6 2.4-2.1 1.2L4 6l-2 3 1.7 1.8v2.4L2 15l2 3 2.3-.6 2.1 1.2L9 21h4l.6-2.4 2.1-1.2 2.3.6 2-3-1.7-1.8v-2.4L20 9l-2-3-2.3.6-2.1-1.2L13 3H9ZM15 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  };
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>;
}
