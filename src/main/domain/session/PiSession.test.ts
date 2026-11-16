import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeProcessSpawner } from "../../adapters/nodeProcessSpawner";
import { createLauncherLocator } from "../../adapters/launcherLocator";
import { DESKTOP_RPC_DEFAULT_TIMEOUT_MS } from "../rpc/desktopRpc";
import { PiSession } from "./PiSession";
import type { ChatState } from "../rpc/chatReducer";
import type { LauncherLocator, ProcessSpawner, SpawnedProcess } from "../../ports";

/**
 * A tiny fake `gentle-shell --mode rpc` script: reads JSON lines on stdin,
 * replies with a scripted event sequence. On `prompt` it streams
 * "hello world" as two text_delta events then settles; on the special
 * prompt text "ask" it opens a select dialog and waits for the matching
 * extension_ui_response before streaming its reply; on `abort` it settles
 * immediately.
 */
const FAKE_RPC_SCRIPT = `
process.stdin.setEncoding("utf8");
let buffer = "";
const pendingDialogs = new Map();

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.trim().length > 0) handleLine(line);
  }
});
process.stdin.on("end", () => process.exit(0));

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function streamReply(text) {
  write({ type: "message_start", message: { role: "assistant", content: [] } });
  write({ type: "message_update", usage: zeroUsage(), assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  for (const word of text.split(" ")) {
    write({ type: "message_update", usage: zeroUsage(), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: word + " " } });
  }
  write({ type: "message_update", usage: zeroUsage(), assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text } });
  write({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
  write({ type: "agent_settled" });
}

function handleLine(line) {
  const cmd = JSON.parse(line);

  // Desktop control traffic (T3): a /gentle:desktop prompt is an extension
  // command, not a user prompt — consume it and answer the documented way
  // (a correlated gentle-desktop-rpc setWidget frame), so it never becomes
  // a transcript message. The usage answer uses the contract's documented
  // example payload.
  if (cmd.type === "prompt" && cmd.message.startsWith("/gentle:desktop ")) {
    const req = JSON.parse(cmd.message.slice("/gentle:desktop ".length));
    if (req.method === "capabilities") {
      write({
        type: "extension_ui_request",
        id: "ui-capabilities",
        method: "setWidget",
        widgetKey: "gentle-desktop-rpc",
        widgetLines: [
          JSON.stringify({
            schema: "gentle-shell.desktop-rpc/v1",
            kind: "response",
            requestId: req.requestId,
            ok: true,
            data: {
              schema: "gentle-shell.desktop-rpc/v1",
              command: "gentle:desktop",
              widget: "gentle-desktop-rpc",
              methods: ["capabilities", "get_subscription_usage"],
              events: ["rate_limit"],
            },
          }),
        ],
      });
    }
    if (req.method === "get_subscription_usage") {
      write({
        type: "extension_ui_request",
        id: "ui-usage",
        method: "setWidget",
        widgetKey: "gentle-desktop-rpc",
        widgetLines: [
          JSON.stringify({
            schema: "gentle-shell.desktop-rpc/v1",
            kind: "response",
            requestId: req.requestId,
            ok: true,
            data: {
              providers: [
                {
                  provider: "openai-codex",
                  status: "ok",
                  fetchedAt: 1788600000000,
                  plan: "pro",
                  limits: [
                    {
                      name: "codex",
                      limitReached: false,
                      windows: [{ label: "week", usedPercent: 40, windowSeconds: 604800, resetAt: 1788777491000 }],
                    },
                  ],
                },
              ],
            },
          }),
        ],
      });
    }
    return;
  }

  if (cmd.type === "prompt" && cmd.message === "ask") {
    write({ type: "agent_start" });
    write({ type: "extension_ui_request", id: "dlg-1", method: "select", title: "Pick one", options: ["A", "B"] });
    pendingDialogs.set("dlg-1", (value) => streamReply("you picked " + value));
    return;
  }

  if (cmd.type === "prompt" && cmd.message === "crash") {
    process.exit(1);
  }

  if (cmd.type === "prompt") {
    write({ type: "agent_start" });
    streamReply("hello world");
    return;
  }

  if (cmd.type === "abort") {
    write({ type: "agent_settled" });
    return;
  }

  if (cmd.type === "get_messages") {
    write({
      type: "response",
      id: cmd.id,
      command: "get_messages",
      success: true,
      data: {
        messages: [
          { role: "user", content: "What is 2+2?", timestamp: 0 },
          { role: "assistant", content: [{ type: "text", text: "4" }], timestamp: 0 },
          // What gentle-todo persists: a hidden custom snapshot in the
          // session history (S4). It is NOT a transcript bubble.
          {
            role: "custom",
            customType: "gentle-todo-state",
            content: {
              tasks: [
                { id: 1, title: "Write the spec", status: "done" },
                { id: 2, title: "Wire the panel", status: "in_progress", note: "T1" },
              ],
              nextId: 3,
              updatedTurn: 9,
            },
            display: false,
            timestamp: 0,
          },
        ],
      },
    });
    return;
  }

  if (cmd.type === "extension_ui_response") {
    const resolve = pendingDialogs.get(cmd.id);
    pendingDialogs.delete(cmd.id);
    if (resolve) resolve(cmd.value ?? (cmd.cancelled ? "cancelled" : "unknown"));
  }
}
`;

function waitFor(session: PiSession, predicate: (state: ChatState) => boolean, timeoutMs = 5000): Promise<ChatState> {
  return new Promise((resolve, reject) => {
    const current = session.getState();
    if (predicate(current)) {
      resolve(current);
      return;
    }

    const timer = setTimeout(() => {
      session.off("state", onState);
      reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function onState(state: ChatState) {
      if (!predicate(state)) return;
      clearTimeout(timer);
      session.off("state", onState);
      resolve(state);
    }

    session.on("state", onState);
  });
}

describe("PiSession", () => {
  let tmpDir: string | undefined;

  function createSession(env: NodeJS.ProcessEnv, options: { sessionPath?: string } = {}): PiSession {
    return new PiSession({
      spawner: createNodeProcessSpawner(),
      locator: createLauncherLocator(env),
      env,
      sessionPath: options.sessionPath,
    });
  }

  function writeFakeScript(): string {
    tmpDir = mkdtempSync(path.join(tmpdir(), "pi-session-test-"));
    const scriptPath = path.join(tmpDir, "fake-gentle-shell.mjs");
    writeFileSync(scriptPath, FAKE_RPC_SCRIPT);
    return scriptPath;
  }

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it("start + prompt streams the assistant's text into state", async () => {
    const scriptPath = writeFakeScript();
    const session = createSession({ GENTLE_SHELL_BIN: scriptPath });

    session.start();
    session.prompt("hi");

    const settled = await waitFor(
      session,
      (state) => state.messages.some((message) => message.role === "assistant" && message.streaming === false),
    );

    expect(settled.messages).toHaveLength(2);
    expect(settled.messages[0]).toMatchObject({ role: "user", text: "hi" });
    // message_end.message is authoritative (see chatReducer's extractAssistantText),
    // so the final text is the un-spaced-joined content block, not the raw deltas.
    expect(settled.messages[1]).toMatchObject({ role: "assistant", text: "hello world", streaming: false });

    await session.stop();
  });

  it("seeds ChatState.messages from get_messages history when started with a sessionPath", async () => {
    const scriptPath = writeFakeScript();
    const session = createSession({ GENTLE_SHELL_BIN: scriptPath }, { sessionPath: "/fake/session.jsonl" });

    session.start();

    const withHistory = await waitFor(session, (state) => state.messages.length === 2);

    expect(withHistory.messages[0]).toMatchObject({ id: "msg-0", role: "user", text: "What is 2+2?" });
    expect(withHistory.messages[1]).toMatchObject({ id: "msg-1", role: "assistant", text: "4", streaming: false });

    await session.stop();
  });

  it("a reopened chat recovers its task list from get_messages history alone (no live event)", async () => {
    const scriptPath = writeFakeScript();
    const session = createSession({ GENTLE_SHELL_BIN: scriptPath }, { sessionPath: "/fake/session.jsonl" });

    // Only start() — no prompt, no live event: the panel state comes purely
    // from the get_messages response, like everything else on reload.
    session.start();

    const reloaded = await waitFor(session, (state) => state.todo !== undefined);
    expect(reloaded.messages).toHaveLength(2); // the custom message is not transcript (S3)
    expect(reloaded.todo).toEqual({
      tasks: [
        { id: 1, title: "Write the spec", status: "done" },
        { id: 2, title: "Wire the panel", status: "in_progress", note: "T1" },
      ],
      nextId: 3,
      updatedTurn: 9,
    });

    await session.stop();
  });

  it("round-trips a select dialog: pending dialog appears, the answer reaches pi, and the reply streams back", async () => {
    const scriptPath = writeFakeScript();
    const session = createSession({ GENTLE_SHELL_BIN: scriptPath });

    session.start();
    session.prompt("ask");

    const withDialog = await waitFor(session, (state) => state.pendingDialogs.length > 0);
    expect(withDialog.pendingDialogs[0]).toMatchObject({ id: "dlg-1", method: "select", options: ["A", "B"] });

    session.answerDialog("dlg-1", { value: "A" });

    const answered = await waitFor(session, (state) => !state.working && state.pendingDialogs.length === 0 && state.messages.some((m) => m.role === "assistant"));
    const assistantMessage = answered.messages.find((m) => m.role === "assistant");
    expect(assistantMessage?.text).toBe("you picked A");
  });

  it("abort sends the abort command and the session settles", async () => {
    const scriptPath = writeFakeScript();
    const session = createSession({ GENTLE_SHELL_BIN: scriptPath });
    const events: string[] = [];
    session.on("event", (event) => events.push(event.type));

    session.start();
    session.abort();

    await waitFor(session, () => events.includes("agent_settled"));
    expect(events).toContain("agent_settled");

    await session.stop();
  });

  it("stop() closes stdin and the child exits; a second stop() is a safe no-op", async () => {
    const scriptPath = writeFakeScript();
    const session = createSession({ GENTLE_SHELL_BIN: scriptPath });

    session.start();
    await session.stop();
    await expect(session.stop()).resolves.toBeUndefined();
  });

  it("surfaces a locator failure as lastError and an error event instead of throwing", () => {
    const session = createSession({ PATH: "" });
    const errors: Error[] = [];
    session.on("error", (error) => errors.push(error));

    expect(() => session.start()).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/GENTLE_SHELL_BIN/);
    expect(session.getState().lastError).toMatch(/GENTLE_SHELL_BIN/);
  });

  it("a spawn failure (missing executable) surfaces an error event and stop() still resolves", async () => {
    const missingBin = path.join(tmpdir(), `gentle-shell-desktop-missing-${Date.now()}`);
    const session = createSession({ GENTLE_SHELL_BIN: missingBin });
    const errors: Error[] = [];
    session.on("error", (error) => errors.push(error));

    session.start();

    await waitFor(session, (state) => state.lastError !== undefined);
    expect(errors.length).toBeGreaterThan(0);

    await session.stop();
  }, 6000);

  it("prompt() after the child exits unexpectedly does not throw or crash the process", async () => {
    const scriptPath = writeFakeScript();
    const session = createSession({ GENTLE_SHELL_BIN: scriptPath });
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    const onUncaughtException = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandledRejection);
    process.on("uncaughtException", onUncaughtException);

    try {
      session.start();
      session.prompt("crash");
      await waitFor(session, (state) => state.lastError !== undefined);

      expect(() => session.prompt("hi")).not.toThrow();
      expect(session.getState().lastError).toBeDefined();

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      process.off("uncaughtException", onUncaughtException);
    }
  });

  it("prompt() called right after stop() begins does not throw (write-after-end guard)", async () => {
    const scriptPath = writeFakeScript();
    const session = createSession({ GENTLE_SHELL_BIN: scriptPath });

    session.start();
    const stopPromise = session.stop();

    expect(() => session.prompt("hi")).not.toThrow();
    expect(session.getState().lastError).toMatch(/no active process/);

    await stopPromise;
  });
});

