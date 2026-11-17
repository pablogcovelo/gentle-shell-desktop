import { directoryOf } from "./ChatListItem";

export interface WorkspaceRowProps {
  readonly directory: string;
  /** T1 (S2): whether a persisted registry entry backs this row. Only a
   * persisted row gets a remove action — a session-only row has nothing
   * persisted to forget (remove would be a silent no-op), so hiding the
   * action is the honest option. */
  readonly persisted?: boolean;
  readonly selected?: boolean;
  readonly disabled?: boolean;
  readonly branch?: string;
  readonly onSelect?: (directory: string) => void;
  readonly onRemove?: (directory: string) => void;
}

/**
 * T1: one Workspaces panel row per workspace directory. Selecting it
 * opens that directory's pane (no picker); the remove action deletes ONLY
 * the persisted registry entry — never a session file, a directory or a
 * chat. Reuses the chat row's classes so the panel's visual contract is
 * untouched; this is not a redesign.
 */
export function WorkspaceRow({ directory, persisted = false, selected = false, disabled = false, branch, onSelect, onRemove }: WorkspaceRowProps) {
  const name = directoryOf(directory) ?? directory;
  return (
    <li className="gc-workspace-row">
      <button
        type="button"
        className={`gc-chat-list-item${selected ? " gc-chat-list-item--selected" : ""}`}
        aria-current={selected || undefined}
        disabled={disabled}
        aria-label={`${name} — workspace`}
        title={directory}
        onClick={() => onSelect?.(directory)}
      >
        <svg
          className="gc-chat-list-item__glyph"
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" />
        </svg>
        <span className="gc-chat-list-item__body">
          <strong className="gc-chat-list-item__title">{name}</strong>
          {branch ? <span className="gc-chat-list-item__branch">{branch}</span> : null}
        </span>
      </button>
      {persisted && onRemove ? (
        <button
          type="button"
          className="gc-chat-list-item__remove"
          aria-label={`Remove workspace ${name}`}
          disabled={disabled}
          title="Close this workspace — Pi sessions and files are kept"
          onClick={() => onRemove(directory)}
        >
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      ) : null}
    </li>
  );
}
