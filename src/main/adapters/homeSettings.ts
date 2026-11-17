import path from "node:path";
import { LauncherUnavailableError } from "./launcherLocator";
import { homeDirFor, resolveHomeArgs, resolveHomeMode } from "../domain/home/home";
import type { HomeSettings, LauncherLocator } from "../ports";
import type { AppConfigStore } from "./appConfigStore";

/** Resolve launch flags and session listing from the same current home contract. */
export function createHomeSettings(
  configStore: AppConfigStore,
  env: NodeJS.ProcessEnv = process.env,
  locator?: LauncherLocator,
): HomeSettings & { homeDir(): string; managedHome(): string | undefined } {
  function managedHome(): string | undefined {
    let home: string | undefined;
    try {
      home = locator?.locate().managedAgentDir;
    } catch (error) {
      if (!(error instanceof LauncherUnavailableError)) throw error;
      // Browsing and setup do not require a child; launch still uses locate().
      return undefined;
    }
    if (home && (configStore.read().home === "link" ||
        (env.GENTLE_SHELL_HOME && path.resolve(env.GENTLE_SHELL_HOME) !== home))) {
      throw new Error("The installed supervisor uses its fixed managed home. Remove the conflicting GENTLE_SHELL_HOME or persisted link choice, or explicitly select a source launcher for that home.");
    }
    return home;
  }
  return {
    managedHome,
    homeArgs: () => managedHome() ? [] : resolveHomeArgs(configStore.read(), env),
    homeDir: () => managedHome() ?? homeDirFor(resolveHomeMode(configStore.read()), env),
  };
}