/**
 * A controllable fake ProcessSpawner (no real child process) for the
 * Electron-host follow-up tests below: stderr-to-log routing, unexpected
 * exit cleanup, the double-start guard, prompt()-while-working, and env
 * merging. These need precise control over stdout/stderr timing and the
 * spawned env, which the real fake-RPC-script tests above cannot give
 * without racing real process I/O.
 */
interface FakeProcessHandle {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly writes: string[];
  killed: boolean;
  emitStdout(line: string): void;
  emitStderr(line: string): void;
  resolveExited(result: { code: number | null; signal: NodeJS.Signals | null; error?: Error }): void;
}

function createFakeSpawner(): { spawner: ProcessSpawner; handles: FakeProcessHandle[] } {
  const handles: FakeProcessHandle[] = [];

  const spawner: ProcessSpawner = {
    spawn(command, args, env): SpawnedProcess {
      const stdoutHandlers: Array<(line: string) => void> = [];
      const stderrHandlers: Array<(line: string) => void> = [];
      const errorHandlers: Array<(error: Error) => void> = [];
      const writes: string[] = [];

      let resolveExitedFn: (result: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => void = () => undefined;
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
        resolveExitedFn = resolve;
      });

      const handle: FakeProcessHandle = {
        command,
        args,
        env,
        writes,
        killed: false,
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
        endStdin() {},
        onStdoutLine(handler) {
          stdoutHandlers.push(handler);
        },
        onStderrLine(handler) {
          stderrHandlers.push(handler);
        },
        onError(handler) {
          errorHandlers.push(handler);
        },
        kill() {
          handle.killed = true;
        },
      };
    },
  };

  return { spawner, handles };
}

const fakeLocator: LauncherLocator = { locate: () => ({ command: "fake-gentle-shell", args: [] }) };

