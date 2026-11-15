import { useEffect, useState } from "react";
import type { ChatState, ChatSummary, DialogAnswer, OpenChatResult } from "@shared/bridge-types";
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
   * it; pushes for other hosts are not ignored any more (T5c) — they
   * accumulate in that host's snapshot. Falls back to the container's own
   * resolution, kept PAIRED with the selection it was resolved for (T5c):
   * a re-rendered selection without App's id still addresses its own
   * host, but the first render after a selection change carries the empty
   * string — a request sent that early is refused by the bridge with its
   * clear unknown-host error instead of being silently routed to the old
   * host. */
  readonly activeHostId?: string;
  /** Reports the host id the open/new or refresh resolution returned, so
   * App can keep it and pass it back down. */
  readonly onHostResolved?: (hostId: string) => void;
  /** T11: a workspace just created through "Add workspace" — the pane key
   * it belongs to plus the open/new-shaped resolution main already
   * returned (host id + state). When it matches the active pane, the
   * container adopts it INSTEAD of resolving through bridge.newChat():
   * that second resolution would start a SECOND child for the same
   * workspace. The directory arrived validated in main; it reaches the
   * footer through ChatState.workspacePath. */
  readonly createdWorkspace?: { readonly chatKey: string; readonly result: OpenChatResult };
}

/**
 * T5c (desktop-rpc-client.md L25): the renderer's per-host snapshot cache,
 * fed by every state push main fans out for every live host — a background
 * host's states accumulate here instead of being dropped, so its state is
 * observable the moment its workspace is focused. Module-level (like the
 * welcome-hero registry) because the pane persists across selection
 * changes while App holds only the currently active host id.
 */
const snapshotsByHost = new Map<string, ChatState>();
/** Which chat key (chat id, or `new-<epoch>` for an unsaved chat) was last
 * resolved to which host: how a re-selected chat finds its host — and its
 * snapshot — before any open/new resolves. */
const hostByChatKey = new Map<string, string>();
/** Hosts a reported close already evicted (T5d). A `chat.refresh` issued
 * before the close can still resolve afterwards; that late answer must not
 * re-add the snapshot and repaint a host nothing owns any more, which would
 * quietly undo the eviction. BOUNDED on purpose: a refresh is one IPC round
 * trip, so remembering the most recent closes is enough to refuse a late
 * answer, while an ever-growing set would be a monotonic leak in a renderer
 * that opens and closes chats all session. */
const CLOSED_HOST_MEMORY = 32;
const closedHosts = new Set<string>();

/** Clears the T5c snapshot cache between tests (same reason as
 * resetWelcomeHeroIntrosForTests): module-level maps would otherwise leak
 * chats, hosts and states across tests. Only tests need it. */
export function resetWorkspaceSnapshotsForTests(): void {
  snapshotsByHost.clear();
  hostByChatKey.clear();
  closedHosts.clear();
}

/** The cache key of a selection: an existing chat's id, or `new-<epoch>`
 * for an unsaved chat (App's epoch counter makes every "New chat" click a
 * distinct pane, T9b). */
function chatKeyOf(activeChat: ActiveChat): string {
  return activeChat.kind === "existing" ? activeChat.chat.id : `new-${activeChat.epoch}`;
}

/** Stores one pushed state as its host's snapshot (T5c): called for every
 * addressed push, focused or not, so a background workspace accumulates. */
function rememberSnapshot(hostId: string, state: ChatState): void {
  if (closedHosts.has(hostId)) return;
  snapshotsByHost.set(hostId, state);
}

/** T5d: a reported close makes the renderer FORGET the host — its snapshot
 * and every chat→host mapping that pointed at it — so a later selection of
 * one of those chats resolves through chat.open again instead of painting
 * the snapshot of a dead host (main also answers a closed id with its
 * unknown-host refusal, so nothing can be routed there either way). */
function rememberClosedHost(closedHostId: string): void {
  closedHosts.add(closedHostId);
  while (closedHosts.size > CLOSED_HOST_MEMORY) {
    const oldest = closedHosts.values().next().value;
    if (oldest === undefined) break;
    closedHosts.delete(oldest);
  }
}

function forgetClosedHost(closedHostId: string): void {
  rememberClosedHost(closedHostId);
  snapshotsByHost.delete(closedHostId);
  for (const [chatKey, owner] of hostByChatKey) {
    if (owner === closedHostId) hostByChatKey.delete(chatKey);
  }
}

