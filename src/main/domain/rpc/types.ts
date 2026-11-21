/**
 * Pure protocol types for pi's `--mode rpc` JSON-line protocol. No Node or
 * Electron imports: this file, codec.ts and chatReducer.ts must stay
 * testable without spawning a real gentle-shell process (hexagonal main
 * process, see src/README.md).
 *
 * Mirrors the authoritative shapes in the installed pi package
 * (`@earendil-works/pi-coding-agent`, resolved from node_modules):
 * - dist/modes/rpc/rpc-types.d.ts (RpcCommand,
 *   RpcExtensionUIRequest/Response)
 * - docs/rpc.md (wire examples, extension UI protocol) and
 *   dist/modes/json-event.js (the RPC-mode-specific `message_update` shape,
 *   which strips the cumulative `message` field and the `partial` snapshot
 *   that the core AgentEvent in @earendil-works/pi-agent-core still carries)
 *
 * Desktop control traffic is a different contract riding the same channel:
 * desktop-rpc wraps a JSON envelope in a `/gentle:desktop` prompt and answers
 * on the `gentle-desktop-rpc` setWidget channel, never as that prompt's
 * `response` (gentle-pi `docs/desktop-rpc.md`; see odd/tasks/
 * desktop-rpc-client.md). Do not model it as a `--mode rpc` response.
 *
 * Only the commands/events the desktop chat window needs are modeled here.
 * Everything else (bash_execution_update, queue_update, compaction_*,
 * auto_retry_*, summarization_retry_*, and any command outside the ones
 * below) decodes to `{ kind: "unknown" }` in codec.ts rather than being
 * typed — this client never sends bash or compaction commands in M1.
 */

// ---------------------------------------------------------------------------
// Commands (stdin)
// ---------------------------------------------------------------------------

export type RpcCommand =
  | { readonly type: "prompt"; readonly message: string }
  | { readonly type: "abort" }
  | { readonly type: "new_session" }
  | { readonly type: "switch_session"; readonly sessionPath: string }
  | { readonly type: "get_state"; readonly id?: string }
  /**
   * `id` is the optional request/response correlation id rpc.md documents
   * for every command ("All commands support an optional `id` field...").
   * Modeled on the commands PiSession actually correlates: `get_messages`
   * for history, and `get_session_stats`/`get_state` for the session
   * identity block (desktop-rpc T4, which must tell a late reply apart from
   * the current one).
   */
  | { readonly type: "get_session_stats"; readonly id?: string }
  | { readonly type: "get_messages"; readonly id?: string }
  /**
   * pi's own slash-command discovery (desktop-pending-work T6, S6): an
   * ordinary RPC command correlated by `id`, exactly like
   * `get_session_stats`/`get_state` — PiSession asks for it once, after the
   * channel probe adopts, and folds the answer into `ChatState.commands`.
   * That answer is the only source of the composer's slash list: no
   * hardcoded `/gentle:*` replica is kept anywhere (S6/S11), and it is NOT
   * a desktop-rpc method, so it never rides the widget channel.
   */
  | { readonly type: "get_commands"; readonly id?: string }
  /**
   * pi's own available-option reads (palette-command-arguments T1, S2/S3):
   * ordinary RPC commands correlated by `id`, exactly like
   * `get_commands`/`get_state` — PiSession sends them on demand (never a
   * /gentle:desktop prompt, never the widget channel) and answers the
   * correlated `response` frame to its caller. Verified against the
   * resolved pi build (rpc-mode.js): `get_available_models` answers
   * `{ models }` (pi-ai's readonly Model[]) and
   * `get_available_thinking_levels` answers `{ levels: string[] }`.
   */
  | { readonly type: "get_available_models"; readonly id?: string }
  | { readonly type: "get_available_thinking_levels"; readonly id?: string }
  | RpcExtensionUIResponse;

/**
 * Mirrors rpc-types.ts `RpcExtensionUIResponse` exactly: `confirm` dialogs
 * reply with `confirmed` (boolean), `select`/`input`/`editor` reply with
 * `value` (string), and any dialog can be dismissed with `cancelled: true`.
 * (The task brief shorthanded this as `{id, value|cancelled}`; the
 * authoritative rpc-types.ts has a third `confirmed` variant, which this
 * type follows so a future `confirm` dialog can be answered correctly.)
 */
export type RpcExtensionUIResponse =
  | { readonly type: "extension_ui_response"; readonly id: string; readonly value: string }
  | { readonly type: "extension_ui_response"; readonly id: string; readonly confirmed: boolean }
  | { readonly type: "extension_ui_response"; readonly id: string; readonly cancelled: true };

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * An `AgentMessage` (UserMessage | AssistantMessage | ToolResultMessage |
 * BashExecutionMessage). Only `role` is modeled; the chat reducer reads
 * `content` off assistant messages defensively at the call site instead of
 * fully typing every message variant, per the "do not over-model" scope.
 */