/** Flush the microtask queue so `proc.exited.then(...)` handlers inside PiSession run. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("PiSession: Electron host follow-ups", () => {
  it("routes stderr lines to the injectable onLog callback instead of surfacing them as lastError", () => {
    const { spawner, handles } = createFakeSpawner();
    const logLines: string[] = [];
    const session = new PiSession({ spawner, locator: fakeLocator, env: {}, onLog: (line) => logLines.push(line) });

    session.start();
    handles[0]?.emitStderr("some diagnostic output");

    expect(logLines).toEqual(["some diagnostic output"]);
    expect(session.getState().lastError).toBeUndefined();
  });

  it("resets working and clears pending dialogs on an unexpected exit, surfacing exactly one error", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    const errors: Error[] = [];
    session.on("error", (error) => errors.push(error));

    session.start();
    handles[0]?.emitStdout(JSON.stringify({ type: "agent_start" }));
    handles[0]?.emitStdout(
      JSON.stringify({ type: "extension_ui_request", id: "dlg-1", method: "select", title: "Pick", options: ["A"] }),
    );

    expect(session.getState().working).toBe(true);
    expect(session.getState().pendingDialogs).toHaveLength(1);

    handles[0]?.resolveExited({ code: 1, signal: null });
    await flushMicrotasks();

    expect(session.getState().working).toBe(false);
    expect(session.getState().pendingDialogs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/exited unexpectedly/);
  });

  it("resets working and clears pending dialogs on a clean self-exit too (code 0, not via stop()), without surfacing an error", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    const errors: Error[] = [];
    session.on("error", (error) => errors.push(error));

    session.start();
    handles[0]?.emitStdout(JSON.stringify({ type: "agent_start" }));
    handles[0]?.emitStdout(
      JSON.stringify({ type: "extension_ui_request", id: "dlg-1", method: "select", title: "Pick", options: ["A"] }),
    );

    expect(session.getState().working).toBe(true);
    expect(session.getState().pendingDialogs).toHaveLength(1);

    handles[0]?.resolveExited({ code: 0, signal: null });
    await flushMicrotasks();

    expect(session.getState().working).toBe(false);
    expect(session.getState().pendingDialogs).toEqual([]);
    expect(errors).toHaveLength(0);
  });

  it("guards start() against a double start: the second call surfaces an error instead of spawning again", () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    const errors: Error[] = [];
    session.on("error", (error) => errors.push(error));

    session.start();
    session.start();

    expect(handles).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/already started|active/i);
  });

  it("rejects prompt() while working: no message appended, no stdin write, lastError set", () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });

    session.start();
    handles[0]?.emitStdout(JSON.stringify({ type: "agent_start" }));
    expect(session.getState().working).toBe(true);

    const beforeCount = session.getState().messages.length;
    const result = session.prompt("another message");

    expect(result).toEqual({ queued: false, reason: "Gentle is still working" });
    expect(session.getState().messages).toHaveLength(beforeCount);
    expect(handles[0]?.writes).toEqual([]);
    expect(session.getState().lastError).toBe("Gentle is still working");
  });

  it("prompt() while idle still queues normally and returns { queued: true }", () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });

    session.start();
    const result = session.prompt("hi");

    expect(result).toEqual({ queued: true });
    expect(session.getState().messages).toHaveLength(1);
    expect(handles[0]?.writes).toHaveLength(1);
  });

  it("merges the launcher's env (e.g. ELECTRON_RUN_AS_NODE for a JS entry) into the spawned process env", () => {
    const { spawner, handles } = createFakeSpawner();
    const locator: LauncherLocator = {
      locate: () => ({ command: process.execPath, args: ["entry.mjs"], env: { ELECTRON_RUN_AS_NODE: "1" } }),
    };
    const session = new PiSession({ spawner, locator, env: { FOO: "bar" } });

    session.start();

    expect(handles[0]?.env).toMatchObject({ FOO: "bar", ELECTRON_RUN_AS_NODE: "1" });
  });

  it("always marks the spawned pi process as an interactive host via GENTLE_SHELL_INTERACTIVE_HOST=1 (M2 prerequisite)", () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: { FOO: "bar" } });

    session.start();

    expect(handles[0]?.env).toMatchObject({ FOO: "bar", GENTLE_SHELL_INTERACTIVE_HOST: "1" });
  });

  it("GENTLE_SHELL_INTERACTIVE_HOST survives being merged alongside the launcher's own env", () => {
    const { spawner, handles } = createFakeSpawner();
    const locator: LauncherLocator = {
      locate: () => ({ command: process.execPath, args: ["entry.mjs"], env: { ELECTRON_RUN_AS_NODE: "1" } }),
    };
    const session = new PiSession({ spawner, locator, env: { FOO: "bar" } });

    session.start();

    expect(handles[0]?.env).toMatchObject({ FOO: "bar", ELECTRON_RUN_AS_NODE: "1", GENTLE_SHELL_INTERACTIVE_HOST: "1" });
  });

  it("sends get_messages when started with a sessionPath and seeds ChatState.messages from the response", () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {}, sessionPath: "/a/sess-1.jsonl" });

    session.start();

    // desktop-rpc T3 correction (R3-001): start() writes ONLY the history
    // request. The capabilities probe follows the history RESPONSE, so
    // `get_messages` stays the child's LAST write while ChatHost's bounded
    // history wait is observing it.
    expect(handles[0]?.writes).toHaveLength(1);
    const sent = JSON.parse(handles[0]?.writes[0] ?? "{}");
    expect(sent).toMatchObject({ type: "get_messages" });
    expect(typeof sent.id).toBe("string");

    handles[0]?.emitStdout(
      JSON.stringify({
        type: "response",
        id: sent.id,
        command: "get_messages",
        success: true,
        data: {
          messages: [
            { role: "user", content: "hi", timestamp: 0 },
            { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 0 },
          ],
        },
      }),
    );

    expect(session.getState().messages).toEqual([
      { id: "msg-0", role: "user", text: "hi" },
      { id: "msg-1", role: "assistant", text: "hello", streaming: false },
    ]);
  });

  it("never sends get_messages for a fresh session (no sessionPath)", () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });

    session.start();

    // desktop-rpc T3: a FRESH chat's stdin stays silent until the user
    // acts (ChatHost.test.ts pins that contract) — no get_messages, and no
    // control write of any kind; its first control write (the capabilities
    // probe) waits for its first settled turn.
    expect(handles[0]?.writes).toEqual([]);
  });

  it("surfaces lastError instead of throwing when the get_messages response fails", () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {}, sessionPath: "/a/sess-1.jsonl" });

    session.start();
    // desktop-rpc T3 correction (R3-001): the history request is the ONLY
    // start write; the capabilities probe waits for its response.
    const sent = JSON.parse(handles[0]?.writes[0] ?? "{}");

    handles[0]?.emitStdout(
      JSON.stringify({ type: "response", id: sent.id, command: "get_messages", success: false, error: "boom" }),
    );

    expect(session.getState().lastError).toBe("Could not load this chat's history");
    expect(session.getState().messages).toEqual([]);
  });

  it("ignores a get_messages response whose id does not match the pending request", () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {}, sessionPath: "/a/sess-1.jsonl" });

    session.start();

    handles[0]?.emitStdout(
      JSON.stringify({
        type: "response",
        id: "some-other-id",
        command: "get_messages",
        success: true,
        data: { messages: [{ role: "user", content: "should be ignored", timestamp: 0 }] },
      }),
    );

    expect(session.getState().messages).toEqual([]);
  });

  it("never overwrites already-live messages with a late get_messages history response", () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {}, sessionPath: "/a/sess-1.jsonl" });

    session.start();
    const sent = JSON.parse(handles[0]?.writes[0] ?? "{}");

    // A live prompt races ahead of the history response.
    session.prompt("hi there");
    expect(session.getState().messages).toHaveLength(1);

    handles[0]?.emitStdout(
      JSON.stringify({
        type: "response",
        id: sent.id,
        command: "get_messages",
        success: true,
        data: { messages: [{ role: "user", content: "should not appear", timestamp: 0 }] },
      }),
    );

    expect(session.getState().messages).toHaveLength(1);
    expect(session.getState().messages[0]).toMatchObject({ text: "hi there" });
  });

  it("a live gentle-todo-state event beats the older snapshot in the get_messages history response", () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {}, sessionPath: "/a/sess-1.jsonl" });

    session.start();
    const sent = JSON.parse(handles[0]?.writes[0] ?? "{}");

    // A live gentle-todo-state event lands while the history request is
    // still in flight: it is always the newer snapshot.
    handles[0]?.emitStdout(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "custom",
          customType: "gentle-todo-state",
          content: {
            tasks: [{ id: 7, title: "Live task", status: "in_progress" }],
            nextId: 8,
            updatedTurn: 10,
          },
          display: false,
        },
      }),
    );
    expect(session.getState().todo).toEqual({
      tasks: [{ id: 7, title: "Live task", status: "in_progress" }],
      nextId: 8,
      updatedTurn: 10,
    });

    // The get_messages response carries a snapshot written BEFORE the live
    // event; it must never clobber the live one.
    handles[0]?.emitStdout(
      JSON.stringify({
        type: "response",
        id: sent.id,
        command: "get_messages",
        success: true,
        data: {
          messages: [
            {
              role: "custom",
              customType: "gentle-todo-state",
              content: {
                tasks: [{ id: 1, title: "Stale task", status: "done" }],
                nextId: 2,
                updatedTurn: 9,
              },
              display: false,
              timestamp: 0,
            },
          ],
        },
      }),
    );

    expect(session.getState().todo).toEqual({
      tasks: [{ id: 7, title: "Live task", status: "in_progress" }],
      nextId: 8,
      updatedTurn: 10,
    });
  });

  // The tool shapes in these two tests are pi 0.85.1's published message
  // types (odd/tasks/desktop-pending-work.md L11, read from the installed
  // package). This repo has no captured get_messages payload with tool
  // parts, so the data is inline from those published types — not a fixture
  // claiming to be a capture.
  it("a reopened chat recovers its tool-call rows — args, result and error — from the get_messages history", () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {}, sessionPath: "/a/sess-1.jsonl" });

    session.start();
    const sent = JSON.parse(handles[0]?.writes[0] ?? "{}");

    handles[0]?.emitStdout(
      JSON.stringify({
        type: "response",
        id: sent.id,
        command: "get_messages",
        success: true,
        data: {
          messages: [
            { role: "user", content: "run it", timestamp: 0 },
            {
              role: "assistant",
              content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } }],
              timestamp: 0,
            },
            {
              role: "toolResult",
              toolCallId: "call_1",
              toolName: "bash",
              content: [{ type: "text", text: "file.txt" }],
              isError: false,
              timestamp: 0,
            },
          ],
        },
      }),
    );

    expect(session.getState().toolCalls).toEqual([
      { id: "call_1", toolName: "bash", args: { command: "ls" }, result: "file.txt", isError: false, status: "done" },
    ]);
    // The text thread is unaffected by the row recovery.
    expect(session.getState().messages).toEqual([
      { id: "msg-0", role: "user", text: "run it" },
    ]);
  });

  it("never clobbers a tool row a live event already produced for the same id while the history answer was in flight", () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {}, sessionPath: "/a/sess-1.jsonl" });

    session.start();
    const sent = JSON.parse(handles[0]?.writes[0] ?? "{}");

    // A live tool_execution_start races ahead of the history response: it
    // owns the row for its id, and no recovered row may overwrite it.
    handles[0]?.emitStdout(
      JSON.stringify({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "live" } }),
    );
    expect(session.getState().toolCalls).toEqual([
      { id: "call_1", toolName: "bash", args: { command: "live" }, status: "running" },
    ]);

    handles[0]?.emitStdout(
      JSON.stringify({
        type: "response",
        id: sent.id,
        command: "get_messages",
        success: true,
        data: {
          messages: [
            {
              role: "assistant",
              content: [
                { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "stale" } },
                { type: "toolCall", id: "call_2", name: "read", arguments: { path: "b.md" } },
              ],
              timestamp: 0,
            },
          ],
        },
      }),
    );

    // The live row is untouched and no recovered row (not even for an id
    // the live row does not own) is resurrected while live rows exist.
    expect(session.getState().toolCalls).toEqual([
      { id: "call_1", toolName: "bash", args: { command: "live" }, status: "running" },
    ]);
  });
});

describe("PiSession: desktop-rpc control plane (U1, desktop-rpc T2)", () => {
  function desktopWidgetFrame(requestId: string, data: unknown): string {
    return JSON.stringify({
      type: "extension_ui_request",
      id: "ui-desktop",
      method: "setWidget",
      widgetKey: "gentle-desktop-rpc",
      widgetLines: [JSON.stringify({ schema: "gentle-shell.desktop-rpc/v1", kind: "response", requestId, data })],
    });
  }

  function controlRequestId(write: string): string {
    const prompt = JSON.parse(write) as { type: string; message: string };
    if (prompt.type !== "prompt" || !prompt.message.startsWith("/gentle:desktop ")) {
      throw new Error(`expected a /gentle:desktop prompt command, got: ${write}`);
    }
    return (JSON.parse(prompt.message.slice("/gentle:desktop ".length)) as { requestId: string }).requestId;
  }

  it("binds the desktop-rpc client on spawn and clears it on exit", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });

    expect(session.desktopRpc).toBeUndefined();
    session.start();
    expect(session.desktopRpc).toBeDefined();

    handles[0]?.resolveExited({ code: 0, signal: null });
    await flushMicrotasks();
    expect(session.desktopRpc).toBeUndefined();
  });

  it("sends control traffic while the agent is working (bypassing the user-prompt guard) and settles it from the correlated widget frame", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    handle.emitStdout(JSON.stringify({ type: "agent_start" }));
    expect(session.getState().working).toBe(true);

    // A user prompt is still refused while working...
    expect(session.prompt("a user message")).toEqual({ queued: false, reason: "Gentle is still working" });
    const messagesBefore = session.getState().messages.length;
    const writesBefore = handle.writes.length;

    // ...but control traffic goes out on the same stdin as a /gentle:desktop prompt.
    const client = session.desktopRpc;
    if (!client) throw new Error("desktop-rpc client not bound after start()");
    const pending = client.request("get_session_stats");
    expect(handle.writes.length).toBe(writesBefore + 1);
    const requestId = controlRequestId(handle.writes[handle.writes.length - 1] ?? "");

    // pi's response to that prompt only reports disposition: it must never
    // become the domain answer nor add a conversation message.
    handle.emitStdout(
      JSON.stringify({ type: "response", command: "prompt", success: true, data: { disposition: "handled" } }),
    );
    expect(session.getState().messages.length).toBe(messagesBefore);
    await Promise.resolve();
    expect(client.pendingCount).toBe(1);

    // The correlated setWidget frame settles the request and never reaches
    // the chat reducer: no message, no helpers change.
    handle.emitStdout(desktopWidgetFrame(requestId, { stats: true }));
    await expect(pending).resolves.toEqual({ ok: true, data: { stats: true } });
    expect(session.getState().messages.length).toBe(messagesBefore);
    expect(session.getState().helpers).toEqual({ summary: { running: 0, queued: 0, waiting: 0, finished: 0 }, tasks: [] });

    handle.resolveExited({ code: 0, signal: null });
    await flushMicrotasks();
  });

  it("a setWidget frame for another widget key keeps today's behaviour: not intercepted, not folded, does not settle a pending request", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    const client = session.desktopRpc;
    if (!client) throw new Error("desktop-rpc client not bound after start()");
    const pending = client.request("get_config");
    const getConfigRequestId = controlRequestId(handle.writes[handle.writes.length - 1] ?? "");
    const writesBefore = handle.writes.length;

    handle.emitStdout(
      JSON.stringify({
        type: "extension_ui_request",
        id: "ui-other",
        method: "setWidget",
        widgetKey: "some-other-extension",
        widgetLines: ["irrelevant"],
      }),
    );
    expect(handle.writes.length).toBe(writesBefore);
    expect(client.pendingCount).toBe(1);
    expect(session.getState().messages).toEqual([]);

    handle.emitStdout(desktopWidgetFrame(getConfigRequestId, { after: true }));
    await expect(pending).resolves.toEqual({ ok: true, data: { after: true } });

    handle.resolveExited({ code: 0, signal: null });
    await flushMicrotasks();
  });

  it("folds setStatus and notify events from the child into this chat's state without creating conversation messages", () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    handle.emitStdout(
      JSON.stringify({ type: "extension_ui_request", id: "u-1", method: "setStatus", statusKey: "gentle-todo", statusText: "2 open" }),
    );
    expect(session.getState().statuses).toEqual({ "gentle-todo": "2 open" });

    handle.emitStdout(
      JSON.stringify({ type: "extension_ui_request", id: "u-2", method: "setStatus", statusKey: "gentle-todo", statusText: "1 open" }),
    );
    expect(session.getState().statuses).toEqual({ "gentle-todo": "1 open" });

    handle.emitStdout(
      JSON.stringify({ type: "extension_ui_request", id: "u-3", method: "notify", message: "Blocked", notifyType: "warning" }),
    );
    handle.emitStdout(JSON.stringify({ type: "extension_ui_request", id: "u-4", method: "notify", message: "Done" }));
    expect(session.getState().notifications).toEqual([
      { message: "Blocked", severity: "warning" },
      { message: "Done", severity: "info" },
    ]);
    expect(session.getState().messages).toEqual([]);

    // Wire clearing: a setStatus without statusText drops the key.
    handle.emitStdout(JSON.stringify({ type: "extension_ui_request", id: "u-5", method: "setStatus", statusKey: "gentle-todo" }));
    expect(session.getState().statuses).toEqual({});

    handle.resolveExited({ code: 0, signal: null });
  });

  it("notifications and statuses stay scoped to their own session (another open chat never sees them)", () => {
    const { spawner, handles } = createFakeSpawner();
    const a = new PiSession({ spawner, locator: fakeLocator, env: {} });
    const b = new PiSession({ spawner, locator: fakeLocator, env: {} });
    a.start();
    b.start();
    const handleA = handles[0];
    const handleB = handles[1];
    if (!handleA || !handleB) throw new Error("expected two spawned handles");

    handleA.emitStdout(
      JSON.stringify({ type: "extension_ui_request", id: "u-1", method: "notify", message: "only for A", notifyType: "error" }),
    );
    handleB.emitStdout(
      JSON.stringify({ type: "extension_ui_request", id: "u-2", method: "setStatus", statusKey: "b-only", statusText: "B" }),
    );

    expect(a.getState().notifications).toEqual([{ message: "only for A", severity: "error" }]);
    expect(a.getState().statuses).toBeUndefined();
    expect(b.getState().notifications).toBeUndefined();
    expect(b.getState().statuses).toEqual({ "b-only": "B" });

    handleA.resolveExited({ code: 0, signal: null });
    handleB.resolveExited({ code: 0, signal: null });
  });

  // -----------------------------------------------------------------------
  // Subscription usage (desktop-rpc T3, U3 acceptance boundaries): the
  // usage meters are fed by `get_subscription_usage` replies and
  // `rate_limit` events on the gentle-desktop-rpc widget channel, folded
  // into ChatState.usage — never the transcript, never another session's
  // state, and never rendered as zero when the source has nothing.
  // -----------------------------------------------------------------------

  const USAGE_INITIAL = {
    providers: [
      {
        provider: "openai-codex",
        status: "ok",
        plan: "pro",
        limits: [
          { name: "codex", limitReached: false, windows: [{ label: "week", usedPercent: 40, windowSeconds: 604800, resetAt: 1788777491000 }] },
        ],
      },
    ],
  };
  const USAGE_NEWEST = {
    providers: [
      {
        provider: "openai-codex",
        status: "ok",
        plan: "pro",
        limits: [
          { name: "codex", limitReached: false, windows: [{ label: "week", usedPercent: 70, windowSeconds: 604800, resetAt: 1788777491000 }] },
        ],
      },
    ],
  };
  const USAGE_STALE = {
    providers: [
      {
        provider: "openai-codex",
        status: "ok",
        plan: "pro",
        limits: [
          { name: "codex", limitReached: false, windows: [{ label: "week", usedPercent: 1, windowSeconds: 604800, resetAt: 1788777491000 }] },
        ],
      },
    ],
  };
  const RATE_LIMIT_EVENT_DATA = {
    source: "response",
    snapshots: [
      {
        provider: "anthropic",
        status: "ok",
        fetchedAt: 1788600000000,
        limits: [
          {
            name: "claude",
            limitReached: false,
            windows: [
              { label: "5h", usedPercent: 25, windowSeconds: 18000, resetAt: null },
              { label: "week", usedPercent: 90, windowSeconds: 604800, resetAt: null },
            ],
          },
        ],
      },
    ],
  };

  /** An unsolicited event frame: no requestId on the envelope (events are
   * published on the widget channel without one, per docs/desktop-rpc.md). */
  function rateLimitEventFrame(data: unknown): string {
    return JSON.stringify({
      type: "extension_ui_request",
      id: "ui-desktop-event",
      method: "setWidget",
      widgetKey: "gentle-desktop-rpc",
      widgetLines: [
        JSON.stringify({ schema: "gentle-shell.desktop-rpc/v1", kind: "event", seq: 3, event: "rate_limit", data }),
      ],
    });
  }

  async function flushReplies(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** The documented capabilities payload shape: a successful probe adopts
   * the channel for this child's lifetime and unlocks control traffic. */
  const CAPABILITIES_DATA = {
    schema: "gentle-shell.desktop-rpc/v1",
    command: "gentle:desktop",
    widget: "gentle-desktop-rpc",
    methods: ["capabilities", "get_subscription_usage"],
    events: ["rate_limit"],
  };

  /** Answers the one capabilities probe a session is allowed to send. */
  async function adoptChannel(handle: FakeProcessHandle): Promise<void> {
    const probeWrite = handle.writes.find((write) => write.includes('capabilities'));
    if (!probeWrite) throw new Error("expected a capabilities probe write");
    handle.emitStdout(desktopWidgetFrame(controlRequestId(probeWrite), CAPABILITIES_DATA));
    await flushReplies();
  }

  /** A correlated reply carrying a server error (ok: false). */
  function desktopErrorWidgetFrame(requestId: string, code: string): string {
    return JSON.stringify({
      type: "extension_ui_request",
      id: "ui-desktop-error",
      method: "setWidget",
      widgetKey: "gentle-desktop-rpc",
      widgetLines: [
        JSON.stringify({
          schema: "gentle-shell.desktop-rpc/v1",
          kind: "response",
          requestId,
          ok: false,
          error: { code, message: `the server said ${code}` },
        }),
      ],
    });
  }

  it("a REOPENED chat probes capabilities at its chat-ready moment — get_messages stays the child's last write — and the usage read follows only once the probe succeeds", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {}, sessionPath: "/a/sess-1.jsonl" });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    // Correction R3-001: a reopened chat writes ONLY its history request at
    // start, so `get_messages` is the child's last write while ChatHost's
    // bounded history wait observes it. The capabilities probe deliberately
    // waits for the history RESPONSE instead of taking that position away.
    expect(handle.writes).toHaveLength(1);
    const historySent = JSON.parse(handle.writes[0] ?? "{}");
    expect(historySent).toMatchObject({ type: "get_messages" });

    handle.emitStdout(
      JSON.stringify({ type: "response", id: historySent.id, command: "get_messages", success: true, data: { messages: [] } }),
    );

    // History landed: now, and only now, the probe takes the next write.
    expect(handle.writes).toHaveLength(2);
    expect(handle.writes[1]).toMatch("capabilities");

    await adoptChannel(handle);

    // The probe unlocked the channel: the usage read goes out now.
    const usageRequestId = controlRequestId(handle.writes[handle.writes.length - 1] ?? "");
    handle.emitStdout(desktopWidgetFrame(usageRequestId, USAGE_INITIAL));
    await flushReplies();

    expect(session.getState().usage).toEqual(USAGE_INITIAL);
    // Nothing about usage reaches the conversation transcript.
    expect(session.getState().messages).toEqual([]);

    handle.resolveExited({ code: 0, signal: null });
  });

  it("a fresh chat sends nothing at start; its first control write is the capabilities probe at the first settled turn", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    // Silent until the user acts (ChatHost.test.ts pins that contract).
    expect(handle.writes).toEqual([]);

    // agent_settled is the meaningful lifecycle boundary: exactly ONE
    // probe goes out, never a repeating timer — and NO usage read, which
    // stays gated on the probe's success.
    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    expect(handle.writes).toHaveLength(1);
    expect(handle.writes[0]).toMatch("capabilities");

    handle.resolveExited({ code: 0, signal: null });
  });

  it("a child that never answers capabilities receives no usage write at all, and the surface reports the channel unavailable", async () => {
    vi.useFakeTimers();
    try {
      const { spawner, handles } = createFakeSpawner();
      const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
      session.start();
      const handle = handles[0];
      if (!handle) throw new Error("no spawned handle");

      handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
      expect(handle.writes).toHaveLength(1);
      expect(handle.writes[0]).toMatch("capabilities");

      // Another settled turn while the probe is unanswered: still nothing.
      handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
      expect(handle.writes).toHaveLength(1);

      // The child never answers: the probe times out.
      await vi.advanceTimersByTimeAsync(DESKTOP_RPC_DEFAULT_TIMEOUT_MS + 1);

      expect(session.getState().usageChannelUnavailable).toBe(true);
      expect(session.getState().usage).toBeUndefined();

      // The channel stays closed: no usage write ever, even on later turns.
      handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
      expect(handle.writes).toHaveLength(1);
      expect(session.getState().usage).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a probe answered with a server error closes the channel the same way (fast failure, no timeout wait)", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    expect(handle.writes).toHaveLength(1);

    handle.emitStdout(desktopErrorWidgetFrame(controlRequestId(handle.writes[0] ?? ""), "unsupported_method"));
    await flushReplies();

    expect(session.getState().usageChannelUnavailable).toBe(true);
    expect(session.getState().usage).toBeUndefined();

    // No further control write of any kind after the failure.
    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    expect(handle.writes).toHaveLength(1);
  });

  it("a child that answers capabilities receives the usage read — the probe is sent exactly once per child", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    await adoptChannel(handle);

    // The probe unlocked the channel: the usage read follows.
    const usageRequestId = controlRequestId(handle.writes[handle.writes.length - 1] ?? "");
    handle.emitStdout(desktopWidgetFrame(usageRequestId, USAGE_INITIAL));
    await flushReplies();
    expect(session.getState().usage).toEqual(USAGE_INITIAL);

    // Later settled turns trigger usage reads, but never a second probe.
    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    expect(handle.writes.filter((write) => write.includes('capabilities'))).toHaveLength(1);
    const secondRequestId = controlRequestId(handle.writes[handle.writes.length - 1] ?? "");
    handle.emitStdout(desktopWidgetFrame(secondRequestId, USAGE_NEWEST));
    await flushReplies();
    expect(session.getState().usage).toEqual(USAGE_NEWEST);

    handle.resolveExited({ code: 0, signal: null });
  });

  it("a rate_limit event updates an already-rendered meter live, without a reload and without transcript traffic", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {}, sessionPath: "/a/sess-1.jsonl" });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    await adoptChannel(handle);
    handle.emitStdout(desktopWidgetFrame(controlRequestId(handle.writes[handle.writes.length - 1] ?? ""), USAGE_INITIAL));
    await flushReplies();
    expect(session.getState().usage).toEqual(USAGE_INITIAL);

    // Unsolicited event (no requestId): the live update path. It merges in
    // the changed snapshot and keeps the providers it did not touch.
    handle.emitStdout(rateLimitEventFrame(RATE_LIMIT_EVENT_DATA));
    expect(session.getState().usage).toEqual({
      providers: [
        USAGE_INITIAL.providers[0],
        {
          provider: "anthropic",
          status: "ok",
          fetchedAt: 1788600000000,
          limits: [
            {
              name: "claude",
              limitReached: false,
              windows: [
                { label: "5h", usedPercent: 25, windowSeconds: 18000, resetAt: null },
                { label: "week", usedPercent: 90, windowSeconds: 604800, resetAt: null },
              ],
            },
          ],
        },
      ],
    });
    expect(session.getState().messages).toEqual([]);

    handle.resolveExited({ code: 0, signal: null });
  });

  it("ignores a malformed usage reply and a malformed rate_limit event without throwing", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    // Good data first (also proves the channel for the settled-turn path).
    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    await adoptChannel(handle);
    handle.emitStdout(desktopWidgetFrame(controlRequestId(handle.writes[handle.writes.length - 1] ?? ""), USAGE_INITIAL));
    await flushReplies();

    // A settled turn triggers a second request; its reply is garbage.
    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    const secondRequestId = controlRequestId(handle.writes[handle.writes.length - 1] ?? "");
    handle.emitStdout(desktopWidgetFrame(secondRequestId, { providers: "nope" }));
    await flushReplies();
    expect(session.getState().usage).toEqual(USAGE_INITIAL);

    // A malformed event keeps the previous usage state too.
    handle.emitStdout(rateLimitEventFrame({ source: "response", snapshots: "nope" }));
    handle.emitStdout(rateLimitEventFrame("not even an object"));
    expect(session.getState().usage).toEqual(USAGE_INITIAL);

    handle.resolveExited({ code: 0, signal: null });
  });

  it("a late answer for an older usage request never overwrites the newest answer's data", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    // Request 1 (first settled turn) is answered normally.
    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    await adoptChannel(handle);
    const firstRequestId = controlRequestId(handle.writes[handle.writes.length - 1] ?? "");
    handle.emitStdout(desktopWidgetFrame(firstRequestId, USAGE_INITIAL));
    await flushReplies();

    // Two settled turns trigger requests 2 and 3; both stay unanswered for
    // now, and the child then answers them OUT OF ORDER: request 3 (the
    // newest) first, request 2 late. The late older answer must lose.
    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    const secondRequestId = controlRequestId(handle.writes[handle.writes.length - 1] ?? "");
    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    const thirdRequestId = controlRequestId(handle.writes[handle.writes.length - 1] ?? "");

    handle.emitStdout(desktopWidgetFrame(thirdRequestId, USAGE_NEWEST));
    handle.emitStdout(desktopWidgetFrame(secondRequestId, USAGE_STALE));
    await flushReplies();

    expect(session.getState().usage).toEqual(USAGE_NEWEST);

    handle.resolveExited({ code: 0, signal: null });
  });

  it("a usage reply that arrives after the session stopped never folds into state", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    await adoptChannel(handle);
    const requestId = controlRequestId(handle.writes[handle.writes.length - 1] ?? "");
    handle.resolveExited({ code: 0, signal: null });
    await flushMicrotasks();

    // The child's last gasp lands after exit: the client is disposed and
    // cleared, so neither the reply nor any state fold may happen.
    handle.emitStdout(desktopWidgetFrame(requestId, USAGE_INITIAL));
    await flushReplies();
    expect(session.getState().usage).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Subagents (desktop-rpc T6): the authoritative helper state arrives as a
// `list_subagents` snapshot after the capabilities probe and as
// `agents_update` events, merged into the SAME task identity the
// `gentle-agents.activity/v1` activity path narrates; Stop goes out as
// `cancel_subagent` through the adopted channel, and the helper's real
// transition arrives with the event — never from the response alone.
// ---------------------------------------------------------------------------

describe("subagents (desktop-rpc T6)", () => {
  const AGENT_CAPABILITIES = {
    schema: "gentle-shell.desktop-rpc/v1",
    command: "gentle:desktop",
    widget: "gentle-desktop-rpc",
    methods: ["capabilities", "get_subscription_usage", "list_subagents", "cancel_subagent"],
    events: ["agents_update", "rate_limit"],
  };
  const PROJECTION_RUNNING = {
    id: "m3a1-worker",
    agent: "worker",
    status: "running",
    model: "anthropic/claude-sonnet-4",
    lastStep: "running",
    usage: { total: 900, cost: 0.002 },
  };
  const PROJECTION_COMPLETED = {
    id: "m3a1-worker",
    agent: "worker",
    status: "completed",
    model: "anthropic/claude-sonnet-4",
    lastStep: "answered",
    usage: { total: 15234, cost: 0.0421, input: 12000, output: 3234, cache: 5000, reasoning: 4000 },
  };

  function activityFrame(tasks: unknown[]): string {
    return JSON.stringify({
      type: "extension_ui_request",
      id: "ui-helpers",
      method: "setWidget",
      widgetKey: "gentle-agents",
      widgetLines: [
        JSON.stringify({
          schema: "gentle-agents.activity/v1",
          summary: {
            running: tasks.length,
            queued: 0,
            waiting: 0,
            finished: 0,
          },
          tasks: tasks.map((task) => ({
            summary: {
              id: (task as { id: string }).id,
              agent: "worker",
              label: "Audit the loaders",
              prompt: "Find every config reader.",
              status: "running",
              createdAt: "2026-09-23T09:00:00.000Z",
              startedAt: "2026-09-23T09:00:05.000Z",
              lastStep: "running",
              turns: 3,
              toolCalls: 5,
            },
            thread: { version: 1, dropped: 0, items: [{ kind: "text", text: "Working on it." }] },
          })),
        }),
      ],
    });
  }

  function agentsUpdateEvent(data: unknown): string {
    return JSON.stringify({
      type: "extension_ui_request",
      id: "ui-agents-event",
      method: "setWidget",
      widgetKey: "gentle-desktop-rpc",
      widgetLines: [
        JSON.stringify({ schema: "gentle-shell.desktop-rpc/v1", kind: "event", seq: 1, event: "agents_update", data }),
      ],
    });
  }

  function desktopWidgetFrame(requestId: string, data: unknown): string {
    return JSON.stringify({
      type: "extension_ui_request",
      id: "ui-desktop",
      method: "setWidget",
      widgetKey: "gentle-desktop-rpc",
      widgetLines: [JSON.stringify({ schema: "gentle-shell.desktop-rpc/v1", kind: "response", requestId, data })],
    });
  }

  function desktopErrorWidgetFrame(requestId: string, code: string): string {
    return JSON.stringify({
      type: "extension_ui_request",
      id: "ui-desktop-error",
      method: "setWidget",
      widgetKey: "gentle-desktop-rpc",
      widgetLines: [
        JSON.stringify({
          schema: "gentle-shell.desktop-rpc/v1",
          kind: "response",
          requestId,
          ok: false,
          error: { code, message: `the server said ${code}` },
        }),
      ],
    });
  }

  function controlRequestId(write: string): string {
    const prompt = JSON.parse(write) as { type: string; message: string };
    if (prompt.type !== "prompt" || !prompt.message.startsWith("/gentle:desktop ")) {
      throw new Error(`expected a /gentle:desktop prompt command, got: ${write}`);
    }
    return (JSON.parse(prompt.message.slice("/gentle:desktop ".length)) as { requestId: string }).requestId;
  }

  async function flushReplies(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function adoptAgentsChannel(handle: FakeProcessHandle, capabilities: unknown = AGENT_CAPABILITIES): Promise<void> {
    const probeWrite = handle.writes.find((write) => write.includes("capabilities"));
    if (!probeWrite) throw new Error("expected a capabilities probe write");
    handle.emitStdout(desktopWidgetFrame(controlRequestId(probeWrite), capabilities));
    await flushReplies();
  }

  it("after adoption the child receives exactly ONE list_subagents snapshot, and it merges into the SAME identity the activity path narrates", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    // The activity path narrates the helper first: thread, prompt, label,
    // counters. The RPC projection must merge into this same id, never
    // duplicate it.
    handle.emitStdout(activityFrame([{ id: "m3a1-worker" }]));
    expect(session.getState().helpers.tasks).toHaveLength(1);
    expect(session.getState().helpers.tasks[0]).toMatchObject({ label: "Audit the loaders", status: "running" });

    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    await adoptAgentsChannel(handle);

    // Exactly one snapshot request went out (never a timer, never a re-probe).
    const snapshotWrites = handle.writes.filter((write) => write.includes("list_subagents"));
    expect(snapshotWrites).toHaveLength(1);
    handle.emitStdout(desktopWidgetFrame(controlRequestId(snapshotWrites[0] ?? ""), { agents: [PROJECTION_COMPLETED] }));
    await flushReplies();

    const helpers = session.getState().helpers;
    expect(helpers.tasks).toHaveLength(1);
    expect(helpers.tasks[0]).toMatchObject({
      id: "m3a1-worker",
      // Narrative fields stay with the activity path...
      label: "Audit the loaders",
      prompt: "Find every config reader.",
      turns: 3,
      toolCalls: 5,
      thread: { version: 1, dropped: 0, items: [{ kind: "text", text: "Working on it." }] },
      // ...structured state comes from the projection.
      status: "done",
      model: "anthropic/claude-sonnet-4",
      usage: { total: 15234, cost: 0.0421 },
    });
    expect(helpers.agents).toEqual([PROJECTION_COMPLETED]);
    expect(helpers.stopChannel).toEqual({ available: true });
    expect(helpers.summary).toEqual({ running: 0, queued: 0, waiting: 0, finished: 1 });

    handle.resolveExited({ code: 0, signal: null });
  });

  it("an agents_update event folds the authoritative list into the same identity and reports the real transition", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    handle.emitStdout(activityFrame([{ id: "m3a1-worker" }]));
    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    await adoptAgentsChannel(handle);
    handle.emitStdout(desktopWidgetFrame(controlRequestId(handle.writes[handle.writes.length - 1] ?? ""), { agents: [PROJECTION_RUNNING] }));
    await flushReplies();
    expect(session.getState().helpers.tasks[0]?.status).toBe("running");

    handle.emitStdout(agentsUpdateEvent({ agents: [PROJECTION_COMPLETED] }));
    await flushReplies();

    const helpers = session.getState().helpers;
    expect(helpers.tasks).toHaveLength(1);
    expect(helpers.tasks[0]).toMatchObject({ status: "done", usage: { total: 15234, cost: 0.0421 } });
    expect(helpers.agents).toEqual([PROJECTION_COMPLETED]);

    handle.resolveExited({ code: 0, signal: null });
  });

  it("cancelHelper before the channel is adopted resolves unavailable and writes nothing", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    await expect(session.cancelHelper("m3a1-worker")).resolves.toBe("unavailable");
    expect(handle.writes).toEqual([]);

    handle.resolveExited({ code: 0, signal: null });
  });

  it("cancelHelper resolves unavailable without writing when the child does not advertise cancel_subagent", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    await adoptAgentsChannel(handle, { ...AGENT_CAPABILITIES, methods: ["capabilities", "list_subagents"] });
    const writesBefore = handle.writes.length;

    await expect(session.cancelHelper("m3a1-worker")).resolves.toBe("unavailable");
    expect(handle.writes).toHaveLength(writesBefore);
    expect(session.getState().helpers.stopChannel?.available).toBe(false);

    handle.resolveExited({ code: 0, signal: null });
  });

  it("Stop sends exactly one cancel_subagent prompt for THAT helper's id and no other; the still-running response does not mark it stopped — the following agents_update does", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    handle.emitStdout(activityFrame([{ id: "m3a1-a" }, { id: "m3a1-b" }]));
    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    await adoptAgentsChannel(handle);

    // The cancel request pends until its correlated reply lands, so the
    // reply is emitted before the outcome is awaited.
    const pending = session.cancelHelper("m3a1-a");
    await flushReplies();

    const cancelWrites = handle.writes.filter((write) => write.includes("cancel_subagent"));
    expect(cancelWrites).toHaveLength(1);
    // The serialized id is JSON-escaped in the raw stdin line, so the
    // assertions match the id itself: helper A's id goes out, never B's.
    expect(cancelWrites[0]).toContain("m3a1-a");
    expect(cancelWrites[0]).not.toContain("m3a1-b");

    // The response is the owner's post-action re-read: for a running
    // helper it reports the STILL-RUNNING state, so the row stays
    // non-terminal — never flipped to stopped by the response alone.
    handle.emitStdout(
      desktopWidgetFrame(controlRequestId(cancelWrites[0] ?? ""), {
        agent: { ...PROJECTION_RUNNING, id: "m3a1-a" },
      }),
    );
    await flushReplies();
    expect(await pending).toBe("requested");
    expect(session.getState().helpers.tasks.find((task) => task.id === "m3a1-a")?.status).toBe("running");

    // The real transition arrives through the normal agents_update path.
    handle.emitStdout(
      agentsUpdateEvent({ agents: [{ ...PROJECTION_RUNNING, id: "m3a1-a", status: "cancelled", lastStep: "cancelled" }] }),
    );
    await flushReplies();
    expect(session.getState().helpers.tasks.find((task) => task.id === "m3a1-a")?.status).toBe("cancelled");
    // The helper the user did not stop is untouched.
    expect(session.getState().helpers.tasks.find((task) => task.id === "m3a1-b")?.status).toBe("running");

    handle.resolveExited({ code: 0, signal: null });
  });

  it("a cancel_subagent reply reporting the synchronous queued stop folds the owner's post-action state immediately", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    handle.emitStdout(activityFrame([{ id: "m3a1-a" }]));
    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    await adoptAgentsChannel(handle);

    const pending = session.cancelHelper("m3a1-a");
    await flushReplies();
    const cancelWrite = handle.writes.find((write) => write.includes("cancel_subagent")) ?? "";

    handle.emitStdout(
      desktopWidgetFrame(controlRequestId(cancelWrite), {
        agent: { id: "m3a1-a", agent: "worker", status: "cancelled", model: "anthropic/claude-sonnet-4", lastStep: "cancelled", usage: { total: 900, cost: 0.002 } },
      }),
    );
    await flushReplies();

    expect(await pending).toBe("requested");
    const task = session.getState().helpers.tasks.find((entry) => entry.id === "m3a1-a");
    expect(task?.status).toBe("cancelled");
    expect(task?.endedAt).toBeDefined();

    handle.resolveExited({ code: 0, signal: null });
  });

  it("a not_found cancel resolves not_tracked and never surfaces an error the user cannot act on", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    handle.emitStdout(activityFrame([{ id: "m3a1-a" }]));
    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    await adoptAgentsChannel(handle);

    const pending = session.cancelHelper("m3a1-gone");
    await flushReplies();
    const cancelWrite = handle.writes.find((write) => write.includes("cancel_subagent")) ?? "";
    handle.emitStdout(desktopErrorWidgetFrame(controlRequestId(cancelWrite), "not_found"));
    await flushReplies();

    expect(await pending).toBe("not_tracked");
    expect(session.getState().lastError).toBeUndefined();
    expect(session.getState().helpers.tasks.find((task) => task.id === "m3a1-a")?.status).toBe("running");

    handle.resolveExited({ code: 0, signal: null });
  });

  it("a failed probe marks the Stop channel unavailable alongside the usage surface", async () => {
    vi.useFakeTimers();
    try {
      const { spawner, handles } = createFakeSpawner();
      const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
      session.start();
      const handle = handles[0];
      if (!handle) throw new Error("no spawned handle");

      handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
      await vi.advanceTimersByTimeAsync(DESKTOP_RPC_DEFAULT_TIMEOUT_MS + 1);

      expect(session.getState().usageChannelUnavailable).toBe(true);
      expect(session.getState().helpers.stopChannel?.available).toBe(false);
      expect(typeof session.getState().helpers.stopChannel?.reason).toBe("string");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Session identity (desktop-rpc T4): the chat's own cost, tokens, context
// usage, model and thinking level, read from pi's own `get_session_stats`
// and `get_state` — ORDINARY RPC commands, correlated by `id` the way
// `get_messages` is, never the desktop-rpc widget channel. U3's honesty
// boundaries are binding: unavailable is never zero, context is never
// derived from accumulated tokens, no context window is guessed, and the
// model/thinking shown are the child's effective values.
// ---------------------------------------------------------------------------

describe("session identity (desktop-rpc T4)", () => {
  function desktopWidgetFrame(requestId: string, data: unknown): string {
    return JSON.stringify({
      type: "extension_ui_request",
      id: "ui-desktop",
      method: "setWidget",
      widgetKey: "gentle-desktop-rpc",
      widgetLines: [JSON.stringify({ schema: "gentle-shell.desktop-rpc/v1", kind: "response", requestId, data })],
    });
  }

  function controlRequestId(write: string): string {
    const prompt = JSON.parse(write) as { type: string; message: string };
    if (prompt.type !== "prompt" || !prompt.message.startsWith("/gentle:desktop ")) {
      throw new Error(`expected a /gentle:desktop prompt command, got: ${write}`);
    }
    return (JSON.parse(prompt.message.slice("/gentle:desktop ".length)) as { requestId: string }).requestId;
  }

  async function flushReplies(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const CAPABILITIES_DATA = {
    schema: "gentle-shell.desktop-rpc/v1",
    command: "gentle:desktop",
    widget: "gentle-desktop-rpc",
    methods: ["capabilities", "get_subscription_usage"],
    events: ["rate_limit"],
  };

  async function adoptChannel(handle: FakeProcessHandle): Promise<void> {
    const probeWrite = handle.writes.find((write) => write.includes("capabilities"));
    if (!probeWrite) throw new Error("expected a capabilities probe write");
    handle.emitStdout(desktopWidgetFrame(controlRequestId(probeWrite), CAPABILITIES_DATA));
    await flushReplies();
  }

  function writesOf(handle: FakeProcessHandle, type: string): string[] {
    return handle.writes.filter((write) => (JSON.parse(write) as { type?: string }).type === type);
  }

  function commandId(write: string): string {
    const id = (JSON.parse(write) as { id?: string }).id;
    if (!id) throw new Error(`expected a correlation id on: ${write}`);
    return id;
  }

  // The documented get_session_stats example payload (fixture values).
  function statsReply(id: string, overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      type: "response",
      id,
      command: "get_session_stats",
      success: true,
      data: {
        sessionFile: "/path/to/session.jsonl",
        sessionId: "abc123",
        userMessages: 5,
        assistantMessages: 5,
        toolCalls: 12,
        toolResults: 12,
        totalMessages: 22,
        tokens: { input: 50000, output: 10000, cacheRead: 40000, cacheWrite: 5000, total: 105000 },
        cost: 0.45,
        contextUsage: { tokens: 60000, contextWindow: 200000, percent: 30 },
        ...overrides,
      },
    });
  }

  // The documented get_state example payload (fixture values).
  function stateReply(id: string, overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      type: "response",
      id,
      command: "get_state",
      success: true,
      data: {
        model: { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic" },
        thinkingLevel: "medium",
        isStreaming: false,
        isCompacting: false,
        steeringMode: "all",
        followUpMode: "one-at-a-time",
        sessionId: "abc123",
        autoCompactionEnabled: true,
        messageCount: 5,
        pendingMessageCount: 0,
        ...overrides,
      },
    });
  }

  it("a reopened chat requests its session identity only after the probe, correlated by id, and folds both replies", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {}, sessionPath: "/a/sess-1.jsonl" });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    // The reopened-chat write ordering is unchanged: the history request
    // is the FIRST write and the capabilities probe the second — the
    // identity reads may never displace either (correction R3-001's pin).
    expect(JSON.parse(handle.writes[0] ?? "{}")).toMatchObject({ type: "get_messages" });
    handle.emitStdout(
      JSON.stringify({ type: "response", id: commandId(handle.writes[0] ?? ""), command: "get_messages", success: true, data: { messages: [] } }),
    );
    await flushReplies();
    expect(handle.writes[1]).toContain("capabilities");

    await adoptChannel(handle);

    // Two ordinary RPC commands, each with its own correlation id — never
    // a /gentle:desktop prompt and never the widget channel. The usage
    // read stays the LAST control write, the ordering the existing pins
    // observe.
    const statsWrites = writesOf(handle, "get_session_stats");
    const stateWrites = writesOf(handle, "get_state");
    expect(statsWrites).toHaveLength(1);
    expect(stateWrites).toHaveLength(1);
    expect(handle.writes[handle.writes.length - 1]).toContain("/gentle:desktop");

    handle.emitStdout(statsReply(commandId(statsWrites[0] ?? "")));
    handle.emitStdout(stateReply(commandId(stateWrites[0] ?? "")));
    await flushReplies();

    expect(session.getState().session).toEqual({
      tokensTotal: 105000,
      sessionCost: 0.45,
      contextTokens: 60000,
      contextWindow: 200000,
      contextPercent: 30,
      modelId: "claude-sonnet-4-20250514",
      modelName: "Claude Sonnet 4",
      modelProvider: "anthropic",
      thinkingLevel: "medium",
    });
    // Identity chrome never becomes transcript traffic.
    expect(session.getState().messages).toEqual([]);

    handle.resolveExited({ code: 0, signal: null });
  });

  it("a fresh chat writes nothing until the user acts; its identity reads go out only after the probe at the first settled turn", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    // Silent until the user acts (ChatHost.test.ts pins that contract).
    expect(handle.writes).toEqual([]);

    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    expect(handle.writes).toHaveLength(1);
    expect(handle.writes[0]).toContain("capabilities");

    await adoptChannel(handle);
    expect(writesOf(handle, "get_session_stats")).toHaveLength(1);
    expect(writesOf(handle, "get_state")).toHaveLength(1);

    handle.resolveExited({ code: 0, signal: null });
  });

  it("every settled turn re-reads the identity, and a late answer for an older request never overwrites the newest", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    await adoptChannel(handle);
    const firstStatsId = commandId(writesOf(handle, "get_session_stats")[0] ?? "");
    const firstStateId = commandId(writesOf(handle, "get_state")[0] ?? "");

    // Settled turn 2: fresh requests, new ids. The child answers the NEW
    // ones first, then the OLD ones late — the late answers must lose.
    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    const secondStatsId = commandId(writesOf(handle, "get_session_stats")[1] ?? "");
    const secondStateId = commandId(writesOf(handle, "get_state")[1] ?? "");
    expect(secondStatsId).not.toBe(firstStatsId);
    expect(secondStateId).not.toBe(firstStateId);

    handle.emitStdout(statsReply(secondStatsId, { cost: 1.25 }));
    handle.emitStdout(stateReply(secondStateId, { data: undefined, thinkingLevel: "high" }));
    handle.emitStdout(statsReply(firstStatsId, { cost: 9999 }));
    handle.emitStdout(stateReply(firstStateId, { data: undefined, thinkingLevel: "off" }));
    await flushReplies();

    // The NEWEST answers win; the late older replies never overwrite them.
    expect(session.getState().session?.sessionCost).toBe(1.25);
    expect(session.getState().session?.thinkingLevel).toBe("high");
    expect(session.getState().session?.contextPercent).toBe(30);

    handle.resolveExited({ code: 0, signal: null });
  });

  it("a malformed or failed identity reply keeps the previous identity — absent stays absent, never zero", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    await adoptChannel(handle);
    const firstStatsId = commandId(writesOf(handle, "get_session_stats")[0] ?? "");
    const firstStateId = commandId(writesOf(handle, "get_state")[0] ?? "");
    handle.emitStdout(statsReply(firstStatsId));
    handle.emitStdout(stateReply(firstStateId));
    await flushReplies();
    const identity = session.getState().session;
    expect(identity?.sessionCost).toBe(0.45);

    // Settled turn 2, whose replies are malformed / failed / mis-addressed:
    // every one of them must leave the last-known identity untouched.
    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    const secondStatsId = commandId(writesOf(handle, "get_session_stats")[1] ?? "");
    handle.emitStdout(statsReply(secondStatsId, { cost: "0.45" })); // wrong-typed cost
    handle.emitStdout(statsReply(commandId(writesOf(handle, "get_session_stats")[1] ?? ""), { tokens: "nope" }));
    handle.emitStdout(JSON.stringify({ type: "response", id: secondStatsId, command: "get_session_stats", success: false, error: "boom" }));
    handle.emitStdout(JSON.stringify({ type: "response", id: "not-the-pending-id", command: "get_session_stats", success: true, data: {} }));
    await flushReplies();

    expect(session.getState().session).toEqual(identity);

    handle.resolveExited({ code: 0, signal: null });
  });

  it("context is never derived from the session's accumulated tokens, no fallback window is invented, and supplied-as-unknown stays null", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    await adoptChannel(handle);

    // A child that omits contextUsage (no model or context window
    // available): the tokens total is recorded, but NOTHING contextual is
    // derived from it — no percentage, no guessed window.
    handle.emitStdout(statsReply(commandId(writesOf(handle, "get_session_stats")[0] ?? ""), { contextUsage: undefined }));
    await flushReplies();
    let identity = session.getState().session;
    expect(identity?.tokensTotal).toBe(105000);
    expect(identity).not.toHaveProperty("contextPercent");
    expect(identity).not.toHaveProperty("contextTokens");
    expect(identity).not.toHaveProperty("contextWindow");

    // Right after compaction the child supplies contextUsage with null
    // tokens/percent: that is "supplied as unknown", not zero.
    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    handle.emitStdout(statsReply(commandId(writesOf(handle, "get_session_stats")[1] ?? ""), { contextUsage: { tokens: null, contextWindow: 200000, percent: null } }));
    await flushReplies();
    identity = session.getState().session;
    expect(identity?.contextTokens).toBe(null);
    expect(identity?.contextPercent).toBe(null);
    expect(identity?.contextWindow).toBe(200000);

    handle.resolveExited({ code: 0, signal: null });
  });

  it("an identity reply that arrives after the session stopped never folds into state", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    await adoptChannel(handle);
    const statsId = commandId(writesOf(handle, "get_session_stats")[0] ?? "");
    const stateId = commandId(writesOf(handle, "get_state")[0] ?? "");

    handle.resolveExited({ code: 0, signal: null });
    await flushMicrotasks();

    // The child's last gasp lands after exit: nothing may fold.
    handle.emitStdout(statsReply(statsId));
    handle.emitStdout(stateReply(stateId));
    await flushReplies();
    expect(session.getState().session).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Worktree group (desktop-rpc T8b): the footer's changed counts, read from
// the child through `get_worktree_changes` for the session's own workspace
// root — PiSession's `cwd`, the directory the child actually runs in. Gated
// on the same capabilities probe as every other control write, and only
// ever asked with a root that is actually known: guessing one would report
// someone else's tree (the T8 rule that parked this until T11).
// ---------------------------------------------------------------------------

describe("worktree group (desktop-rpc T8b)", () => {
  function desktopWidgetFrame(requestId: string, data: unknown): string {
    return JSON.stringify({
      type: "extension_ui_request",
      id: "ui-desktop",
      method: "setWidget",
      widgetKey: "gentle-desktop-rpc",
      widgetLines: [JSON.stringify({ schema: "gentle-shell.desktop-rpc/v1", kind: "response", requestId, data })],
    });
  }

  function desktopErrorWidgetFrame(requestId: string, code: string): string {
    return JSON.stringify({
      type: "extension_ui_request",
      id: "ui-desktop-error",
      method: "setWidget",
      widgetKey: "gentle-desktop-rpc",
      widgetLines: [
        JSON.stringify({
          schema: "gentle-shell.desktop-rpc/v1",
          kind: "response",
          requestId,
          ok: false,
          error: { code, message: `the server said ${code}` },
        }),
      ],
    });
  }

  function controlRequestId(write: string): string {
    const prompt = JSON.parse(write) as { type: string; message: string };
    if (prompt.type !== "prompt" || !prompt.message.startsWith("/gentle:desktop ")) {
      throw new Error(`expected a /gentle:desktop prompt command, got: ${write}`);
    }
    return (JSON.parse(prompt.message.slice("/gentle:desktop ".length)) as { requestId: string }).requestId;
  }

  async function flushReplies(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const WORKTREE_CAPABILITIES = {
    schema: "gentle-shell.desktop-rpc/v1",
    command: "gentle:desktop",
    widget: "gentle-desktop-rpc",
    methods: ["capabilities", "get_worktree_changes", "get_subscription_usage"],
    events: ["rate_limit"],
  };

  async function adoptChannel(handle: FakeProcessHandle): Promise<void> {
    const probeWrite = handle.writes.find((write) => write.includes("capabilities"));
    if (!probeWrite) throw new Error("expected a capabilities probe write");
    handle.emitStdout(desktopWidgetFrame(controlRequestId(probeWrite), WORKTREE_CAPABILITIES));
    await flushReplies();
  }

  function worktreeWrites(handle: FakeProcessHandle): string[] {
    return handle.writes.filter((write) => write.includes("get_worktree_changes"));
  }

  // The documented get_worktree_changes example payload (docs/desktop-rpc.md).
  function worktreeData(added: number, deleted: number): unknown {
    return {
      root: "/home/dev/project",
      branch: "main",
      model: {
        files: [{ path: "src/index.ts", added, deleted, status: "modified" }],
        added,
        deleted,
        digest: "1a2b3c4d5e6f7081",
      },
    };
  }

  it("asks for the known root behind the adopted channel and at each settled turn, and folds the answer into workspace", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {}, cwd: "/home/dev/project" });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    await adoptChannel(handle);

    // The channel advertised the method and the root is known: the request
    // names exactly that root — never a guessed one.
    const requests = worktreeWrites(handle);
    expect(requests).toHaveLength(1);
    const prompt = JSON.parse(requests[0] ?? "{}") as { type: string; message: string };
    expect(prompt.type).toBe("prompt");
    expect(JSON.parse(prompt.message.slice("/gentle:desktop ".length))).toMatchObject({
      method: "get_worktree_changes",
      params: { root: "/home/dev/project" },
    });

    handle.emitStdout(desktopWidgetFrame(controlRequestId(requests[0] ?? ""), worktreeData(12, 3)));
    await flushReplies();

    expect(session.getState().workspace?.worktree).toEqual({
      root: "/home/dev/project",
      branch: "main",
      files: ["src/index.ts"],
      added: 12,
      deleted: 3,
    });
    // Nothing reaches the conversation transcript.
    expect(session.getState().messages).toEqual([]);

    // A settled turn is a refresh trigger, the same boundary the other
    // stats refresh at — never a timer.
    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    expect(worktreeWrites(handle)).toHaveLength(2);

    handle.resolveExited({ code: 0, signal: null });
  });

  it("no root known, no worktree request — even when the method is advertised", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    await adoptChannel(handle);

    expect(worktreeWrites(handle)).toEqual([]);
    expect(session.getState().workspace?.worktree).toBeUndefined();

    handle.resolveExited({ code: 0, signal: null });
  });

  it("a child that does not advertise get_worktree_changes is never asked", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {}, cwd: "/home/dev/project" });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    // The usage-only capabilities payload of the sibling describes above:
    // adopted, but without the worktree method.
    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    const probeWrite = handle.writes.find((write) => write.includes("capabilities"));
    if (!probeWrite) throw new Error("expected a capabilities probe write");
    handle.emitStdout(
      desktopWidgetFrame(
        controlRequestId(probeWrite),
        {
          schema: "gentle-shell.desktop-rpc/v1",
          command: "gentle:desktop",
          widget: "gentle-desktop-rpc",
          methods: ["capabilities", "get_subscription_usage"],
          events: ["rate_limit"],
        },
      ),
    );
    await flushReplies();

    expect(worktreeWrites(handle)).toEqual([]);

    handle.resolveExited({ code: 0, signal: null });
  });

  it("a refused or failed answer carries the root-level unavailable flag and invents no numbers", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {}, cwd: "/home/dev/project" });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    await adoptChannel(handle);
    const requestId = controlRequestId(worktreeWrites(handle)[0] ?? "");

    // The wire's typed refusal for a root the child will not read.
    handle.emitStdout(desktopErrorWidgetFrame(requestId, "unknown_root"));
    await flushReplies();

    const worktree = session.getState().workspace?.worktree;
    expect(worktree).toEqual({ root: "/home/dev/project", files: [], countsUnavailable: true });
    expect(worktree).not.toHaveProperty("added");
    expect(worktree).not.toHaveProperty("deleted");

    handle.resolveExited({ code: 0, signal: null });
  });

  it("a late answer for an older worktree request never overwrites the newest answer's data", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {}, cwd: "/home/dev/project" });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    await adoptChannel(handle);

    // Two settled turns trigger requests 2 and 3 (request 1 at adoption
    // stays unanswered); the child answers them OUT OF ORDER: request 3
    // (the newest) first, request 2 late. The late older answer must lose.
    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    const secondRequestId = controlRequestId(worktreeWrites(handle)[1] ?? "");
    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    const thirdRequestId = controlRequestId(worktreeWrites(handle)[2] ?? "");

    handle.emitStdout(desktopWidgetFrame(thirdRequestId, worktreeData(30, 5)));
    handle.emitStdout(desktopWidgetFrame(secondRequestId, worktreeData(1, 1)));
    await flushReplies();

    expect(session.getState().workspace?.worktree).toMatchObject({ added: 30, deleted: 5 });

    handle.resolveExited({ code: 0, signal: null });
  });
});

