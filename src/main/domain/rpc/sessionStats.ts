import { THINKING_LEVEL, type SessionIdentityView, type ThinkingLevel } from "@shared/bridge-types";

/**
 * Decoders for pi's own `--mode rpc` command replies (desktop-rpc T4;
 * contract: the installed package's docs/rpc.md "get_session_stats" and
 * "get_state", typed in dist/modes/rpc/rpc-types.d.ts as `SessionStats`
 * and `RpcSessionState`). Pure domain module (hexagonal main process, see
 * src/README.md): no Node or Electron imports, never throws.
 *
 * These are ORDINARY RPC commands, not desktop-rpc ones: their answers
 * arrive as `response` frames correlated by the command's `id`, never on
 * the `gentle-desktop-rpc` widget channel.
 *
 * Modelling rule (same standard as usage.ts): the parser keeps exactly the
 * fields the contract documents, drops a wrongly typed field rather than
 * coercing, and returns `undefined` when the payload is not the
 * documented shape at all — the caller keeps the previous (last-known)
 * state, because an unavailable value must never be rendered as zero.
 *
 * Quoted field names, verified against the installed package:
 * - get_session_stats → `cost` (number), `tokens` (`input`, `output`,
 *   `cacheRead`, `cacheWrite`, `total`), `contextUsage` (`tokens`,
 *   `contextWindow`, `percent`). docs/rpc.md: "`contextUsage` is omitted
 *   when no model or context window is available" and "`contextUsage.tokens`
 *   and `contextUsage.percent` are `null` immediately after compaction".
 * - get_state → `model` ("a full Model object or null"; Model carries
 *   `id`, `name`, `provider`) and `thinkingLevel` (the closed
 *   "off|minimal|low|medium|high|xhigh|max" union). These are the
 *   EFFECTIVE values the child reports — never the last requested ones.
 */

const THINKING_LEVELS: ReadonlySet<string> = new Set<string>(Object.values(THINKING_LEVEL));

/**
 * Parses the `data` of a `get_session_stats` response into the subset of
 * SessionIdentityView this command supplies. Returns `undefined` when the
 * payload is not the documented shape (no object, or a required core
 * field — `sessionId`, `tokens`, `cost` — is missing or wrongly typed):
 * the caller must keep the previous identity instead of treating this as
 * "zero cost". `contextUsage` is optional on the wire: present-but-
 * malformed means the context fields are simply not supplied; present
 * with `null` tokens/percent is kept AS null (supplied-as-unknown, e.g.
 * right after compaction — never rendered as 0 %).
 */
export function parseSessionStats(data: unknown): Partial<SessionIdentityView> | undefined {
  if (!isRecord(data)) return undefined;
  if (typeof data.sessionId !== "string" || data.sessionId.length === 0) return undefined;
  const tokens = toTokens(data.tokens);
  if (!tokens) return undefined;
  if (typeof data.cost !== "number" || !Number.isFinite(data.cost)) return undefined;

  return { tokensTotal: tokens.total, sessionCost: data.cost, ...toContextUsage(data.contextUsage) };
}

/**
 * Parses the `data` of a `get_state` response into the subset of
 * SessionIdentityView this command supplies. Returns `undefined` when the
 * payload is not the documented shape (no object, or `thinkingLevel` —
 * required on the wire and a closed union — is missing or unknown), so a
 * stale rendering is never mistaken for a fresh one. `model` may be
 * `null` per the docs; a null or wrongly typed model supplies no model
 * identity at all, and nothing is invented for it.
 */
export function parseSessionState(data: unknown): Partial<SessionIdentityView> | undefined {
  if (!isRecord(data)) return undefined;
  if (typeof data.sessionId !== "string" || data.sessionId.length === 0) return undefined;
  if (typeof data.thinkingLevel !== "string" || !THINKING_LEVELS.has(data.thinkingLevel)) return undefined;

  return { thinkingLevel: data.thinkingLevel as ThinkingLevel, ...toModel(data.model) };
}

function toTokens(value: unknown): { total: number } | undefined {
  if (!isRecord(value)) return undefined;
  // All five documented members must be finite numbers; the view keeps
  // the session total (the per-call breakdown is not part of the compact
  // identity block, and the accumulated total must never be mistaken for
  // occupied context — that comes only from contextUsage below).
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) return undefined;
  }
  return { total: value.total as number };
}

function toContextUsage(
  value: unknown,
): { contextTokens: number | null; contextWindow: number; contextPercent: number | null } | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.contextWindow !== "number" || !Number.isFinite(value.contextWindow)) return undefined;
  // tokens/percent are numbers or exactly null (supplied-as-unknown right
  // after compaction); anything else means the field is not trustworthy
  // and supplies nothing.
  if (value.tokens !== null && (typeof value.tokens !== "number" || !Number.isFinite(value.tokens))) return undefined;
  if (value.percent !== null && (typeof value.percent !== "number" || !Number.isFinite(value.percent))) return undefined;

  return {
    contextTokens: value.tokens as number | null,
    contextWindow: value.contextWindow,
    contextPercent: value.percent as number | null,
  };
}

function toModel(value: unknown): Partial<SessionIdentityView> {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) return {};
  return {
    modelId: value.id,
    ...(typeof value.name === "string" && value.name.length > 0 ? { modelName: value.name } : {}),
    ...(typeof value.provider === "string" && value.provider.length > 0 ? { modelProvider: value.provider } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
