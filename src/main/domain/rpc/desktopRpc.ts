/**
 * Client base for gentle-pi's desktop control channel
 * (`gentle-shell.desktop-rpc/v1`). A request is a `/gentle:desktop <json>`
 * prompt; the domain answer NEVER comes back as that prompt's `response` —
 * it arrives as a `setWidget` frame on the `gentle-desktop-rpc` widget key,
 * correlated by `requestId` (gentle-pi `docs/desktop-rpc.md`; app-side
 * contract in `odd/tasks/desktop-rpc-client.md` S10).
 *
 * Pure domain module (hexagonal main process, see src/README.md): no
 * Electron or Node process imports, global timers only so tests can drive
 * them with `vi.useFakeTimers()`. Wired into `PiSession` in T2: its `send`
 * is bound to the spawned child's stdin there (it only exists after
 * spawn), and `handleLine` feeds every `gentle-desktop-rpc` setWidget
 * frame to `handleWidget` BEFORE the chat reducer — the control channel's
 * frames are never chat state (odd/tasks/desktop-rpc-client.md S11).
 */

export const DESKTOP_RPC_SCHEMA = "gentle-shell.desktop-rpc/v1";
export const DESKTOP_RPC_WIDGET_KEY = "gentle-desktop-rpc";
export const DESKTOP_RPC_COMMAND = "gentle:desktop";
export const DESKTOP_RPC_MAX_REQUEST_BYTES = 64 * 1024;
export const DESKTOP_RPC_DEFAULT_TIMEOUT_MS = 5000;

/** Server-side method names are lowercase, digits and underscores, 1..64 chars. */
export const DESKTOP_RPC_METHOD_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

const DESKTOP_RPC_PROMPT_PREFIX = `/${DESKTOP_RPC_COMMAND} `;
const REQUEST_ID_MAX_LENGTH = 128;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type DesktopRpcError =
  | { kind: "timeout"; detail?: string }
  | { kind: "disposed"; detail?: string }
  /** Client-side requestId validation; distinct from the SERVER's own
   * `invalid_request` code, which surfaces as `server_error`. */
  | { kind: "invalid_request_id"; detail?: string }
  | { kind: "invalid_method"; detail?: string }
  | { kind: "request_too_large"; detail?: string }
  | { kind: "malformed_reply"; detail?: string }
  /** The injected `send` threw synchronously: the request was never
   * written, so it is settled here instead of rejecting the promise or
   * leaking a pending entry. */
  | { kind: "send_failed"; detail?: string }
  | { kind: "schema_mismatch"; detail?: string }
  | { kind: "unsupported_method"; detail?: string }
  /** Any server code other than `unsupported_method`. `code` is preserved
   * verbatim and absent when the server omitted it (never invented);
   * `message` falls back to a neutral string when the envelope has none. */
  | { kind: "server_error"; code?: string; message: string };

export type DesktopRpcReply = { ok: true; data: unknown } | { ok: false; error: DesktopRpcError };

export type DesktopRpcCapabilities = {
  schema: string;
  command: string;
  widget: string;
  methods: string[];
  events: string[];
};

// ---------------------------------------------------------------------------
// Frame parsing
// ---------------------------------------------------------------------------

export type DesktopRpcFrame = {
  kind: "response" | "event" | "malformed" | "schema_mismatch";
  schema?: string;
  requestId?: string;
  data?: unknown;
  error?: unknown;
  event?: string;
  seq?: number;
  raw: string;
};

/**
 * Parses one `setWidget` reply into a `DesktopRpcFrame`. Returns `undefined`
 * for any widget key other than `gentle-desktop-rpc` or for missing lines.
 * Never throws: a JSON.parse failure yields a `malformed` frame carrying
 * whatever `requestId` could be recovered from the raw text (`undefined`
 * when none). A frame whose JSON parses but lacks a string `schema` or a
 * `kind` of `response`/`event` is malformed too — a real reply always has
 * both.
 */
export function parseDesktopRpcWidget(
  widgetKey: string,
  widgetLines: readonly string[] | undefined,
): DesktopRpcFrame | undefined {
  if (widgetKey !== DESKTOP_RPC_WIDGET_KEY) return undefined;
  const raw = widgetLines?.[0];
  if (raw === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "malformed", requestId: recoverRequestId(raw), raw };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "malformed", requestId: recoverRequestId(raw), raw };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.schema !== "string" || (obj.kind !== "response" && obj.kind !== "event")) {
    return { kind: "malformed", requestId: requestIdFrom(obj, raw), raw };
  }
  if (obj.schema !== DESKTOP_RPC_SCHEMA) {
    // A frame from a different specification version is not a trustworthy v1
    // response (docs/desktop-rpc.md: never infer support from a later
    // version); mark it so callers can settle with schema_mismatch instead
    // of treating it as data.
    return { kind: "schema_mismatch", schema: obj.schema, requestId: asRequestId(obj), raw };
  }
  return {
    kind: obj.kind,
    schema: obj.schema,
    requestId: asRequestId(obj),
    data: obj.data,
    error: obj.error,
    event: typeof obj.event === "string" ? obj.event : undefined,
    seq: typeof obj.seq === "number" ? obj.seq : undefined,
    raw,
  };
}

