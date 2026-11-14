import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_RPC_COMMAND,
  DESKTOP_RPC_DEFAULT_TIMEOUT_MS,
  DESKTOP_RPC_MAX_REQUEST_BYTES,
  DESKTOP_RPC_SCHEMA,
  DESKTOP_RPC_WIDGET_KEY,
  DesktopRpcClient,
  buildDesktopRpcPrompt,
  parseDesktopRpcWidget,
} from "./desktopRpc";

// NOTE: `desktop-rpc-capabilities.jsonl` is a real capture from a live
// `gentle-shell --mode rpc` child (see odd/tasks/desktop-rpc-client.md T0/L6),
// not a constructed sample. Its method list is authoritative evidence that the
// advertised surface can grow beyond what any earlier spec knew about.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readFixtureLines(name: string): string[] {
  const raw = readFileSync(path.join(__dirname, "__fixtures__", name), "utf8");
  return raw.split("\n").filter((line) => line.trim().length > 0);
}

function fixtureWidget(): { widgetKey: string; widgetLines: string[] } {
  const lines = readFixtureLines("desktop-rpc-capabilities.jsonl");
  const first = lines[0];
  if (first === undefined) throw new Error("fixture desktop-rpc-capabilities.jsonl is empty");
  const envelope = JSON.parse(first) as { widgetKey: string; widgetLines: string[] };
  return { widgetKey: envelope.widgetKey, widgetLines: envelope.widgetLines };
}

function requestIdOf(sentMessage: string | undefined): string {
  if (sentMessage === undefined) throw new Error("nothing was sent");
  const body = JSON.parse(sentMessage.slice(`/${DESKTOP_RPC_COMMAND} `.length)) as { requestId: string };
  return body.requestId;
}

function frameFor(requestId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: DESKTOP_RPC_SCHEMA,
    kind: "response",
    requestId,
    data: { ok: true },
    ...extra,
  });
}

function makeClient() {
  const sent: string[] = [];
  const client = new DesktopRpcClient({ send: (message) => sent.push(message) });
  return { client, sent };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("buildDesktopRpcPrompt", () => {
  it("builds the exact /gentle:desktop message without params", () => {
    const built = buildDesktopRpcPrompt({ requestId: "r-1", method: "capabilities" });
    expect(built).toEqual({
      ok: true,
      message: `/gentle:desktop {"schema":"${DESKTOP_RPC_SCHEMA}","requestId":"r-1","method":"capabilities","params":{}}`,
    });
  });

  it("builds the exact /gentle:desktop message with params", () => {
    const built = buildDesktopRpcPrompt({ requestId: "r-2", method: "set_config", params: { theme: "dark" } });
    expect(built).toEqual({
      ok: true,
      message: `/gentle:desktop {"schema":"${DESKTOP_RPC_SCHEMA}","requestId":"r-2","method":"set_config","params":{"theme":"dark"}}`,
    });
  });

  it("rejects an invalid method name without throwing", () => {
    for (const method of ["Bad-Method", "1lowercase", "", "x".repeat(65), "has space"]) {
      const built = buildDesktopRpcPrompt({ requestId: "r-3", method });
      expect(built.ok).toBe(false);
      if (!built.ok) expect(built.error.kind).toBe("invalid_method");
    }
  });

  it("rejects an empty or over-128-character requestId without throwing", () => {
    for (const requestId of ["", "x".repeat(129)]) {
      const built = buildDesktopRpcPrompt({ requestId, method: "capabilities" });
      expect(built.ok).toBe(false);
      if (!built.ok) expect(built.error.kind).toBe("invalid_request_id");
    }
    expect(buildDesktopRpcPrompt({ requestId: "x".repeat(128), method: "capabilities" }).ok).toBe(true);
  });

  it("rejects a serialized body over the byte cap", () => {
    const built = buildDesktopRpcPrompt({
      requestId: "r-4",
      method: "set_config",
      params: { blob: "x".repeat(DESKTOP_RPC_MAX_REQUEST_BYTES) },
    });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error.kind).toBe("request_too_large");
  });
});

