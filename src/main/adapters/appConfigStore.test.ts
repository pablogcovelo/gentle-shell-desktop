import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppConfigStore } from "./appConfigStore";

describe("createAppConfigStore", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("read() returns {} when the config file does not exist yet", () => {
    dir = mkdtempSync(path.join(tmpdir(), "gentle-shell-config-"));
    const store = createAppConfigStore(path.join(dir, "config.json"));

    expect(store.read()).toEqual({});
  });

  it("read() tolerates invalid JSON, returning {}", () => {
    dir = mkdtempSync(path.join(tmpdir(), "gentle-shell-config-"));
    const configPath = path.join(dir, "config.json");
    writeFileSync(configPath, "{ not valid json");
    const store = createAppConfigStore(configPath);

    expect(store.read()).toEqual({});
  });

  it("read() tolerates an unrecognized home value, returning {}", () => {
    dir = mkdtempSync(path.join(tmpdir(), "gentle-shell-config-"));
    const configPath = path.join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ home: "not-a-mode" }));
    const store = createAppConfigStore(configPath);

    expect(store.read()).toEqual({});
  });

  it("write() persists the patch and creates the parent directory if needed, and read() round-trips it", () => {
    dir = mkdtempSync(path.join(tmpdir(), "gentle-shell-config-"));
    const configPath = path.join(dir, "nested", "config.json");
    const store = createAppConfigStore(configPath);

    const written = store.write({ home: "link" });

    expect(written).toEqual({ home: "link" });
    expect(store.read()).toEqual({ home: "link" });
  });

  // T1 (S1/S2): the persisted workspace registry — a list of absolute
  // workspace directories next to `home`, deduplicated,
  // most-recently-added first, read tolerantly exactly like `home`.
  it("read() keeps a {home}-only config backward compatible and reports no workspaces", () => {
    dir = mkdtempSync(path.join(tmpdir(), "gentle-shell-config-"));
    const configPath = path.join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ home: "isolated" }));
    const store = createAppConfigStore(configPath);

    expect(store.read()).toEqual({ home: "isolated" });
    expect(store.listWorkspaces()).toEqual([]);
  });

  it("addWorkspace() stores the directory most-recently-added first and read() round-trips it", () => {
    dir = mkdtempSync(path.join(tmpdir(), "gentle-shell-config-"));
    const store = createAppConfigStore(path.join(dir, "config.json"));

    store.addWorkspace("/tmp/ws-first");
    const second = store.addWorkspace("/tmp/ws-second");

    expect(second.workspaces).toEqual(["/tmp/ws-second", "/tmp/ws-first"]);
    expect(store.listWorkspaces()).toEqual(["/tmp/ws-second", "/tmp/ws-first"]);
    // A full restart (a fresh store over the same file) still sees both.
    expect(createAppConfigStore(path.join(dir, "config.json")).listWorkspaces()).toEqual([
      "/tmp/ws-second",
      "/tmp/ws-first",
    ]);
  });

  it("addWorkspace() deduplicates: re-adding an existing directory changes nothing", () => {
    dir = mkdtempSync(path.join(tmpdir(), "gentle-shell-config-"));
    const store = createAppConfigStore(path.join(dir, "config.json"));

    store.addWorkspace("/tmp/ws-a");
    const again = store.addWorkspace("/tmp/ws-a");

    expect(again.workspaces).toEqual(["/tmp/ws-a"]);
    expect(store.listWorkspaces()).toEqual(["/tmp/ws-a"]);
  });

  it("addWorkspace() refuses a relative directory with a clear message and persists nothing", () => {
    dir = mkdtempSync(path.join(tmpdir(), "gentle-shell-config-"));
    const store = createAppConfigStore(path.join(dir, "config.json"));

    expect(() => store.addWorkspace("relative/path")).toThrow(/not an absolute path/);
    expect(store.listWorkspaces()).toEqual([]);
  });

  it("removeWorkspace() deletes only the persisted entry and is a no-op for an unknown directory", () => {
    dir = mkdtempSync(path.join(tmpdir(), "gentle-shell-config-"));
    const configPath = path.join(dir, "config.json");
    const store = createAppConfigStore(configPath);
    store.addWorkspace("/tmp/ws-a");
    store.addWorkspace("/tmp/ws-b");
    const before = store.read();

    const after = store.removeWorkspace("/tmp/ws-b");

    expect(after.workspaces).toEqual(["/tmp/ws-a"]);
    expect(after.home).toBe(before.home);
    // An unknown directory removes nothing: the persisted file is untouched.
    const noOp = store.removeWorkspace("/tmp/never-added");
    expect(noOp).toEqual(store.read());
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ workspaces: ["/tmp/ws-a"] });
  });

  it("removeWorkspace() keeps the home choice intact next to the workspace list", () => {
    dir = mkdtempSync(path.join(tmpdir(), "gentle-shell-config-"));
    const store = createAppConfigStore(path.join(dir, "config.json"));

    store.write({ home: "link" });
    store.addWorkspace("/tmp/ws-a");
    const after = store.removeWorkspace("/tmp/ws-a");

    expect(after.home).toBe("link");
    expect(after.workspaces).toEqual([]);
  });

  it("read() tolerates a malformed or non-absolute workspaces value", () => {
    dir = mkdtempSync(path.join(tmpdir(), "gentle-shell-config-"));
    const configPath = path.join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ home: "link", workspaces: "nope" }));
    const store = createAppConfigStore(configPath);
    expect(store.read()).toEqual({ home: "link" });

    writeFileSync(configPath, JSON.stringify({ home: "link", workspaces: ["relative/path", 42, "/tmp/ok"] }));
    expect(store.read()).toEqual({ home: "link", workspaces: ["/tmp/ok"] });
  });

  it("write() merges with the previously persisted config instead of replacing it", () => {
    dir = mkdtempSync(path.join(tmpdir(), "gentle-shell-config-"));
    const configPath = path.join(dir, "config.json");
    const store = createAppConfigStore(configPath);

    store.write({ home: "isolated" });
    const second = store.write({});

    expect(second).toEqual({ home: "isolated" });
  });
});
