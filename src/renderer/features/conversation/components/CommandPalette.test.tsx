// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ChatCommand } from "@shared/bridge-types";
import { CommandPalette } from "./CommandPalette";

/** Demo commands in the exact shape the host's `get_snapshot` commands
 * section answers (palette-host-catalog T2, S3): every source group —
 * builtins included — with the host's own `runnable` verdict per row. */
const DEMO_COMMANDS: readonly ChatCommand[] = [
  { name: "plan", description: "Turn the request into an ODD plan", runnable: false, source: "prompt" },
  { name: "skill:review", description: "Run the native review flow", runnable: false, source: "skill" },
  { name: "gentle:mode", runnable: false, source: "extension" },
  { name: "compact", description: "Compact the conversation context", runnable: true, source: "builtin" },
  { name: "fork", description: "Create a new fork from a previous user message", runnable: false, source: "builtin" },
  { name: "resume", description: "Resume another session", runnable: true, source: "builtin" },
];

type RenderOptions = {
  readonly commands?: readonly ChatCommand[];
};

function renderPalette(options: RenderOptions = {}) {
  const onRun = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <CommandPalette commands={options.commands ?? DEMO_COMMANDS} onRun={onRun} onClose={onClose} />,
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
  it("groups the host catalog prompt, skill, extension, builtin — builtin after extension (S3)", () => {
    const { dialog } = renderPalette();

    expect(groupHeads(dialog)).toEqual([
      ["Prompt", "1"],
      ["Skill", "1"],
      ["Extension", "1"],
      ["Builtin", "3"],
    ]);
  });

  it("does not render an empty group — no builtin entries, no builtin header for them", () => {
    const { dialog } = renderPalette({
      commands: [{ name: "plan", description: "Make a plan", runnable: false, source: "prompt" }],
    });

    expect(groupHeads(dialog)).toEqual([["Prompt", "1"]]);
  });

  it("lists the visible rows in group order with mono names, descriptions and a source badge", () => {
    const { rows, onRun } = renderPalette();

    expect(rows().map((row) => row.textContent)).toEqual([
      "/planTurn the request into an ODD planprompt",
      "/skill:reviewRun the native review flowskill",
      "/gentle:modeextension",
      "/compactCompact the conversation contextbuiltin",
      "/forkCreate a new fork from a previous user messagebuiltin",
      "/resumeResume another sessionbuiltin",
    ]);
    // The first row is selected as soon as the palette opens.
    expect(rows()[0]).toHaveAttribute("aria-selected", "true");
    expect(rows()[1]!).toHaveAttribute("aria-selected", "false");
    // Clicking a row runs it, like Enter does — the WHOLE entry is handed
    // up, runnable verdict included (S3: the row decides nothing locally).
    fireEvent.click(rows()[5]!);
    expect(onRun).toHaveBeenCalledExactlyOnceWith({
      name: "resume",
      description: "Resume another session",
      runnable: true,
      source: "builtin",
    });
  });

  it("matches the command NAME only, case-insensitively, and ignores a leading / in the query", () => {
    const { input, rows } = renderPalette();

    fireEvent.change(input, { target: { value: "/RE" } });
    // "re" matches "review" and "resume" by NAME. It used to also pull in
    // "plan" ("the request") and "fork" ("a previous") through their
    // descriptions; prose is not a name any more (owner decision).
    expect(rows().map((row) => row.textContent)).toEqual([
      "/skill:reviewRun the native review flowskill",
      "/resumeResume another sessionbuiltin",
    ]);

    // The same rows without the slash: the two queries are equivalent.
    fireEvent.change(input, { target: { value: "RE" } });
    expect(rows().map((row) => row.textContent)).toEqual([
      "/skill:reviewRun the native review flowskill",
      "/resumeResume another sessionbuiltin",
    ]);
  });

  it("never lets a word in a description win a slot — the reported 'new' regression", () => {
    const { input, rows, dialog } = renderPalette({
      commands: [
        {
          name: "skill:skill-creator",
          description: "Create new skills with valid frontmatter",
          runnable: false,
          source: "skill",
        },
        { name: "new", description: "Start a new session", runnable: true, source: "builtin" },
      ],
    });

    fireEvent.change(input, { target: { value: "new" } });
    // Before this rule, typing "new" returned the skill whose prose says
    // "new skills" and pushed /new to the bottom of the list.
    expect(rows().map((row) => row.textContent)).toEqual(["/newStart a new sessionbuiltin"]);

    // A word that only exists in a description matches nothing at all, and
    // the palette says so instead of guessing.
    fireEvent.change(input, { target: { value: "frontmatter" } });
    expect(within(dialog).queryByRole("option")).not.toBeInTheDocument();
    expect(dialog).toHaveTextContent('No command matches "frontmatter"');
  });

  it("selects the first row on open and on every filter change, and moves with wraparound", () => {
    const { input, rows } = renderPalette();
    const selection = () => rows().map((row) => row.getAttribute("aria-selected"));

    expect(selection()).toEqual(["true", "false", "false", "false", "false", "false"]);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selection()).toEqual(["false", "true", "false", "false", "false", "false"]);
    for (let i = 0; i < 4; i += 1) fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selection()).toEqual(["false", "false", "false", "false", "false", "true"]);
    // Wrap: down from the last lands on the first…
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selection()).toEqual(["true", "false", "false", "false", "false", "false"]);
    // …and up from the first lands on the last.
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(selection()).toEqual(["false", "false", "false", "false", "false", "true"]);

    // A filter change selects the first visible row again. "rev" matches
    // skill:review by name — and nothing else, now that "previous" in fork's
    // description no longer counts.
    fireEvent.change(input, { target: { value: "rev" } });
    expect(selection()).toEqual(["true"]);
  });

  it("runs the selected entry through onRun with its name, description, runnable verdict and source", () => {
    const { input, onRun } = renderPalette();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onRun).toHaveBeenCalledExactlyOnceWith({
      name: "gentle:mode",
      runnable: false,
      source: "extension",
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

  it("closes on Escape from any element inside the dialog, including the Clear button", () => {
    const { input, onClose } = renderPalette();

    fireEvent.change(input, { target: { value: "zzz" } });
    fireEvent.keyDown(screen.getByRole("button", { name: "Clear" }), { key: "Escape" });

    expect(onClose).toHaveBeenCalledExactlyOnceWith();
  });

  it("keeps Enter native on the focused Clear button: it clears the filter and dispatches nothing (R3-001/R4-001)", () => {
    const { input, dialog, onRun, onClose } = renderPalette();

    // A filter with no matches shows the Clear button; the palette's Tab
    // cycle parks focus on it, and Enter there must keep the button's
    // native activation — clearing the filter — instead of being claimed
    // for the (here empty) selection and swallowing the clear.
    fireEvent.change(input, { target: { value: "zzz" } });
    const clear = screen.getByRole("button", { name: "Clear" });
    clear.focus();
    expect(clear).toHaveFocus();

    // A cancelable Enter keydown, with preventDefault spied: the palette
    // must return WITHOUT claiming the key, so the browser's native button
    // activation proceeds. jsdom performs no keydown→click default action
    // itself, so the native activation the browser would run is simulated
    // with the button's own click below.
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    const preventDefault = vi.spyOn(enter, "preventDefault");
    clear.dispatchEvent(enter);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(onRun).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // The native activation: the filter is cleared, the full catalog is
    // listed again, and still nothing was dispatched.
    fireEvent.click(clear);
    expect(input).toHaveValue("");
    expect(within(dialog).getAllByRole("option")).toHaveLength(6);
    expect(onRun).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  // R3-002 (U4 review): the window claim must stop propagation only where
  // it actually handles the key. Enter on the Clear button is NOT claimed —
  // but the handler used to stopImmediatePropagation() BEFORE deciding,
  // starving every other window listener with a key it was declining.
  it("a key the palette declines does not stop the other window listeners — Enter on the Clear button (R3-002)", () => {
    const { input, onRun } = renderPalette();
    fireEvent.change(input, { target: { value: "zzz" } });
    const later = vi.fn();
    // Registered AFTER the palette's own window claim, so within the same
    // capture phase it runs second: the palette must leave the key event
    // alive for it when it does not handle the key.
    window.addEventListener("keydown", later, true);
    try {
      fireEvent.keyDown(screen.getByRole("button", { name: "Clear" }), { key: "Enter" });
      expect(later).toHaveBeenCalledTimes(1);
      expect(onRun).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", later, true);
    }
  });

  it("keeps Tab inside the dialog: it cycles between the input and the Clear button", () => {
    const { input } = renderPalette();

    fireEvent.change(input, { target: { value: "zzz" } });
    const clear = screen.getByRole("button", { name: "Clear" });

    // From the input, Tab lands on the Clear button.
    fireEvent.keyDown(input, { key: "Tab" });
    expect(document.activeElement).toBe(clear);
    // From the Clear button, Tab wraps back to the input.
    fireEvent.keyDown(clear, { key: "Tab" });
    expect(document.activeElement).toBe(input);
    // Shift+Tab from the input wraps backwards to the Clear button.
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(clear);
  });

  it("keeps focus on the single focusable element when Tab is pressed, never letting it escape the dialog", () => {
    const { input } = renderPalette();

    // The normal list state has exactly one focusable (the input): Tab must
    // keep focus on it instead of moving behind the dimmed page.
    fireEvent.keyDown(input, { key: "Tab" });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(input);
  });

  it("shows the honest empty-filter state with a Clear that empties the query", () => {
    const { input, dialog } = renderPalette();

    fireEvent.change(input, { target: { value: "zzz" } });
    expect(within(dialog).queryByRole("option")).not.toBeInTheDocument();
    expect(screen.getByText('No command matches "zzz"')).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(input).toHaveValue("");
    expect(within(dialog).getAllByRole("option")).toHaveLength(6);
  });

  it("describes the host catalog — builtins included — when the chat's catalog is empty (S7)", () => {
    renderPalette({ commands: [] });

    expect(screen.getByText(/This conversation has not reported any commands yet\./)).toBeInTheDocument();
    // The empty state names the real source and stops claiming that pi's
    // builtins live only in its terminal UI (S7).
    expect(screen.getByText(/pi host publishes — its builtin commands/)).toBeInTheDocument();
    expect(screen.getByText(/such as \/new and \/resume/)).toBeInTheDocument();
    expect(screen.queryByText(/never reach the desktop/i)).not.toBeInTheDocument();
  });

  it("renders nothing at all when the catalog is empty — no listbox", () => {
    renderPalette({ commands: [] });

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("keeps the dialog's a11y wiring: combobox controls the list and names the selected option", () => {
    const { input, dialog, rows, selectedRow } = renderPalette();

    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute("aria-controls", within(dialog).getByRole("listbox").id);
    expect(input).toHaveAttribute("aria-activedescendant", selectedRow().id);
    expect(dialog).toHaveAttribute("aria-modal", "true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", selectedRow().id);
    expect(rows()).toHaveLength(6);
  });

  it("shows the footer's key hints", () => {
    const { dialog } = renderPalette();
    const foot = dialog.querySelector(".gc-command-palette__foot");
    expect(foot?.textContent).toContain("move");
    expect(foot?.textContent).toContain("run");
    expect(foot?.textContent).toContain("close");
  });

  it("moves the selection with the arrows even when nothing holds focus — the keydown is dispatched on document.body (S11)", () => {
    const { input, rows } = renderPalette();
    // The browser parks focus on body after the app window loses focus:
    // nothing inside the palette holds it, and navigation must stay active
    // (the owner's report: arrows only worked while the text field held
    // focus).
    input.blur();
    expect(document.activeElement).toBe(document.body);

    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    expect(rows()[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(document.body, { key: "ArrowUp" });
    expect(rows()[0]).toHaveAttribute("aria-selected", "true");
  });

  it("restores focus to the filter input when the app window regains focus, and the arrows still navigate (S11)", () => {
    const { input, rows } = renderPalette();
    expect(input).toHaveFocus();

    // The app window loses focus (a click outside the GUI) — the browser
    // parks focus on body — and then the window regains it.
    input.blur();
    fireEvent(window, new Event("focus"));

    expect(input).toHaveFocus();
    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    expect(rows()[1]).toHaveAttribute("aria-selected", "true");
  });

  it("restores focus to the previously focused element when it closes", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();

    const view = render(
      <CommandPalette commands={DEMO_COMMANDS} onRun={vi.fn()} onClose={vi.fn()} />,
    );
    expect(document.activeElement).toBe(screen.getByRole("combobox"));

    view.unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