describe("parseDesktopRpcWidget", () => {
  it("parses the captured fixture into a response frame with both advertised lists", () => {
    const { widgetKey, widgetLines } = fixtureWidget();
    const frame = parseDesktopRpcWidget(widgetKey, widgetLines);
    expect(frame).toBeDefined();
    expect(frame?.kind).toBe("response");
    expect(frame?.schema).toBe(DESKTOP_RPC_SCHEMA);
    expect(frame?.requestId).toBe("fixture-1");
    const data = frame?.data as { methods: string[]; events: string[] };
    expect(data.methods).toHaveLength(14);
    expect(data.methods).toContain("apply_profile");
    expect(data.events).toHaveLength(7);
    expect(frame?.raw).toBe(widgetLines[0]);
  });

  it("returns undefined for a foreign widget key or missing lines", () => {
    const { widgetLines } = fixtureWidget();
    expect(parseDesktopRpcWidget("some-other-widget", widgetLines)).toBeUndefined();
    expect(parseDesktopRpcWidget(DESKTOP_RPC_WIDGET_KEY, undefined)).toBeUndefined();
    expect(parseDesktopRpcWidget(DESKTOP_RPC_WIDGET_KEY, [])).toBeUndefined();
  });

  it("returns a malformed frame (recovering whatever requestId it can) without throwing", () => {
    const malformed = parseDesktopRpcWidget(DESKTOP_RPC_WIDGET_KEY, ["{not json at all"]);
    expect(malformed?.kind).toBe("malformed");
    expect(malformed?.requestId).toBeUndefined();

    // Valid JSON but an unknown kind: requestId recovered from the parsed object.
    const recoveredKind = parseDesktopRpcWidget(DESKTOP_RPC_WIDGET_KEY, [
      '{"schema":"' + DESKTOP_RPC_SCHEMA + '","kind":"resp","requestId":"rec-9"}',
    ]);
    expect(recoveredKind?.kind).toBe("malformed");
    expect(recoveredKind?.requestId).toBe("rec-9");

    // Unparseable JSON: requestId recovered from the raw text.
    const recoveredRaw = parseDesktopRpcWidget(DESKTOP_RPC_WIDGET_KEY, ['{"requestId":"rec-8"']);
    expect(recoveredRaw?.kind).toBe("malformed");
    expect(recoveredRaw?.requestId).toBe("rec-8");
  });
});