/** An error push lands in the snapshot of the host that emitted it (T5c):
 * it renders only while that host is focused and never in another
 * workspace's status line. A host with no snapshot yet gets nothing here —
 * PiSession's surfaceError always follows the error event with a state
 * push carrying the same lastError, which the cache then holds. */
function rememberError(hostId: string, message: string): void {
  const snapshot = snapshotsByHost.get(hostId);
  if (snapshot) snapshotsByHost.set(hostId, { ...snapshot, lastError: message });
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
export function ConversationContainer({ activeChat, activeHostId, onHostResolved, createdWorkspace }: ConversationContainerProps) {
  const bridge = useBridge();
  const [chatState, setChatState] = useState<ChatState>(emptyChatState());
  // The host id this container resolved for the current activeChat, kept
  // PAIRED with the selection it was resolved for (T5c fix of the L24
  // follow-up; it also serves bare usage where no activeHostId comes from
  // above). Because the pair is checked against the CURRENT selection at
  // render time, during the first render after a selection change the old
  // resolution no longer matches: the previously resolved host id is not
  // an address at all, so a request sent in that window carries the empty
  // string and is refused by the bridge with its clear unknown-host error
  // — visible in the status line, never silently misrouted to the old
  // host. (Resetting this state in an effect cannot do the same: effects
  // run only after the render in which the stale id would be used.)
  const [resolved, setResolved] = useState<{ readonly key: string; readonly hostId: string } | undefined>(undefined);
  const currentKey = chatKeyOf(activeChat);
  const hostId = activeHostId ?? (resolved?.key === currentKey ? resolved.hostId : "");
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
      // T5c: every addressed push accumulates under its host id, focused
      // or not; only the focused host's also renders. An unaddressed push
      // has no host to accumulate under — the T5b gate below still decides
      // whether it may render.
      if (state.hostId !== undefined) rememberSnapshot(state.hostId, state);
      if (isForeignPush(state.hostId)) return;
      setChatState(state);
    });
    const unsubscribeError = bridge.onError((message, errorHostId) => {
      // T5c: the error lands in the snapshot of the host that emitted it,
      // so a child failure stays local to its workspace (see rememberError
      // for the no-snapshot-yet case).
      if (errorHostId !== undefined) rememberError(errorHostId, message);
      if (isForeignPush(errorHostId)) return;
      setBridgeError(message);
    });
    // T5d: a close report (the chat.closed push for a host closed through
    // bridge.closeChat — there is deliberately no close button in the UI)
    // evicts that host's snapshot and chat→host mapping. When the closed
    // host is the one this pane is addressing, say so in the status line:
    // the pane keeps painting its last known state, but every request from
    // now on is refused by the bridge's unknown-host error.
    const unsubscribeClosed = bridge.onClosed?.((closedHostId) => {
      forgetClosedHost(closedHostId);
      if (closedHostId === hostId) setBridgeError("This workspace's host was closed");
    });
    return () => {
      unsubscribeState();
      unsubscribeError();
      unsubscribeClosed?.();
    };
  }, [bridge, hostId]);

  // Opens (or starts) the selected chat whenever the selection changes.
  // Guarded against stale resolutions: if the selection changes again
  // before this request settles (e.g. quickly clicking two chats), its
  // resolved/rejected result must not clobber the state that belongs to
  // the newer selection.
  // Reset to the chat pane whenever the selected chat changes — a helper
  // tab left open on the previous chat must never bleed into the next one.
  // The previous chat's host id needs no reset here: the resolved pair is
  // checked against the current selection at render time (see `resolved`),
  // so it stops being an address the moment the selection changes.
  useEffect(() => {
    setPane(CONVERSATION_PANE.CHAT);
    setHelpersOpenedAt(new Date().toISOString());
  }, [activeChat]);

  useEffect(() => {
    setBridgeError(undefined);
    let cancelled = false;

    // Adopts the resolution of the chat this effect opened (T5b + T5c):
    // remembers which host owns it, caches its state as that host's
    // snapshot, reports the host id up (App keeps it; also kept paired
    // locally for bare usage), and renders the state.
    const adopt = (resolvedHostId: string, state: ChatState): void => {
      hostByChatKey.set(currentKey, resolvedHostId);
      rememberSnapshot(resolvedHostId, state);
      setResolved({ key: currentKey, hostId: resolvedHostId });
      onHostResolved?.(resolvedHostId);
      setChatState(state);
    };

    const resolveThroughOpenOrNew = (): void => {
      // T11: a pane created through "Add workspace" arrives already
      // resolved — main minted its host, validated its directory and
      // started its chat. Adopt that result directly; resolving this pane
      // through bridge.newChat() would spawn a second child for the same
      // workspace. The key guard keeps a stale creation from ever adopting
      // into the wrong pane.
      const creation = createdWorkspace && createdWorkspace.chatKey === currentKey ? createdWorkspace : undefined;
      if (creation) {
        adopt(creation.result.hostId, creation.result.state);
        return;
      }
      const opening = activeChat.kind === "existing" ? bridge.openChat(activeChat.chat.id) : bridge.newChat();
      opening
        .then((result) => {
          if (cancelled) return;
          adopt(result.hostId, result.state);
        })
        .catch((cause: unknown) => {
          if (!cancelled) setBridgeError(errorText(cause));
        });
    };

    // T5c focus discipline: a chat this pane already resolved keeps its
    // host. Re-selecting it paints the retained snapshot immediately and
    // asks THAT host (chat.refresh) for its current state instead of
    // restarting the child through chat.open — the background child keeps
    // running, and the refresh's answer then replaces the snapshot. A chat
    // with no retained snapshot (never opened here, or a fresh unsaved
    // pane) resolves through chat.open/chat.new as today. The
    // refreshChat-less-bridge fallback covers older test fakes only.
    const knownHostId = hostByChatKey.get(currentKey);
    const snapshot = knownHostId !== undefined ? snapshotsByHost.get(knownHostId) : undefined;
    if (knownHostId !== undefined && snapshot) {
      setResolved({ key: currentKey, hostId: knownHostId });
      onHostResolved?.(knownHostId);
      setChatState(snapshot);
      const refreshing = bridge.refreshChat?.(knownHostId);
      if (refreshing) {
        refreshing
          .then((state) => {
            if (cancelled) return;
            // A close reported while this refresh was in flight wins: the
            // late answer must not repaint a host the renderer already forgot.
            if (closedHosts.has(knownHostId)) return;
            rememberSnapshot(knownHostId, state);
            setChatState(state);
          })
          .catch((cause: unknown) => {
            if (cancelled) return;
            // T5d: a failed refresh NO LONGER falls back to chat.open/
            // chat.new — starting a `gentle-shell --mode rpc` child must
            // never be an implicit consequence of focusing a chat. The
            // retained snapshot stays painted and the failure is surfaced
            // instead; the chat→host mapping is dropped so the only reopen
            // path left is an explicit user selection, which resolves
            // through chat.open (main reuses a still-live host there, so
            // the reopen costs no child either).
            if (hostByChatKey.get(currentKey) === knownHostId) hostByChatKey.delete(currentKey);
            setBridgeError(errorText(cause));
          });
      } else {
        resolveThroughOpenOrNew();
      }
    } else {
      resolveThroughOpenOrNew();
    }

    return () => {
      cancelled = true;
    };
    // onHostResolved is deliberately NOT a dependency: it is a stable
    // state setter from App, and re-running this effect on identity churn
    // would re-resolve the chat on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, activeChat, createdWorkspace]);

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
  // T11: the footer's path is the open workspace's directory. Preference
  // order: the app-validated directory the pane's host was created with
  // (workspace.create attached it to the state at the push boundary), then
  // the session summary's own cwd for a chat opened from the sidebar —
  // pi's record of where that session was started. Undefined means no
  // directory is known, and the footer shows `~/` rather than an invented
  // path. NOT the worktree group: no worktree counts here (that is T8b).
  const workspacePath =
    chatState.workspacePath ?? (activeChat.kind === "existing" ? activeChat.chat.cwd : undefined);
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
      <Footer workspace={chatState.workspace} workspacePath={workspacePath} />
      {pane === CONVERSATION_PANE.HELPERS ? (
        <HelpersContainer
          activity={chatState.helpers}
          // T5b: the Stop control routes by this chat's host id. Omitting it
          // sent an empty address that the router rejects, so Helper Stop was
          // broken in the real app while every unit test passed — the wiring
          // is pinned by "addresses a helper stop from the Helpers pane".
          hostId={hostId}
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
            <Composer
              value={draft}
              working={chatState.working}
              // Send is enabled only once this pane knows its host (T5b): a
              // request before that would be refused by main.
              ready={hostId !== ""}
              onChange={setDraft}
              onSend={handleSend}
              onAbort={handleAbort}
            />
          </div>
        </div>
      )}
    </section>
  );
}
