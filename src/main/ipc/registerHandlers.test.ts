import { describe, expect, it, vi } from "vitest";
import type { IpcMain, WebContents } from "electron";
import type { ChatState } from "@shared/bridge-types";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import { ChatHost } from "../domain/session/ChatHost";
import type { LauncherLocator, ProcessSpawner, SessionInfoLike, SessionStore, SpawnedProcess } from "../ports";
import type { SetupService } from "../ports";
import { WorkspaceHostRouter, registerHandlers, type WorkspaceHostSource } from "./registerHandlers";

function fakeHost(overrides: Partial<ChatHost> = {}): ChatHost {
  return {
    hostId: "host-1",
    listChats: vi.fn(),
    openChat: vi.fn(),
    newChat: vi.fn(),
    sendMessage: vi.fn(),
    abort: vi.fn(),
    answerDialog: vi.fn(),
    stopHelper: vi.fn(),
    onState: vi.fn().mockReturnValue(() => {}),
    onError: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  } as unknown as ChatHost;
}

/** A fake WorkspaceHostSource over spy hosts: enough for routing/wiring
 * tests without spawning any process. Mirrors WorkspaceHostRegistry's
 * shape (get/createHost/list), which is the real value passed in
 * src/main/index.ts. */
function fakeHostSource(...hosts: ChatHost[]): WorkspaceHostSource {
  const byId = new Map(hosts.map((host) => [host.hostId, host]));
  let nextNumber = hosts.length + 1;
  return {
    get: (hostId: string) => byId.get(hostId),
    createHost: () => {
      const host = fakeHost({ hostId: `host-${nextNumber++}` });
      byId.set(host.hostId, host);
      return host;
    },
    list: () => [...byId.values()],
  };
}

/** A WorkspaceHostSource that mints REAL ChatHosts (with the given shared
 * deps), the way WorkspaceHostRegistry does — used by the routing tests
 * that must prove things about actual child stdin/stdout. */
function realHostSource(
  makeDeps: () => { spawner: ProcessSpawner; locator: LauncherLocator; sessionStore: SessionStore; env: NodeJS.ProcessEnv },
): WorkspaceHostSource {
  const byId = new Map<string, ChatHost>();
  let nextNumber = 1;
  return {
    get: (hostId: string) => byId.get(hostId),
    createHost: () => {
      const host = new ChatHost({ ...makeDeps(), hostId: `host-${nextNumber++}` });
      byId.set(host.hostId, host);
      return host;
    },
    list: () => [...byId.values()],
  };
}

function fakeSetup(): SetupService {
  return {
    status: vi.fn().mockResolvedValue({ needsChoice: false, detection: { found: false, dir: "", hasAuth: false, hasModels: false } }),
    chooseHome: vi.fn().mockResolvedValue(undefined),
  };
}

/** Mirrors Electron's real behaviour: handle() throws for a channel that
 * already has a handler; removeHandler() is a safe no-op otherwise. */