function asRequestId(obj: Record<string, unknown>): string | undefined {
  return typeof obj.requestId === "string" ? obj.requestId : undefined;
}

function requestIdFrom(obj: Record<string, unknown>, raw: string): string | undefined {
  // requestId comes straight from the parsed object when it is a string;
  // otherwise whatever can be recovered from the raw text (undefined for
  // requestId: null — an uncorrelatable reply must never be matched).
  return asRequestId(obj) ?? recoverRequestId(raw);
}

function recoverRequestId(raw: string): string | undefined {
  const match = /"requestId"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (!match) return undefined;
  try {
    const decoded: unknown = JSON.parse(`"${match[1]}"`);
    return typeof decoded === "string" ? decoded : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Envelope building
// ---------------------------------------------------------------------------

let utf8ByteLength: (value: string) => number = defaultUtf8ByteLength;

function defaultUtf8ByteLength(value: string): number {
  // TextEncoder is a global in both Node and Electron main; no import needed.
  const encoder = new TextEncoder();
  utf8ByteLength = (text) => encoder.encode(text).length;
  return utf8ByteLength(value);
}

/**
 * Builds the `/gentle:desktop` prompt for one request. Returns an error
 * instead of throwing for: an invalid method name, an empty or
 * over-128-character `requestId`, or a serialized body over the byte cap.
 */
export function buildDesktopRpcPrompt(input: {
  requestId: string;
  method: string;
  params?: Record<string, unknown>;
}): { ok: true; message: string } | { ok: false; error: DesktopRpcError } {
  if (!DESKTOP_RPC_METHOD_PATTERN.test(input.method)) {
    return {
      ok: false,
      error: {
        kind: "invalid_method",
        detail: `method must match /^[a-z][a-z0-9_]{0,63}$/: ${JSON.stringify(input.method)}`,
      },
    };
  }
  if (input.requestId.length < 1 || input.requestId.length > REQUEST_ID_MAX_LENGTH) {
    return {
      ok: false,
      error: {
        kind: "invalid_request_id",
        detail: `requestId must be 1..${REQUEST_ID_MAX_LENGTH} characters, got ${input.requestId.length}`,
      },
    };
  }
  const body = JSON.stringify({
    schema: DESKTOP_RPC_SCHEMA,
    requestId: input.requestId,
    method: input.method,
    params: input.params ?? {},
  });
  if (utf8ByteLength(body) > DESKTOP_RPC_MAX_REQUEST_BYTES) {
    return {
      ok: false,
      error: {
        kind: "request_too_large",
        detail: `serialized request is ${utf8ByteLength(body)} bytes, cap is ${DESKTOP_RPC_MAX_REQUEST_BYTES}`,
      },
    };
  }
  return { ok: true, message: `${DESKTOP_RPC_PROMPT_PREFIX}${body}` };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

type PendingRequest = {
  resolve: (reply: DesktopRpcReply) => void;
  timer: ReturnType<typeof setTimeout>;
};

let requestCounter = 0;

function generateRequestId(): string {
  requestCounter += 1;
  return `desktop-rpc-${Date.now().toString(36)}-${requestCounter}`;
}

/**
 * Sends desktop-rpc requests through an injected `send` and settles each one
 * from its correlated `gentle-desktop-rpc` widget frame.
 */
export class DesktopRpcClient {
  private readonly send: (message: string) => void;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(deps: { send: (message: string) => void; timeoutMs?: number }) {
    this.send = deps.send;
    this.timeoutMs = deps.timeoutMs ?? DESKTOP_RPC_DEFAULT_TIMEOUT_MS;
  }

  /** Pending (unsettled) request count, for tests and diagnostics. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Sends one request and resolves with its reply. The requestId is
   * generated here and correlates the eventual `setWidget` frame; the
   * prompt's own `response` (which carries `disposition: "handled"` at
   * most) is NOT the domain answer. A silent channel must therefore
   * surface as a timeout, never as success — see `handleWidget`.
   */
  request(method: string, params?: Record<string, unknown>): Promise<DesktopRpcReply> {
    const requestId = generateRequestId();
    const built = buildDesktopRpcPrompt({ requestId, method, params });
    if (!built.ok) return Promise.resolve({ ok: false, error: built.error });
    return new Promise<DesktopRpcReply>((resolve) => {
      const timer = setTimeout(() => {
        // Settle from the map only if still pending; a correlated frame that
        // already settled removed the entry, so no double settlement.
        const entry = this.pending.get(requestId);
        if (!entry) return;
        this.pending.delete(requestId);
        entry.resolve({
          ok: false,
          error: {
            kind: "timeout",
            detail: `request ${requestId} for ${method} got no correlated frame within ${this.timeoutMs}ms`,
          },
        });
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, timer });
      try {
        this.send(built.message);
      } catch (error) {
        // An injected send that throws (e.g. a dead transport) must not
        // turn into a rejected promise — callers settle on DesktopRpcReply,
        // never on exceptions — nor leave the pending entry behind to leak
        // until its timer fires.
        this.pending.delete(requestId);
        clearTimeout(timer);
        return resolve({
          ok: false,
          error: { kind: "send_failed", detail: error instanceof Error ? error.message : String(error) },
        });
      }
    });
  }

  /**
   * Feeds one `setWidget` reply into the correlation map. The prompt
   * response may report `data.disposition: "handled"` — that is NOT a
   * domain answer and must never settle a request; only the widget frame
   * correlated by `requestId` does, so a silent channel surfaces as a
   * timeout, never as success (odd/tasks/desktop-rpc-client.md S10).
   */
  handleWidget(widgetKey: string, widgetLines: readonly string[] | undefined): void {
    const frame = parseDesktopRpcWidget(widgetKey, widgetLines);
    if (!frame || !frame.requestId) return;
    // An unsolicited `kind: "event"` frame is never a reply (docs/
    // desktop-rpc.md: one response per request; events are published on
    // this same widget channel without a requestId). Even if one carried a
    // matching requestId, it must not settle a pending request.
    if (frame.kind === "event") return;
    const entry = this.pending.get(frame.requestId);
    if (!entry) return; // unknown or already-settled requestId: ignore
    this.pending.delete(frame.requestId);
    clearTimeout(entry.timer);
    entry.resolve(replyFromFrame(frame));
  }

  /**
   * Probes the child's advertised surface via the `capabilities` method.
   * Returns the advertised `{ schema, command, widget, methods, events }` on
   * success and `undefined` on timeout, error or unusable payload. It never
   * returns a hardcoded or inferred method list: the captured fixture
   * proves the list can grow (it advertises 14 methods, including
   * `apply_profile`, which earlier specifications did not know about).
   */
  async probe(): Promise<DesktopRpcCapabilities | undefined> {
    const reply = await this.request("capabilities");
    if (!reply.ok) return undefined;
    return capabilitiesFromData(reply.data);
  }

  /** Clears every timer and settles every pending request as `disposed`. */
  dispose(): void {
    for (const [requestId, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, error: { kind: "disposed", detail: `request ${requestId} disposed` } });
    }
    this.pending.clear();
  }
}

// ---------------------------------------------------------------------------
// Frame → reply mapping
// ---------------------------------------------------------------------------

function replyFromFrame(frame: DesktopRpcFrame): DesktopRpcReply {
  if (frame.kind === "malformed") {
    return { ok: false, error: { kind: "malformed_reply", detail: frame.raw } };
  }
  if (frame.kind === "schema_mismatch") {
    return {
      ok: false,
      error: {
        kind: "schema_mismatch",
        detail: `frame schema ${JSON.stringify(frame.schema)} does not match ${DESKTOP_RPC_SCHEMA}`,
      },
    };
  }
  if (frame.error !== undefined) {
    return { ok: false, error: serverError(frame.error) };
  }
  return { ok: true, data: frame.data };
}

// The error `code` list belongs to the server (gentle-pi lib/desktop-rpc.ts;
// docs/desktop-rpc.md): invalid_request, unknown_store, read_only,
// invalid_data, revision_conflict, write_failed, unsupported_method,
// permission_unavailable, permission_denied, config_unavailable,
// usage_unavailable, design_unavailable, jobs_unavailable,
// agents_unavailable, profiles_unavailable, unknown_profile,
// profile_apply_busy, not_found, internal_error. This client does not
// enumerate them: any code other than unsupported_method — including one
// added by a future server version — surfaces as server_error with the code
// preserved verbatim, never reinterpreted, so the UI can tell "temporarily
// unavailable" from a bad request. unsupported_method is lifted out only
// because callers gate on it. When the envelope omits `code` or `message`,
// the client keeps `code` absent and falls back to a neutral message; it
// never invents a code.
function serverError(error: unknown): DesktopRpcError {
  let code: string | undefined;
  let message: string | undefined;
  if (typeof error === "string") {
    message = error;
  } else if (typeof error === "object" && error !== null) {
    const obj = error as Record<string, unknown>;
    if (typeof obj.code === "string") code = obj.code;
    if (typeof obj.message === "string") message = obj.message;
    else if (typeof obj.detail === "string") message = obj.detail;
  }
  if (code === "unsupported_method") {
    return { kind: "unsupported_method", detail: message };
  }
  return {
    kind: "server_error",
    code,
    message: message ?? "the server reported an error without a message",
  };
}

function capabilitiesFromData(data: unknown): DesktopRpcCapabilities | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const obj = data as Record<string, unknown>;
  const methods = stringList(obj.methods);
  const events = stringList(obj.events);
  if (!methods || !events) return undefined;
  if (typeof obj.command !== "string" || typeof obj.widget !== "string" || typeof obj.schema !== "string") {
    return undefined;
  }
  return { schema: obj.schema, command: obj.command, widget: obj.widget, methods, events };
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
}
