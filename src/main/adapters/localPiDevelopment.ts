import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { HomeSettings, LauncherLocator, SetupService } from "../ports";
import { createLauncherLocator } from "./launcherLocator";
import { sanitizeChildEnv } from "./childEnv";

/** Opt-in source launch, not an installed-supervisor launch contract. */
export function createLocalPiDevelopment(appRoot: string, env: NodeJS.ProcessEnv = process.env): {
  locator: LauncherLocator;
  homeSettings: HomeSettings & { homeDir(): string };
  setupService: SetupService;
} {
  // Ignore the source override only for discovery of the managed installation.
  const installed = createLauncherLocator({ ...env, GENTLE_SHELL_BIN: undefined }).locate();
  const home = installed.managedAgentDir;
  if (!home) throw new Error("Local Pi development requires a managed gentle-shell installation on PATH.");
  requireDirectory(home);
  const installRoot = path.dirname(home);
  const pi = path.join(installRoot, "prefix/bin/pi");
  requireFile(pi, true);

  const selected = env.GENTLE_SHELL_BIN;
  if (!selected || !path.isAbsolute(selected)) {
    throw new Error("Local Pi development requires an absolute GENTLE_SHELL_BIN pointing to a checkout's bin/gentle-shell.mjs.");
  }
  const sourceEntry = realpathSync(selected);
  const sourceRoot = path.dirname(path.dirname(sourceEntry));
  requireFile(sourceEntry);
  if (path.basename(sourceEntry) !== "gentle-shell.mjs" || path.basename(path.dirname(sourceEntry)) !== "bin" ||
      JSON.parse(readFileSync(path.join(sourceRoot, "package.json"), "utf8")).name !== "gentle-pi") {
    throw new Error("Local Pi development requires a gentle-pi source checkout with bin/gentle-shell.mjs.");
  }
  for (const [key, expected] of Object.entries({
    GENTLE_SHELL_HOME: home,
    PI_CODING_AGENT_DIR: home,
    GENTLE_SHELL_USER_PI_HOME: home,
    GENTLE_SHELL_PI: pi,
  })) {
    if (env[key] && path.resolve(env[key]!) !== expected) {
      throw new Error(`Local Pi development conflicts with ${key}; unset it to use the installed agent home and Pi runtime.`);
    }
  }

  const childEnv: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: "1",
    PI_CODING_AGENT_DIR: home,
    GENTLE_SHELL_USER_PI_HOME: home,
    GENTLE_SHELL_NO_AUTO_SETUP: "1",
    GENTLE_SHELL_PI: pi,
  };
  // Pi's env-node shebang should use the installation's private Node when
  // available. Never execute a command obtained from descriptor contents.
  const node = path.join(installRoot, "runtime/node/bin/node");
  try {
    requireFile(node, true);
    childEnv.PATH = `${path.dirname(node)}${path.delimiter}${env.PATH ?? env.Path ?? ""}`;
  } catch {
    // Older layouts may rely on Node already on PATH, just as their launcher does.
  }

  // PiSession applies launcher overrides after the base environment: sanitize
  // this PATH too, or the private-Node override restores Desktop's local Pi bins.
  const launcherEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(sanitizeChildEnv(childEnv, appRoot))) {
    if (value !== undefined) launcherEnv[key] = value;
  }
  return {
    locator: { locate: () => ({ command: process.execPath, args: [sourceEntry, "--package-root", sourceRoot], env: launcherEnv }) },
    homeSettings: { homeArgs: () => ["--link"], homeDir: () => home },
    setupService: {
      status: async () => ({ needsChoice: false, detection: { found: true, dir: home, hasAuth: false, hasModels: false } }),
      chooseHome: async () => { throw new Error("Local Pi development uses the installed agent home; no home choice is available."); },
    },
  };
}

function requireFile(file: string, executable = false): void {
  if (!statSync(file).isFile()) throw new Error(`Local Pi development requires a file: ${file}`);
  accessSync(file, executable ? constants.X_OK : constants.R_OK);
}

function requireDirectory(directory: string): void {
  if (!statSync(directory).isDirectory()) throw new Error(`Local Pi development requires an agent directory: ${directory}`);
}
