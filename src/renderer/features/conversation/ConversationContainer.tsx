import { useEffect, useState } from "react";
import type { ChatState, ChatSummary, DialogAnswer } from "@shared/bridge-types";
import { useBridge } from "@renderer/shared/bridge/useBridge";
import { HelpersContainer } from "@renderer/features/helpers/HelpersContainer";
import { Composer } from "./components/Composer";
import { ActionRows } from "./components/ActionRows";
import { Footer } from "./components/Footer";
import { CONVERSATION_PANE, ConversationHeader, type ConversationPane } from "./components/ConversationHeader";
import { HelpersStrip } from "./components/HelpersStrip";
import { MessageThread } from "./components/MessageThread";
import { StatusLine } from "./components/StatusLine";
import { TodoCard } from "./components/TodoCard";
import { UsageMeters } from "./components/UsageMeters";
import "./ConversationContainer.css";

/**
 * Which chat is open right now. App.tsx owns this as small local state (no
 * global store for M1, see odd/tasks/desktop-m1-chat-core.md) and passes it
 * down; ChatsContainer only reports selection intent up to App, it never
 * calls chat.open/chat.new itself, because GentleBridge tracks exactly one
 * "currently open" chat.
 */
export type ActiveChat =
  | { readonly kind: "new"; readonly epoch: number }
  | { readonly kind: "existing"; readonly chat: ChatSummary };

export interface ConversationContainerProps {
  readonly activeChat: ActiveChat;
  /** T5b: the active chat's workspace host id, OWNED BY App — set from
   * the open/new resolution (see onHostResolved) and reset on every
   * selection change. Every request the container sends is addressed to
   * it and pushes for other hosts are ignored. Falls back to the
   * container's own open/new resolution when App does not supply it
   * (bare usage/tests), and to the empty string while nothing has been
   * resolved yet — a request sent that early is rejected by the bridge
   * with its clear unknown-host error instead of being silently routed. */
  readonly activeHostId?: string;
  /** Reports the host id the open/new resolution returned, so App can
   * keep it and pass it back down. */
  readonly onHostResolved?: (hostId: string) => void;
}

