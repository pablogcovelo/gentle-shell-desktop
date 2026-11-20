import { describe, expect, it, vi } from "vitest";
import type { ChatState } from "@shared/bridge-types";
import type { LauncherLocator, ProcessSpawner, SessionInfoLike, SessionStore, SpawnedProcess } from "../../ports";
import { ChatHost } from "./ChatHost";

/**
 * A controllable fake ProcessSpawner (no real child process), mirroring
 * the pattern in PiSession.test.ts's "Electron host follow-ups" describe
 * block: ChatHost's own tests need the same precise control over
 * stdout/exit timing without racing real process I/O. `events` records
 * spawn/endStdin ordering across handles, used by the startSession
 * serialization test below to prove the previous session is fully
 * stopped before the next one spawns (not just that both eventually run).
 */
interface FakeProcessHandle {
  readonly args: readonly string[];
  /** The cwd the spawn was asked for (T11): the workspace directory the
   * child must run in, recorded from the spawner's fourth argument. */
  readonly cwd: string | undefined;
  readonly writes: string[];
  emitStdout(line: string): void;
  emitStderr(line: string): void;
  resolveExited(result: { code: number | null; signal: NodeJS.Signals | null; error?: Error }): void;
}

function createFakeSpawner(): { spawner: ProcessSpawner; handles: FakeProcessHandle[]; events: string[] } {
  const handles: FakeProcessHandle[] = [];
  const events: string[] = [];

  const spawner: ProcessSpawner = {
    spawn(_command, args, _env, cwd): SpawnedProcess {
      const index = handles.length;
      events.push(`spawn:${index}`);

      const stdoutHandlers: Array<(line: string) => void> = [];
      const stderrHandlers: Array<(line: string) => void> = [];
      const writes: string[] = [];
      let resolveExitedFn: (result: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => void = () => undefined;
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
        resolveExitedFn = resolve;
      });

      const handle: FakeProcessHandle = {
        args: [...args],
        cwd,
        writes,
        emitStdout(line) {
          for (const handler of stdoutHandlers) handler(line);
        },
        emitStderr(line) {
          for (const handler of stderrHandlers) handler(line);
        },
        resolveExited(result) {
          resolveExitedFn(result);
        },
      };
      handles.push(handle);

      return {
        exited,
        writeStdin(text: string) {
          writes.push(text);
        },
        endStdin() {
          events.push(`endStdin:${index}`);
        },
        onStdoutLine(handler) {
          stdoutHandlers.push(handler);
        },
        onStderrLine(handler) {
          stderrHandlers.push(handler);
        },
        onError() {},
        kill() {},
      };
    },
  };

  return { spawner, handles, events };
}

const fakeLocator: LauncherLocator = { locate: () => ({ command: "fake-gentle-shell", args: [] }) };

function fakeSessionStore(sessions: readonly SessionInfoLike[]): SessionStore {
  return { listAll: () => Promise.resolve([...sessions]) };
}

function session(overrides: Partial<SessionInfoLike> = {}): SessionInfoLike {
  return {
    id: "sess-1",
    path: "/home/sessions/proj/sess-1.jsonl",
    cwd: "/tmp/proj",
    modified: new Date("2026-09-21T10:00:00.000Z"),
    messageCount: 0,
    firstMessage: "",
    ...overrides,
  };
}

/**
 * Opening an existing chat (sessionPath set) now sends `get_messages` and
 * bounds its wait to `HISTORY_LOAD_TIMEOUT_MS` (see ChatHost.ts). Tests
 * that don't care about the seeded history content answer it immediately
 * with an empty history through this helper, so `openChat` resolves right
 * away instead of blocking on the real 2s bound; tests that do care about
 * the content answer inline instead.
 */
async function respondToHistoryRequest(
  handles: readonly FakeProcessHandle[],
  index: number,
  data: unknown = { messages: [] },
): Promise<void> {
  await vi.waitFor(() => expect(handles[index]?.writes.length ?? 0).toBeGreaterThan(0));
  const sent = JSON.parse(handles[index]!.writes[handles[index]!.writes.length - 1]!);
  handles[index]!.emitStdout(
    JSON.stringify({ type: "response", id: sent.id, command: "get_messages", success: true, data }),
  );
}

