import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HOME_MODE, type HomeMode } from "@shared/bridge-types";
import type { HomeConfig } from "../domain/home/home";

/**
 * The app's own persisted config (T5's `home` + T1's workspace registry,
 * S1/S2): the same config.json entry now also holds the workspace
 * directories the user added through the panel, so an added folder
 * survives a full app restart. Extends HomeConfig (never replaces it) so
 * homeSettings/setupService keep reading the exact same shape they own.
 */
export interface AppConfig extends HomeConfig {
  /**
   * The persisted workspace directories: absolute paths, deduplicated,
   * most-recently-added first. Absent for a `{home}`-only file (backward
   * compatible) and dropped silently when the persisted value is not an
   * array of absolute paths — the same tolerance the `home` key gets.
   */
  readonly workspaces?: readonly string[];
}

export interface AppConfigStore {
  read(): AppConfig;
  write(patch: Partial<AppConfig>): AppConfig;
}

/**
 * T1 (S1/S2): the workspace-registry slice of the store. Kept separate
 * from the base AppConfigStore (read/write — what setupService and
 * homeSettings consume) so consumers that never touch workspaces keep
 * working with a read/write-only view while the concrete store implements
 * the full slice.
 */
export interface WorkspaceConfigStore extends AppConfigStore {
  /** The persisted workspace directories ([] when none). */
  listWorkspaces(): readonly string[];
  /** T1 (S2): persists a workspace directory — most-recently-added first,
   * deduplicated (re-adding an existing directory changes nothing), and
   * only ever an absolute path: anything else is refused with a clear
   * message and persists nothing. */
  addWorkspace(directory: string): AppConfig;
  /** T1: removes ONLY the persisted registry entry for `directory` —
   * never a session file, a directory or a chat. A directory without a
   * persisted entry is a no-op (the persisted file is untouched). */
  removeWorkspace(directory: string): AppConfig;
}

/**
 * JSON config under Electron's `app.getPath("userData")/config.json`
 * (T5), with `configPath` injected so this is testable without a real
 * Electron `app` — see src/main/index.ts for the real wiring. Tolerant of
 * a missing or invalid file: any read failure (ENOENT, malformed JSON, an
 * unrecognized `home` value) is treated as "no choice persisted yet"
 * instead of throwing, so a corrupt config never blocks the app from
 * starting. Each key is tolerated independently: a file whose `home` is
 * unrecognized still serves a valid `workspaces` list, and vice versa.
 */
export function createAppConfigStore(configPath: string): WorkspaceConfigStore {
  function read(): AppConfig {
    try {
      const raw = readFileSync(configPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return {};

      const home: unknown = (parsed as { home?: unknown }).home;
      const workspaces = parseWorkspaces((parsed as { workspaces?: unknown }).workspaces);
      return {
        ...(isHomeMode(home) ? { home } : {}),
        ...(workspaces ? { workspaces } : {}),
      };
    } catch {
      return {};
    }
  }

  function write(patch: Partial<AppConfig>): AppConfig {
    const next: AppConfig = { ...read(), ...patch };
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(next, null, 2));
    return next;
  }

  function listWorkspaces(): readonly string[] {
    return read().workspaces ?? [];
  }

  function addWorkspace(directory: string): AppConfig {
    if (directory.length === 0 || !path.isAbsolute(directory)) {
      throw new Error(`"${directory}" is not an absolute path — the workspace registry stores absolute directories only`);
    }
    const current = read();
    const existing = current.workspaces ?? [];
    // Dedup on the exact string, matching WorkspaceHostRegistry's own
    // findByDirectory policy: the picker returns one canonical absolute
    // path per directory, and inventing normalization here would make the
    // persisted entry drift from what creation and reuse match on.
    if (existing.includes(directory)) return current;
    return write({ workspaces: [directory, ...existing] });
  }

  function removeWorkspace(directory: string): AppConfig {
    const current = read();
    const existing = current.workspaces ?? [];
    if (!existing.includes(directory)) return current;
    return write({ workspaces: existing.filter((entry) => entry !== directory) });
  }

  return { read, write, listWorkspaces, addWorkspace, removeWorkspace };
}

/** Tolerant parse of the persisted `workspaces` key: only an array of
 * absolute path strings is kept (deduplicated, order preserved); anything
 * else reads as "no workspaces persisted", never a crash. */
function parseWorkspaces(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const deduped: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || !path.isAbsolute(entry)) continue;
    if (!deduped.includes(entry)) deduped.push(entry);
  }
  return deduped;
}

function isHomeMode(value: unknown): value is HomeMode {
  return value === HOME_MODE.LINK || value === HOME_MODE.ISOLATED;
}