function fakeIpcMain(): IpcMain {
  const handlers = new Set<string>();
  return {
    handle: vi.fn((channel: string) => {
      if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
      handlers.add(channel);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  } as unknown as IpcMain;
}

function fakeWebContents(): { webContents: WebContents; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  return { webContents: { send } as unknown as WebContents, send };
}

describe("registerHandlers", () => {
  it("can be called again for a new window without throwing (window closed, then re-registered on activate)", () => {
    const ipc = fakeIpcMain();
    const router = new WorkspaceHostRouter(fakeHostSource(fakeHost()));

    registerHandlers(router, fakeSetup(), fakeWebContents().webContents, ipc);

    expect(() => registerHandlers(router, fakeSetup(), fakeWebContents().webContents, ipc)).not.toThrow();
  });

  it("returns an unsubscribe that stops forwarding state/error pushes for that call's webContents", () => {
    const ipc = fakeIpcMain();
    const { webContents, send } = fakeWebContents();
    // The pushes are captured at wiring time: the router fans every live
    // host's events out to its own listeners, and registerHandlers binds
    // one of those listeners to THIS window's webContents.
    let emitState: (state: ChatState, hostId: string) => void = () => undefined;
    let emitError: (message: string, hostId: string) => void = () => undefined;
    const host = fakeHost({
      onState: vi.fn((listener: (state: ChatState, hostId: string) => void) => {
        emitState = listener;
        return () => undefined;
      }),
      onError: vi.fn((listener: (message: string, hostId: string) => void) => {
        emitError = listener;
        return () => undefined;
      }),
    });

    const unregister = registerHandlers(new WorkspaceHostRouter(fakeHostSource(host)), fakeSetup(), webContents, ipc);

    emitState({ messages: [], working: false, pendingDialogs: [], activity: 0, helpers: emptyHelpers() }, "host-1");
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.STATE_PUSH, expect.objectContaining({ hostId: "host-1" }));
    emitError("boom", "host-1");
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.ERROR_PUSH, "boom", "host-1");

    send.mockClear();
    unregister();
    emitState({ messages: [], working: false, pendingDialogs: [], activity: 0, helpers: emptyHelpers() }, "host-1");
    emitError("boom again", "host-1");
    expect(send).not.toHaveBeenCalled();
  });

  it("registers setup.status and setup.chooseHome, wired to the SetupService", () => {
    const ipc = fakeIpcMain();
    const setup = fakeSetup();

    registerHandlers(new WorkspaceHostRouter(fakeHostSource()), setup, fakeWebContents().webContents, ipc);

    const statusHandler = registeredHandler(ipc, "setup.status");
    const chooseHomeHandler = registeredHandler(ipc, "setup.chooseHome");

    void statusHandler({} as never);
    expect(setup.status).toHaveBeenCalledTimes(1);

    void chooseHomeHandler({} as never, "link");
    expect(setup.chooseHome).toHaveBeenCalledWith("link");
  });

  it("registers helpers.stop, routing (host id, helper id) to that host's stopHelper (desktop-rpc T6, T5b)", async () => {
    const ipc = fakeIpcMain();
    const host = fakeHost({ stopHelper: vi.fn().mockResolvedValue("requested") });

    registerHandlers(new WorkspaceHostRouter(fakeHostSource(host)), fakeSetup(), fakeWebContents().webContents, ipc);

    const stopHandler = registeredHandler(ipc, "helpers.stop");
    await expect(stopHandler({} as never, "host-1", "m3a1-worker")).resolves.toBe("requested");
    expect(host.stopHelper).toHaveBeenCalledWith("m3a1-worker");
  });

  // registerRequestHandler is a thin pass-through (ipc.handle(channel,
  // listener) with no try/catch of its own) so a rejected SetupService
  // call reaches the renderer as a rejected invoke() unchanged — this is
  // Electron's own ipcMain.handle()/ipcRenderer.invoke() contract, not
  // something this file has to implement; this test pins that the
  // pass-through never starts swallowing or rewrapping it (T6 follow-up).
  it("setup.chooseHome's handler rejects with the SetupService's own error instead of swallowing it", async () => {
    const ipc = fakeIpcMain();
    const setup: SetupService = {
      status: vi.fn(),
      chooseHome: vi.fn().mockRejectedValue(new Error("Could not save the home choice: EACCES")),
    };

    registerHandlers(new WorkspaceHostRouter(fakeHostSource()), setup, fakeWebContents().webContents, ipc);
    const chooseHomeHandler = registeredHandler(ipc, "setup.chooseHome");

    await expect(chooseHomeHandler({} as never, "link")).rejects.toThrow("Could not save the home choice: EACCES");
  });
});

function emptyHelpers(): ChatState["helpers"] {
  return { summary: { running: 0, queued: 0, waiting: 0, finished: 0 }, tasks: [] };
}

function registeredHandler(ipc: IpcMain, channel: string): (...args: unknown[]) => unknown {
  const call = vi.mocked(ipc.handle).mock.calls.find(([registeredChannel]) => registeredChannel === channel);
  if (!call) throw new Error(`no handler registered for channel "${channel}"`);
  return call[1] as (...args: unknown[]) => unknown;
}

