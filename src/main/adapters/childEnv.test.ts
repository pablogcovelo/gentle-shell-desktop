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

  // Windows answers `env.PATH` even when the real key is `Path`, and a spread keeps
  // the original spelling, so both variants can reach the child. The unsanitized
  // copy must not survive next to the clean one.
  it("removes every case variant of the PATH name on Windows so only the sanitized list survives", () => {
    const owned = path.join(appRoot, "node_modules", ".bin");
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      Path: [owned, "/usr/bin"].join(path.delimiter),
    };

    const sanitized = sanitizeChildEnv(env, appRoot, "win32");

    expect(sanitized.PATH).toBe("/usr/bin");
    expect(sanitized.Path).toBeUndefined();
    expect(Object.keys(sanitized).filter((name) => name.toUpperCase() === "PATH")).toEqual(["PATH"]);
  });

  // Outside Windows the two names are different variables; a distinct `Path` is
  // none of this function's business and must survive untouched.
  it("leaves a distinct Path variable alone on POSIX", () => {
    const owned = path.join(appRoot, "node_modules", ".bin");
    const env: NodeJS.ProcessEnv = {
      PATH: [owned, "/usr/bin"].join(path.delimiter),
      Path: "/opt/other-tool/bin",
    };

    const sanitized = sanitizeChildEnv(env, appRoot, "linux");

    expect(sanitized.PATH).toBe("/usr/bin");
    expect(sanitized.Path).toBe("/opt/other-tool/bin");
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
