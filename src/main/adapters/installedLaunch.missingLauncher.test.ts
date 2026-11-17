import { expect, it, vi } from "vitest";
import { homedir } from "node:os";
import path from "node:path";
import { createHomeSettings } from "./homeSettings";
import { createLauncherLocator } from "./launcherLocator";
import { createSetupService } from "./setupService";

it.each([false, true])("keeps setup and legacy session browsing available without a launcher (pi=%s)", async (found) => {
  const write = vi.fn(() => { throw new Error("must not write"); });
  const config = { read: () => ({}), write };
  const env = { PATH: "", HOME: "/unused" };
  const locator = createLauncherLocator(env);
  const settings = createHomeSettings(config, env, locator);
  const setup = createSetupService(config, env, () => found, settings.managedHome);

  expect((await setup.status()).needsChoice).toBe(found);
  expect(settings.managedHome()).toBeUndefined();
  expect(settings.homeDir()).toBe(path.join(homedir(), ".gentle-shell", "agent"));
  expect(settings.homeArgs()).toEqual(["--isolated"]);
  expect(write).not.toHaveBeenCalled();
  expect(() => locator.locate()).toThrow(/launcher not found/);
});