describe("ChatHost", () => {
  it("stop joins metadata discovery before the session start is queued", async () => {
    const { spawner, handles, events } = createFakeSpawner();
    let release!: (sessions: SessionInfoLike[]) => void;
    const store: SessionStore = { listAll: () => new Promise((resolve) => { release = resolve; }) };
    const host = new ChatHost({ spawner, locator: fakeLocator, sessionStore: store, env: {} });
    const opening = host.openChat("sess-1");
    await Promise.resolve();
    const stopping = host.stop();
    release([session()]);
    await respondToHistoryRequest(handles, 0);
    await vi.waitFor(() => expect(events).toContain("endStdin:0"));
    handles[0]!.resolveExited({ code: 0, signal: null });
    await Promise.all([opening, stopping]);
    expect(host.isAlive).toBe(false);
    expect(host.effectiveCwd).toBe("/tmp/proj");
    expect(host.cwd).toBeUndefined(); // creation-bound directory reuse stays unchanged
    expect(events).toEqual(["spawn:0", "endStdin:0"]);
    expect(handles[0]!.args).toContain("--session");
  });
  it("reports isAlive only while its child is running", async () => {
    const { spawner, handles } = createFakeSpawner();
    const store = fakeSessionStore([session({ id: "sess-1", path: "/home/sessions/proj/sess-1.jsonl" })]);
    const host = new ChatHost({ spawner, locator: fakeLocator, sessionStore: store, env: {} });

    // Nothing started yet: a host that never opened a chat owns no child.
    expect(host.isAlive).toBe(false);

    const openPromise = host.openChat("sess-1");
    await respondToHistoryRequest(handles, 0);
    await openPromise;
    expect(host.isAlive).toBe(true);

    // The child can exit on its own; the host object stays, so the registry
    // must be able to tell that its directory is no longer being served.
    handles[0]?.resolveExited({ code: 0, signal: null });
    await Promise.resolve();
    await Promise.resolve();
    expect(host.isAlive).toBe(false);
  });

  it("openChat resolves the session path from the store, starts it, and pushes state", async () => {
    const { spawner, handles } = createFakeSpawner();
    const store = fakeSessionStore([session({ id: "sess-1", path: "/home/sessions/proj/sess-1.jsonl" })]);
    const host = new ChatHost({ spawner, locator: fakeLocator, sessionStore: store, env: {} });
    const states: ChatState[] = [];
    host.onState((state) => states.push(state));

    const openPromise = host.openChat("sess-1");
    await respondToHistoryRequest(handles, 0);
    const initial = await openPromise;

    expect(initial.messages).toEqual([]);
    handles[0]?.emitStdout(JSON.stringify({ type: "agent_start" }));
    expect(states.some((state) => state.working)).toBe(true);
  });

  it("openChat resolves with the seeded history once pi answers get_messages", async () => {
    const { spawner, handles } = createFakeSpawner();
    const store = fakeSessionStore([session({ id: "sess-1", path: "/home/sessions/proj/sess-1.jsonl" })]);
    const host = new ChatHost({ spawner, locator: fakeLocator, sessionStore: store, env: {} });

    const openPromise = host.openChat("sess-1");
    await respondToHistoryRequest(handles, 0, {
      messages: [
        { role: "user", content: "hi", timestamp: 0 },
        { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 0 },
      ],
    });
    const state = await openPromise;

    expect(state.messages).toEqual([
      { id: "msg-0", role: "user", text: "hi" },
      { id: "msg-1", role: "assistant", text: "hello", streaming: false },
    ]);
  });

  it("openChat resolves after the 2s bound even if pi never answers get_messages", async () => {
    vi.useFakeTimers();
    try {
      const { spawner, handles } = createFakeSpawner();
      const store = fakeSessionStore([session({ id: "sess-1", path: "/home/sessions/proj/sess-1.jsonl" })]);
      const host = new ChatHost({ spawner, locator: fakeLocator, sessionStore: store, env: {} });

      const openPromise = host.openChat("sess-1");
      await vi.advanceTimersByTimeAsync(2000);
      const state = await openPromise;

      expect(state.messages).toEqual([]);
      expect(handles).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("openChat rejects for an id the session store does not have", async () => {
    const { spawner } = createFakeSpawner();
    const host = new ChatHost({ spawner, locator: fakeLocator, sessionStore: fakeSessionStore([]), env: {} });

    await expect(host.openChat("missing")).rejects.toThrow(/no session found/i);
  });

  it("newChat starts a session with no sessionPath", async () => {
    const { spawner } = createFakeSpawner();
    const host = new ChatHost({ spawner, locator: fakeLocator, sessionStore: fakeSessionStore([]), env: {} });

    const state = await host.newChat();

    expect(state.messages).toEqual([]);
  });

  it("switching chats stops the previous session before starting the next one", async () => {
    const { spawner, handles } = createFakeSpawner();
    const store = fakeSessionStore([
      session({ id: "sess-1", path: "/a/sess-1.jsonl" }),
      session({ id: "sess-2", path: "/b/sess-2.jsonl" }),
    ]);
    const host = new ChatHost({ spawner, locator: fakeLocator, sessionStore: store, env: {} });

    const openFirstPromise = host.openChat("sess-1");
    await respondToHistoryRequest(handles, 0);
    await openFirstPromise;
    expect(handles).toHaveLength(1);

    const openSecond = host.openChat("sess-2");
    // stop() waits for the child to exit (or a 3s grace timeout); resolve
    // the first child's exit immediately so this test does not wait it out.
    handles[0]?.resolveExited({ code: 0, signal: null });
    await respondToHistoryRequest(handles, 1);
    await openSecond;

    expect(handles).toHaveLength(2);
  });

  it("sendMessage while the assistant is working resolves { queued: false, reason } instead of rejecting (report once)", async () => {
    const { spawner, handles } = createFakeSpawner();
    const host = new ChatHost({ spawner, locator: fakeLocator, sessionStore: fakeSessionStore([]), env: {} });

    await host.newChat();
    expect(handles[0]?.writes.map((write) => JSON.parse(write).type)).toEqual(["get_state"]);
    handles[0]?.emitStdout(JSON.stringify({ type: "agent_start" }));
    // T3's new probe trigger: the first stdout frame proved the child
    // alive, so the capabilities probe is now on stdin. The DECLINE itself
    // still writes nothing new — the point this test has always pinned.
    expect(handles[0]?.writes.filter((write) => write.includes("capabilities"))).toHaveLength(1);
    const writesBefore = [...handles[0]!.writes];

    const result = await host.sendMessage("another message");

    expect(result).toEqual({ queued: false, reason: "Gentle is still working" });
    expect(handles[0]?.writes).toEqual(writesBefore);
  });

  it("startSession serializes overlapping open/new calls: the previous session is fully stopped before the next spawns, and the last request wins", async () => {
    const { spawner, handles, events } = createFakeSpawner();
    const store = fakeSessionStore([
      session({ id: "sess-1", path: "/a/sess-1.jsonl" }),
      session({ id: "sess-2", path: "/b/sess-2.jsonl" }),
    ]);
    const host = new ChatHost({ spawner, locator: fakeLocator, sessionStore: store, env: {} });

    const openFirst = host.openChat("sess-1");
    const openSecond = host.openChat("sess-2");

    await vi.waitFor(() => expect(handles).toHaveLength(1));
    await respondToHistoryRequest(handles, 0);

    // performStart(sess1) only resolves once the history response above
    // unblocks its bounded wait, and only then does performStart(sess2)'s
    // own `await this.current?.stop()` reach `endStdin()`. Wait for that
    // before resolving session 1's exit below, so stop() still observes a
    // live process instead of racing handleExit's own cleanup (which
    // would otherwise clear `this.process` first and make stop() a no-op).
    await vi.waitFor(() => expect(events).toContain("endStdin:0"));
    // stop() waits for the child to exit (or a 3s grace timeout); resolve
    // it so the serialized second call can proceed without waiting it out.
    handles[0]?.resolveExited({ code: 0, signal: null });

    await vi.waitFor(() => expect(handles).toHaveLength(2));
    await respondToHistoryRequest(handles, 1);

    await Promise.all([openFirst, openSecond]);

    expect(handles).toHaveLength(2);
    // The key regression check: without serialization both sessions spawn
    // back-to-back (current is briefly undefined for both), leaking the
    // first child. Serialized, session 1 must be stopped (endStdin) before
    // session 2 ever spawns.
    expect(events).toEqual(["spawn:0", "endStdin:0", "spawn:1"]);

    await host.abort();
    expect(handles[1]?.writes.some((write) => write.includes('"abort"'))).toBe(true);
    // Session 1 only ever received its own get_messages request (sent by
    // its own start()); the abort reaches the current session (2) only.
    expect(handles[0]?.writes.some((write) => write.includes('"abort"'))).toBe(false);
  });

  it("passes deps.log to every PiSession as its onLog callback", async () => {
    const { spawner, handles } = createFakeSpawner();
    const logLines: string[] = [];
    const host = new ChatHost({
      spawner,
      locator: fakeLocator,
      sessionStore: fakeSessionStore([]),
      env: {},
      log: (line) => logLines.push(line),
    });

    await host.newChat();
    handles[0]?.emitStderr("hello from pi");

    expect(logLines).toEqual(["hello from pi"]);
  });

  it("answerDialog round-trips: forwards the answer to the current session's stdin", async () => {
    const { spawner, handles } = createFakeSpawner();
    const host = new ChatHost({ spawner, locator: fakeLocator, sessionStore: fakeSessionStore([]), env: {} });

    await host.newChat();
    handles[0]?.emitStdout(
      JSON.stringify({ type: "extension_ui_request", id: "dlg-1", method: "select", title: "Pick", options: ["A"] }),
    );

    await host.answerDialog("dlg-1", { value: "A" });

    // T3's new probe trigger: the dialog frame was the child's first stdout
    // frame, so the capabilities probe preceded the dialog answer on stdin.
    expect(handles[0]?.writes.filter((write) => write.includes("capabilities"))).toHaveLength(1);
    expect(handles[0]?.writes.filter((write) => JSON.parse(write).type === "extension_ui_response")).toEqual([`${JSON.stringify({ type: "extension_ui_response", id: "dlg-1", value: "A" })}\n`]);
    expect(handles[0]?.writes.at(-1)).toEqual(`${JSON.stringify({ type: "extension_ui_response", id: "dlg-1", value: "A" })}\n`);
  });

  it("abort() with no chat open rejects instead of throwing synchronously", async () => {
    const { spawner } = createFakeSpawner();
    const host = new ChatHost({ spawner, locator: fakeLocator, sessionStore: fakeSessionStore([]), env: {} });

    await expect(host.abort()).rejects.toThrow(/no chat is open/i);
  });

  it("onError forwards errors surfaced by the current session (e.g. an unexpected exit)", async () => {
    const { spawner, handles } = createFakeSpawner();
    const host = new ChatHost({ spawner, locator: fakeLocator, sessionStore: fakeSessionStore([]), env: {} });
    const errors: string[] = [];
    host.onError((message) => errors.push(message));

    await host.newChat();
    handles[0]?.resolveExited({ code: 1, signal: null });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/exited unexpectedly/);
  });

  it("reads homeArgs from deps.homeSettings on every spawn instead of a fixed constant", async () => {
    const { spawner, handles } = createFakeSpawner();
    let mode: "link" | "isolated" = "isolated";
    const homeSettings = { homeArgs: () => (mode === "link" ? ["--link"] : ["--isolated"]) };
    const host = new ChatHost({ spawner, locator: fakeLocator, sessionStore: fakeSessionStore([]), env: {}, homeSettings });

    await host.newChat();
    expect(handles[0]?.args).toContain("--isolated");

    mode = "link";
    const second = host.newChat();
    handles[0]?.resolveExited({ code: 0, signal: null });
    await second;
    expect(handles[1]?.args).toContain("--link");
  });

  it("stop() awaits the internal start chain before stopping the current session, so a queued start cannot outlive quit", async () => {
    const { spawner, handles, events } = createFakeSpawner();
    const store = fakeSessionStore([session({ id: "sess-1", path: "/a/sess-1.jsonl" })]);
    const host = new ChatHost({ spawner, locator: fakeLocator, sessionStore: store, env: {} });

    // An already-open, live chat...
    const openFirstPromise = host.openChat("sess-1");
    await respondToHistoryRequest(handles, 0);
    await openFirstPromise;
    expect(handles).toHaveLength(1);

    // ...then newChat() is requested (queuing behind the still-live open
    // session — its own performStart will stop that session first, before
    // starting the next one), and stop() is called immediately after,
    // racing the still-queued newChat: without joining startChain first,
    // stop() would act on whatever `current` happens to be at this exact
    // synchronous instant (still the open session, not yet the queued
    // one), leaving the queued session's eventual child unstopped.
    const queuedNew = host.newChat();
    const stopping = host.stop();

    // The queued newChat's own internal `await this.current?.stop()` is
    // now stopping the open session; let it exit so newChat's performStart
    // can proceed to spawn its own session.
    handles[0]?.resolveExited({ code: 0, signal: null });
    await vi.waitFor(() => expect(handles).toHaveLength(2));

    // stop()'s own await of the now-current (queued) session; let it exit
    // too, so this resolves without waiting out PiSession's 3s stop grace
    // period.
    handles[1]?.resolveExited({ code: 0, signal: null });

    await stopping;
    await queuedNew;

    // No live child remains: both sessions were told to stop (endStdin),
    // including the one the queued newChat produced.
    expect(events).toEqual(["spawn:0", "endStdin:0", "spawn:1", "endStdin:1"]);
  });
it("passes deps.cwd to PiSession, so the workspace's child is spawned in that directory (T11)", async () => {
  const { spawner, handles } = createFakeSpawner();
  const host = new ChatHost({
    spawner,
    locator: fakeLocator,
    sessionStore: fakeSessionStore([]),
    env: {},
    cwd: "/tmp/workspace-demo",
  });

  await host.newChat();

  // The spawn OPTIONS carry the directory (asserted, not a real process):
  // this is the whole reason a workspace can say which folder it works in.
  expect(handles[0]?.cwd).toBe("/tmp/workspace-demo");
  // The host reports the same directory, so the push layer can attach it
  // to every state (the footer's path) without guessing.
  expect(host.cwd).toBe("/tmp/workspace-demo");
});

it("spawns with no cwd for a fresh chat when the host was created without a workspace directory (chat.new)", async () => {
  const { spawner, handles } = createFakeSpawner();
  const host = new ChatHost({ spawner, locator: fakeLocator, sessionStore: fakeSessionStore([]), env: {} });

  await host.newChat();

  expect(handles[0]?.cwd).toBeUndefined();
  expect(host.cwd).toBeUndefined();
});

it("spawns a reopened chat's child in that chat's own directory when the host was created without one (P1)", async () => {
  const { spawner, handles } = createFakeSpawner();
  const host = new ChatHost({
    spawner,
    locator: fakeLocator,
    sessionStore: fakeSessionStore([
      session({ id: "sess-9", path: "/a/sess-9.jsonl", cwd: "/home/user/project" }),
    ]),
    env: {},
  });

  const opening = host.openChat("sess-9");
  await respondToHistoryRequest(handles, 0);
  await opening;

  // The gap in L30/T11: a chat reopened through chat.open used to spawn in
  // Electron's launch directory, so the child never ran in the chat's own
  // workspace and no worktree group could be computed for it.
  expect(handles[0]?.cwd).toBe("/home/user/project");
});

it("keeps the host's own directory when it has one, even if the session reports another (a created workspace)", async () => {
  const { spawner, handles } = createFakeSpawner();
  const host = new ChatHost({
    spawner,
    locator: fakeLocator,
    sessionStore: fakeSessionStore([
      session({ id: "sess-10", path: "/a/sess-10.jsonl", cwd: "/home/user/elsewhere" }),
    ]),
    env: {},
    cwd: "/tmp/workspace-demo",
  });

  const opening = host.openChat("sess-10");
  await respondToHistoryRequest(handles, 0);
  await opening;

  // The directory the user chose for this workspace stays authoritative: a
  // session's recorded cwd can drift, the host's binding cannot.
  expect(handles[0]?.cwd).toBe("/tmp/workspace-demo");
});

it("carries its host id on its state and error events so a registry can fan out per host (T5a)", async () => {
  const { spawner, handles } = createFakeSpawner();
  const host = new ChatHost({
    spawner,
    locator: fakeLocator,
    sessionStore: fakeSessionStore([]),
    env: {},
    hostId: "host-9",
  });

  expect(host.hostId).toBe("host-9");

  const stateHostIds: string[] = [];
  const errorHostIds: string[] = [];
  host.onState((_state, hostId) => stateHostIds.push(hostId));
  host.onError((_message, hostId) => errorHostIds.push(hostId));

  await host.newChat();
  handles[0]?.emitStdout(JSON.stringify({ type: "agent_start" }));
  expect(stateHostIds.length).toBeGreaterThan(0);
  expect(stateHostIds.every((id) => id === "host-9")).toBe(true);

  handles[0]?.resolveExited({ code: 1, signal: null });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(errorHostIds.length).toBeGreaterThan(0);
  expect(errorHostIds.every((id) => id === "host-9")).toBe(true);
});

it("stopHelper routes through the current session's cancel path (desktop-rpc T6)", async () => {
    vi.useFakeTimers();
    try {
      const { spawner, handles } = createFakeSpawner();
      const store = fakeSessionStore([session({ id: "sess-1", path: "/home/sessions/proj/sess-1.jsonl" })]);
      const host = new ChatHost({ spawner, locator: fakeLocator, sessionStore: store, env: {} });

      // No chat open yet: the helper stop reports the bridge's own error,
      // like every other requireCurrent() call.
      await expect(host.stopHelper("m3a1-worker")).rejects.toThrow(/no chat is open/i);

      const openPromise = host.openChat("sess-1");
      await respondToHistoryRequest(handles, 0);
      await openPromise;

      // The history response triggers the capabilities probe; adopt the
      // channel with the subagents methods advertised, then stop a helper.
      const handle = handles[0];
      if (!handle) throw new Error("no spawned handle");
      const probeWrite = handle.writes.find((write) => write.includes("capabilities"));
      if (!probeWrite) throw new Error("expected a capabilities probe write");
      const probeRequest = JSON.parse((JSON.parse(probeWrite) as { message: string }).message.slice("/gentle:desktop ".length)) as { requestId: string };
      handle.emitStdout(
        JSON.stringify({
          type: "extension_ui_request",
          id: "ui-capabilities",
          method: "setWidget",
          widgetKey: "gentle-desktop-rpc",
          widgetLines: [
            JSON.stringify({
              schema: "gentle-shell.desktop-rpc/v1",
              kind: "response",
              requestId: probeRequest.requestId,
              ok: true,
              data: {
                schema: "gentle-shell.desktop-rpc/v1",
                command: "gentle:desktop",
                widget: "gentle-desktop-rpc",
                methods: ["capabilities", "list_subagents", "cancel_subagent"],
                events: ["agents_update"],
              },
            }),
          ],
        }),
      );
      await vi.advanceTimersByTimeAsync(0);

      const pending = host.stopHelper("m3a1-worker");
      await vi.advanceTimersByTimeAsync(0);
      const cancelWrite = handle.writes.find((write) => write.includes("cancel_subagent"));
      if (!cancelWrite) throw new Error("expected a cancel_subagent write");
      const cancelRequest = JSON.parse((JSON.parse(cancelWrite) as { message: string }).message.slice("/gentle:desktop ".length)) as { requestId: string; params: { id: string } };
      expect(cancelRequest.params.id).toBe("m3a1-worker");
      handle.emitStdout(
        JSON.stringify({
          type: "extension_ui_request",
          id: "ui-cancel",
          method: "setWidget",
          widgetKey: "gentle-desktop-rpc",
          widgetLines: [
            JSON.stringify({
              schema: "gentle-shell.desktop-rpc/v1",
              kind: "response",
              requestId: cancelRequest.requestId,
              ok: true,
              data: { agent: { id: "m3a1-worker", agent: "worker", status: "running" } },
            }),
          ],
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      await expect(pending).resolves.toBe("requested");
    } finally {
      vi.useRealTimers();
    }
  });
});

// palette-host-catalog T3 (S4): the host's `run_command` is the ONE
// execution path for a runnable catalog row. ChatHost adds one named
// passthrough — the exact shape of its stopHelper route — so the IPC
// layer never reaches around it, and the answer classification (executed,
// refusal, retryable session_switching, transport) is PiSession's.
it("runCommand routes through the current session's run_command path (palette-host-catalog S4)", async () => {
  vi.useFakeTimers();
  try {
    const { spawner, handles } = createFakeSpawner();
    const store = fakeSessionStore([session({ id: "sess-1", path: "/home/sessions/proj/sess-1.jsonl" })]);
    const host = new ChatHost({ spawner, locator: fakeLocator, sessionStore: store, env: {} });

    // No chat open yet: the refusal is the bridge's own error, like every
    // other requireCurrent() call.
    await expect(host.runCommand("compact")).rejects.toThrow(/no chat is open/i);

    const openPromise = host.openChat("sess-1");
    await respondToHistoryRequest(handles, 0);
    await openPromise;

    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");
    const probeWrite = handle.writes.find((write) => write.includes("capabilities"));
    if (!probeWrite) throw new Error("expected a capabilities probe write");
    const probeRequest = JSON.parse((JSON.parse(probeWrite) as { message: string }).message.slice("/gentle:desktop ".length)) as { requestId: string };
    handle.emitStdout(
      JSON.stringify({
        type: "extension_ui_request",
        id: "ui-capabilities",
        method: "setWidget",
        widgetKey: "gentle-desktop-rpc",
        widgetLines: [
          JSON.stringify({
            schema: "gentle-shell.desktop-rpc/v1",
            kind: "response",
            requestId: probeRequest.requestId,
            ok: true,
            data: {
              schema: "gentle-shell.desktop-rpc/v1",
              command: "gentle:desktop",
              widget: "gentle-desktop-rpc",
              methods: ["capabilities", "run_command"],
              events: [],
            },
          }),
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    const pending = host.runCommand("compact");
    await vi.advanceTimersByTimeAsync(0);
    const commandWrite = handle.writes.find((write) => write.includes("run_command"));
    if (!commandWrite) throw new Error("expected a run_command write");
    const commandRequest = JSON.parse((JSON.parse(commandWrite) as { message: string }).message.slice("/gentle:desktop ".length)) as { requestId: string; params: { name: string } };
    expect(commandRequest.params.name).toBe("compact");
    handle.emitStdout(
      JSON.stringify({
        type: "extension_ui_request",
        id: "ui-run",
        method: "setWidget",
        widgetKey: "gentle-desktop-rpc",
        widgetLines: [
          JSON.stringify({
            schema: "gentle-shell.desktop-rpc/v1",
            kind: "response",
            requestId: commandRequest.requestId,
            ok: true,
            data: { executed: true },
          }),
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toEqual({ kind: "executed" });
  } finally {
    vi.useRealTimers();
  }
});
