import type { ChatCommand, ChatCommandSource } from "@shared/bridge-types";

/**
 * The command catalog the host publishes (odd/tasks/palette-host-catalog
 * T1, S1/S2): `get_snapshot`'s `commands` section, shaped
 * `{ items, truncated }` where each item is
 * `{ name, description: string|null, args: string|null, terminal: boolean,
 * runnable: boolean, source }` (gentle-pi lib/desktop-feed.ts). This module
 * is the pure, fail-closed fold of that payload into the renderer-facing
 * `ChatCommand` list: it drops what the contract does not document and
 * keeps the host's order. `terminal` is NOT carried — the palette's own
 * builtin group renders its rows from `runnable`/`source`, and a
 * non-runnable builtin is only ever a "show it, say why" row (S3), never
 * a `terminal`-driven decision.
 */

/** The source values the wire documents for a catalog command (S2); the
 * closed allow-list both this parser and PiSession's `get_commands`
 * fallback fold through. Anything else is dropped, never coerced. */
export const CATALOG_SOURCES: ReadonlySet<string> = new Set<string>(["builtin", "extension", "prompt", "skill"] satisfies readonly ChatCommandSource[]);

/**
 * Folds one `get_snapshot` `commands` section payload, fail-closed: a
 * non-record payload or a non-array `items` yields `undefined` (nothing
 * folds, and a caller keeps whatever catalog it already had), and an entry
 * without a non-empty string `name`, with a `source` outside
 * `CATALOG_SOURCES`, with a non-boolean `runnable`, with a `description`
 * or `args` that is neither a string nor null/absent contributes nothing.
 * The order is the host's and is kept; `args` is carried ONLY when the
 * wire carries a string (a null or absent `args` is the wire's "absent" —
 * no placeholder is invented). `truncated` is the host's own flag about
 * the items it cut and does not shape this fold.
 */
export function parseCommandCatalog(data: unknown): readonly ChatCommand[] | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const raw = (data as { items?: unknown }).items;
  if (!Array.isArray(raw)) return undefined;
  const commands: ChatCommand[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const { name, description, args, runnable, source } = entry as Record<string, unknown>;
    if (typeof name !== "string" || name.length === 0) continue;
    if (typeof source !== "string" || !CATALOG_SOURCES.has(source)) continue;
    if (typeof runnable !== "boolean") continue;
    if (typeof description !== "undefined" && description !== null && typeof description !== "string") continue;
    if (typeof args !== "undefined" && args !== null && typeof args !== "string") continue;
    commands.push({
      name,
      ...(typeof description === "string" ? { description } : {}),
      ...(typeof args === "string" ? { args } : {}),
      runnable,
      source: source as ChatCommandSource,
    });
  }
  return commands;
}
