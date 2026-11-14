import type { ChangeEvent } from "react";
import { Button } from "@renderer/shared/ui/atoms/Button";
import "./HelpersFooter.css";

export interface HelpersFooterProps {
  readonly followLive: boolean;
  readonly showToolDetails: boolean;
  readonly onToggleFollowLive: (value: boolean) => void;
  readonly onToggleShowToolDetails: (value: boolean) => void;
  readonly onBackToChat: () => void;
  /**
   * Why Stop is disabled right now, or undefined while it is enabled
   * (desktop-rpc T6). Every disabled state names its honest reason:
   * unprobed channel, a failed probe, a child without `cancel_subagent`,
   * a selected helper that is not queued/running — or no helper selected
   * at all. Mirrors the honest-note pattern of the usage surface.
   */
  readonly stopDisabledReason?: string;
  /** The outcome note of the latest Stop request (e.g. "Stop requested —
   * the helper stops asynchronously…"). Cleared by the container when the
   * selection changes. */
  readonly stopNote?: string;
  readonly onStop: () => void;
}

// Presentational: Follow live / Show tool details toggles (plain
// checkboxes — a single-feature control, no shared Checkbox atom exists
// yet and only this feature needs one), Back to chat, and the Stop button
// (desktop-rpc T6): enabled only for a queued/running helper once the
// chat's control channel is adopted, disabled with its reason otherwise.
// Stopping is asynchronous: onStop asks gentle-shell, and the row updates
// when the following `agents_update` state push confirms the exit — the
// button never claims success on its own response.
export function HelpersFooter({ followLive, showToolDetails, onToggleFollowLive, onToggleShowToolDetails, onBackToChat, stopDisabledReason, stopNote, onStop }: HelpersFooterProps) {
  const handleFollowLive = (event: ChangeEvent<HTMLInputElement>): void => onToggleFollowLive(event.target.checked);
  const handleShowToolDetails = (event: ChangeEvent<HTMLInputElement>): void => onToggleShowToolDetails(event.target.checked);

  return (
    <footer className="gc-helpers-footer">
      <label className="gc-helpers-footer__toggle">
        <input type="checkbox" checked={followLive} onChange={handleFollowLive} />
        Follow live
      </label>
      <label className="gc-helpers-footer__toggle">
        <input type="checkbox" checked={showToolDetails} onChange={handleShowToolDetails} />
        Show tool details
      </label>
      {stopNote ? <span className="gc-helpers-footer__note">{stopNote}</span> : null}
      <div className="gc-helpers-footer__actions">
        <Button type="button" variant="ghost" onClick={onBackToChat}>
          Back to chat
        </Button>
        <Button type="button" variant="ghost" disabled={stopDisabledReason !== undefined} title={stopDisabledReason ?? "Stop this helper"} onClick={onStop}>
          Stop
        </Button>
      </div>
    </footer>
  );
}