// ---------------------------------------------------------------------------
// Command discovery (desktop-pending-work T6, S6): the composer's slash list
// is ONLY ever what the child answers for pi's own `get_commands` command —
// an ordinary RPC command correlated by `id`, exactly like the identity
// reads, never a /gentle:desktop prompt and never a hardcoded replica.
// ---------------------------------------------------------------------------

describe("command discovery (desktop-pending-work T6, S6)", () => {
  function desktopWidgetFrame(requestId: string, data: unknown): string {
    return JSON.stringify({
      type: "extension_ui_request",
      id: "ui-desktop",
      method: "setWidget",
      widgetKey: "gentle-desktop-rpc",
      widgetLines: [JSON.stringify({ schema: "gentle-shell.desktop-rpc/v1", kind: "response", requestId, data })],
    });
  }

  function controlRequestId(write: string): string {
    const prompt = JSON.parse(write) as { type: string; message: string };
    if (prompt.type !== "prompt" || !prompt.message.startsWith("/gentle:desktop ")) {
      throw new Error(`expected a /gentle:desktop prompt command, got: ${write}`);
    }
    return (JSON.parse(prompt.message.slice("/gentle:desktop ".length)) as { requestId: string }).requestId;
  }

  async function flushReplies(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const CAPABILITIES_DATA = {
    schema: "gentle-shell.desktop-rpc/v1",
    command: "gentle:desktop",
    widget: "gentle-desktop-rpc",
    methods: ["capabilities", "get_subscription_usage"],
    events: ["rate_limit"],
  };

  async function adoptChannel(handle: FakeProcessHandle): Promise<void> {
    const probeWrite = handle.writes.find((write) => write.includes("capabilities"));
    if (!probeWrite) throw new Error("expected a capabilities probe write");
    handle.emitStdout(desktopWidgetFrame(controlRequestId(probeWrite), CAPABILITIES_DATA));
    await flushReplies();
  }

  function writesOf(handle: FakeProcessHandle, type: string): string[] {
    return handle.writes.filter((write) => (JSON.parse(write) as { type?: string }).type === type);
  }

  function commandId(write: string): string {
    const id = (JSON.parse(write) as { id?: string }).id;
    if (!id) throw new Error(`expected a correlation id on: ${write}`);
    return id;
  }

  function commandsReply(id: string, commands: unknown): string {
    return JSON.stringify({ type: "response", id, command: "get_commands", success: true, data: { commands } });
  }

  /** The captured wire frame from __fixtures__/commands-contract.jsonl: the
   * real shape pi answers with (the extension entry carries `sourceInfo`, the
   * app ignores it). */
  function fixtureCommands(): unknown[] {
    const lines = readFileSync(path.join(__dirname, "..", "rpc", "__fixtures__", "commands-contract.jsonl"), "utf8")
      .trim()
      .split("\n");
    const frame = JSON.parse(lines[1] ?? "{}") as { command: string; data: { commands: unknown[] } };
    if (frame.command !== "get_commands") throw new Error(`unexpected fixture frame: ${lines[1]}`);
    return frame.data.commands;
  }

  it("requests get_commands once, after the probe, as an ordinary correlated command, and folds the answer in the order received", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    expect(handle.writes).toHaveLength(1);
    expect(handle.writes[0]).toContain("capabilities");

    await adoptChannel(handle);

    // An ORDINARY RPC command (never a /gentle:desktop prompt), requested
    // exactly once, correlated by its own id — and the usage read stays the
    // child's last control write, the ordering the T3 pins observe.
    const commandWrites = writesOf(handle, "get_commands");
    expect(commandWrites).toHaveLength(1);
    const request = JSON.parse(commandWrites[0] ?? "{}") as { type: string; id?: string };
    expect(request.type).toBe("get_commands");
    expect(typeof request.id).toBe("string");
    expect(handle.writes[handle.writes.length - 1]).toContain("/gentle:desktop");

    handle.emitStdout(commandsReply(String(request.id), fixtureCommands()));
    await flushReplies();

    // The order is the child's; sourceInfo is not carried; the prompt entry
    // genuinely has no description and none is invented.
    expect(session.getState().commands).toEqual([
      { name: "gentle:desktop", description: "Open the desktop control channel", source: "extension" },
      { name: "review", description: "Run the rdd review flow", source: "prompt" },
      { name: "skill:commit", source: "skill" },
    ]);
    expect(session.getState().commands?.[2]).not.toHaveProperty("description");
    // Command chrome never becomes transcript traffic.
    expect(session.getState().messages).toEqual([]);

    // Requested ONCE per child: a later settled turn asks nothing again.
    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    expect(writesOf(handle, "get_commands")).toHaveLength(1);

    handle.resolveExited({ code: 0, signal: null });
  });

  it("a reopened chat requests get_commands too, after the probe", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {}, sessionPath: "/a/sess-1.jsonl" });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    expect(JSON.parse(handle.writes[0] ?? "{}")).toMatchObject({ type: "get_messages" });
    handle.emitStdout(
      JSON.stringify({ type: "response", id: commandId(handle.writes[0] ?? ""), command: "get_messages", success: true, data: { messages: [] } }),
    );
    await flushReplies();
    expect(handle.writes[1]).toContain("capabilities");

    await adoptChannel(handle);
    expect(writesOf(handle, "get_commands")).toHaveLength(1);

    handle.emitStdout(commandsReply(commandId(writesOf(handle, "get_commands")[0] ?? ""), fixtureCommands()));
    await flushReplies();
    expect(session.getState().commands).toHaveLength(3);

    handle.resolveExited({ code: 0, signal: null });
  });

  it("drops an entry without a non-empty string name, an entry with an unknown source, and a non-string description", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    await adoptChannel(handle);
    const id = commandId(writesOf(handle, "get_commands")[0] ?? "");

    handle.emitStdout(commandsReply(id, [
      { name: "review", description: "Run the rdd review flow", source: "prompt" },
      { name: "", source: "prompt" }, // empty name
      { source: "prompt" }, // no name at all
      { name: 42, source: "prompt" }, // non-string name
      { name: "mystery", source: "host" }, // unknown source — dropped, never coerced
      { name: "no-description-string", description: 7, source: "skill" },
      { name: "skill:commit", source: "skill" },
    ]));
    await flushReplies();

    // Fail closed: the broken entries contribute nothing, in neither state.
    expect(session.getState().commands).toEqual([
      { name: "review", description: "Run the rdd review flow", source: "prompt" },
      { name: "skill:commit", source: "skill" },
    ]);

    handle.resolveExited({ code: 0, signal: null });
  });

  it("a malformed or failed correlated answer stores nothing — never an invented list", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    await adoptChannel(handle);
    const id = commandId(writesOf(handle, "get_commands")[0] ?? "");

    // The first malformed variant is genuinely correlated (it settles the
    // pending id); the later ones arrive late — every one of them must leave
    // the list absent, because there is no previous list to keep.
    handle.emitStdout(commandsReply(id, "not-an-array")); // non-array commands
    await flushReplies();
    expect(session.getState().commands).toBeUndefined();

    handle.emitStdout(JSON.stringify({ type: "response", id, command: "get_commands", success: false, error: "boom" }));
    handle.emitStdout(JSON.stringify({ type: "response", id, command: "get_commands", success: true })); // data missing entirely
    await flushReplies();
    expect(session.getState().commands).toBeUndefined();

    handle.resolveExited({ code: 0, signal: null });
  });

  it("a mismatched or wrong-command answer changes nothing; the right one still folds", async () => {
    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    handle.emitStdout(JSON.stringify({ type: "agent_settled" }));
    await adoptChannel(handle);
    const id = commandId(writesOf(handle, "get_commands")[0] ?? "");

    // A different id, then the pending id under a different command: neither
    // may fold, and neither may consume the pending id.
    handle.emitStdout(commandsReply("not-the-pending-id", fixtureCommands()));
    handle.emitStdout(JSON.stringify({ type: "response", id, command: "get_state", success: true, data: {} }));
    await flushReplies();
    expect(session.getState().commands).toBeUndefined();

    handle.emitStdout(commandsReply(id, fixtureCommands()));
    await flushReplies();
    expect(session.getState().commands).toHaveLength(3);

    handle.resolveExited({ code: 0, signal: null });
  });
});

