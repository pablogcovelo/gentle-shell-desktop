import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createLauncherLocator } from "./launcherLocator";
import { createHomeSettings } from "./homeSettings";
import { createSetupService } from "./setupService";
import type { AppConfigStore } from "./appConfigStore";

let scratch: string;
afterEach(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });
function fixture() {
  scratch = mkdtempSync(path.join(tmpdir(), "desktop-installed-"));
  const root = path.join(scratch, "install");
  mkdirSync(path.join(root, "bin"), { recursive: true });
  mkdirSync(path.join(scratch, "public"));
  writeFileSync(path.join(root, "supervisor"), "fixture");
  const wrapper = path.join(root, "bin", "gentle-shell");
  writeFileSync(wrapper, "#!/bin/sh\n");
  chmodSync(wrapper, 0o755);
  const link = path.join(scratch, "public", "gentle-shell");
  symlinkSync(wrapper, link);
  const descriptor = { Schema: "gentle-shell-user-install/v1", Destination: root, Agent: path.join(root, "agent"), Mode: "separate" };
  writeFileSync(path.join(root, "installation.json"), JSON.stringify(descriptor));
  return { root, wrapper, link, descriptor };
}
function config(home?: "link" | "isolated") {
  return { read: () => ({ home }), write: () => { throw new Error("must not write"); } } as unknown as AppConfigStore;
}
it("uses the symlinked installed supervisor and aligns flags, store home and first-run", async () => {
  const { root, link } = fixture();
  for (const env of [{ PATH: path.dirname(link) }, { GENTLE_SHELL_BIN: link }]) {
    const locator = createLauncherLocator(env);
    const settings = createHomeSettings(config(), env, locator);
    expect(locator.locate()).toEqual({ command: link, args: [], managedAgentDir: path.join(root, "agent") });
    expect(settings.homeArgs()).toEqual([]);
    expect(settings.homeDir()).toBe(path.join(root, "agent"));
    const setup = createSetupService(config(), env, () => { throw new Error("must not probe pi"); }, settings.managedHome);
    expect(await setup.status()).toEqual({ needsChoice: false, detection: { found: true, dir: path.join(root, "agent"), hasAuth: false, hasModels: false } });
    await expect(setup.chooseHome("link")).rejects.toThrow(/installed supervisor/);
  }
});
it.each(["link", "override"])("rejects conflicting %s without changing configuration", (choice) => {
  const { link } = fixture();
  const env = { GENTLE_SHELL_BIN: link, ...(choice === "override" ? { GENTLE_SHELL_HOME: "/other/agent" } : {}) };
  const settings = createHomeSettings(config(choice === "link" ? "link" : undefined), env, createLauncherLocator(env));
  expect(() => settings.homeArgs()).toThrow(/installed supervisor/);
  expect(() => settings.homeDir()).toThrow(/installed supervisor/);
});
it.each(["missing", "malformed", "oversized", "schema", "relative", "destination", "agent", "mode"])("fails clearly for a managed wrapper with %s metadata", (kind) => {
  const { root, link, descriptor } = fixture();
  const file = path.join(root, "installation.json");
  const changed = { ...descriptor, ...(kind === "schema" ? { Schema: "v99" } : {}), ...(kind === "relative" ? { Agent: "agent" } : {}), ...(kind === "destination" ? { Destination: scratch } : {}), ...(kind === "agent" ? { Agent: "/other/agent" } : {}), ...(kind === "mode" ? { Mode: "link" } : {}) };
  if (kind === "missing") rmSync(file);
  else writeFileSync(file, kind === "malformed" ? "{" : kind === "oversized" ? " ".repeat(16385) : JSON.stringify(changed));
  const env = { GENTLE_SHELL_BIN: link };
  const locator = createLauncherLocator(env);
  expect(() => locator.locate()).toThrow(/installation descriptor/);
  const settings = createHomeSettings(config(), env, locator);
  expect(() => settings.managedHome()).toThrow(/installation descriptor/);
  expect(() => settings.homeDir()).toThrow(/installation descriptor/);
});
it("rejects a private JS entry in a managed bin instead of choosing Desktop's runtime", () => {
  const { root } = fixture();
  const entry = path.join(root, "bin", "gentle-shell.mjs");
  writeFileSync(entry, "// not a public supervisor entry");
  expect(() => createLauncherLocator({ GENTLE_SHELL_BIN: entry }).locate()).toThrow(/installation descriptor/);
});
it("accepts the managed home override without forwarding source flags", () => {
  const { root, wrapper } = fixture();
  const env = { GENTLE_SHELL_BIN: wrapper, GENTLE_SHELL_HOME: path.join(root, "agent") };
  const settings = createHomeSettings(config("isolated"), env, createLauncherLocator(env));
  expect(settings.homeArgs()).toEqual([]);
  expect(settings.homeDir()).toBe(path.join(root, "agent"));
});
it("preserves explicit source launch and legacy home selection", () => {
  const env = { GENTLE_SHELL_BIN: "/source/bin/gentle-shell.mjs", GENTLE_SHELL_HOME: "/source/agent" };
  const settings = createHomeSettings(config("link"), env, createLauncherLocator(env));
  expect(settings.homeArgs()).toEqual(["--home", "/source/agent"]);
  expect(settings.homeDir()).toBe("/source/agent");
  expect(settings.managedHome()).toBeUndefined();
});
