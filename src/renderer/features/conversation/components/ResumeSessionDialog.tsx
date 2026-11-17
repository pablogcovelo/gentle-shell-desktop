import { useEffect, useId, useRef, useState } from "react";
import type { ChatSummary } from "@shared/bridge-types";
import { useBridge } from "@renderer/shared/bridge/useBridge";
import "@renderer/app/components/AppDialogs.css";
import "./ResumeSessionDialog.css";

interface ResumeSessionDialogProps {
  readonly directory: string;
  readonly onCancel: () => void;
  readonly onSelect: (chat: ChatSummary) => void;
}

/** Pi owns the history; this picker only selects a summary in this directory. */
export function ResumeSessionDialog({ directory, onCancel, onSelect }: ResumeSessionDialogProps) {
  const bridge = useBridge();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<{ directory: string; chats?: ChatSummary[]; error?: string }>();
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    // Capture at window level so App's global Escape/search cannot also act.
    const keydown = (event: KeyboardEvent): void => {
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        cancelRef.current();
      }
      if (event.key !== "Tab") return;
      const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      const first = buttons[0];
      const last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", keydown, true);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    bridge.listChats().then((chats) => {
      if (!cancelled) setResult({ directory, chats: chats.filter((chat) => chat.cwd === directory).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) });
    }).catch((cause: unknown) => {
      if (!cancelled) setResult({ directory, error: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => { cancelled = true; };
  }, [bridge, directory]);

  const current = result?.directory === directory ? result : undefined;
  return (
    <div className="gc-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div ref={panel} className="gc-dialog gc-resume" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="gc-dialog__header">
          <h2 id={titleId}>Resume a session</h2>
          <button type="button" className="gc-dialog__close" aria-label="Cancel resume" onClick={onCancel}>✕</button>
        </header>
        <p className="gc-dialog__intro">Pi sessions in <span className="gc-resume__directory">{directory}</span></p>
        {!current ? <p role="status">Loading sessions…</p> : current.error ? <p role="alert">Could not load sessions: {current.error}</p> : current.chats?.length === 0 ? <p>No saved sessions in this directory.</p> : (
          <ul className="gc-resume__sessions">
            {current.chats?.map((chat) => (
              <li key={chat.id}>
                <button type="button" className="gc-resume__session" onClick={() => onSelect(chat)}>
                  <span>{chat.title}</span>
                  <time dateTime={chat.updatedAt}>{new Date(chat.updatedAt).toLocaleString()}</time>
                </button>
              </li>
            ))}
          </ul>
        )}
        <footer className="gc-dialog__actions"><button type="button" className="gc-dialog__dismiss" onClick={onCancel}>Cancel</button></footer>
      </div>
    </div>
  );
}