describe("DesktopRpcClient.request", () => {
  it("sends the built prompt exactly once and settles on the correlated frame", async () => {
    const { client, sent } = makeClient();
    const promise = client.request("get_config", { section: "theme" });
    expect(sent).toHaveLength(1);
    const requestId = requestIdOf(sent[0]);
    client.handleWidget(DESKTOP_RPC_WIDGET_KEY, [frameFor(requestId, { data: { resolved: true } })]);
    await expect(promise).resolves.toEqual({ ok: true, data: { resolved: true } });
    expect(client.pendingCount).toBe(0);
  });

  it("never calls send for an invalid request and settles with the validation error", async () => {
    const { client, sent } = makeClient();
    await expect(client.request("Bad-Method")).resolves.toMatchObject({ ok: false, error: { kind: "invalid_method" } });
    await expect(client.request("caps", { blob: "x".repeat(DESKTOP_RPC_MAX_REQUEST_BYTES) })).resolves.toMatchObject({
      ok: false,
      error: { kind: "request_too_large" },
    });
    expect(sent).toHaveLength(0);
    expect(client.pendingCount).toBe(0);
  });

  it("does not settle twice on a duplicate frame and does not resurrect a settled request", async () => {
    const { client, sent } = makeClient();
    let settledCount = 0;
    const promise = client.request("get_config").then((reply) => {
      settledCount += 1;
      return reply;
    });
    const requestId = requestIdOf(sent[0]);
    const frame = [frameFor(requestId, { data: { first: true } })];
    client.handleWidget(DESKTOP_RPC_WIDGET_KEY, frame);
    await expect(promise).resolves.toEqual({ ok: true, data: { first: true } });
    client.handleWidget(DESKTOP_RPC_WIDGET_KEY, frame);
    await Promise.resolve();
    expect(settledCount).toBe(1);
    expect(client.pendingCount).toBe(0);
  });

  it("ignores a frame for an unknown requestId while other pending requests stay pending", async () => {
    const { client, sent } = makeClient();
    const first = client.request("get_config");
    const second = client.request("get_snapshot");
    expect(client.pendingCount).toBe(2);
    client.handleWidget(DESKTOP_RPC_WIDGET_KEY, [frameFor("not-a-known-id")]);
    expect(client.pendingCount).toBe(2);
    const firstId = requestIdOf(sent[0]);
    const secondId = requestIdOf(sent[1]);
    client.handleWidget(DESKTOP_RPC_WIDGET_KEY, [frameFor(secondId, { data: { which: "second" } })]);
    await expect(second).resolves.toEqual({ ok: true, data: { which: "second" } });
    expect(client.pendingCount).toBe(1);
    client.handleWidget(DESKTOP_RPC_WIDGET_KEY, [frameFor(firstId, { data: { which: "first" } })]);
    await expect(first).resolves.toEqual({ ok: true, data: { which: "first" } });
    expect(client.pendingCount).toBe(0);
  });

  it("settles with kind timeout after the timer fires, with no late second settlement", async () => {
    const { client, sent } = makeClient();
    let settledCount = 0;
    const promise = client.request("slow_method").then((reply) => {
      settledCount += 1;
      return reply;
    });
    expect(client.pendingCount).toBe(1);
    vi.advanceTimersByTime(DESKTOP_RPC_DEFAULT_TIMEOUT_MS);
    await expect(promise).resolves.toMatchObject({ ok: false, error: { kind: "timeout" } });
    expect(client.pendingCount).toBe(0);
    expect(settledCount).toBe(1);
    // A late frame for the already-timed-out id must not settle anything again.
    client.handleWidget(DESKTOP_RPC_WIDGET_KEY, [frameFor(requestIdOf(sent[0]))]);
    await Promise.resolve();
    expect(settledCount).toBe(1);
    expect(client.pendingCount).toBe(0);
  });

  it("surfaces a server error envelope as unsupported_method with its detail", async () => {
    const { client, sent } = makeClient();
    const promise = client.request("no_such_method");
    const requestId = requestIdOf(sent[0]);
    client.handleWidget(DESKTOP_RPC_WIDGET_KEY, [
      frameFor(requestId, {
        data: undefined,
        error: { code: "unsupported_method", message: "Unknown method: no_such_method" },
      }),
    ]);
    await expect(promise).resolves.toEqual({
      ok: false,
      error: { kind: "unsupported_method", detail: "Unknown method: no_such_method" },
    });
  });

  it("surfaces a server usage_unavailable envelope as server_error with code and message preserved", async () => {
    const { client, sent } = makeClient();
    const promise = client.request("get_subscription_usage");
    client.handleWidget(DESKTOP_RPC_WIDGET_KEY, [
      frameFor(requestIdOf(sent[0]), {
        data: undefined,
        error: { code: "usage_unavailable", message: "no provider configured" },
      }),
    ]);
    await expect(promise).resolves.toEqual({
      ok: false,
      error: { kind: "server_error", code: "usage_unavailable", message: "no provider configured" },
    });
  });

  it("surfaces an unknown future server code as server_error, never reinterpreted as invalid_request", async () => {
    const { client, sent } = makeClient();
    const promise = client.request("get_config");
    client.handleWidget(DESKTOP_RPC_WIDGET_KEY, [
      frameFor(requestIdOf(sent[0]), {
        data: undefined,
        error: { code: "something_new", message: "a code this client has never seen" },
      }),
    ]);
    await expect(promise).resolves.toEqual({
      ok: false,
      error: { kind: "server_error", code: "something_new", message: "a code this client has never seen" },
    });
  });

  it("settles a pending request as schema_mismatch when the frame advertises a different schema", async () => {
    // Parse level: a later-specification frame is a mismatch, not a v1 response
    // (docs/desktop-rpc.md: clients must not infer support from a later version).
    const parsed = parseDesktopRpcWidget(DESKTOP_RPC_WIDGET_KEY, [
      '{"schema":"gentle-shell.desktop-rpc/v2","kind":"response","requestId":"v2-1","data":{}}',
    ]);
    expect(parsed?.kind).toBe("schema_mismatch");
    expect(parsed?.requestId).toBe("v2-1");

    // Client level: the matching pending request settles instead of hanging.
    const { client, sent } = makeClient();
    const promise = client.request("get_config");
    client.handleWidget(DESKTOP_RPC_WIDGET_KEY, [
      JSON.stringify({
        schema: "gentle-shell.desktop-rpc/v2",
        kind: "response",
        requestId: requestIdOf(sent[0]),
        data: { ok: true },
      }),
    ]);
    await expect(promise).resolves.toMatchObject({ ok: false, error: { kind: "schema_mismatch" } });
    expect(client.pendingCount).toBe(0);
  });

  it("ignores a requestId: null frame without disturbing a pending request", async () => {
    // docs/desktop-rpc.md: a request without a valid correlation id is answered
    // with requestId: null; it must never be matched and never throw.
    const parsed = parseDesktopRpcWidget(DESKTOP_RPC_WIDGET_KEY, [
      `{"schema":"${DESKTOP_RPC_SCHEMA}","kind":"response","requestId":null,"data":{}}`,
    ]);
    expect(parsed?.kind).toBe("response");
    expect(parsed?.requestId).toBeUndefined();

    const { client, sent } = makeClient();
    const promise = client.request("get_config");
    client.handleWidget(DESKTOP_RPC_WIDGET_KEY, [
      `{"schema":"${DESKTOP_RPC_SCHEMA}","kind":"response","requestId":null,"data":{"ok":true}}`,
    ]);
    expect(client.pendingCount).toBe(1);
    client.handleWidget(DESKTOP_RPC_WIDGET_KEY, [frameFor(requestIdOf(sent[0]), { data: { after: "null" } })]);
    await expect(promise).resolves.toEqual({ ok: true, data: { after: "null" } });
  });

  it("never settles a pending request from a kind-event frame, even one carrying a requestId", async () => {
    // docs/desktop-rpc.md: events are published on the same widget channel
    // but are not replies; only a response settles a request. A future or
    // misbehaving server must not be able to answer a request with an event.
    const { client, sent } = makeClient();
    const promise = client.request("get_config");
    client.handleWidget(DESKTOP_RPC_WIDGET_KEY, [
      JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, kind: "event", requestId: requestIdOf(sent[0]), event: "rate_limit", data: {} }),
    ]);
    expect(client.pendingCount).toBe(1);
    client.handleWidget(DESKTOP_RPC_WIDGET_KEY, [frameFor(requestIdOf(sent[0]), { data: { real: true } })]);
    await expect(promise).resolves.toEqual({ ok: true, data: { real: true } });
  });

  it("settles as send_failed instead of rejecting when the injected send throws", async () => {
    const client = new DesktopRpcClient({
      send: () => {
        throw new Error("stdin gone");
      },
    });
    await expect(client.request("capabilities")).resolves.toMatchObject({
      ok: false,
      error: { kind: "send_failed", detail: "stdin gone" },
    });
    expect(client.pendingCount).toBe(0);
    // No leaked timer: advancing it must not produce a late settlement or
    // an unhandled rejection.
    vi.advanceTimersByTime(DESKTOP_RPC_DEFAULT_TIMEOUT_MS * 2);
    await Promise.resolve();
  });

  it("does not throw on a malformed widget line and leaves unrelated pending requests alone", async () => {
    const { client, sent } = makeClient();
    const unrelated = client.request("get_config");
    client.handleWidget(DESKTOP_RPC_WIDGET_KEY, ["{definitely not json"]);
    expect(client.pendingCount).toBe(1);
    const requestId = requestIdOf(sent[0]);
    client.handleWidget(DESKTOP_RPC_WIDGET_KEY, [frameFor(requestId, { data: { after: "malformed" } })]);
    await expect(unrelated).resolves.toEqual({ ok: true, data: { after: "malformed" } });
  });

  it("settles a pending request as malformed_reply when a malformed frame recovers its requestId", async () => {
    const { client, sent } = makeClient();
    const promise = client.request("get_config");
    const requestId = requestIdOf(sent[0]);
    const broken = '{"schema":"' + DESKTOP_RPC_SCHEMA + '","kind":"resp","requestId":"' + requestId + '"';
    client.handleWidget(DESKTOP_RPC_WIDGET_KEY, [broken]);
    await expect(promise).resolves.toMatchObject({ ok: false, error: { kind: "malformed_reply" } });
    expect(client.pendingCount).toBe(0);
  });
});

