import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const { scripts } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

function launch(override?: string) {
  const env = { ...process.env };
  delete env.GENTLE_SHELL_BIN;
  if (override) env.GENTLE_SHELL_BIN = override;
  // Exercise the actual package command without starting a GUI.
  return spawnSync("/bin/bash", ["-c", `electron-vite() { printf '%s\\n' "$GENTLE_SHELL_BIN" "$@"; }; ${scripts["dev:local-pi"]}`], {
    cwd: root, env, encoding: "utf8",
  });
}

describe("dev:local-pi", () => {
  it("selects the sibling checkout using an absolute entrypoint", () => {
    const result = launch();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const [entry, command] = result.stdout.trim().split("\n");
    expect(path.isAbsolute(entry!)).toBe(true);
    expect(path.normalize(entry!)).toBe(path.resolve(root, "../gentle-pi/bin/gentle-shell.mjs"));
    expect(command).toBe("dev");
  });

  it("preserves an explicitly selected launcher", () => {
    const result = launch("/custom checkout/bin/gentle-shell.mjs");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("/custom checkout/bin/gentle-shell.mjs\ndev\n");
  });
});
