// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ChatCommand } from "@shared/bridge-types";
import { CommandPalette, type PaletteEntry } from "./CommandPalette";

/** Demo commands in the exact shape `get_commands` answers: every source
 * group, one entry with no description, no argument hint anywhere. */
const DEMO_COMMANDS: readonly ChatCommand[] = [
  { name: "plan", description: "Turn the request into an ODD plan", source: "prompt" },
  { name: "skill:review", description: "Run the native review flow", source: "skill" },
  { name: "gentle:mode", source: "extension" },
  { name: "compact", description: "Compact the conversation context", source: "prompt" },
];

type RenderOptions = {
  readonly commands?: readonly ChatCommand[];
  readonly resumeAvailable?: boolean;
};

function renderPalette(options: RenderOptions = {}) {
  const onRun = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <CommandPalette
      commands={options.commands ?? DEMO_COMMANDS}
      resumeAvailable={options.resumeAvailable ?? false}
      onRun={onRun}
      onClose={onClose}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "Commands" });
  const input = within(dialog).getByRole("combobox");
  /** The listbox, re-queried each time: it unmounts in the empty-filter state. */
  const list = () => within(dialog).getByRole("listbox", { name: "Commands" });
  const rows = () => within(list()).getAllByRole("option");
  /** The row whose aria-selected is currently true (DOM order). */
  const selectedRow = (): HTMLElement => {
    const selected = rows().find((row) => row.getAttribute("aria-selected") === "true");
    expect(selected).toBeDefined();
    return selected!;
  };
  return { onRun, onClose, dialog, input, list, rows, selectedRow, unmount: view.unmount };
}

/** The group headers in DOM order, as [name, count] pairs. */
function groupHeads(dialog: HTMLElement): [string, string][] {
  return [...dialog.querySelectorAll<HTMLElement>(".gc-command-palette__group-head")].map((head) => [
    head.querySelector<HTMLElement>(".gc-command-palette__group-name")?.textContent ?? "",
    head.querySelector<HTMLElement>(".gc-command-palette__group-count")?.textContent ?? "",
  ]);
}