// -----------------------------------------------------------------------
// The ODD phase (desktop-pending-work T5, S5): `session_state_changed`
// rides the desktop-rpc widget channel as an unsolicited event (no
// requestId — events never settle requests) and folds into
// ChatState.oddPhase — a READ of what the child published, never inferred
// from transcript text, never derived from a tool name. The fixture
// carries the three wire shapes in order: a published phase, an
// unrecognized token, and the owner's clear (the field OMITTED).
// -----------------------------------------------------------------------
describe("PiSession: session_state_changed (ODD phase, desktop-pending-work T5)", () => {
  it("the captured wire frames fold the published phase, drop an unrecognized token, and clear by omission", () => {
    const lines = readFileSync(path.join(__dirname, "..", "rpc", "__fixtures__", "session-state-changed.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(3);
    const [setPhase, unknownToken, cleared] = lines;
    if (!setPhase || !unknownToken || !cleared) throw new Error("fixture session-state-changed.jsonl is incomplete");

    const { spawner, handles } = createFakeSpawner();
    const session = new PiSession({ spawner, locator: fakeLocator, env: {} });
    const pushes: ChatState[] = [];
    session.on("state", (state) => pushes.push(state));
    session.start();
    const handle = handles[0];
    if (!handle) throw new Error("no spawned handle");

    // A frame carrying a token from the closed set sets the phase.
    handle.emitStdout(setPhase);
    expect(session.getState().oddPhase).toBe("exploring");
    expect(pushes).toHaveLength(1);

    // An unrecognized token contributes nothing: no fold, no push, and the
    // last published phase is kept — never coerced to something else.
    handle.emitStdout(unknownToken);
    expect(session.getState().oddPhase).toBe("exploring");
    expect(pushes).toHaveLength(1);

    // Cleared means the field is OMITTED from data: the indicator drops by
    // omission — never a placeholder, never a stale phase.
    handle.emitStdout(cleared);
    expect("oddPhase" in session.getState()).toBe(false);
    expect(pushes).toHaveLength(2);

    handle.resolveExited({ code: 0, signal: null });
  });
});
