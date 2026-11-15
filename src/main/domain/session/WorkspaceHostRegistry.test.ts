import { describe, expect, it } from "vitest";
import type { LauncherLocator, ProcessSpawner, SpawnedProcess } from "../../ports";
import type { ChatHostDeps } from "./ChatHost";
import { WorkspaceHostRegistry } from "./WorkspaceHostRegistry";

/**
 * Minimal fake ProcessSpawner for registry-level tests: each host gets its
 * own spawner (created inside the test's createHostDeps factory), so every
 * host's child handle is unambiguously its own. Records the writes each
 * child received, whether its stdin was ended and whether it was killed,
 * and lets the test emit stdout lines and resolve the child's exit.
 */
interface FakeChildHandle {
  readonly writes: string[];
  endStdinCalled: boolean;
  killCalled: boolean;
  emitStdout(line: string): void;
  resolveExited(): void;
}

function createFakeSpawner(): { spawner: ProcessSpawner; handles: FakeChildHandle[] } {
  const handles: FakeChildHandle[] = [];

  const spawner: ProcessSpawner = {
    spawn(): SpawnedProcess {
      const stdoutHandlers: Array<(line: string) => void> = [];
      const writes: string[] = [];
      let resolveExitedFn: () => void = () => undefined;
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        resolveExitedFn = () => resolve({ code: 0, signal: null });
      });

      const handle: FakeChildHandle = {
        writes,
        endStdinCalled: false,
        killCalled: false,
        emitStdout(line) {
          for (const handler of stdoutHandlers) handler(line);
        },
        resolveExited() {
          resolveExitedFn();
        },
      };
      handles.push(handle);

      return {
        exited,
        writeStdin(text: string) {
          writes.push(text);
        },
        endStdin() {
          handle.endStdinCalled = true;
        },
        onStdoutLine(handler) {
          stdoutHandlers.push(handler);
        },
        onStderrLine() {},
        onError() {},
        kill() {
          handle.killCalled = true;
        },
      };
    },
  };

  return { spawner, handles };
}

const fakeLocator: LauncherLocator = { locate: () => ({ command: "fake-gentle-shell", args: [] }) };

interface HostFixture {
  readonly handles: FakeChildHandle[];
}

/**
 * A registry whose every host owns a fresh fake spawner: `hosts[i]` holds
 * the handles of the i-th created host's children, so a test can address
 * "host A's child" and "host B's child" without guessing.
 */
function createRegistry(): { registry: WorkspaceHostRegistry; hosts: HostFixture[] } {
  const hosts: HostFixture[] = [];
  const registry = new WorkspaceHostRegistry({
    createHostDeps: (): ChatHostDeps => {
      const { spawner, handles } = createFakeSpawner();
      hosts.push({ handles });
      return { spawner, locator: fakeLocator, sessionStore: { listAll: () => Promise.resolve([]) }, env: {} };
    },
  });
  return { registry, hosts };
}