describe("DesktopRpcClient.probe", () => {
  it("returns the advertised capabilities from the captured fixture", async () => {
    const { client, sent } = makeClient();
    const promise = client.probe();
    expect(requestIdOf(sent[0])).toBeDefined();
    // The prompt response in the fixture carries disposition: "handled" — that is
    // NOT the answer; only the correlated setWidget frame settles the probe.
    // The client generates its own requestId, so the fixture's data payload is
    // re-correlated onto a frame for the request the probe actually sent.
    const { widgetLines } = fixtureWidget();
    const first = widgetLines[0];
    if (first === undefined) throw new Error("fixture widgetLines is empty");
    const fixtureData = (JSON.parse(first) as { data: unknown }).data;
    client.handleWidget(DESKTOP_RPC_WIDGET_KEY, [frameFor(requestIdOf(sent[0]), { data: fixtureData })]);
    await expect(promise).resolves.toEqual({
      schema: DESKTOP_RPC_SCHEMA,
      command: "gentle:desktop",
      widget: "gentle-desktop-rpc",
      methods: [
        "capabilities",
        "get_snapshot",
        "get_config",
        "set_config",
        "get_permission_mode",
        "set_permission_mode",
        "get_subscription_usage",
        "refresh_subscription_usage",
        "get_design_canvas",
        "list_jobs",
        "cancel_job",
        "apply_profile",
        "list_subagents",
        "cancel_subagent",
      ],
      events: [
        "config_changed",
        "permission_mode_changed",
        "rate_limit",
        "design_canvas",
        "jobs_update",
        "profile_applied",
        "agents_update",
      ],
    });
  });

  it("returns undefined on silence rather than inventing a method list", async () => {
    const { client } = makeClient();
    const promise = client.probe();
    vi.advanceTimersByTime(DESKTOP_RPC_DEFAULT_TIMEOUT_MS);
    await expect(promise).resolves.toBeUndefined();
    expect(client.pendingCount).toBe(0);
  });

  it("returns undefined when the frame carries an unusable capabilities payload", async () => {
    const { client, sent } = makeClient();
    const promise = client.probe();
    client.handleWidget(DESKTOP_RPC_WIDGET_KEY, [
      frameFor(requestIdOf(sent[0]), { data: { methods: "not-a-list" } }),
    ]);
    await expect(promise).resolves.toBeUndefined();
  });
});

describe("DesktopRpcClient.dispose", () => {
  it("settles every pending request as disposed and clears the timers", async () => {
    const { client } = makeClient();
    const first = client.request("get_config");
    const second = client.request("get_snapshot");
    expect(client.pendingCount).toBe(2);
    client.dispose();
    await expect(first).resolves.toMatchObject({ ok: false, error: { kind: "disposed" } });
    await expect(second).resolves.toMatchObject({ ok: false, error: { kind: "disposed" } });
    expect(client.pendingCount).toBe(0);
    // Timers were cleared: advancing them must not produce any late settlement
    // or unhandled rejection.
    vi.advanceTimersByTime(DESKTOP_RPC_DEFAULT_TIMEOUT_MS * 2);
    await Promise.resolve();
    expect(client.pendingCount).toBe(0);
  });
});
