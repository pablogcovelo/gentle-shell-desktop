import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMain, WebContents } from "electron";
import type { ChatState } from "@shared/bridge-types";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import { ChatHost } from "../domain/session/ChatHost";
import { createAppConfigStore } from "../adapters/appConfigStore";
import type { LauncherLocator, ProcessSpawner, SessionInfoLike, SessionStore, SpawnedProcess } from "../ports";
import type { SetupService } from "../ports";
import { WorkspaceHostRegistry } from "../domain/session/WorkspaceHostRegistry";
import { WorkspaceHostRouter, registerHandlers, validateWorkspaceDirectory, type WorkspaceHostSource, type WorkspaceRegistryPort, type WorkspaceRouterDeps } from "./registerHandlers";

function fakeHost(overrides: Partial<ChatHost> = {}): ChatHost {
  return {
    hostId: "host-1",
    cwd: undefined,
    listChats: vi.fn(),
    openChat: vi.fn(),
    newChat: vi.fn(),
    sendMessage: vi.fn(),
    abort: vi.fn(),
    answerDialog: vi.fn(),
    stopHelper: vi.fn(),
    runCommand: vi.fn(),
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
    createHost: (cwd?: string) => {
      const host = fakeHost({ hostId: `host-${nextNumber++}`, cwd });
      byId.set(host.hostId, host);
      return host;
    },
    findByDirectory: (directory: string) => [...byId.values()].find((host) => host.cwd === directory),
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
    createHost: (cwd?: string) => {
      const host = new ChatHost({ ...makeDeps(), hostId: `host-${nextNumber++}`, cwd });
      byId.set(host.hostId, host);
      return host;
    },
    findByDirectory: (directory: string) => [...byId.values()].find((host) => host.cwd === directory),
    list: () => [...byId.values()],
    // Mirrors WorkspaceHostRegistry.stopHost exactly: stop exactly this
    // host's child, forget the host, and refuse an id no live host owns.
    stopHost: async (hostId: string) => {
      const host = byId.get(hostId);
      if (!host) throw new Error(`no host for id "${hostId}"`);
      byId.delete(hostId);
      await host.stop();
    },
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

describe("WorkspaceHostRouter workspace creation races", () => {
  it("shares one start between two concurrent creates of the same directory", async () => {
    const byId = new Map<string, ChatHost>();
    let nextNumber = 1;
    let releaseNewChat: (() => void) | undefined;
    const hostNewChat = vi.fn(
      () =>
        new Promise<ChatState>((resolve) => {
          releaseNewChat = () => resolve({ messages: [], working: false, pendingDialogs: [], activity: 0, helpers: emptyHelpers() } as ChatState);
        }),
    );
    const source: WorkspaceHostSource = {
      get: (hostId) => byId.get(hostId),
      createHost: (cwd?: string) => {
        const host = fakeHost({ hostId: `host-${nextNumber++}`, cwd, newChat: hostNewChat });
        byId.set(host.hostId, host);
        return host;
      },
      list: () => [...byId.values()],
      findByDirectory: (directory: string) => [...byId.values()].find((host) => host.cwd === directory),
    };
    const router = new WorkspaceHostRouter(source, {
      chooseDirectory: vi.fn(),
      validateDirectory: vi.fn().mockResolvedValue(undefined),
    });

    const first = router.createWorkspace("/tmp/ws-shared");
    const second = router.createWorkspace("/tmp/ws-shared");
    await vi.waitFor(() => expect(hostNewChat).toHaveBeenCalled());
    releaseNewChat?.();
    const [a, b] = await Promise.all([first, second]);

    // One spawn, one answer: the loser of the race must not be refused nor
    // start a second child for the same folder.
    // One spawn per directory: the loser of the race shares the winner's start.
    expect(byId.size).toBe(1);
    expect(a.hostId).toBe(b.hostId);
    expect(hostNewChat).toHaveBeenCalledTimes(1);
  });
});

describe("directory closure", () => {
  it("closes A after discovering pending B ownership without awaiting B startup or validation", async () => {
    vi.useFakeTimers();
    const { spawner, handles, events } = createFakeSpawner();
    let releaseLookup!: (sessions: SessionInfoLike[]) => void;
    let releaseValidation!: () => void;
    const saved = [session({ id: "saved-B", cwd: "/tmp/B" })];
    const store: SessionStore = { listAll: () => new Promise((resolve) => { releaseLookup = resolve; }) };
    const registry = new WorkspaceHostRegistry({ createHostDeps: () => ({ spawner, locator: fakeLocator, sessionStore: store, env: {} }) });
    const router = new WorkspaceHostRouter(registry, { validateDirectory: (directory) => directory === "/tmp/B-create"
      ? new Promise((resolve) => { releaseValidation = resolve; }) : Promise.resolve() });
    const closed: string[] = [];
    router.onClosed((id) => closed.push(id));
    const a = await router.createWorkspace("/tmp/A");
    const openingB = router.openChat("saved-B");
    const creatingB = router.createWorkspace("/tmp/B-create");
    let bStarted = false;
    void openingB.then(() => { bStarted = true; });
    let aClosed = false;
    const closing = router.closeWorkspace("/tmp/A").then(() => { aClosed = true; });
    const duplicate = router.closeWorkspace("/tmp/A");
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(aClosed).toBe(false); // unknown metadata could still belong to A
      releaseLookup(saved);
      await vi.advanceTimersByTimeAsync(0);
      expect(handles[1]!.cwd).toBe("/tmp/B");
      expect(events).toContain("endStdin:0");
      handles[0]!.resolveExited({ code: 0, signal: null });
      await vi.advanceTimersByTimeAsync(0);
      expect(aClosed).toBe(true); // B's get_messages and validator are still gated
      expect(bStarted).toBe(false);
      expect(closed).toEqual([a.hostId]);
      expect(events).toEqual(["spawn:0", "spawn:1", "endStdin:0"]);
      await expect(router.refreshChat(a.hostId)).rejects.toThrow(`No live workspace host for id "${a.hostId}" (unknown or already stopped)`);
    } finally {
      // Release every deterministic gate, even in the intended RED case.
      releaseValidation();
      await respondToHistoryRequest(handles, 1);
      handles[0]!.resolveExited({ code: 0, signal: null });
      await Promise.all([openingB, creatingB, closing, duplicate]);
      vi.useRealTimers();
    }
    const b = await openingB;
    await expect(router.sendMessage(b.hostId, "only B")).resolves.toEqual({ queued: true });
    expect(handles[1]!.writes.some((write) => write.includes('"message":"only B"'))).toBe(true);
    expect(handles[0]!.writes.some((write) => write.includes("only B"))).toBe(false);
    expect(saved).toEqual([session({ id: "saved-B", cwd: "/tmp/B" })]);
  });

  it("attempts every owner on failure and retains the persistent entry", async () => {
    const a = fakeHost({ hostId: "host-1", cwd: "/tmp/A" });
    const resumed = fakeHost({ hostId: "host-2", effectiveCwd: "/tmp/A" });
    const b = fakeHost({ hostId: "host-3", cwd: "/tmp/B" });
    const source = fakeHostSource(a, resumed, b);
    const dropped = new Set<string>();
    const get = source.get;
    const list = source.list;
    source.get = (id) => dropped.has(id) ? undefined : get(id);
    source.list = () => list().filter((host) => !dropped.has(host.hostId));
    const stopHost = vi.fn(async (id: string) => {
      dropped.add(id); // registry's existing drop-before-stop contract
      if (id === a.hostId) throw new Error("stop uncertain");
    });
    source.stopHost = stopHost;
    const router = new WorkspaceHostRouter(source);
    const ipc = fakeIpcMain();
    const remove = vi.fn();
    registerHandlers(router, fakeSetup(), fakeWebContents().webContents, ipc, {
      workspaces: { list: () => ["/tmp/A", "/tmp/B"], add: () => [], remove },
    });
    await expect(registeredHandler(ipc, IPC_CHANNELS.WORKSPACE_REMOVE)({}, "/tmp/A")).rejects.toThrow("stop uncertain");
    expect(stopHost.mock.calls).toEqual([[a.hostId], [resumed.hostId]]);
    expect(remove).not.toHaveBeenCalled();
    expect(source.get(a.hostId)).toBeUndefined();
    expect(source.get(resumed.hostId)).toBeUndefined();
    expect(source.get(b.hostId)).toBe(b);
  });

  it("joins a workspace start already inside newChat and rejects its late answer", async () => {
    const { spawner, handles, events } = createFakeSpawner();
    const registry = new WorkspaceHostRegistry({ createHostDeps: () => ({ spawner, locator: fakeLocator, sessionStore: fakeSessionStore([]), env: {} }) });
    const router = new WorkspaceHostRouter(registry, { validateDirectory: async () => {} });
    const opening = router.createWorkspace("/tmp/A");
    // Validation completes, but the host's queued performStart has not yet run.
    await Promise.resolve();
    const rejected = expect(opening).rejects.toThrow('Workspace "/tmp/A" is closing');
    const closing = router.closeWorkspace("/tmp/A");
    const duplicate = router.closeWorkspace("/tmp/A");
    await vi.waitFor(() => expect(events).toContain("endStdin:0"));
    handles[0]!.resolveExited({ code: 0, signal: null });
    await Promise.all([closing, duplicate, rejected]);
    expect(events).toEqual(["spawn:0", "endStdin:0"]);
    expect(registry.list()).toEqual([]);
    const reopened = await router.createWorkspace("/tmp/A");
    expect(reopened.hostId).toBe("host-2");
    expect(handles[1]!.args).not.toContain("--session");
  });
  it("closes fresh and legacy resumed hosts, retaining history and unrelated routing", async () => {
    const { spawner, handles, events } = createFakeSpawner();
    const saved = [session()];
    const store = fakeSessionStore(saved);
    const registry = new WorkspaceHostRegistry({ createHostDeps: () => ({ spawner, locator: fakeLocator, sessionStore: store, env: {} }) });
    const router = new WorkspaceHostRouter(registry, { validateDirectory: async () => {} });
    const closed: string[] = [];
    router.onClosed((id) => closed.push(id));
    const a = await router.createWorkspace("/tmp/proj");
    const b = await router.createWorkspace("/tmp/B");
    const opening = router.openChat("sess-1");
    await respondToHistoryRequest(handles, 2);
    const resumed = await opening;
    const closing = router.closeWorkspace("/tmp/proj");
    await vi.waitFor(() => expect(events).toContain("endStdin:0"));
    handles[0]!.resolveExited({ code: 0, signal: null });
    await vi.waitFor(() => expect(events).toContain("endStdin:2"));
    handles[2]!.resolveExited({ code: 0, signal: null });
    await closing;
    expect(closed.sort()).toEqual([a.hostId, resumed.hostId].sort());
    expect(events.filter((event) => event.startsWith("endStdin:"))).toEqual(["endStdin:0", "endStdin:2"]);
    await expect(router.sendMessage(a.hostId, "no")).rejects.toThrow(`No live workspace host for id "${a.hostId}" (unknown or already stopped)`);
    await expect(router.sendMessage(b.hostId, "still usable")).resolves.toEqual({ queued: true });
    expect(await router.listChats()).toHaveLength(1);
    expect(await store.listAll()).toEqual(saved);
  });

  it("joins pending validation, metadata lookup and duplicate closes without publishing late results", async () => {
    const { spawner, handles, events } = createFakeSpawner();
    let releaseValidation!: () => void;
    let releaseLookup!: (sessions: SessionInfoLike[]) => void;
    const store: SessionStore = { listAll: () => new Promise((resolve) => { releaseLookup = resolve; }) };
    const registry = new WorkspaceHostRegistry({ createHostDeps: () => ({ spawner, locator: fakeLocator, sessionStore: store, env: {} }) });
    const router = new WorkspaceHostRouter(registry, { validateDirectory: () => new Promise((resolve) => { releaseValidation = resolve; }) });
    const closed: string[] = [];
    router.onClosed((id) => closed.push(id));
    const creating = router.createWorkspace("/tmp/proj");
    const opening = router.openChat("sess-1");
    const rejectedCreate = expect(creating).rejects.toThrow('Workspace "/tmp/proj" is closing');
    const rejectedOpen = expect(opening).rejects.toThrow('Workspace "/tmp/proj" is closing');
    const closing = router.closeWorkspace("/tmp/proj");
    const duplicate = router.closeWorkspace("/tmp/proj");
    releaseValidation();
    await vi.waitFor(() => expect(releaseLookup).toBeTypeOf("function"));
    releaseLookup([session()]);
    await respondToHistoryRequest(handles, 0);
    await vi.waitFor(() => expect(events).toContain("endStdin:0"));
    handles[0]!.resolveExited({ code: 0, signal: null });
    await Promise.all([closing, duplicate, rejectedCreate, rejectedOpen]);
    expect(handles).toHaveLength(1);
    expect(events).toEqual(["spawn:0", "endStdin:0"]);
    expect(closed).toEqual(["host-1"]);
    expect(registry.list().every((host) => !host.isAlive)).toBe(true);
  });
});

describe("WorkspaceHostRouter close cleanup", () => {
  it("still unwires a host whose stop rejects, so a later open mints a fresh host", async () => {
    const byId = new Map<string, ChatHost>();
    let nextNumber = 1;
    let stopRejects = false;
    const openChat = vi.fn(async () => ({ messages: [], working: false, pendingDialogs: [], activity: 0, helpers: emptyHelpers() }) as ChatState);
    const source: WorkspaceHostSource = {
      get: (hostId) => byId.get(hostId),
      createHost: (cwd?: string) => {
        const host = fakeHost({ hostId: `host-${nextNumber++}`, openChat, cwd });
        byId.set(host.hostId, host);
        return host;
      },
      findByDirectory: (directory: string) => [...byId.values()].find((host) => host.cwd === directory),
      list: () => [...byId.values()],
      stopHost: async (hostId: string) => {
        const host = byId.get(hostId);
        if (!host) throw new Error(`no host for id "${hostId}"`);
        // The registry drops the host before awaiting its stop.
        byId.delete(hostId);
        if (stopRejects) throw new Error("stop failed");
      },
    };

    const router = new WorkspaceHostRouter(source);
    const closed: string[] = [];
    router.onClosed((hostId) => closed.push(hostId));
    const opened = await router.openChat("chat-1");
    expect(opened.hostId).toBe("host-1");

    stopRejects = true;
    await expect(router.closeChat("host-1")).rejects.toThrow("stop failed");

    // The host is gone from the source either way: the router must not keep
    // its wiring or reuse entry, and it must still report the close so the
    // renderer forgets the host (the cleanup lives in a finally for exactly
    // this case).
    expect(closed).toEqual(["host-1"]);
    stopRejects = false;
    const reopened = await router.openChat("chat-1");
    expect(reopened.hostId).toBe("host-2");
  });

  it("reports a rejected close as an error push for that host, after the close report (P3)", async () => {
    const byId = new Map<string, ChatHost>();
    let nextNumber = 1;
    let stopRejects = false;
    const openChat = vi.fn(async () => ({ messages: [], working: false, pendingDialogs: [], activity: 0, helpers: emptyHelpers() }) as ChatState);
    const source: WorkspaceHostSource = {
      get: (hostId) => byId.get(hostId),
      createHost: (cwd?: string) => {
        const host = fakeHost({ hostId: `host-${nextNumber++}`, openChat, cwd });
        byId.set(host.hostId, host);
        return host;
      },
      findByDirectory: (directory: string) => [...byId.values()].find((host) => host.cwd === directory),
      list: () => [...byId.values()],
      stopHost: async (hostId: string) => {
        const host = byId.get(hostId);
        if (!host) throw new Error(`no host for id "${hostId}"`);
        byId.delete(hostId); // dropped before the await, exactly like the registry
        if (stopRejects) throw new Error("stop failed");
      },
    };

    const router = new WorkspaceHostRouter(source);
    // One ordered log: the renderer's close handler and its error handler
    // both repaint the same status line, so which one lands LAST decides
    // what the user reads.
    const pushes: string[] = [];
    router.onClosed((hostId) => pushes.push(`closed:${hostId}`));
    router.onError((_message, hostId) => pushes.push(`error:${hostId}`));
    const errors: string[] = [];
    router.onError((message) => errors.push(message));

    const opened = await router.openChat("chat-1");
    stopRejects = true;
    await expect(router.closeChat(opened.hostId)).rejects.toThrow("stop failed");

    // P3: the source dropped the host before its child was stopped, so a
    // failed close can leave a live child nothing tracks. Cleanup alone is
    // silent — the renderer must be told.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("stop failed");
    expect(errors[0]).toContain("may still be running");
    // Order matters: the generic "host was closed" notice must not be the
    // last word on a close that did not complete.
    expect(pushes).toEqual([`closed:${opened.hostId}`, `error:${opened.hostId}`]);
  });

  it("reports a close whose stop rejects with no reason instead of resolving as success (R3-001)", async () => {
    const byId = new Map<string, ChatHost>();
    let nextNumber = 1;
    let failWithoutReason = false;
    const openChat = vi.fn(async () => ({ messages: [], working: false, pendingDialogs: [], activity: 0, helpers: emptyHelpers() }) as ChatState);
    const source: WorkspaceHostSource = {
      get: (hostId) => byId.get(hostId),
      createHost: (cwd?: string) => {
        const host = fakeHost({ hostId: `host-${nextNumber++}`, openChat, cwd });
        byId.set(host.hostId, host);
        return host;
      },
      findByDirectory: (directory: string) => [...byId.values()].find((host) => host.cwd === directory),
      list: () => [...byId.values()],
      stopHost: async (hostId: string) => {
        const host = byId.get(hostId);
        if (!host) throw new Error(`no host for id "${hostId}"`);
        byId.delete(hostId);
        // A rejection whose reason is undefined is legal JavaScript; the
        // router must not read it as "nothing failed".
        if (failWithoutReason) throw undefined;
      },
    };

    const router = new WorkspaceHostRouter(source);
    const errors: string[] = [];
    router.onError((message) => errors.push(message));

    const opened = await router.openChat("chat-1");
    failWithoutReason = true;

    await expect(router.closeChat(opened.hostId)).rejects.toBeUndefined();

    // Rejecting is only half the report: the renderer must be told too, or a
    // live child outlives its workspace in silence.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Could not close this workspace's host");
    expect(errors[0]).toContain("may still be running");
  });
});

// T11 — Add workspace: a native directory picker answered by main, a
// directory validated BEFORE anything is created, one host per directory
// whose child is spawned with that directory as cwd, and the chosen
// directory attached to the host's states (the footer's path).
describe("workspace.create (T11)", () => {
  // Same shape as the T5b describe's setup, declared locally there; this
  // describe adds the workspace router deps the T11 channels need.
  function setup(overrides: { routerDeps?: WorkspaceRouterDeps } = {}): {
    ipc: IpcMain;
    webContents: WebContents;
    send: ReturnType<typeof vi.fn>;
    handles: FakeProcessHandle[];
    events: string[];
  } {
    const { spawner, handles, events } = createFakeSpawner();
    const store = fakeSessionStore([session({ id: "sess-1", path: "/home/sessions/proj/sess-1.jsonl" })]);
    const ipc = fakeIpcMain();
    const { webContents, send } = fakeWebContents();
    const router = new WorkspaceHostRouter(
      realHostSource(() => ({ spawner, locator: fakeLocator, sessionStore: store, env: {} })),
      overrides.routerDeps,
    );
    registerHandlers(router, fakeSetup(), webContents, ipc);
    return { ipc, webContents, send, handles, events };
  }

  it("creates one host for a valid directory and spawns its child with that directory as cwd (assert the spawn options)", async () => {
    const { ipc, handles, send } = setup({ routerDeps: { validateDirectory: vi.fn().mockResolvedValue(undefined) } });

    const created = (await registeredHandler(ipc, IPC_CHANNELS.WORKSPACE_CREATE)({}, "/tmp/ws-demo")) as {
      hostId: string;
      state: ChatState;
    };

    // Exactly one host, minted for THIS directory.
    expect(created.hostId).toBe("host-1");
    expect(handles).toHaveLength(1);
    // The spawn OPTIONS carry the directory — the whole point of T11 — and
    // the fake records what it was asked to spawn, not a real process.
    expect(handles[0]!.cwd).toBe("/tmp/ws-demo");
    // The answer's state carries the directory, so the footer can show it.
    expect(created.state.workspacePath).toBe("/tmp/ws-demo");
    expect(send).not.toHaveBeenCalled(); // the answer is returned, not pushed
  });

  it("choosing a directory that is already open selects the existing host instead of spawning a second child", async () => {
    const { ipc, handles } = setup({ routerDeps: { validateDirectory: vi.fn().mockResolvedValue(undefined) } });

    const first = (await registeredHandler(ipc, IPC_CHANNELS.WORKSPACE_CREATE)({}, "/tmp/ws-demo")) as { hostId: string };
    const second = (await registeredHandler(ipc, IPC_CHANNELS.WORKSPACE_CREATE)({}, "/tmp/ws-demo")) as { hostId: string };

    expect(second.hostId).toBe(first.hostId);
    expect(handles).toHaveLength(1); // no second child was ever spawned
  });

  it("refuses an invalid directory with a clear message and leaves no host, no chat and no state behind", async () => {
    const { ipc, handles, send } = setup({
      routerDeps: { validateDirectory: vi.fn().mockRejectedValue(new Error('"relative/path" is not an absolute path')) },
    });

    await expect(registeredHandler(ipc, IPC_CHANNELS.WORKSPACE_CREATE)({}, "relative/path")).rejects.toThrow(
      /not an absolute path/,
    );

    // Nothing was created: no host, no child, no chat state anywhere.
    expect(handles).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    // And the router is not wedged: a later valid create still mints a host.
    const { ipc: ipc2, handles: handles2 } = setup({ routerDeps: { validateDirectory: vi.fn().mockResolvedValue(undefined) } });
    const created = (await registeredHandler(ipc2, IPC_CHANNELS.WORKSPACE_CREATE)({}, "/tmp/after-refusal")) as { hostId: string };
    expect(created.hostId).toBe("host-1");
    expect(handles2).toHaveLength(1);
  });

  it("a workspace host's pushed states carry its directory, and a host without one carries none", async () => {
    const { ipc, webContents, handles } = setup({ routerDeps: { validateDirectory: vi.fn().mockResolvedValue(undefined) } });

    await registeredHandler(ipc, IPC_CHANNELS.WORKSPACE_CREATE)({}, "/tmp/ws-demo");
    handles[0]!.emitStdout(JSON.stringify({ type: "agent_start" }));
    await vi.waitFor(() => expect(statePushes(webContents).length).toBeGreaterThan(0));
    expect(statePushes(webContents).every((state) => state.workspacePath === "/tmp/ws-demo")).toBe(true);

    // A host minted by chat.new carries no directory: the footer falls back
    // to `~/` instead of inventing a path.
    const fresh = (await registeredHandler(ipc, IPC_CHANNELS.NEW_CHAT)({})) as { hostId: string; state: ChatState };
    expect(fresh.hostId).toBe("host-2");
    expect(fresh.state.workspacePath).toBeUndefined();
  });

  it("workspace.chooseDirectory answers the picker's choice, and null on a cancelled pick, creating nothing", async () => {
    // A cancelled pick: the answer is null and NOTHING is created.
    const cancelled = setup({ routerDeps: { chooseDirectory: vi.fn().mockResolvedValue(null) } });
    await expect(registeredHandler(cancelled.ipc, IPC_CHANNELS.WORKSPACE_CHOOSE_DIRECTORY)({})).resolves.toBeNull();
    expect(cancelled.handles).toHaveLength(0);

    // A real pick passes the chosen absolute path through unchanged.
    const picked = setup({ routerDeps: { chooseDirectory: vi.fn().mockResolvedValue("/tmp/chosen") } });
    await expect(registeredHandler(picked.ipc, IPC_CHANNELS.WORKSPACE_CHOOSE_DIRECTORY)({})).resolves.toBe("/tmp/chosen");
    expect(picked.handles).toHaveLength(0); // choosing alone starts no child
  });
});

// T1 (S1/S2) — the persisted workspace registry channels: the panel's
// list (persisted opened directories), add (validate, then
// persist), remove (close directory owners and remove entry) and open (the creation
// path without the picker). Each of list/add/remove answers the fresh
// WorkspaceList — one explicit re-read per action, no push channel.
describe("workspace registry channels (T1)", () => {
  function fakeWorkspaceRegistry(persisted: string[]): WorkspaceRegistryPort {
    const list = [...persisted];
    return {
      list: vi.fn(() => [...list]),
      add: vi.fn((directory: string) => {
        if (!list.includes(directory)) list.unshift(directory);
        return [...list];
      }),
      remove: vi.fn((directory: string) => {
        const index = list.indexOf(directory);
        if (index >= 0) list.splice(index, 1);
        return [...list];
      }),
    };
  }

  function setup(
    persisted: string[],
    routerDeps: WorkspaceRouterDeps = { validateDirectory: vi.fn().mockResolvedValue(undefined) },
    readWorkspaceBranch?: (directory: string) => string | undefined,
  ): {
    ipc: IpcMain;
    handles: FakeProcessHandle[];
    registry: ReturnType<typeof fakeWorkspaceRegistry>;
  } {
    const { spawner, handles } = createFakeSpawner();
    const store = fakeSessionStore([session({ id: "sess-1", path: "/home/sessions/proj/sess-1.jsonl", cwd: "/tmp/proj" })]);
    const ipc = fakeIpcMain();
    const registry = fakeWorkspaceRegistry(persisted);
    const router = new WorkspaceHostRouter(
      realHostSource(() => ({ spawner, locator: fakeLocator, sessionStore: store, env: {} })),
      routerDeps,
    );
    registerHandlers(router, fakeSetup(), fakeWebContents().webContents, ipc, { workspaces: registry, readWorkspaceBranch });
    return { ipc, handles, registry };
  }

  it("closed navigation survives a config reload even with saved Pi history", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "gentle-workspace-reload-"));
    try {
      const configPath = join(scratch, "config.json");
      const config = createAppConfigStore(configPath);
      config.write({ home: "isolated" });
      config.addWorkspace("/tmp/proj");
      const { spawner, handles } = createFakeSpawner();
      const sessions = [session()];
      const store = fakeSessionStore(sessions);
      const router = new WorkspaceHostRouter(new WorkspaceHostRegistry({ createHostDeps: () => ({ spawner, locator: fakeLocator, sessionStore: store, env: {} }) }));
      const ipc = fakeIpcMain();
      registerHandlers(router, fakeSetup(), fakeWebContents().webContents, ipc, { workspaces: {
        list: () => config.listWorkspaces(),
        add: (directory) => config.addWorkspace(directory).workspaces ?? [],
        remove: (directory) => config.removeWorkspace(directory).workspaces ?? [],
      } });
      await expect(registeredHandler(ipc, IPC_CHANNELS.WORKSPACE_REMOVE)({}, "/tmp/proj")).resolves.toEqual({ directories: [], persisted: [] });
      const reloaded = createAppConfigStore(configPath);
      expect(reloaded.read()).toEqual({ home: "isolated", workspaces: [] });
      expect(await store.listAll()).toEqual(sessions);
      expect(handles).toEqual([]);
      await expect(registeredHandler(ipc, IPC_CHANNELS.WORKSPACE_LIST)({})).resolves.toEqual({ directories: [], persisted: [] });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("workspace.list answers persisted opened directories in registry order", async () => {
    const { ipc } = setup(["/tmp/persisted-a", "/tmp/proj"]);

    await expect(registeredHandler(ipc, IPC_CHANNELS.WORKSPACE_LIST)({})).resolves.toEqual({
      directories: ["/tmp/persisted-a", "/tmp/proj"],
      persisted: ["/tmp/persisted-a", "/tmp/proj"],
    });
  });

  // S-branch: the list carries the branch each directory has checked out, so
  // the panel can show it for EVERY workspace at startup and right after an
  // add — not only for the one whose live child happens to have answered.
  it("workspace.list answers each persisted directory's active branch", async () => {
    const { ipc } = setup(["/tmp/persisted-a", "/tmp/proj"], undefined, (directory) =>
      directory === "/tmp/proj" ? "develop" : undefined,
    );

    await expect(registeredHandler(ipc, IPC_CHANNELS.WORKSPACE_LIST)({})).resolves.toEqual({
      directories: ["/tmp/persisted-a", "/tmp/proj"],
      persisted: ["/tmp/persisted-a", "/tmp/proj"],
      branches: { "/tmp/proj": "develop" },
    });
  });

  it("workspace.add answers the branch of the directory it just persisted", async () => {
    const { ipc } = setup([], undefined, (directory) =>
      directory === "/tmp/added" ? "feature/registry" : undefined,
    );

    await expect(registeredHandler(ipc, IPC_CHANNELS.WORKSPACE_ADD)({}, "/tmp/added")).resolves.toEqual({
      directories: ["/tmp/added"],
      persisted: ["/tmp/added"],
      branches: { "/tmp/added": "feature/registry" },
    });
  });

  it("workspace.list excludes a session directory the registry never persisted", async () => {
    const { ipc } = setup([]);

    await expect(registeredHandler(ipc, IPC_CHANNELS.WORKSPACE_LIST)({})).resolves.toEqual({
      directories: [],
      persisted: [],
    });
  });

  it("workspace.add validates the directory BEFORE persisting: an invalid one is refused and persists nothing", async () => {
    const { ipc, registry, handles } = setup([], {
      validateDirectory: vi.fn().mockRejectedValue(new Error('"relative/path" is not an absolute path')),
    });

    await expect(registeredHandler(ipc, IPC_CHANNELS.WORKSPACE_ADD)({}, "relative/path")).rejects.toThrow(
      /not an absolute path/,
    );
    expect(registry.add).not.toHaveBeenCalled();
    expect(registry.list()).toEqual([]);
    expect(handles).toHaveLength(0); // nothing was created either
  });

  it("workspace.add persists a valid directory and answers the fresh list including it", async () => {
    const { ipc, registry } = setup([]);

    const answer = (await registeredHandler(ipc, IPC_CHANNELS.WORKSPACE_ADD)({}, "/tmp/added")) as {
      directories: readonly string[];
      persisted: readonly string[];
    };

    expect(registry.add).toHaveBeenCalledWith("/tmp/added");
    // A persisted directory with no chat yet is still a row (S1): it is
    // listed even though pi has no session for it.
    expect(answer.persisted).toEqual(["/tmp/added"]);
    expect(answer.directories).toEqual(["/tmp/added"]);
  });

  it("workspace.remove removes navigation without starting a history host", async () => {
    const { ipc, handles } = setup(["/tmp/persisted"]);

    const answer = (await registeredHandler(ipc, IPC_CHANNELS.WORKSPACE_REMOVE)({}, "/tmp/persisted")) as {
      directories: readonly string[];
      persisted: readonly string[];
    };

    expect(answer.persisted).toEqual([]);
    // Saved history is not opened navigation.
    expect(answer.directories).toEqual([]);
    expect(handles).toHaveLength(0); // no child was spawned or stopped
  });

  it("workspace.remove leaves saved history out of the opened list", async () => {
    const { ipc } = setup([]);

    const answer = (await registeredHandler(ipc, IPC_CHANNELS.WORKSPACE_REMOVE)({}, "/tmp/proj")) as {
      directories: readonly string[];
      persisted: readonly string[];
    };

    expect(answer.persisted).toEqual([]);
    expect(answer.directories).toEqual([]);
  });

  it("workspace.open is the creation path without the picker: validates, spawns the host with that directory as cwd", async () => {
    const { ipc, handles } = setup([]);

    const opened = (await registeredHandler(ipc, IPC_CHANNELS.WORKSPACE_OPEN)({}, "/tmp/opened")) as {
      hostId: string;
      state: ChatState;
    };

    expect(opened.hostId).toBe("host-1");
    expect(handles).toHaveLength(1);
    expect(handles[0]!.cwd).toBe("/tmp/opened");
    expect(opened.state.workspacePath).toBe("/tmp/opened");
  });

  it("the registry channels refuse clearly when no registry is configured", async () => {
    const { spawner } = createFakeSpawner();
    const store = fakeSessionStore([]);
    const ipc = fakeIpcMain();
    const router = new WorkspaceHostRouter(
      realHostSource(() => ({ spawner, locator: fakeLocator, sessionStore: store, env: {} })),
    );
    registerHandlers(router, fakeSetup(), fakeWebContents().webContents, ipc);

    await expect(registeredHandler(ipc, IPC_CHANNELS.WORKSPACE_LIST)({})).rejects.toThrow(/workspace registry is unavailable/);
    await expect(registeredHandler(ipc, IPC_CHANNELS.WORKSPACE_ADD)({}, "/tmp/a")).rejects.toThrow(/workspace registry is unavailable/);
    await expect(registeredHandler(ipc, IPC_CHANNELS.WORKSPACE_REMOVE)({}, "/tmp/a")).rejects.toThrow(/workspace registry is unavailable/);
  });
});

// T11 — the concrete validator over node:fs, exercised against a REAL
// scratch directory outside the repository (created and removed by the
// test): these are the refusals the spec names — relative path, missing
// path, a file, an unreadable directory — each with its clear message.
describe("validateWorkspaceDirectory (T11)", () => {
  let scratch: string | undefined;

  function createScratchDirectory(): string {
    return mkdtempSync(join(tmpdir(), "gentle-ws-validate-"));
  }

  afterEach(() => {
    if (scratch === undefined) return;
    // Make sure the directory is removable even after the unreadable case.
    try {
      chmodSync(scratch, 0o700);
    } catch {
      // already gone
    }
    rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  it("accepts a readable directory", async () => {
    scratch = createScratchDirectory();
    await expect(validateWorkspaceDirectory(scratch)).resolves.toBeUndefined();
  });

  it("refuses a relative path", async () => {
    await expect(validateWorkspaceDirectory("relative/path")).rejects.toThrow(/not an absolute path/);
  });

  it("refuses a path that does not exist", async () => {
    await expect(validateWorkspaceDirectory(join(tmpdir(), "gentle-ws-does-not-exist"))).rejects.toThrow(
      /does not exist or cannot be read/,
    );
  });

  it("refuses a file that is not a directory", async () => {
    scratch = createScratchDirectory();
    const filePath = join(scratch, "a-file.txt");
    writeFileSync(filePath, "not a directory");
    await expect(validateWorkspaceDirectory(filePath)).rejects.toThrow(/is not a directory/);
  });

  it("refuses an unreadable directory", async () => {
    scratch = createScratchDirectory();
    chmodSync(scratch, 0o000);
    try {
      await expect(validateWorkspaceDirectory(scratch)).rejects.toThrow(/is not readable/);
    } finally {
      chmodSync(scratch, 0o700); // so afterEach can remove it
    }
  });
});

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

  // palette-host-catalog T3 (S4): the ONE execution channel for runnable
  // catalog rows, addressed by host id like every other chat.* request and
  // resolving refusals instead of rejecting them.
  it("registers chat.runCommand, routing (host id, name, args?) to that host's runCommand, refusals resolving", async () => {
    const ipc = fakeIpcMain();
    const host = fakeHost({
      runCommand: vi.fn()
        .mockResolvedValueOnce({ kind: "executed" })
        .mockResolvedValueOnce({ kind: "refused", reason: "terminal_only" }),
    });

    registerHandlers(new WorkspaceHostRouter(fakeHostSource(host)), fakeSetup(), fakeWebContents().webContents, ipc);

    const runHandler = registeredHandler(ipc, "chat.runCommand");
    await expect(runHandler({} as never, "host-1", "compact")).resolves.toEqual({ kind: "executed" });
    expect(host.runCommand).toHaveBeenCalledWith("compact", undefined);
    await expect(runHandler({} as never, "host-1", "fork", undefined)).resolves.toEqual({ kind: "refused", reason: "terminal_only" });
  });

  it("passes the /resume picker's session path through chat.runCommand as args (S5)", async () => {
    const ipc = fakeIpcMain();
    const host = fakeHost({ runCommand: vi.fn().mockResolvedValue({ kind: "executed" }) });

    registerHandlers(new WorkspaceHostRouter(fakeHostSource(host)), fakeSetup(), fakeWebContents().webContents, ipc);

    const runHandler = registeredHandler(ipc, "chat.runCommand");
    await expect(runHandler({} as never, "host-1", "resume", "/tmp/sess-1.jsonl")).resolves.toEqual({ kind: "executed" });
    expect(host.runCommand).toHaveBeenCalledWith("resume", "/tmp/sess-1.jsonl");
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
  /** The cwd the spawn was asked for (T11): the workspace directory the
   * child must run in, recorded from the spawner's fourth argument. */
  readonly cwd: string | undefined;
  readonly writes: string[];
  emitStdout(line: string): void;
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
  function setup(overrides: { sessions?: readonly SessionInfoLike[]; routerDeps?: WorkspaceRouterDeps } = {}): {
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
      overrides.routerDeps,
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
      createHost: (cwd?: string) => {
        const created = fakeHost({
          hostId: `host-${nextNumber++}`,
          cwd,
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
      findByDirectory: (directory: string) => [...byId.values()].find((host) => host.cwd === directory),
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
      createHost: (cwd?: string) => {
        const created = fakeHost({
          hostId: `host-${nextNumber++}`,
          cwd,
          newChat: vi.fn().mockRejectedValue(new Error("spawn failed")),
          onState: vi.fn((listener: (state: ChatState, hostId: string) => void) => {
            emitState = listener;
            return unsubscribeState;
          }),
        });
        byId.set(created.hostId, created);
        return created;
      },
      findByDirectory: (directory: string) => [...byId.values()].find((host) => host.cwd === directory),
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

  // ---------------------------------------------------------------------------
  // T5d — lifecycle: chat.close stops exactly its own host, quit stops every
  // remaining one, and a closed host is never resurrected or double-stopped.
  // ---------------------------------------------------------------------------

/** Closes one host through the chat.close handler, resolving the child's
 * exit the way a real child only exits because its stdin was ended (same
 * pattern as the chat.open reuse test above). */
async function closeHostThroughIpc(
  close: (...args: unknown[]) => unknown,
  handles: readonly FakeProcessHandle[],
  events: string[],
  hostId: string,
  childIndex: number,
): Promise<void> {
  const closing = close({}, hostId);
  await vi.waitFor(() => expect(events.filter((event) => event === `endStdin:${childIndex}`)).toHaveLength(1));
  handles[childIndex]!.resolveExited({ code: 0, signal: null });
  await closing;
}

describe("workspace host lifecycle (T5d)", () => {
  it("chat.close stops exactly the addressed host's child; the other live host keeps running and still receives its requests", async () => {
    const { ipc, handles, events } = setup({
      sessions: [
        session({ id: "sess-1", path: "/home/sessions/proj/sess-1.jsonl" }),
        session({ id: "sess-2", path: "/home/sessions/proj/sess-2.jsonl" }),
      ],
    });
    await openLiveChat(ipc, handles, "sess-1", 0);
    await openLiveChat(ipc, handles, "sess-2", 1);
    expect(handles).toHaveLength(2); // both hosts live at once

    await closeHostThroughIpc(registeredHandler(ipc, IPC_CHANNELS.CLOSE_CHAT), handles, events, "host-1", 0);

    // host-1 is gone: a request addressed to it is refused, never routed to host-2.
    await expect(registeredHandler(ipc, IPC_CHANNELS.SEND_MESSAGE)({}, "host-1", "hello A")).rejects.toThrow(
      /No live workspace host/,
    );

    // host-2 keeps running and still receives its requests.
    await expect(registeredHandler(ipc, IPC_CHANNELS.SEND_MESSAGE)({}, "host-2", "hello B")).resolves.toEqual({ queued: true });
    expect(handles[1]!.writes.some((write) => write.includes('"message":"hello B"'))).toBe(true);
    // Nothing addressed to host-2 (or anything else) ever reached host-1's child.
    expect(handles[0]!.writes.some((write) => write.includes("hello"))).toBe(false);
  });

  it("chat.close of an unknown or already-stopped host id is refused and reaches no child", async () => {
    const { ipc, handles, events } = setup();
    await openLiveChat(ipc, handles, "sess-1", 0);
    const writesBefore = handles[0]!.writes.length;

    // Unknown id: refused before any child is touched.
    await expect(registeredHandler(ipc, IPC_CHANNELS.CLOSE_CHAT)({}, "host-999")).rejects.toThrow(/No live workspace host/);
    expect(handles[0]!.writes.length).toBe(writesBefore);

    // Already-stopped id: refused too, and the stopped host is never stopped twice.
    await closeHostThroughIpc(registeredHandler(ipc, IPC_CHANNELS.CLOSE_CHAT), handles, events, "host-1", 0);
    const writesAfterClose = handles[0]!.writes.length;
    await expect(registeredHandler(ipc, IPC_CHANNELS.CLOSE_CHAT)({}, "host-1")).rejects.toThrow(/No live workspace host/);
    expect(events.filter((event) => event === "endStdin:0")).toHaveLength(1);
    expect(handles[0]!.writes.length).toBe(writesAfterClose);
  });

  it("a successful close reports the closed host's id through the chat.closed push", async () => {
    const { ipc, send, handles, events } = setup();
    await openLiveChat(ipc, handles, "sess-1", 0);

    await closeHostThroughIpc(registeredHandler(ipc, IPC_CHANNELS.CLOSE_CHAT), handles, events, "host-1", 0);

    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.CLOSED_PUSH, "host-1");
  });

  it("chat.open of a chat owned by a closed host mints a fresh host instead of resurrecting the closed one", async () => {
    const { ipc, handles, events } = setup();
    await openLiveChat(ipc, handles, "sess-1", 0);
    await closeHostThroughIpc(registeredHandler(ipc, IPC_CHANNELS.CLOSE_CHAT), handles, events, "host-1", 0);

    const reopened = (await openLiveChat(ipc, handles, "sess-1", 1)) as { hostId: string };
    expect(reopened.hostId).toBe("host-2"); // never host-1 again
  });

  it("app quit (registry.stopAll) stops every remaining host and never double-stops or resurrects a closed one", async () => {
    const { spawner, handles, events } = createFakeSpawner();
    const store = fakeSessionStore([
      session({ id: "sess-1", path: "/home/sessions/proj/sess-1.jsonl" }),
      session({ id: "sess-2", path: "/home/sessions/proj/sess-2.jsonl" }),
    ]);
    const ipc = fakeIpcMain();
    const { webContents } = fakeWebContents();
    // The REAL registry — the same object src/main/index.ts passes to the
    // router and whose stopAll() app quit awaits — so this exercises the
    // actual quit path over close, not a stand-in for either.
    const registry = new WorkspaceHostRegistry({ createHostDeps: () => ({ spawner, locator: fakeLocator, sessionStore: store, env: {} }) });
    registerHandlers(new WorkspaceHostRouter(registry), fakeSetup(), webContents, ipc);

    await openLiveChat(ipc, handles, "sess-1", 0);
    await openLiveChat(ipc, handles, "sess-2", 1);
    await closeHostThroughIpc(registeredHandler(ipc, IPC_CHANNELS.CLOSE_CHAT), handles, events, "host-1", 0);

    const quitting = registry.stopAll();
    await vi.waitFor(() => expect(events).toContain("endStdin:1"));
    handles[1]!.resolveExited({ code: 0, signal: null });
    await quitting;

    // host-2's child was stopped by quit; host-1's was stopped exactly once
    // (by its own close) and was neither stopped again nor brought back.
    expect(events).toContain("endStdin:1");
    expect(events.filter((event) => event === "endStdin:0")).toHaveLength(1);
    expect(registry.get("host-1")).toBeUndefined();
    expect(registry.get("host-2")).toBeUndefined();
    });
  });
});
