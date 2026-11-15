import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_STATE, type ChatState } from "@shared/bridge-types";
import { mockBridge, resetMockBridge } from "./mockBridge";

function collectStates(): { states: ChatState[]; errors: string[] } {
  const states: ChatState[] = [];
  const errors: string[] = [];
  mockBridge.onState((state) => states.push(state));
  mockBridge.onError((message) => errors.push(message));
  return { states, errors };
}

describe("mockBridge", () => {
  // resetMockBridge (not just newChat()) so homeChoice, listener sets and
  // id counters never leak between tests — see its doc comment.
  beforeEach(() => {
    resetMockBridge();
  });

  // Ordered deliberately before the "needsChoice: true" test below: with
  // module state reset between tests (resetMockBridge in beforeEach), the
  // two must not depend on running in file order — a rerun with only this
  // test, or the suite in reverse, must see the same fresh homeChoice.
  it("chooseHome persists the choice: a later setupStatus() reports needsChoice: false", async () => {
    await mockBridge.chooseHome("link");

    const status = await mockBridge.setupStatus();

    expect(status.needsChoice).toBe(false);
  });

  it("setupStatus() starts with needsChoice: true and a fake pi detection, so the first-run screen is reachable in the browser preview", async () => {
    const status = await mockBridge.setupStatus();

    expect(status.needsChoice).toBe(true);
    expect(status.detection).toMatchObject({ found: true, hasAuth: true, hasModels: true });
  });

  it("lists two example chats plus one already-working chat", async () => {
    const chats = await mockBridge.listChats();

    expect(chats).toHaveLength(3);
    expect(chats.filter((chat) => chat.state === CHAT_STATE.WORKING)).toHaveLength(1);
  });

  it('opens a select dialog for a message containing "?"', async () => {
    const { states } = collectStates();
    const { hostId } = await mockBridge.newChat();

    await mockBridge.sendMessage(hostId, "Which branch?");

    const withDialog = states.find((state) => state.pendingDialogs.length > 0);
    expect(withDialog?.pendingDialogs[0]).toMatchObject({ method: "select" });
    expect(withDialog?.working).toBe(true);
  });

  it('opens a confirm dialog for a message containing "delete"', async () => {
    const { states } = collectStates();
    const { hostId } = await mockBridge.newChat();

    await mockBridge.sendMessage(hostId, "please delete the branch");

    const withDialog = states.find((state) => state.pendingDialogs.length > 0);
    expect(withDialog?.pendingDialogs[0]).toMatchObject({ method: "confirm" });
  });

  it('opens an input dialog for a message containing "name"', async () => {
    const { states } = collectStates();
    const { hostId } = await mockBridge.newChat();

    await mockBridge.sendMessage(hostId, "what is your name");

    const withDialog = states.find((state) => state.pendingDialogs.length > 0);
    expect(withDialog?.pendingDialogs[0]).toMatchObject({ method: "input" });
  });

  it('surfaces an error through onError for a message containing "fail"', async () => {
    const { states, errors } = collectStates();
    const { hostId } = await mockBridge.newChat();

    await mockBridge.sendMessage(hostId, "make this fail please");

    expect(errors).toHaveLength(1);
    expect(states.every((state) => state.pendingDialogs.length === 0)).toBe(true);
  });

  it("answering a dialog clears it and resolves back to not working", async () => {
    const { states } = collectStates();
    const { hostId } = await mockBridge.newChat();

    await mockBridge.sendMessage(hostId, "Which branch?");
    const dialog = states.find((state) => state.pendingDialogs.length > 0)?.pendingDialogs[0];
    expect(dialog).toBeDefined();

    await mockBridge.answerDialog(hostId, dialog!.id, { value: "main" });

    const final = states.at(-1);
    expect(final?.pendingDialogs).toHaveLength(0);
    expect(final?.working).toBe(false);
  });

  it('resolves { queued: false, reason } instead of notifying onError while already working (report once)', async () => {
    const { errors } = collectStates();
    const { hostId } = await mockBridge.newChat();

    await mockBridge.sendMessage(hostId, "Which branch?"); // opens a dialog, leaves working: true
    const result = await mockBridge.sendMessage(hostId, "another message");

    expect(result).toEqual({ queued: false, reason: "Gentle is still working" });
    expect(errors).toHaveLength(0);
  });

  it("streams a plain reply word by word for an ordinary message", async () => {
    const { states } = collectStates();
    const { hostId } = await mockBridge.newChat();

    await mockBridge.sendMessage(hostId, "hello Gentle");
    await vi.waitFor(() => expect(states.at(-1)?.working).toBe(false));

    expect(states.at(-1)?.messages.at(-1)?.text).toContain("hello Gentle");
  });

  it("openChat reuses the host id of an already-open chat; newChat mints a distinct one", async () => {
    const first = await mockBridge.openChat("chat-readme");
    const again = await mockBridge.openChat("chat-readme");
    const other = await mockBridge.newChat();

    expect(first.hostId).toMatch(/^mock-host-/);
    expect(again.hostId).toBe(first.hostId);
    expect(other.hostId).toMatch(/^mock-host-/);
    expect(other.hostId).not.toBe(first.hostId);
  });

  it("rejects a request whose host id is unknown or no longer current, and mutates no state", async () => {
    const { states } = collectStates();

    await expect(mockBridge.sendMessage("mock-host-999", "hello")).rejects.toThrow(/No live workspace host/);
    await expect(mockBridge.abort("mock-host-999")).rejects.toThrow(/No live workspace host/);
    await expect(mockBridge.answerDialog("mock-host-999", "dlg-1", { confirmed: true })).rejects.toThrow(/No live workspace host/);
    await expect(mockBridge.stopHelper?.("mock-host-999", "helper-1")).rejects.toThrow(/No live workspace host/);

    // Nothing was routed to the one live host either: no state change, no
    // fallback to whichever chat is open.
    expect(states).toHaveLength(0);
  });

  // T5c — the mock implements the same chat.refresh contract as the real
  // bridge: the addressed host's current state, without any restart, and a
  // clear refusal for an id no live host owns.
  it("refreshChat answers the current host's state without pushing anything new, and refuses an unknown host id", async () => {
    const { states } = collectStates();
    const { hostId } = await mockBridge.newChat();
    await mockBridge.sendMessage(hostId, "hello refresh");
    const pushesBefore = states.length;

    // refreshChat is optional on the interface (both real bridges implement
    // it); guard the optional call instead of asserting non-null.
    const refresh = mockBridge.refreshChat?.bind(mockBridge);
    if (!refresh) throw new Error("mockBridge did not implement refreshChat");

    const refreshed = await refresh(hostId);
    expect(refreshed.hostId).toBe(hostId);
    expect(refreshed.messages.some((message) => message.role === "user" && message.text === "hello refresh")).toBe(true);
    // A refresh is a read, not a round-trip: no extra state push.
    expect(states.length).toBe(pushesBefore);

    await expect(mockBridge.refreshChat?.("mock-host-999")).rejects.toThrow(/No live workspace host/);
  });

  it("tags every pushed state, every dialog and every error push with the emitting host id", async () => {
    const states: ChatState[] = [];
    const errorPushes: Array<{ message: string; hostId: string }> = [];
    mockBridge.onState((state) => states.push(state));
    mockBridge.onError((message, hostId) => errorPushes.push({ message, hostId }));
    const { hostId } = await mockBridge.newChat();

    expect(hostId).toMatch(/^mock-host-/);

    await mockBridge.sendMessage(hostId, "Which branch?");
    const withDialog = states.find((state) => state.pendingDialogs.length > 0);
    expect(withDialog?.hostId).toBe(hostId);
    expect(withDialog?.pendingDialogs[0]?.hostId).toBe(hostId);

    // The pending dialog keeps that host "working", so the fail-path send
    // runs on a freshly opened chat — whose error push must carry ITS host
    // id, not the previous one's.
    const { hostId: failHostId } = await mockBridge.openChat("chat-readme");
    await mockBridge.sendMessage(failHostId, "make this fail please");
    expect(errorPushes.at(-1)).toEqual({ message: expect.stringContaining("Mock error"), hostId: failHostId });
  });

  // D4: the "Migrate the config schema" working chat (chat-migration) seeds
  // five helpers so the Helpers tab is reachable under `pnpm dev:web`
  // without a real gentle-agents process — including two already finished
  // days ago, so the "Earlier" group (format.ts's partitionHelpers) has
  // something to show in the preview.
  describe("helpers scenario (chat-migration)", () => {
    it("seeds five helper tasks (running, waiting, done, and two earlier-finished) with a matching summary when opened", async () => {
      const { state } = await mockBridge.openChat("chat-migration");

      expect(state.helpers.tasks).toHaveLength(5);
      expect(state.helpers.tasks.map((task) => task.status).sort()).toEqual(["done", "done", "failed", "running", "waiting"]);
      expect(state.helpers.summary).toEqual({ running: 1, queued: 0, waiting: 1, finished: 3 });
    });

    it("leaves helpers empty for any other chat", async () => {
      const { state } = await mockBridge.openChat("chat-readme");
      expect(state.helpers).toEqual({ summary: { running: 0, queued: 0, waiting: 0, finished: 0 }, tasks: [] });
    });

    it("grows the running task's thread over time", async () => {
      vi.useFakeTimers();
      try {
        const { states } = collectStates();
        await mockBridge.openChat("chat-migration");

        const runningTask = () => states.at(-1)?.helpers.tasks.find((task) => task.status === "running");
        expect(runningTask()?.thread.items).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(800);
        expect(runningTask()?.thread.items.length).toBeGreaterThan(0);

        const afterOneStep = runningTask()?.thread.items.length ?? 0;
        await vi.advanceTimersByTimeAsync(800);
        expect(runningTask()?.thread.items.length ?? 0).toBeGreaterThan(afterOneStep);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops growing the previous chat's thread once a different chat is opened", async () => {
      vi.useFakeTimers();
      try {
        const { states } = collectStates();
        await mockBridge.openChat("chat-migration");
        await vi.advanceTimersByTimeAsync(800);

        await mockBridge.openChat("chat-readme");
        const countAfterSwitch = states.length;

        await vi.advanceTimersByTimeAsync(5000);
        expect(states.length).toBe(countAfterSwitch);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
