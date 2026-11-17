import { describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import { createBridge, type RendererIpc } from "./bridge";

type Listener = (event: unknown, ...args: unknown[]) => void;

function createFakeIpc(): { ipc: RendererIpc; invoke: ReturnType<typeof vi.fn>; listeners: Map<string, Listener[]> } {
  const invoke = vi.fn().mockResolvedValue(undefined);
  const listeners = new Map<string, Listener[]>();

  const ipc: RendererIpc = {
    invoke,
    on(channel, listener) {
      const list = listeners.get(channel) ?? [];
      list.push(listener);
      listeners.set(channel, list);
    },
    removeListener(channel, listener) {
      const list = listeners.get(channel);
      if (!list) return;
      listeners.set(
        channel,
        list.filter((registered) => registered !== listener),
      );
    },
  };

  return { ipc, invoke, listeners };
}

describe("createBridge", () => {
  it("listChats invokes the sessions.list channel with no payload", async () => {
    const { ipc, invoke } = createFakeIpc();
    invoke.mockResolvedValue([{ id: "chat-1" }]);
    const bridge = createBridge(ipc);

    await expect(bridge.listChats()).resolves.toEqual([{ id: "chat-1" }]);
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.LIST_CHATS);
  });

  it("openChat invokes chat.open with the chat id", async () => {
    const { ipc, invoke } = createFakeIpc();
    const bridge = createBridge(ipc);

    await bridge.openChat("chat-1");

    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.OPEN_CHAT, "chat-1");
  });

  it("newChat invokes chat.new with no payload", async () => {
    const { ipc, invoke } = createFakeIpc();
    const bridge = createBridge(ipc);

    await bridge.newChat();

    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.NEW_CHAT);
  });

  it("sendMessage invokes chat.send with the host id first and the text (T5b)", async () => {
    const { ipc, invoke } = createFakeIpc();
    const bridge = createBridge(ipc);

    await bridge.sendMessage("host-1", "hello");

    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.SEND_MESSAGE, "host-1", "hello");
  });

  it("abort invokes chat.abort with the host id (T5b)", async () => {
    const { ipc, invoke } = createFakeIpc();
    const bridge = createBridge(ipc);

    await bridge.abort("host-1");

    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.ABORT, "host-1");
  });

  it("answerDialog invokes dialog.answer with the host id, the id and the answer (T5b)", async () => {
    const { ipc, invoke } = createFakeIpc();
    const bridge = createBridge(ipc);

    await bridge.answerDialog("host-1", "dlg-1", { value: "A" });

    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.ANSWER_DIALOG, "host-1", "dlg-1", { value: "A" });
  });

  it("stopHelper invokes helpers.stop with the host id and the helper id (desktop-rpc T6, T5b)", async () => {
    const { ipc, invoke } = createFakeIpc();
    invoke.mockResolvedValue("requested");
    const bridge = createBridge(ipc);

    // stopHelper is optional on the interface (both real bridges implement
    // it); guard the optional call instead of asserting non-null.
    const stop = bridge.stopHelper?.bind(bridge);
    if (!stop) throw new Error("createBridge did not implement stopHelper");

    await expect(stop("host-1", "m3a1-worker")).resolves.toBe("requested");
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.STOP_HELPER, "host-1", "m3a1-worker");
  });

  it("refreshChat invokes chat.refresh with the host id (T5c)", async () => {
    const { ipc, invoke } = createFakeIpc();
    invoke.mockResolvedValue({ messages: [] });
    const bridge = createBridge(ipc);

    // refreshChat is optional on the interface (both real bridges implement
    // it); guard the optional call instead of asserting non-null.
    const refresh = bridge.refreshChat?.bind(bridge);
    if (!refresh) throw new Error("createBridge did not implement refreshChat");

    await expect(refresh("host-1")).resolves.toEqual({ messages: [] });
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.REFRESH_CHAT, "host-1");
  });

  it("closeChat invokes chat.close with the host id (T5d)", async () => {
    const { ipc, invoke } = createFakeIpc();
    const bridge = createBridge(ipc);

    // closeChat is optional on the interface (both real bridges implement
    // it); guard the optional call instead of asserting non-null.
    const close = bridge.closeChat?.bind(bridge);
    if (!close) throw new Error("createBridge did not implement closeChat");

    await expect(close("host-1")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.CLOSE_CHAT, "host-1");
  });

  // T11 — Add workspace: the renderer asks main to open the native picker
  // and, with the chosen directory, to create the workspace.
  it("chooseDirectory invokes workspace.chooseDirectory and answers the chosen path (T11)", async () => {
    const { ipc, invoke } = createFakeIpc();
    invoke.mockResolvedValue("/tmp/chosen");
    const bridge = createBridge(ipc);

    // chooseDirectory is optional on the interface (both real bridges
    // implement it); guard the optional call instead of asserting non-null.
    const pick = bridge.chooseDirectory?.bind(bridge);
    if (!pick) throw new Error("createBridge did not implement chooseDirectory");

    await expect(pick()).resolves.toBe("/tmp/chosen");
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.WORKSPACE_CHOOSE_DIRECTORY);
  });

  it("chooseDirectory answers null when the user cancelled (T11)", async () => {
    const { ipc, invoke } = createFakeIpc();
    invoke.mockResolvedValue(null);
    const bridge = createBridge(ipc);

    const pick = bridge.chooseDirectory?.bind(bridge);
    if (!pick) throw new Error("createBridge did not implement chooseDirectory");

    await expect(pick()).resolves.toBeNull();
  });

  it("createWorkspace invokes workspace.create with the directory (T11)", async () => {
    const { ipc, invoke } = createFakeIpc();
    invoke.mockResolvedValue({ hostId: "host-1", state: { messages: [] } });
    const bridge = createBridge(ipc);

    const create = bridge.createWorkspace?.bind(bridge);
    if (!create) throw new Error("createBridge did not implement createWorkspace");

    await expect(create("/tmp/chosen")).resolves.toEqual({ hostId: "host-1", state: { messages: [] } });
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.WORKSPACE_CREATE, "/tmp/chosen");
  });

  // T1 (S1/S2): the workspace registry channels — list, add (persist),
  // remove (forget the persisted entry only) and open (the creation path
  // without the picker).
  it("listWorkspaces invokes workspace.list and answers the WorkspaceList", async () => {
    const { ipc, invoke } = createFakeIpc();
    invoke.mockResolvedValue({ directories: ["/tmp/a"], persisted: ["/tmp/a"] });
    const bridge = createBridge(ipc);

    const list = bridge.listWorkspaces?.bind(bridge);
    if (!list) throw new Error("createBridge did not implement listWorkspaces");

    await expect(list()).resolves.toEqual({ directories: ["/tmp/a"], persisted: ["/tmp/a"] });
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.WORKSPACE_LIST);
  });

  it("addWorkspace invokes workspace.add with the directory", async () => {
    const { ipc, invoke } = createFakeIpc();
    invoke.mockResolvedValue({ directories: ["/tmp/a"], persisted: ["/tmp/a"] });
    const bridge = createBridge(ipc);

    const add = bridge.addWorkspace?.bind(bridge);
    if (!add) throw new Error("createBridge did not implement addWorkspace");

    await add("/tmp/a");
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.WORKSPACE_ADD, "/tmp/a");
  });

  it("removeWorkspace invokes workspace.remove with the directory", async () => {
    const { ipc, invoke } = createFakeIpc();
    invoke.mockResolvedValue({ directories: [], persisted: [] });
    const bridge = createBridge(ipc);

    const remove = bridge.removeWorkspace?.bind(bridge);
    if (!remove) throw new Error("createBridge did not implement removeWorkspace");

    await remove("/tmp/a");
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.WORKSPACE_REMOVE, "/tmp/a");
  });

  it("openWorkspace invokes workspace.open with the directory and answers the routed host", async () => {
    const { ipc, invoke } = createFakeIpc();
    invoke.mockResolvedValue({ hostId: "host-1", state: { messages: [] } });
    const bridge = createBridge(ipc);

    const open = bridge.openWorkspace?.bind(bridge);
    if (!open) throw new Error("createBridge did not implement openWorkspace");

    await expect(open("/tmp/a")).resolves.toEqual({ hostId: "host-1", state: { messages: [] } });
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.WORKSPACE_OPEN, "/tmp/a");
  });

  it("onState subscribes to the state push channel and forwards pushed state", () => {
    const { ipc, listeners } = createFakeIpc();
    const bridge = createBridge(ipc);
    const states: unknown[] = [];

    bridge.onState((state) => states.push(state));
    const pushed = { messages: [], working: true, pendingDialogs: [], activity: 0 };
    listeners.get(IPC_CHANNELS.STATE_PUSH)?.[0]?.(undefined, pushed);

    expect(states).toEqual([pushed]);
  });

  it("onState's returned unsubscribe removes the listener", () => {
    const { ipc, listeners } = createFakeIpc();
    const bridge = createBridge(ipc);

    const unsubscribe = bridge.onState(() => undefined);
    expect(listeners.get(IPC_CHANNELS.STATE_PUSH)).toHaveLength(1);

    unsubscribe();
    expect(listeners.get(IPC_CHANNELS.STATE_PUSH)).toHaveLength(0);
  });

  it("onError subscribes to the error push channel and forwards the pushed message with its host id (T5b)", () => {
    const { ipc, listeners } = createFakeIpc();
    const bridge = createBridge(ipc);
    const pushes: Array<{ message: string; hostId: string }> = [];

    bridge.onError((message, hostId) => pushes.push({ message, hostId }));
    listeners.get(IPC_CHANNELS.ERROR_PUSH)?.[0]?.(undefined, "boom", "host-1");

    expect(pushes).toEqual([{ message: "boom", hostId: "host-1" }]);
  });

  it("onClosed subscribes to the chat.closed push and forwards the closed host's id (T5d)", () => {
    const { ipc, listeners } = createFakeIpc();
    const bridge = createBridge(ipc);
    const closed: string[] = [];

    // onClosed is optional on the interface (both real bridges implement
    // it); guard the optional call instead of asserting non-null.
    const unsubscribe = bridge.onClosed?.((hostId) => closed.push(hostId));
    if (!unsubscribe) throw new Error("createBridge did not implement onClosed");

    listeners.get(IPC_CHANNELS.CLOSED_PUSH)?.[0]?.(undefined, "host-1");
    expect(closed).toEqual(["host-1"]);

    unsubscribe();
    expect(listeners.get(IPC_CHANNELS.CLOSED_PUSH)).toHaveLength(0);
  });

  it("setupStatus invokes setup.status with no payload", async () => {
    const { ipc, invoke } = createFakeIpc();
    invoke.mockResolvedValue({ needsChoice: true, detection: { found: true, dir: "/dir", hasAuth: true, hasModels: true } });
    const bridge = createBridge(ipc);

    await expect(bridge.setupStatus()).resolves.toEqual({
      needsChoice: true,
      detection: { found: true, dir: "/dir", hasAuth: true, hasModels: true },
    });
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.SETUP_STATUS);
  });

  it("chooseHome invokes setup.chooseHome with the mode", async () => {
    const { ipc, invoke } = createFakeIpc();
    const bridge = createBridge(ipc);

    await bridge.chooseHome("link");

    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.CHOOSE_HOME, "link");
  });

  it("onError's returned unsubscribe removes the listener", () => {
    const { ipc, listeners } = createFakeIpc();
    const bridge = createBridge(ipc);

    const unsubscribe = bridge.onError(() => undefined);
    expect(listeners.get(IPC_CHANNELS.ERROR_PUSH)).toHaveLength(1);

    unsubscribe();
    expect(listeners.get(IPC_CHANNELS.ERROR_PUSH)).toHaveLength(0);
  });
});
