import { useEffect, useRef, type ReactNode } from "react";
import { MESSAGE_ROLE, type ChatMessage, type Dialog, type DialogAnswer, type ToolCallView, type ToolVocabulary } from "@shared/bridge-types";
import { DialogCard } from "./DialogCard";
import { MessageBubble } from "./MessageBubble";
import { WelcomeHero } from "./WelcomeHero";
import { ActionRows } from "./ActionRows";
import "./MessageThread.css";

/** S1: how close to the end still counts as "following". It tolerates
 * sub-pixel layout and a partially visible last line. */
const PIN_THRESHOLD_PX = 32;

/**
 * S2 (chat-action-rows T3): a row is bound to the turn position where it
 * started — the `tool` part the turn itself recorded (chatReducer) — and
 * never migrates: the fallbacks that attached unresolved calls to the last
 * assistant message, or to a trailing group outside every bubble, are gone.
 * What remains here is the complement: calls that belong to NO turn — never
 * bound, or bound to a message the thread dropped — are rows without a
 * turn, rendered in their own clearly separate region after the thread so
 * nothing is silently lost.
 */
function callsWithoutTurn(
  visibleMessages: readonly ChatMessage[],
  toolCalls: readonly ToolCallView[] | undefined,
): ToolCallView[] {
  const claimed = new Set<string>();
  for (const message of visibleMessages) {
    for (const part of message.parts ?? []) {
      if (part.kind === "tool") claimed.add(part.toolCallId);
    }
  }
  return (toolCalls ?? []).filter((call) => !claimed.has(call.id));
}

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
  /** The chat's tool executions (ChatState.toolCalls): each turn renders
   * its own `tool` parts inside its bubble; calls that belong to no turn
   * get their own region after the thread (S2). */
  readonly toolCalls?: readonly ToolCallView[];
  /** The vocabulary the child published, for the action rows' glyphs. */
  readonly vocabulary?: ToolVocabulary;
  /** Anything still rendered after the thread (StatusLine). */
  readonly activity?: ReactNode;
}

// Presentational: renders message bubbles in order — each carrying the tool
// calls its own message produced (S2) — then any pending dialog cards (pi
// blocks on these, so they read as the newest thing in the thread), and
// auto-scrolls to the bottom only while the reader is following it (S1).
export function MessageThread({ messages, dialogs, onAnswerDialog, welcomeKey, toolCalls, vocabulary, activity }: MessageThreadProps) {
  // React 19: ref is a normal prop/hook value, no forwardRef needed.
  const bottomRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  // S1: a scroll position the reader chose is not ours to overwrite. The
  // thread starts pinned (a fresh chat follows its first answers); scrolling
  // up unpins it and returning to the bottom pins it again.
  const pinnedToBottom = useRef(true);

  // Safety net for the domain-level fix in chatReducer.ts/history.ts: an
  // assistant message that finalized (streaming !== true) with nothing but
  // whitespace text renders as an empty grey bubble. It should already have
  // been dropped upstream, but this belongs here too so no other producer
  // of `messages` can reintroduce the same empty bubble. A still-streaming
  // empty assistant message stays visible as the typing placeholder; user
  // messages are never filtered.
  // A text-less assistant turn that ran tools is KEPT: its rows are the only
  // thing it has to show, and dropping it here sent every one of them to the
  // no-turn region at the end of the thread — the trailing list this feature
  // removes (S2). The reducer and the history path both keep such a turn for
  // exactly this reason.
  const visibleMessages = messages.filter(
    (message) =>
      message.role !== MESSAGE_ROLE.ASSISTANT ||
      message.streaming === true ||
      message.text.trim().length > 0 ||
      (message.parts ?? []).some((part) => part.kind === "tool"),
  );
  const isEmpty = visibleMessages.length === 0 && dialogs.length === 0;

  // S2: every turn renders its own ordered parts inside its bubble; only
  // the calls that belong to no turn stay outside — never nested in a
  // bubble, never migrated onto the last assistant message.
  const orphanCalls = callsWithoutTurn(visibleMessages, toolCalls);

  // S1: track the reader's position on the real scroll container. The
  // threshold tolerates sub-pixel layout and a partially visible last line,
  // so a reader who is effectively at the end still follows.
  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    const handleScroll = () => {
      pinnedToBottom.current = thread.scrollHeight - thread.scrollTop - thread.clientHeight <= PIN_THRESHOLD_PX;
    };
    thread.addEventListener("scroll", handleScroll, { passive: true });
    return () => thread.removeEventListener("scroll", handleScroll);
  }, []);

  // S1: a different chat is a fresh reading position. This ref outlives the
  // switch, so it is reset explicitly instead of inheriting the previous
  // chat's scrolled-up state (R3-002).


  useEffect(() => {
    pinnedToBottom.current = true;
  }, [welcomeKey]);

  // Scrolling to the bottom is about following a conversation. An empty chat
  // has nothing to follow, and scrolling there would push the welcome hero
  // (T9b) — the first thing the reader should meet — out of view. Neither
  // does an update move a reader who scrolled up (S1).
  useEffect(() => {
    if (isEmpty || !pinnedToBottom.current) {
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: "auto" });
  }, [messages, dialogs, isEmpty]);

  return (
    <div className="gc-thread" ref={threadRef} data-testid="gc-message-thread">
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
            <MessageBubble key={message.id} message={message} toolCalls={toolCalls} vocabulary={vocabulary} />
          ))}
          {dialogs.map((dialog) => (
            <DialogCard key={dialog.id} dialog={dialog} onAnswer={(answer) => onAnswerDialog(dialog.id, answer)} />
          ))}
        </>
      )}
      {/* chat-action-rows T3 (S2): rows without a turn — calls that belong
      to no assistant message's parts — keep their own clearly separate
      region after the thread, never nested inside a bubble. */}
      {orphanCalls.length > 0 ? (
        <div className="gc-thread__orphan-actions" data-testid="gc-orphan-actions">
          <ActionRows toolCalls={orphanCalls} vocabulary={vocabulary} />
        </div>
      ) : null}
      {activity}
      <div ref={bottomRef} />
    </div>
  );
}
