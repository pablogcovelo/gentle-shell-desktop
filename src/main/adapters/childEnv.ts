import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * Removes this app's own dependency bins from the environment a `gentle-shell`
 * child inherits.
 *
 * Why: pi's subagent runner reuses the host runtime only when it can prove it,
 * and otherwise spawns a bare `pi` looked up on PATH (gentle-pi
 * `lib/agents-runner.ts#piCommand`). A dev launch (`pnpm dev`,
 * `pnpm dev:local-pi`) puts `<repo>/node_modules/.bin` first on PATH, and this
 * package depends on `@earendil-works/pi-coding-agent` 0.85.x, whose
 * `node_modules/.bin/pi` is that older CLI. Every subagent then booted the
 * 0.85.1 runtime instead of the managed one, which fails to load gentle-pi's
 * extensions (`createCodemodeExtension` does not exist there) and exits 1
 * before `agent_settled`.
 *
 * The desktop is a client of the agent runtime, never a provider of it, so
 * nothing under its own `node_modules` belongs on the child's PATH.
 */
export function sanitizeChildEnv(env: NodeJS.ProcessEnv, appRoot: string): NodeJS.ProcessEnv {
  const key = pathKey(env);
  const value = key === undefined ? undefined : env[key];
  if (key === undefined || value === undefined) return { ...env };

  const owned = realpathOrSelf(path.join(appRoot, "node_modules"));
  const kept = value.split(path.delimiter).filter((entry) => !isInsideAppNodeModules(entry, owned));
  return { ...env, [key]: kept.join(path.delimiter) };
}

/** Windows spells the variable `Path`; whichever spelling the environment uses is the one to rewrite. */
function pathKey(env: NodeJS.ProcessEnv): "PATH" | "Path" | undefined {
  if (env.PATH !== undefined) return "PATH";
  if (env.Path !== undefined) return "Path";
  return undefined;
}

/** A directory that is not on disk cannot be realpath'd; its literal form is the best available identity. */
function realpathOrSelf(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

function isInsideAppNodeModules(entry: string, owned: string): boolean {
  const candidate = realpathOrSelf(entry);
  const [left, right] = process.platform === "win32"
    ? [candidate.toLowerCase(), owned.toLowerCase()]
    : [candidate, owned];
  return left === right || left.startsWith(right.endsWith(path.sep) ? right : `${right}${path.sep}`);
}
