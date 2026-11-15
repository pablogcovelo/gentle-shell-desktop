import { useEffect, useRef, type ReactNode } from "react";
import { MESSAGE_ROLE, type ChatMessage, type Dialog, type DialogAnswer } from "@shared/bridge-types";
import { DialogCard } from "./DialogCard";
import { MessageBubble } from "./MessageBubble";
import { WelcomeHero } from "./WelcomeHero";
import "./MessageThread.css";

export interface MessageThreadProps {
  readonly messages: readonly ChatMessage[];
  readonly dialogs: readonly Dialog[];
  readonly onAnswerDialog: (id: string, answer: DialogAnswer) => void;
  /**
   * Identity of the open chat for the welcome hero's one-intro-per-chat rule
   * (T9b). Omitted means no hero: the thread stays a plain message list for
   * callers that do not own a chat identity.
   */
  readonly welcomeKey?: string;
  readonly activity?: ReactNode;
}

// Presentational: renders message bubbles in order, then any pending
// dialog cards (pi blocks on these, so they read as the newest thing in
// the thread), and auto-scrolls to the bottom whenever either changes.
export function MessageThread({ messages, dialogs, onAnswerDialog, welcomeKey, activity }: MessageThreadProps) {
  // React 19: ref is a normal prop/hook value, no forwardRef needed.
  const bottomRef = useRef<HTMLDivElement>(null);

  // Safety net for the domain-level fix in chatReducer.ts/history.ts: an
  // assistant message that finalized (streaming !== true) with nothing but
  // whitespace text renders as an empty grey bubble. It should already have
  // been dropped upstream, but this belongs here too so no other producer
  // of `messages` can reintroduce the same empty bubble. A still-streaming
  // empty assistant message stays visible as the typing placeholder; user
  // messages are never filtered.
  const visibleMessages = messages.filter(
    (message) => message.role !== MESSAGE_ROLE.ASSISTANT || message.streaming === true || message.text.trim().length > 0,
  );
  const isEmpty = visibleMessages.length === 0 && dialogs.length === 0;

  // Scrolling to the bottom is about following a conversation. An empty chat
  // has nothing to follow, and scrolling there would push the welcome hero
  // (T9b) — the first thing the reader should meet — out of view.
  useEffect(() => {
    if (isEmpty) {
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: "auto" });
  }, [messages, dialogs, isEmpty]);

  return (
    <div className="gc-thread" data-testid="gc-message-thread">
      {/* Chat-start welcome (T9b): persistent at the top of the thread like the
      artboard, so it is what the reader meets in an empty chat and scrolls
      away naturally once the conversation grows. */}
      {/* key = welcomeKey: a pane identity change REMOUNTS the hero, so a
      chat switch mid-intro restarts it from its own first render instead of
      keeping the previous chat's `is-playing` class and animations (T9b). */}
      {welcomeKey ? <WelcomeHero key={welcomeKey} chatKey={welcomeKey} /> : null}
      {isEmpty ? (
        <p className="gc-thread__empty">Start a conversation with Gentle.</p>
      ) : (
        <>
          {visibleMessages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
          {dialogs.map((dialog) => (
            <DialogCard key={dialog.id} dialog={dialog} onAnswer={(answer) => onAnswerDialog(dialog.id, answer)} />
          ))}
        </>
      )}
      {activity}
      <div ref={bottomRef} />
    </div>
  );
}
