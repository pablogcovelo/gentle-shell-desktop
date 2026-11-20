import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG_SOURCES, parseCommandCatalog } from "./commandCatalog";

/** The captured wire payload from __fixtures__/host-commands.json: the
 * `{ items, truncated }` answer `get_snapshot`'s `commands` section
 * carries (palette-host-catalog T1, S1). */
function fixtureCatalog(): unknown {
  return JSON.parse(readFileSync(path.join(__dirname, "__fixtures__", "host-commands.json"), "utf8"));
}

describe("parseCommandCatalog (palette-host-catalog T1, S1/S2)", () => {
  it("parses the captured wire answer: the host's order is kept, every source group carried", () => {
    const commands = parseCommandCatalog(fixtureCatalog());

    expect(commands).toEqual([
      { name: "new", description: "Start a new session", runnable: true, source: "builtin" },
      { name: "resume", description: "Resume another session", runnable: true, source: "builtin" },
      { name: "fork", description: "Create a new fork from a previous user message", runnable: false, source: "builtin" },
      { name: "name", description: "Set session display name", args: "<name>", runnable: true, source: "builtin" },
      { name: "gentle:desktop", description: "Open the desktop control channel", runnable: false, source: "extension" },
      { name: "review", description: "Run the rdd review flow", runnable: false, source: "prompt" },
      { name: "skill:commit", runnable: false, source: "skill" },
    ]);
    // A null `args` and a null `description` are the wire's "absent": neither
    // a placeholder nor an invented value is carried.
    expect(commands?.[6]).not.toHaveProperty("description");
    expect(commands?.[6]).not.toHaveProperty("args");
  });

  it("yields undefined for a non-record payload and for a missing or non-array items list", () => {
    expect(parseCommandCatalog(undefined)).toBeUndefined();
    expect(parseCommandCatalog("not-a-record")).toBeUndefined();
    expect(parseCommandCatalog([])).toBeUndefined();
    expect(parseCommandCatalog({})).toBeUndefined();
    expect(parseCommandCatalog({ items: "not-an-array" })).toBeUndefined();
  });

  it("drops an entry without a non-empty string name", () => {
    const commands = parseCommandCatalog({
      items: [
        { name: "", runnable: true, source: "builtin" },
        { runnable: true, source: "builtin" },
        { name: 42, runnable: true, source: "builtin" },
        { name: "kept", runnable: true, source: "builtin" },
      ],
    });

    expect(commands).toEqual([{ name: "kept", runnable: true, source: "builtin" }]);
  });

  it("drops an entry with a source outside the closed set — never coerced", () => {
    const commands = parseCommandCatalog({
      items: [
        { name: "mystery", runnable: true, source: "host" },
        { name: "app", runnable: true, source: "app" },
        { name: "kept", runnable: false, source: "skill" },
      ],
    });

    expect(commands).toEqual([{ name: "kept", runnable: false, source: "skill" }]);
  });

  it("drops an entry whose runnable is not a boolean", () => {
    const commands = parseCommandCatalog({
      items: [
        { name: "no-runnable", source: "builtin" },
        { name: "string-runnable", runnable: "yes", source: "builtin" },
        { name: "kept", runnable: false, source: "builtin" },
      ],
    });

    expect(commands).toEqual([{ name: "kept", runnable: false, source: "builtin" }]);
  });

  it("drops an entry whose description is neither a string nor null/absent", () => {
    const commands = parseCommandCatalog({
      items: [
        { name: "number-description", description: 7, runnable: true, source: "builtin" },
        { name: "kept", description: null, runnable: true, source: "builtin" },
      ],
    });

    expect(commands).toEqual([{ name: "kept", runnable: true, source: "builtin" }]);
  });

  it("keeps args only when it is a string or null — anything else drops the entry", () => {
    const commands = parseCommandCatalog({
      items: [
        { name: "string-args", args: "<description>", runnable: false, source: "builtin" },
        { name: "null-args", args: null, runnable: false, source: "builtin" },
        { name: "number-args", args: 5, runnable: false, source: "builtin" },
        { name: "object-args", args: { hint: true }, runnable: false, source: "builtin" },
      ],
    });

    expect(commands).toEqual([
      { name: "string-args", args: "<description>", runnable: false, source: "builtin" },
      { name: "null-args", runnable: false, source: "builtin" },
    ]);
    expect(commands?.[1]).not.toHaveProperty("args");
  });

  it("keeps the host's order and drops broken entries in place, never re-sorting", () => {
    const commands = parseCommandCatalog({
      items: [
        { name: "first", runnable: true, source: "builtin" },
        { name: "", runnable: true, source: "builtin" },
        { name: "last", runnable: false, source: "extension" },
      ],
    });

    expect(commands?.map((command) => command.name)).toEqual(["first", "last"]);
  });

  it("exports the closed source allow-list the wire documents", () => {
    expect([...CATALOG_SOURCES].sort()).toEqual(["builtin", "extension", "prompt", "skill"]);
  });
});
