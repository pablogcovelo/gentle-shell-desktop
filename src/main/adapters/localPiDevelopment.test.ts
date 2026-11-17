import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalPiDevelopment } from "./localPiDevelopment";
import { createLauncherLocator } from "./launcherLocator";

const scratch: string[] = [];
afterEach(() => scratch.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "local pi spaces "));
  scratch.push(root);
  const install = path.join(root, "managed install");
  const source = path.join(root, "source checkout");
  const executable = (file: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "#!/usr/bin/env node\n");
    chmodSync(file, 0o755);
  };
  executable(path.join(install, "bin/gentle-shell"));
  executable(path.join(install, "prefix/bin/pi"));
  executable(path.join(install, "runtime/node/bin/node"));
  executable(path.join(source, "bin/gentle-shell.mjs"));
  mkdirSync(path.join(install, "agent"));
  writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "gentle-pi" }));
  const descriptor = path.join(install, "installation.json");
  writeFileSync(descriptor, JSON.stringify({ Schema: "gentle-shell-user-install/v1", Mode: "separate", Destination: install, Agent: path.join(install, "agent") }));
  const bin = path.join(root, "path bin");
  mkdirSync(bin);
  symlinkSync(path.join(install, "bin/gentle-shell"), path.join(bin, "gentle-shell"));
  const config = path.join(root, "config.json");
  writeFileSync(config, '{"home":"isolated"}');
  const env = { PATH: bin, GENTLE_SHELL_BIN: path.join(source, "bin/gentle-shell.mjs") };
  return { root, install, source, descriptor, config, env };
}

describe("explicit local Pi development", () => {
  it("selects source package and the installed home without persisting a home choice", async () => {
    const f = fixture();
    for (const choice of ["isolated", "link"]) {
      writeFileSync(f.config, JSON.stringify({ home: choice }));
      const before = readFileSync(f.config, "utf8");
      const dev = createLocalPiDevelopment(f.env);
      const launch = dev.locator.locate();
      expect(launch.command).toBe(process.execPath);
      expect(launch.args).toEqual([f.env.GENTLE_SHELL_BIN, "--package-root", f.source]);
      expect(launch.managedAgentDir).toBeUndefined();
      expect(launch.env).toEqual({ ELECTRON_RUN_AS_NODE: "1", PI_CODING_AGENT_DIR: path.join(f.install, "agent"), GENTLE_SHELL_USER_PI_HOME: path.join(f.install, "agent"), GENTLE_SHELL_NO_AUTO_SETUP: "1", GENTLE_SHELL_PI: path.join(f.install, "prefix/bin/pi"), PATH: `${path.join(f.install, "runtime/node/bin")}${path.delimiter}${f.env.PATH}` });
      expect(dev.homeSettings.homeArgs()).toEqual(["--link"]);
      expect(dev.homeSettings.homeDir()).toBe(launch.env!.PI_CODING_AGENT_DIR);
      expect(await dev.setupService.status()).toEqual({ needsChoice: false, detection: { found: true, dir: path.join(f.install, "agent"), hasAuth: false, hasModels: false } });
      await expect(dev.setupService.chooseHome("link")).rejects.toThrow("Local Pi development uses the installed agent home; no home choice is available.");
      expect(readFileSync(f.config, "utf8")).toBe(before);
    }
  });

  it.each(["missing install", "malformed install", "missing source", "wrong source", "missing runtime", "conflicting home", "conflicting Pi", "conflicting user home", "conflicting Pi home"])("rejects %s without changing config", (kind) => {
    const f = fixture();
    const env: NodeJS.ProcessEnv = { ...f.env };
    if (kind === "missing install") env.PATH = f.root;
    if (kind === "malformed install") writeFileSync(f.descriptor, "{}");
    if (kind === "missing source") env.GENTLE_SHELL_BIN = path.join(f.source, "absent.mjs");
    if (kind === "wrong source") writeFileSync(path.join(f.source, "package.json"), '{"name":"other"}');
    if (kind === "missing runtime") chmodSync(path.join(f.install, "prefix/bin/pi"), 0o644);
    if (kind === "conflicting home") env.GENTLE_SHELL_HOME = f.root;
    if (kind === "conflicting Pi") env.GENTLE_SHELL_PI = f.root;
    if (kind === "conflicting user home") env.GENTLE_SHELL_USER_PI_HOME = f.root;
    if (kind === "conflicting Pi home") env.PI_CODING_AGENT_DIR = f.root;
    const before = readFileSync(f.config, "utf8");
    expect(() => createLocalPiDevelopment(env)).toThrow();
    expect(readFileSync(f.config, "utf8")).toBe(before);
  });

  it("keeps the ordinary installed route free of source flags", () => {
    const f = fixture();
    const launch = createLauncherLocator({ PATH: f.env.PATH }).locate();
    expect(launch.args).toEqual([]);
    expect(launch.env).toBeUndefined();
    expect(launch.managedAgentDir).toBe(path.join(f.install, "agent"));
  });
});