export interface RpcMessage {
  readonly role: string;
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// message_update deltas (`assistantMessageEvent`), RPC-mode shape: `partial`
// is always stripped, and `toolcall_start` carries `id`/`toolName` instead
// (see json-event.ts `toJsonAssistantMessageEvent`).
// ---------------------------------------------------------------------------

export type AssistantMessageEvent =
  | { readonly type: "text_start"; readonly contentIndex: number }
  | { readonly type: "text_delta"; readonly contentIndex: number; readonly delta: string }
  | { readonly type: "text_end"; readonly contentIndex: number; readonly content: string }
  | { readonly type: "thinking_start"; readonly contentIndex: number }
  | { readonly type: "thinking_delta"; readonly contentIndex: number; readonly delta: string }
  | { readonly type: "thinking_end"; readonly contentIndex: number; readonly content: string }
  | {
      readonly type: "toolcall_start";
      readonly contentIndex: number;
      readonly id: string;
      readonly toolName: string;
    }
  | { readonly type: "toolcall_delta"; readonly contentIndex: number; readonly delta: string }
  | { readonly type: "toolcall_end"; readonly contentIndex: number; readonly toolCall: unknown };

// ---------------------------------------------------------------------------
// Extension UI requests (stdout). Dialog methods (select, confirm, input,
// editor) block for a response; the rest are fire-and-forget.
// ---------------------------------------------------------------------------

import type { NotificationSeverity } from "@shared/bridge-types";

export type DialogMethod = "select" | "confirm" | "input" | "editor";
export type FireAndForgetMethod = "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text";

export type RpcExtensionUIRequest =
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "select";
      readonly title: string;
      readonly options: readonly string[];
      readonly timeout?: number;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "confirm";
      readonly title: string;
      readonly message: string;
      readonly timeout?: number;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "input";
      readonly title: string;
      readonly placeholder?: string;
      readonly timeout?: number;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "editor";
      readonly title: string;
      readonly prefill?: string;
    }
  | {
      // Exact member, verified against the resolved pi build
      // (dist/modes/rpc/rpc-types.d.ts) and docs/rpc-extension-ui.md
      // "notify": `message` is required, `notifyType` is
      // info|warning|error and defaults to "info" when omitted. The
      // codec validates both fields; a wrong-typed or unknown-severity
      // frame decodes to unknown instead.
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "notify";
      readonly message: string;
      readonly notifyType?: NotificationSeverity;
    }
  | {
      // Exact member, verified against the resolved pi build and
      // docs/rpc-extension-ui.md "setStatus": `statusKey` is required,
      // `statusText` optional — omitted/undefined CLEARS that key's entry
      // (clearing is expressible on the wire, so the reducer implements
      // it instead of keeping the last value).
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "setStatus";
      readonly statusKey: string;
      readonly statusText?: string;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: FireAndForgetMethod;
      readonly [key: string]: unknown;
    };

// ---------------------------------------------------------------------------
// Events (stdout)
// ---------------------------------------------------------------------------

export type RpcEvent =
  | { readonly type: "agent_start" }
  | { readonly type: "agent_end"; readonly willRetry?: boolean }
  | { readonly type: "agent_settled" }
  | { readonly type: "turn_start" }
  | { readonly type: "turn_end" }
  | { readonly type: "message_start"; readonly message: RpcMessage }
  | { readonly type: "message_update"; readonly assistantMessageEvent: AssistantMessageEvent }
  | { readonly type: "message_end"; readonly message: RpcMessage }
  | { readonly type: "tool_execution_start"; readonly toolCallId: string; readonly toolName: string; readonly args?: unknown }
  | { readonly type: "tool_execution_update"; readonly toolCallId: string; readonly toolName: string }
  | {
      readonly type: "tool_execution_end";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly result?: unknown;
      readonly isError: boolean;
    }
  | RpcExtensionUIRequest
  | { readonly type: "extension_error"; readonly extensionPath: string; readonly event: string; readonly error: string }
  | {
      /** gentle-pi's desktop-rpc `session_state_changed` event
       * (desktop-pending-work T5, S5, host contract L9), fed from
       * PiSession's widget-channel arm — it NEVER decodes from stdout in
       * codec.ts, because it rides the `gentle-desktop-rpc` widget channel
       * like `agents_update`/`rate_limit`, not the `--mode rpc` event
       * stream. `oddPhase` carries the RAW wire value: present means the
       * child published a phase (validated in the reducer against the
       * closed ODD_PHASE token set; an unrecognized value contributes
       * nothing, never coerced), omitted means unknown or cleared — which
       * is how the owner's clear arrives (the field is omitted from
       * `data`). */
      readonly type: "session_state_changed";
      readonly oddPhase?: unknown;
    }
  | RpcResponse;

/** Command acknowledgement envelope. The chat reducer does not act on it
 * today (M1 never correlates a command to its response), but the codec
 * still decodes it instead of falling back to `unknown` so nothing on the
 * wire silently vanishes from view. */
export type RpcResponse =
  | {
      readonly type: "response";
      readonly id?: string;
      readonly command: string;
      readonly success: true;
      readonly data?: unknown;
    }
  | { readonly type: "response"; readonly id?: string; readonly command: string; readonly success: false; readonly error: string };

export type DecodedLine = RpcEvent | { readonly kind: "unknown"; readonly raw: string };