describe("WorkspaceHostRegistry", () => {
  it("holds two hosts alive at once, each with its own child process", async () => {
    const { registry, hosts } = createRegistry();

    const a = registry.createHost();
    const b = registry.createHost();
    await a.newChat();
    await b.newChat();

    expect(hosts).toHaveLength(2);
    expect(hosts[0]?.handles).toHaveLength(1);
    expect(hosts[1]?.handles).toHaveLength(1);
    // Both children are still live: neither stdin was ended.
    expect(hosts[0]?.handles[0]?.endStdinCalled).toBe(false);
    expect(hosts[1]?.handles[0]?.endStdinCalled).toBe(false);
  });

  it("mints unique, stable, opaque host ids (a counter, never a reused id)", () => {
    const { registry } = createRegistry();

    const a = registry.createHost();
    const b = registry.createHost();

    expect(a.hostId).toBe("host-1");
    expect(b.hostId).toBe("host-2");
    expect(b.hostId).not.toBe(a.hostId);
    // Stable: the id a host reports does not change over time.
    expect(a.hostId).toBe(registry.get("host-1")?.hostId);
  });

  it("never reuses a stopped host's id for a different live host, and stops removing it from the registry", () => {
    const { registry } = createRegistry();

    registry.createHost();
    registry.createHost();
    void registry.stopHost("host-1");

    expect(registry.get("host-1")).toBeUndefined();
    const c = registry.createHost();
    expect(c.hostId).toBe("host-3");
    expect(registry.get("host-3")).toBe(c);
    expect(registry.get("host-1")).toBeUndefined();
  });

  it("routes a state event only to the host that owns the child that emitted it", async () => {
    const { registry, hosts } = createRegistry();
    const a = registry.createHost();
    const b = registry.createHost();

    const statesA: string[] = [];
    const statesB: string[] = [];
    a.onState((_state, hostId) => statesA.push(hostId));
    b.onState((_state, hostId) => statesB.push(hostId));

    await a.newChat();
    await b.newChat();

    // A state event from host A's child reaches A's listener only.
    hosts[0]?.handles[0]?.emitStdout(JSON.stringify({ type: "agent_start" }));
    expect(statesA.length).toBeGreaterThan(0);
    expect(statesA.every((hostId) => hostId === "host-1")).toBe(true);
    expect(statesB).toEqual([]);

    // And one from host B's child reaches B's listener only.
    hosts[1]?.handles[0]?.emitStdout(JSON.stringify({ type: "agent_start" }));
    expect(statesB.length).toBeGreaterThan(0);
    expect(statesB.every((hostId) => hostId === "host-2")).toBe(true);
  });

  it("stopping one host stops only that host's child and leaves the other running", async () => {
    const { registry, hosts } = createRegistry();
    const a = registry.createHost();
    const b = registry.createHost();

    const stillAlive: string[] = [];
    b.onState((_state, hostId) => stillAlive.push(hostId));

    await a.newChat();
    await b.newChat();

    const childA = hosts[0]?.handles[0];
    const childB = hosts[1]?.handles[0];
    if (!childA || !childB) throw new Error("expected one spawned child per host");

    const stopping = registry.stopHost("host-1");
    childA.resolveExited(); // PiSession.stop() waits for the child to exit (3s grace)
    await stopping;

    expect(childA.endStdinCalled).toBe(true);
    expect(childB.endStdinCalled).toBe(false);
    expect(childB.killCalled).toBe(false);

    // Host B is still a live, working host: its child is still talking to it.
    childB.emitStdout(JSON.stringify({ type: "agent_start" }));
    expect(stillAlive.length).toBeGreaterThan(0);
    expect(stillAlive.every((hostId) => hostId === "host-2")).toBe(true);
    expect(registry.list()).toEqual([b]);
  });

  it("stopHost rejects for an id no live host owns (never falls back to another child)", async () => {
    const { registry } = createRegistry();

    await expect(registry.stopHost("host-1")).rejects.toThrow(/no host for id/i);
  });

  // T11 — the workspace directory: createHost takes it, the host reports
  // it, and findByDirectory resolves the live host that owns a directory —
  // which is how "a directory that is already open selects the existing
  // workspace instead of starting a second child for it" resolves.
  it("createHost accepts the workspace directory, the host reports it, and findByDirectory resolves it (T11)", () => {
    const { registry } = createRegistry();

    const a = registry.createHost("/tmp/ws-a");
    const b = registry.createHost("/tmp/ws-b");
    const bare = registry.createHost(); // no directory: must never match a lookup

    expect(a.cwd).toBe("/tmp/ws-a");
    expect(b.cwd).toBe("/tmp/ws-b");
    expect(bare.cwd).toBeUndefined();
    expect(registry.findByDirectory("/tmp/ws-a")).toBe(a);
    expect(registry.findByDirectory("/tmp/ws-b")).toBe(b);
    expect(registry.findByDirectory("/tmp/other")).toBeUndefined();
  });

  it("findByDirectory never returns a stopped host, so the directory is free again (T11)", async () => {
    const { registry, hosts } = createRegistry();

    const a = registry.createHost("/tmp/ws-a");
    await a.newChat();
    // stopHost's stop() waits for the child to exit (or its 3s grace); the
    // fake child only exits when the test resolves it, as in the tests above.
    const stopping = registry.stopHost(a.hostId);
    hosts[0]?.handles[0]?.resolveExited();
    await stopping;

    expect(registry.findByDirectory("/tmp/ws-a")).toBeUndefined();
  });

  it("stop-all stops every host's child and empties the registry", async () => {
    const { registry, hosts } = createRegistry();
    const a = registry.createHost();
    const b = registry.createHost();
    const c = registry.createHost();
    await a.newChat();
    await b.newChat();
    await c.newChat();

    const stopping = registry.stopAll();
    for (const host of hosts) {
      for (const handle of host.handles) handle.resolveExited();
    }
    await stopping;

    expect(hosts).toHaveLength(3);
    for (const host of hosts) {
      expect(host.handles[0]?.endStdinCalled).toBe(true);
    }
    expect(registry.list()).toEqual([]);
  });

  it("stopAll resolves even with no hosts at all (quit path with nothing open)", async () => {
    const { registry } = createRegistry();

    await expect(registry.stopAll()).resolves.toBeUndefined();
  });

  it("get returns the created host for its id and undefined for an unknown id", () => {
    const { registry } = createRegistry();

    const a = registry.createHost();
    const b = registry.createHost();

    expect(registry.get("host-1")).toBe(a);
    expect(registry.get("host-2")).toBe(b);
    expect(registry.get("host-3")).toBeUndefined();
    expect(registry.list()).toEqual([a, b]);
  });
});