describe("CommandPalette", () => {
  it("groups app first, then prompt, skill and extension, with a live count per group", () => {
    const { dialog } = renderPalette({ resumeAvailable: true });

    expect(groupHeads(dialog)).toEqual([
      ["App", "1"],
      ["Prompt", "2"],
      ["Skill", "1"],
      ["Extension", "1"],
    ]);
  });

  it("does not render an empty group — no resume entry, no extension commands, no headers for them", () => {
    const { dialog } = renderPalette({
      commands: [{ name: "plan", description: "Make a plan", source: "prompt" }],
      resumeAvailable: false,
    });

    expect(groupHeads(dialog)).toEqual([["Prompt", "1"]]);
  });

  it("lists the visible rows in group order with mono names, descriptions and a source badge", () => {
    const { rows, onRun } = renderPalette({ resumeAvailable: true });

    expect(rows().map((row) => row.textContent)).toEqual([
      "/resumeChoose a saved Pi session in this directoryapp",
      "/planTurn the request into an ODD planprompt",
      "/compactCompact the conversation contextprompt",
      "/skill:reviewRun the native review flowskill",
      "/gentle:modeextension",
    ]);
    // The first row is selected as soon as the palette opens.
    expect(rows()[0]).toHaveAttribute("aria-selected", "true");
    expect(rows()[1]!).toHaveAttribute("aria-selected", "false");
    // Clicking a row runs it, like Enter does.
    fireEvent.click(rows()[2]!);
    expect(onRun).toHaveBeenCalledExactlyOnceWith({
      name: "compact",
      description: "Compact the conversation context",
      source: "prompt",
    });
  });

  it("filters case-insensitively over name and description and ignores a leading / in the query", () => {
    const { input, rows } = renderPalette();

    fireEvent.change(input, { target: { value: "/RE" } });
    // "re" matches "review" (name) and "plan"'s description ("the request");
    // the leading-slash prefix changes nothing.
    expect(rows().map((row) => row.textContent)).toEqual([
      "/planTurn the request into an ODD planprompt",
      "/skill:reviewRun the native review flowskill",
    ]);

    // The same rows without the slash: the two queries are equivalent.
    fireEvent.change(input, { target: { value: "RE" } });
    expect(rows().map((row) => row.textContent)).toEqual([
      "/planTurn the request into an ODD planprompt",
      "/skill:reviewRun the native review flowskill",
    ]);
  });

  it("selects the first row on open and on every filter change, and moves with wraparound", () => {
    const { input, rows } = renderPalette();
    const selection = () => rows().map((row) => row.getAttribute("aria-selected"));

    expect(selection()).toEqual(["true", "false", "false", "false"]);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selection()).toEqual(["false", "true", "false", "false"]);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selection()).toEqual(["false", "false", "false", "true"]);
    // Wrap: down from the last lands on the first…
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selection()).toEqual(["true", "false", "false", "false"]);
    // …and up from the first lands on the last.
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(selection()).toEqual(["false", "false", "false", "true"]);

    // A filter change selects the first visible row again.
    fireEvent.change(input, { target: { value: "rev" } });
    expect(selection()).toEqual(["true"]);
  });

  it("runs the selected entry through onRun with its name, description and source", () => {
    const { input, onRun } = renderPalette();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onRun).toHaveBeenCalledExactlyOnceWith({
      name: "skill:review",
      description: "Run the native review flow",
      source: "skill",
    });
  });

  it("closes on Escape and leaves every other keystroke alone", () => {
    const { input, onClose } = renderPalette();

    // Typing keeps working — the palette does not swallow it.
    fireEvent.change(input, { target: { value: "re" } });
    expect(input).toHaveValue("re");
    fireEvent.keyDown(input, { key: "x" });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledExactlyOnceWith();
  });

  it("shows the honest empty-filter state with a Clear that empties the query", () => {
    const { input, dialog } = renderPalette();

    fireEvent.change(input, { target: { value: "zzz" } });
    expect(within(dialog).queryByRole("option")).not.toBeInTheDocument();
    expect(screen.getByText('No command matches "zzz"')).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(input).toHaveValue("");
    expect(within(dialog).getAllByRole("option")).toHaveLength(4);
  });

  it("reports that the conversation has reported no commands when both lists are empty", () => {
    renderPalette({ commands: [], resumeAvailable: false });

    expect(screen.getByText("This conversation has not reported any commands yet.")).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("shows the app resume entry only while resume is available, always badged app", () => {
    const withResume = renderPalette({ resumeAvailable: true });
    const resume = within(withResume.list()).getByRole("option", { name: /^\/resume/ });
    expect(resume.textContent).toContain("app");

    withResume.unmount();
    const withoutResume = renderPalette({ resumeAvailable: false });
    expect(
      within(withoutResume.list()).queryByRole("option", { name: /^\/resume/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps the dialog's a11y wiring: combobox controls the list and names the selected option", () => {
    const { input, dialog, rows, selectedRow } = renderPalette();

    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute("aria-controls", within(dialog).getByRole("listbox").id);
    expect(input).toHaveAttribute("aria-activedescendant", selectedRow().id);
    expect(dialog).toHaveAttribute("aria-modal", "true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", selectedRow().id);
    expect(rows()).toHaveLength(4);
  });

  it("shows the footer's key hints", () => {
    const { dialog } = renderPalette();
    const foot = dialog.querySelector(".gc-command-palette__foot");
    expect(foot?.textContent).toContain("move");
    expect(foot?.textContent).toContain("run");
    expect(foot?.textContent).toContain("close");
  });

  it("restores focus to the previously focused element when it closes", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();

    const view = render(
      <CommandPalette commands={DEMO_COMMANDS} resumeAvailable={false} onRun={vi.fn()} onClose={vi.fn()} />,
    );
    expect(document.activeElement).toBe(screen.getByRole("combobox"));

    view.unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});

describe("PaletteEntry", () => {
  it("keeps the app entry a distinct local type the wire never publishes", () => {
    const entry: PaletteEntry = { name: "resume", source: "app" };
    expect(entry.source).toBe("app");
  });
});