function emptyChatState(): ChatState {
  return {
    messages: [],
    working: false,
    pendingDialogs: [],
    activity: 0,
    helpers: { summary: { running: 0, queued: 0, waiting: 0, finished: 0 }, tasks: [] },
  };
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Conversation container: ONE source of truth for the thread is the pushed
 * `ChatState` (messages, working, pendingDialogs, lastError) — nothing is
 * derived or invented locally. Errors (ChatState.lastError and
 * bridge.onError pushes) render in a dedicated StatusLine, never as a
 * synthetic ChatMessage appended to the thread. Keyed statuses and
 * notifications (desktop-rpc T2b) render in the same status surface for
 * the same reason: they are feedback chrome, never transcript entries.
 */
export function ConversationContainer({ activeChat, activeHostId, onHostResolved }: ConversationContainerProps) {
  const bridge = useBridge();
  const [chatState, setChatState] = useState<ChatState>(emptyChatState());
  // The host id this container resolved for the current activeChat from
  // its own open/new call — the fallback when no activeHostId comes from
  // above. Reset whenever the selection changes, together with App's own
  // reset below, so a stale host id can never answer for the new chat.
  const [resolvedHostId, setResolvedHostId] = useState<string | undefined>(undefined);
  const hostId = activeHostId ?? resolvedHostId ?? "";
  const [bridgeError, setBridgeError] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [pane, setPane] = useState<ConversationPane>(CONVERSATION_PANE.CHAT);
  // The moment this chat became active — HelpersContainer's line between
  // "current" helpers and the collapsed "Earlier" group (format.ts's
  // partitionHelpers). Set once per activeChat change, not per pane
  // switch, so opening the Helpers tab later doesn't move the line.
  const [helpersOpenedAt, setHelpersOpenedAt] = useState<string>(() => new Date().toISOString());

  // Subscribes once per host id: pushes arrive from EVERY live host, so a
  // push is accepted only when it carries no contradicting identity — one
  // whose host id differs from the active host's is ignored (T5b). An
  // unaddressed push is tolerated only while this pane has no host id yet —
  // once it knows which host it is, an untagged push cannot be proven to be
  // its own, and accepting it would be exactly the "whichever chat is open"
  // routing this slice removes.
  const isForeignPush = (pushedHostId: string | undefined): boolean =>
    pushedHostId === undefined ? hostId !== "" : pushedHostId !== hostId;
  useEffect(() => {
    const unsubscribeState = bridge.onState((state) => {
      if (isForeignPush(state.hostId)) return;
      setChatState(state);
    });
    const unsubscribeError = bridge.onError((message, errorHostId) => {
      if (isForeignPush(errorHostId)) return;
      setBridgeError(message);
    });
    return () => {
      unsubscribeState();
      unsubscribeError();
    };
  }, [bridge, hostId]);

  // Opens (or starts) the selected chat whenever the selection changes.
  // Guarded against stale resolutions: if the selection changes again
  // before this request settles (e.g. quickly clicking two chats), its
  // resolved/rejected result must not clobber the state that belongs to
  // the newer selection.
  // Reset to the chat pane whenever the selected chat changes — a helper
  // tab left open on the previous chat must never bleed into the next one.
  // The previous chat's host id is dropped with it (T5b): until the new
  // open/new resolves, no request may route to the old host.
  useEffect(() => {
    setPane(CONVERSATION_PANE.CHAT);
    setHelpersOpenedAt(new Date().toISOString());
    setResolvedHostId(undefined);
  }, [activeChat]);

  useEffect(() => {
    setBridgeError(undefined);
    let cancelled = false;
    const opening = activeChat.kind === "existing" ? bridge.openChat(activeChat.chat.id) : bridge.newChat();
    opening
      .then((result) => {
        if (cancelled) return;
        // T5b: the answer names the host this chat was routed to. It is
        // reported up (App keeps it) and kept locally for bare usage;
        // every later request is addressed to it.
        setResolvedHostId(result.hostId);
        onHostResolved?.(result.hostId);
        setChatState(result.state);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setBridgeError(errorText(cause));
      });
    return () => {
      cancelled = true;
    };
    // onHostResolved is deliberately NOT a dependency: it is a stable
    // state setter from App, and re-running this effect on identity churn
    // would re-open the chat on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, activeChat]);

  // Every request is addressed to the active chat's host (T5b). Before
  // any open/new resolution the address is the empty string, which the
  // bridge rejects with its clear unknown-host error — visible in the
  // status line, never silently routed to another host.
  const handleSend = (): void => {
    const text = draft.trim();
    if (text.length === 0 || chatState.working) return;

    setDraft("");
    bridge
      .sendMessage(hostId, text)
      .then((result) => {
        if (!result.queued) setBridgeError(result.reason ?? "Gentle did not send the message");
      })
      .catch((cause: unknown) => setBridgeError(errorText(cause)));
  };

  const handleAbort = (): void => {
    bridge.abort(hostId).catch((cause: unknown) => setBridgeError(errorText(cause)));
  };

  const handleAnswerDialog = (id: string, answer: DialogAnswer): void => {
    bridge.answerDialog(hostId, id, answer).catch((cause: unknown) => setBridgeError(errorText(cause)));
  };

  const title = activeChat.kind === "existing" ? activeChat.chat.title : "New chat";
  // One welcome intro per chat identity (T9b). An existing chat keeps its id,
  // so re-selecting the same saved chat never replays. Every unsaved chat is
  // its own pane via App's epoch counter, so two "New chat" clicks never
  // share an intro. Boundary, deliberately accepted: opening a saved chat
  // from the sidebar is a different pane identity and therefore gets its own
  // intro, because the app cannot prove it is the same conversation that was
  // just saved.
  const welcomeKey = activeChat.kind === "existing" ? activeChat.chat.id : `new-chat-${activeChat.epoch}`;
  const error = bridgeError ?? chatState.lastError;

  return (
    <section className="gc-conversation">
      <ConversationHeader
        title={title}
        working={chatState.working}
        pane={pane}
        runningHelpersCount={chatState.helpers.summary.running}
        onSelectPane={setPane}
      />
      <StatusLine
        error={error}
        statuses={chatState.statuses}
        notifications={chatState.notifications}
        session={chatState.session}
      />
      <Footer workspace={chatState.workspace} />
      {pane === CONVERSATION_PANE.HELPERS ? (
        <HelpersContainer
          activity={chatState.helpers}
          onBackToChat={() => setPane(CONVERSATION_PANE.CHAT)}
          openedAt={helpersOpenedAt}
        />
      ) : (
        <div className="gc-conversation__body">
          <div className="gc-conversation__stack">
            <HelpersStrip helpers={chatState.helpers} onOpen={() => setPane(CONVERSATION_PANE.HELPERS)} />
            <MessageThread
              messages={chatState.messages}
              dialogs={chatState.pendingDialogs}
              onAnswerDialog={handleAnswerDialog}
              welcomeKey={welcomeKey}
            />
            <ActionRows toolCalls={chatState.toolCalls} vocabulary={chatState.toolVocabulary} />
            {/* The chat's own ODD task card (M3: S5). It lives INSIDE the
            stack and above the composer so the narrow layout keeps the TUI's
            order — its bottom widget renders above the prompt, never below
            it — while the wide layout lifts the same node into a right rail
            with CSS grid. Fed strictly from the pushed ChatState.todo of the
            open chat (S1), never a global list, and absent from Helpers. */}
            {chatState.todo ? <TodoCard todo={chatState.todo} /> : null}
            {/* Subscription-usage meters (desktop-rpc T3): fed strictly from
            the pushed ChatState.usage of the open chat — one block per
            provider, honest states for pending/failed/unavailable, and
            nothing at all when there is no usage data. Never a transcript
            entry, like TodoCard above. */}
            <UsageMeters usage={chatState.usage} channelUnavailable={chatState.usageChannelUnavailable} />
            <Composer value={draft} working={chatState.working} onChange={setDraft} onSend={handleSend} onAbort={handleAbort} />
          </div>
        </div>
      )}
    </section>
  );
}
