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
 * S2: split the calls into the messages that produced them. A call whose
 * message cannot be resolved — never bound, or bound to a message the thread
 * dropped — is never lost either: it rides the last assistant message, or
 * comes back as a trailing group when the thread has no assistant message.
 */
function groupCallsByMessage(
  visibleMessages: readonly ChatMessage[],
  toolCalls: readonly ToolCallView[] | undefined,
): { byMessage: Map<string, ToolCallView[]>; trailing: ToolCallView[] } {
  const byMessage = new Map<string, ToolCallView[]>();
  const unresolved: ToolCallView[] = [];
  const messageIds = new Set(visibleMessages.map((message) => message.id));

  for (const call of toolCalls ?? []) {
    const known = call.messageId !== undefined && messageIds.has(call.messageId);
    if (!known) {
      unresolved.push(call);
      continue;
    }
    const group = byMessage.get(call.messageId as string);
    if (group) group.push(call);
    else byMessage.set(call.messageId as string, [call]);
  }

  const lastAssistant = [...visibleMessages].reverse().find((message) => message.role === MESSAGE_ROLE.ASSISTANT);
  if (lastAssistant === undefined || unresolved.length === 0) {
    return { byMessage, trailing: unresolved };
  }

  const group = byMessage.get(lastAssistant.id);
  if (group) group.push(...unresolved);
  else byMessage.set(lastAssistant.id, [...unresolved]);
  return { byMessage, trailing: [] };
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
  /** The chat's tool executions (ChatState.toolCalls), grouped per message. */
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
  const visibleMessages = messages.filter(
    (message) => message.role !== MESSAGE_ROLE.ASSISTANT || message.streaming === true || message.text.trim().length > 0,
  );
  const isEmpty = visibleMessages.length === 0 && dialogs.length === 0;

  // S2: group the calls by the message that produced them, using the real
  // messageId the producers bind (chatReducer / historyToToolCalls), never a
  // render-time guess over the whole list.
  const { byMessage: boundByMessage, trailing: trailingCalls } = groupCallsByMessage(visibleMessages, toolCalls);

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
            <MessageBubble key={message.id} message={message} actions={boundByMessage.get(message.id)} vocabulary={vocabulary} />
          ))}
          {dialogs.map((dialog) => (
            <DialogCard key={dialog.id} dialog={dialog} onAnswer={(answer) => onAnswerDialog(dialog.id, answer)} />
          ))}
        </>
      )}
      {trailingCalls.length > 0 ? <ActionRows toolCalls={trailingCalls} vocabulary={vocabulary} /> : null}
      {activity}
      <div ref={bottomRef} />
    </div>
  );
}
