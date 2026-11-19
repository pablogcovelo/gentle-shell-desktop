import path from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeChildEnv } from "./childEnv";

const appRoot = path.join(path.sep, "work", "gentle-shell-desktop");

describe("sanitizeChildEnv", () => {
  it("drops every PATH entry that lives inside the app's own node_modules", () => {
    const env = {
      PATH: [
        "/usr/local/bin",
        path.join(appRoot, "node_modules", ".bin"),
        path.join(appRoot, "node_modules", ".pnpm", "vite@8.3.0", "node_modules", ".bin"),
        "/home/dev/.local/share/pnpm/bin",
      ].join(path.delimiter),
      HOME: "/home/dev",
    };

    const sanitized = sanitizeChildEnv(env, appRoot);

    expect(sanitized.PATH).toBe(["/usr/local/bin", "/home/dev/.local/share/pnpm/bin"].join(path.delimiter));
    expect(sanitized.HOME).toBe("/home/dev");
  });

  it("keeps a directory that merely contains the word node_modules but is not the app's own", () => {
    const elsewhere = path.join(path.sep, "work", "node_modules-tools", "bin");
    const env = { PATH: [elsewhere, path.join(appRoot, "node_modules", ".bin")].join(path.delimiter) };

    expect(sanitizeChildEnv(env, appRoot).PATH).toBe(elsewhere);
  });

  it("drops an app-owned entry that does not exist on disk", () => {
    const missing = path.join(appRoot, "node_modules", ".bin");
    const env = { PATH: [missing, "/usr/bin"].join(path.delimiter) };

    expect(sanitizeChildEnv(env, appRoot).PATH).toBe("/usr/bin");
  });

  it("edits the PATH key the environment actually uses, leaving the other spelling alone", () => {
    const key = process.platform === "win32" ? "Path" : "PATH";
    const env: NodeJS.ProcessEnv = {
      [key]: [path.join(appRoot, "node_modules", ".bin"), path.join(path.sep, "usr", "bin")].join(path.delimiter),
    };

    const sanitized = sanitizeChildEnv(env, appRoot);

    expect(sanitized[key]).toBe(path.join(path.sep, "usr", "bin"));
    expect(sanitized[key === "Path" ? "PATH" : "Path"]).toBeUndefined();
  });

  it("leaves an environment without PATH untouched", () => {
    const env = { HOME: "/home/dev" };

    expect(sanitizeChildEnv(env, appRoot)).toEqual({ HOME: "/home/dev" });
  });

  it("never mutates the environment it was given", () => {
    const env = { PATH: [path.join(appRoot, "node_modules", ".bin"), "/usr/bin"].join(path.delimiter) };

    sanitizeChildEnv(env, appRoot);

    expect(env.PATH).toBe([path.join(appRoot, "node_modules", ".bin"), "/usr/bin"].join(path.delimiter));
  });
});