// ---------------------------------------------------------------------------
// T5b — routing by workspace-host identity over REAL ChatHosts and their
// real (faked) child processes. The fake spawner/session-store helpers
// mirror ChatHost.test.ts's own fakes so "no child's stdin receives
// anything" is a statement about actual writes, not about spies.
// ---------------------------------------------------------------------------

interface FakeProcessHandle {
  readonly args: readonly string[];
  readonly writes: string[];
  emitStdout(line: string): void;
  resolveExited(result: { code: number | null; signal: NodeJS.Signals | null; error?: Error }): void;
}

function createFakeSpawner(): { spawner: ProcessSpawner; handles: FakeProcessHandle[]; events: string[] } {
  const handles: FakeProcessHandle[] = [];
  const events: string[] = [];

  const spawner: ProcessSpawner = {
    spawn(_command, args): SpawnedProcess {
      const index = handles.length;
      events.push(`spawn:${index}`);

      const stdoutHandlers: Array<(line: string) => void> = [];
      const writes: string[] = [];
      let resolveExitedFn: (result: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => void = () => undefined;
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
        resolveExitedFn = resolve;
      });

      const handle: FakeProcessHandle = {
        args: [...args],
        writes,
        emitStdout(line) {
          for (const handler of stdoutHandlers) handler(line);
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
        onStderrLine() {},
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

/** Answers the history request a sessionPath-backed open is waiting on, so
 * openChat resolves immediately instead of blocking on the real 2s bound
 * (same helper as ChatHost.test.ts). */
async function respondToHistoryRequest(handles: readonly FakeProcessHandle[], index: number): Promise<void> {
  await vi.waitFor(() => expect(handles[index]?.writes.length ?? 0).toBeGreaterThan(0));
  const sent = JSON.parse(handles[index]!.writes[handles[index]!.writes.length - 1]!);
  handles[index]!.emitStdout(JSON.stringify({ type: "response", id: sent.id, command: "get_messages", success: true, data: { messages: [] } }));
}

function statePushes(webContents: WebContents): ChatState[] {
  return vi
    .mocked(webContents.send)
    .mock.calls.filter(([channel]) => channel === IPC_CHANNELS.STATE_PUSH)
    .map(([, state]) => state as ChatState);
}

describe("workspace host routing (T5b)", () => {
  function setup(overrides: { sessions?: readonly SessionInfoLike[] } = {}): {
    ipc: IpcMain;
    webContents: WebContents;
    send: ReturnType<typeof vi.fn>;
    handles: FakeProcessHandle[];
    events: string[];
  } {
    const { spawner, handles, events } = createFakeSpawner();
    const store = fakeSessionStore(overrides.sessions ?? [session({ id: "sess-1", path: "/home/sessions/proj/sess-1.jsonl" })]);
    const ipc = fakeIpcMain();
    const { webContents, send } = fakeWebContents();
    const router = new WorkspaceHostRouter(
      realHostSource(() => ({ spawner, locator: fakeLocator, sessionStore: store, env: {} })),
    );
    registerHandlers(router, fakeSetup(), webContents, ipc);
    return { ipc, webContents, send, handles, events };
  }

  async function openLiveChat(ipc: IpcMain, handles: readonly FakeProcessHandle[], chatId: string, childIndex: number): Promise<unknown> {
    const opening = registeredHandler(ipc, IPC_CHANNELS.OPEN_CHAT)({}, chatId);
    await respondToHistoryRequest(handles, childIndex);
    return opening;
  }

  it("rejects a request whose host id is unknown, and no child's stdin receives anything", async () => {
    const { ipc, handles } = setup();
    await openLiveChat(ipc, handles, "sess-1", 0);

    // The one live child has written its history request (and the probe
    // that follows adoption). Nothing any rejection does may add to it.
    const writesBefore = handles[0]!.writes.length;

    await expect(registeredHandler(ipc, IPC_CHANNELS.SEND_MESSAGE)({}, "host-999", "hello")).rejects.toThrow(
      /No live workspace host for id "host-999"/,
    );
    await expect(registeredHandler(ipc, IPC_CHANNELS.ABORT)({}, "host-999")).rejects.toThrow(/No live workspace host/);
    await expect(registeredHandler(ipc, IPC_CHANNELS.ANSWER_DIALOG)({}, "host-999", "dlg-1", { confirmed: true })).rejects.toThrow(
      /No live workspace host/,
    );
    await expect(registeredHandler(ipc, IPC_CHANNELS.STOP_HELPER)({}, "host-999", "helper-1")).rejects.toThrow(/No live workspace host/);

    // The unknown id never reached the live child: not one extra write.
    expect(handles[0]!.writes.length).toBe(writesBefore);
    expect(handles[0]!.writes.some((write) => write.includes("hello"))).toBe(false);
    expect(handles[0]!.writes.some((write) => write.includes("extension_ui_response"))).toBe(false);
  });

  it("with two live hosts, a prompt to host A reaches only host A's child, and a dialog answer to host B reaches only host B's child", async () => {
    const { ipc, webContents, handles } = setup({
      sessions: [
        session({ id: "sess-1", path: "/home/sessions/proj/sess-1.jsonl" }),
        session({ id: "sess-2", path: "/home/sessions/proj/sess-2.jsonl" }),
      ],
    });
    await openLiveChat(ipc, handles, "sess-1", 0);
    await openLiveChat(ipc, handles, "sess-2", 1);
    expect(handles).toHaveLength(2); // both hosts live at once

    await expect(registeredHandler(ipc, IPC_CHANNELS.SEND_MESSAGE)({}, "host-1", "hello A")).resolves.toEqual({ queued: true });
    expect(handles[0]!.writes.some((write) => write.includes('"message":"hello A"'))).toBe(true);
    expect(handles[1]!.writes.some((write) => write.includes('"message":"hello A"'))).toBe(false);

    // Host B's child asks a dialog; the answer is addressed to host B.
    handles[1]!.emitStdout(JSON.stringify({ type: "extension_ui_request", id: "dlg-b", method: "confirm", title: "Confirm", message: "m" }));
    await vi.waitFor(() =>
      expect(statePushes(webContents).some((state) => state.pendingDialogs.some((dialog) => dialog.id === "dlg-b"))).toBe(true),
    );

    await expect(registeredHandler(ipc, IPC_CHANNELS.ANSWER_DIALOG)({}, "host-2", "dlg-b", { confirmed: true })).resolves.toBeUndefined();
    expect(handles[1]!.writes.some((write) => write.includes('"extension_ui_response"'))).toBe(true);
    expect(handles[0]!.writes.some((write) => write.includes('"extension_ui_response"'))).toBe(false);
  });

  it("chat.open of an already-live chat reuses its host id instead of starting a second child; chat.new creates a distinct host id", async () => {
    const { ipc, handles, events } = setup();

    const first = (await openLiveChat(ipc, handles, "sess-1", 0)) as { hostId: string };
    expect(first.hostId).toBe("host-1");

    // Opening the SAME chat again routes to the host that owns it: the
    // old child is stopped (endStdin) before the replacement spawns — a
    // second host would have left the first child running.
    const secondOpening = registeredHandler(ipc, IPC_CHANNELS.OPEN_CHAT)({}, "sess-1");
    // ChatHost's reopen first stops the child it already owns. A real
    // child only exits BECAUSE its stdin was ended, so the fake child's
    // exit is resolved only after the stop has reached stdin (endStdin).
    await vi.waitFor(() => expect(events).toContain("endStdin:0"));
    handles[0]!.resolveExited({ code: 0, signal: null });
    await respondToHistoryRequest(handles, 1);
    const second = (await secondOpening) as { hostId: string };
    expect(second.hostId).toBe("host-1");
    expect(events).toContain("endStdin:0");
    expect(events.indexOf("endStdin:0")).toBeLessThan(events.indexOf("spawn:1"));
    expect(handles).toHaveLength(2);

    const fresh = (await registeredHandler(ipc, IPC_CHANNELS.NEW_CHAT)({})) as { hostId: string };
    expect(fresh.hostId).toBe("host-2");
    expect(fresh.hostId).not.toBe(first.hostId);
    expect(handles).toHaveLength(3);
  });

  it("a pushed state from a host carries that host's id, and every dialog in it carries it too", async () => {
    const { ipc, webContents, handles } = setup();
    await openLiveChat(ipc, handles, "sess-1", 0);

    // Every state push out of this host is tagged with its id.
    expect(statePushes(webContents).length).toBeGreaterThan(0);
    expect(statePushes(webContents).every((state) => state.hostId === "host-1")).toBe(true);

    // A dialog asked by that host's child arrives carrying the same id —
    // on the state and on the dialog itself, so an answer can be
    // addressed without guessing.
    handles[0]!.emitStdout(JSON.stringify({ type: "extension_ui_request", id: "dlg-a", method: "confirm", title: "Confirm", message: "m" }));
    await vi.waitFor(() =>
      expect(
        statePushes(webContents).some(
          (state) => state.hostId === "host-1" && state.pendingDialogs.some((dialog) => dialog.id === "dlg-a" && dialog.hostId === "host-1"),
        ),
      ).toBe(true),
    );
  });

  // T5c — focus and background discipline: chat.refresh answers a host's
  // current state without touching its child, and a failed start unwires
  // the host it spawned (the L24 follow-up).
  it("chat.refresh answers the addressed host's latest state without touching any child, and refuses an unknown host id", async () => {
    const { ipc, handles } = setup();
    const opened = (await openLiveChat(ipc, handles, "sess-1", 0)) as { hostId: string };
    expect(opened.hostId).toBe("host-1");
    const writesBefore = handles[0]!.writes.length;

    const refreshed = (await registeredHandler(ipc, IPC_CHANNELS.REFRESH_CHAT)({}, "host-1")) as ChatState;
    expect(refreshed.hostId).toBe("host-1");
    // A refresh is a read of main's own per-host record, never a child
    // round-trip: not one extra stdin write.
    expect(handles[0]!.writes.length).toBe(writesBefore);

    // The answer tracks the host's LATEST state: after a prompt, the user
    // message is part of the refreshed state (PiSession appends and pushes
    // it synchronously, so the router's record already holds it).
    await expect(registeredHandler(ipc, IPC_CHANNELS.SEND_MESSAGE)({}, "host-1", "hello refresh")).resolves.toEqual({ queued: true });
    const afterPrompt = (await registeredHandler(ipc, IPC_CHANNELS.REFRESH_CHAT)({}, "host-1")) as ChatState;
    expect(afterPrompt.messages.some((message) => message.role === "user" && message.text === "hello refresh")).toBe(true);

    // An unknown id is refused before any child is touched.
    const writesAfter = handles[0]!.writes.length;
    await expect(registeredHandler(ipc, IPC_CHANNELS.REFRESH_CHAT)({}, "host-999")).rejects.toThrow(/No live workspace host/);
    expect(handles[0]!.writes.length).toBe(writesAfter);
  });

  it("chat.refresh refuses a live host whose chat has never reported a state", async () => {
    const ipc = fakeIpcMain();
    // fakeHost's default onState/onError already wire a childless host:
    // the router subscribes to it at construction, but no chat was ever
    // opened on it, so main holds no state to answer a refresh with.
    const host = fakeHost({ hostId: "host-1" });

    registerHandlers(new WorkspaceHostRouter(fakeHostSource(host)), fakeSetup(), fakeWebContents().webContents, ipc);

    await expect(registeredHandler(ipc, IPC_CHANNELS.REFRESH_CHAT)({}, "host-1")).rejects.toThrow(/No known state/);
  });

  it("a failed openChat invokes and drops that host's stored unsubscriber, so the router stops hearing a host the registry dropped", async () => {
    const ipc = fakeIpcMain();
    const { webContents, send } = fakeWebContents();
    let emitState: (state: ChatState, hostId: string) => void = () => undefined;
    let emitError: (message: string, hostId: string) => void = () => undefined;
    // These unsubscribers honour the real ChatHost contract (removing the
    // listener from its Set), so "the host's listeners receive nothing
    // afterwards" is a statement about actual delivery, not about spies.
    const unsubscribeState = vi.fn(() => {
      emitState = () => undefined;
    });
    const unsubscribeError = vi.fn(() => {
      emitError = () => undefined;
    });
    const stopHost = vi.fn().mockResolvedValue(undefined);
    // The source mints a FRESH host per createHost call (as the real
    // registry does), so the router wires it exactly once — at spawn.
    const byId = new Map<string, ChatHost>();
    let nextNumber = 1;
    const source: WorkspaceHostSource = {
      get: (hostId) => byId.get(hostId),
      createHost: () => {
        const created = fakeHost({
          hostId: `host-${nextNumber++}`,
          openChat: vi.fn().mockRejectedValue(new Error("spawn failed")),
          onState: vi.fn((listener: (state: ChatState, hostId: string) => void) => {
            emitState = listener;
            return unsubscribeState;
          }),
          onError: vi.fn((listener: (message: string, hostId: string) => void) => {
            emitError = listener;
            return unsubscribeError;
          }),
        });
        byId.set(created.hostId, created);
        return created;
      },
      list: () => [...byId.values()],
      stopHost,
    };

    const router = new WorkspaceHostRouter(source);
    const lateStates: ChatState[] = [];
    router.onState((state) => lateStates.push(state));
    registerHandlers(router, fakeSetup(), webContents, ipc);

    await expect(registeredHandler(ipc, IPC_CHANNELS.OPEN_CHAT)({}, "sess-1")).rejects.toThrow("spawn failed");

    // The stored unsubscriber was invoked and its entry dropped: exactly
    // one invocation each (the host was wired once, at spawn), so a repeat
    // start cannot unwire someone else.
    expect(unsubscribeState).toHaveBeenCalledTimes(1);
    expect(unsubscribeError).toHaveBeenCalledTimes(1);
    expect(stopHost).toHaveBeenCalledWith("host-1");

    // The router is no longer subscribed: the dropped host's pushes reach
    // neither this router's own listeners nor the window.
    emitState({ messages: [], working: false, pendingDialogs: [], activity: 0, helpers: emptyHelpers() }, "host-1");
    emitError("late error", "host-1");
    expect(lateStates).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("a failed newChat unwires its host the same way", async () => {
    const ipc = fakeIpcMain();
    const { webContents, send } = fakeWebContents();
    let emitState: (state: ChatState, hostId: string) => void = () => undefined;
    const unsubscribeState = vi.fn(() => {
      emitState = () => undefined;
    });
    const byId = new Map<string, ChatHost>();
    let nextNumber = 1;
    const source: WorkspaceHostSource = {
      get: (hostId) => byId.get(hostId),
      createHost: () => {
        const created = fakeHost({
          hostId: `host-${nextNumber++}`,
          newChat: vi.fn().mockRejectedValue(new Error("spawn failed")),
          onState: vi.fn((listener: (state: ChatState, hostId: string) => void) => {
            emitState = listener;
            return unsubscribeState;
          }),
        });
        byId.set(created.hostId, created);
        return created;
      },
      list: () => [...byId.values()],
    };

    registerHandlers(new WorkspaceHostRouter(source), fakeSetup(), webContents, ipc);

    await expect(registeredHandler(ipc, IPC_CHANNELS.NEW_CHAT)({})).rejects.toThrow("spawn failed");
    expect(unsubscribeState).toHaveBeenCalledTimes(1);

    emitState({ messages: [], working: false, pendingDialogs: [], activity: 0, helpers: emptyHelpers() }, "host-1");
    expect(send).not.toHaveBeenCalled();
  });

  it("forwards error pushes with the emitting host's id, so the renderer can ignore other hosts' errors", () => {
    const ipc = fakeIpcMain();
    const { webContents, send } = fakeWebContents();
    let emitError: (message: string, hostId: string) => void = () => undefined;
    const host = fakeHost({
      onError: vi.fn((listener: (message: string, hostId: string) => void) => {
        emitError = listener;
        return () => undefined;
      }),
    });

    registerHandlers(new WorkspaceHostRouter(fakeHostSource(host)), fakeSetup(), webContents, ipc);

    emitError("pi exited unexpectedly", "host-1");
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.ERROR_PUSH, "pi exited unexpectedly", "host-1");
  });
});
