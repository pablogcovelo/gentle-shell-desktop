// @vitest-environment jsdom
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ChatCommand } from "@shared/bridge-types";
import { Composer } from "./Composer";

function Harness(props: { readonly initial?: string; readonly onPickFile?: () => Promise<string | null>; readonly commands?: readonly ChatCommand[] }) {
  const [value, setValue] = useState(props.initial ?? "");
  return (
    <Composer
      value={value}
      working={false}
      onChange={setValue}
      onSend={vi.fn()}
      onAbort={vi.fn()}
      onPickFile={props.onPickFile}
      commands={props.commands}
    />
  );
}

/** Demo commands in the exact shape `get_commands` answers (S6): the order
 * is the child's, one entry has no description, and there is no argument
 * hint anywhere. */
const DEMO_COMMANDS: readonly ChatCommand[] = [
  { name: "review", description: "Run the rdd review flow", source: "extension" },
  { name: "plan", description: "Turn the request into an ODD plan", source: "prompt" },
  { name: "skill:commit", source: "skill" },
];

/** A stateful harness that keeps the draft in React state (like
 * ConversationContainer) and hands the same onSend spy to every render, so
 * submit assertions survive re-renders caused by completing a command. */
function renderSlashComposer(options: { readonly commands?: readonly ChatCommand[] } = {}) {
  const onSend = vi.fn();
  function Harness() {
    const [value, setValue] = useState("");
    return <Composer value={value} working={false} onChange={setValue} onSend={onSend} onAbort={vi.fn()} commands={options.commands} />;
  }
  render(<Harness />);
  const textarea = screen.getByPlaceholderText("Tell Gentle what you need…");
  return { textarea, onSend };
}

describe("Composer", () => {
  it("merges local resume once with child commands without changing child completion", () => {
    const onChange = vi.fn();
    const props = { value: "/", working: false, onChange, onSend: vi.fn(), onAbort: vi.fn() };
    const { rerender } = render(<Composer {...props} resumeAvailable commands={[...DEMO_COMMANDS, { name: "resume", source: "extension" }]} />);
    const choices = screen.getAllByRole("option");
    expect(choices.filter((choice) => choice.textContent?.startsWith("/resume"))).toHaveLength(1);
    expect(choices.map((choice) => choice.textContent)).toContain("/reviewRun the rdd review flow");
    fireEvent.click(screen.getByRole("option", { name: /\/review/ }));
    expect(onChange).toHaveBeenLastCalledWith("/review ");
    fireEvent.click(screen.getByRole("option", { name: /\/resume/ }));
    expect(onChange).toHaveBeenLastCalledWith("/resume ");
    rerender(<Composer {...props} commands={DEMO_COMMANDS} />);
    expect(screen.queryByRole("option", { name: /\/resume/ })).not.toBeInTheDocument();
  });
  it("keeps Send icon-only and grows then shrinks the textarea with the draft", () => {
    const props = { working: false, onChange: vi.fn(), onSend: vi.fn(), onAbort: vi.fn() };
    const { rerender } = render(<Composer {...props} value="hi" />);
    const field = screen.getByRole("textbox");
    Object.defineProperty(field, "scrollHeight", { configurable: true, value: 120 });
    rerender(<Composer {...props} value="hi\nmore" />);
    expect(field).toHaveStyle({ height: "120px" });
    Object.defineProperty(field, "scrollHeight", { configurable: true, value: 48 });
    rerender(<Composer {...props} value="" />);
    expect(field).toHaveStyle({ height: "48px" });
    const send = screen.getByRole("button", { name: "Send" });
    expect(send.textContent).toBe("");
    expect(send.querySelector("svg")).not.toBeNull();
  });
  it("exposes the form with the accessible name 'Composer'", () => {
    render(<Composer value="" working={false} onChange={vi.fn()} onSend={vi.fn()} onAbort={vi.fn()} />);

    expect(screen.getByRole("form", { name: "Composer" })).toBeInTheDocument();
  });

  it("shows the placeholder and the key hints", () => {
    render(<Composer value="" working={false} onChange={vi.fn()} onSend={vi.fn()} onAbort={vi.fn()} />);

    expect(screen.getByPlaceholderText("Tell Gentle what you need…")).toBeInTheDocument();
    expect(screen.getByText("Enter to send · Shift+Enter for a new line · Esc to stop")).toBeInTheDocument();
  });

  it("calls onSend and does not insert a newline when Enter is pressed without Shift", () => {
    const onSend = vi.fn();

    render(<Composer value="hello" working={false} onChange={vi.fn()} onSend={onSend} onAbort={vi.fn()} />);
    const textarea = screen.getByPlaceholderText("Tell Gentle what you need…");
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalled();
  });

  it("does not call onSend when Shift+Enter is pressed (newline instead)", () => {
    const onSend = vi.fn();

    render(<Composer value="hello" working={false} onChange={vi.fn()} onSend={onSend} onAbort={vi.fn()} />);
    fireEvent.keyDown(screen.getByPlaceholderText("Tell Gentle what you need…"), { key: "Enter", shiftKey: true });

    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not call onSend on Enter when the draft is empty", () => {
    const onSend = vi.fn();

    render(<Composer value="   " working={false} onChange={vi.fn()} onSend={onSend} onAbort={vi.fn()} />);
    fireEvent.keyDown(screen.getByPlaceholderText("Tell Gentle what you need…"), { key: "Enter" });

    expect(onSend).not.toHaveBeenCalled();
  });

  it("calls onAbort on Escape only while working", () => {
    const onAbort = vi.fn();
    const { rerender } = render(
      <Composer value="" working={false} onChange={vi.fn()} onSend={vi.fn()} onAbort={onAbort} />,
    );
    const textarea = screen.getByPlaceholderText("Tell Gentle what you need…");

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(onAbort).not.toHaveBeenCalled();

    rerender(<Composer value="" working onChange={vi.fn()} onSend={vi.fn()} onAbort={onAbort} />);
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(onAbort).toHaveBeenCalled();
  });

  it("marks the field read-only while working so Escape still reaches it, and disables Send", () => {
    render(<Composer value="hi" working onChange={vi.fn()} onSend={vi.fn()} onAbort={vi.fn()} />);

    const textarea = screen.getByPlaceholderText("Tell Gentle what you need…");
    expect(textarea).toHaveAttribute("readonly");
    expect(textarea).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("disables Send when the draft is empty", () => {
    render(<Composer value="" working={false} onChange={vi.fn()} onSend={vi.fn()} onAbort={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("clicking Send calls onSend", () => {
    const onSend = vi.fn();
    render(<Composer value="hi" working={false} onChange={vi.fn()} onSend={onSend} onAbort={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSend).toHaveBeenCalled();
  });

it("keeps Send disabled while the pane has no host to send to", () => {
  render(
    <Composer value="hi" working={false} ready={false} onChange={vi.fn()} onSend={vi.fn()} onAbort={vi.fn()} />,
  );

  // No host resolved yet means no route: offering Send would only produce a
  // request main has to refuse.
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
});

it("appends the picked emoji to the draft and closes the panel", async () => {
  render(<Harness initial="hi" />);

  fireEvent.click(screen.getByRole("button", { name: "Emoji" }));
  const panel = screen.getByRole("group", { name: "Emoji" });
  fireEvent.click(within(panel).getByRole("button", { name: "🙂" }));

  await waitFor(() => expect(screen.getByPlaceholderText("Tell Gentle what you need…")).toHaveValue("hi🙂"));
  expect(screen.queryByRole("group", { name: "Emoji" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Emoji" })).toHaveAttribute("aria-expanded", "false");
});

it("closes the emoji panel on Escape without touching the draft", () => {
  render(<Harness initial="hi" />);

  fireEvent.click(screen.getByRole("button", { name: "Emoji" }));
  fireEvent.keyDown(screen.getByRole("group", { name: "Emoji" }), { key: "Escape" });

  expect(screen.queryByRole("group", { name: "Emoji" })).not.toBeInTheDocument();
  expect(screen.getByPlaceholderText("Tell Gentle what you need…")).toHaveValue("hi");
});

it("renders the tool buttons as type=button so they never submit the form", () => {
  render(<Composer value="" working={false} onChange={vi.fn()} onSend={vi.fn()} onAbort={vi.fn()} />);

  expect(screen.getByRole("button", { name: "Emoji" })).toHaveAttribute("type", "button");
  expect(screen.getByRole("button", { name: /Microphone/ })).toHaveAttribute("type", "button");
});

it("appends the chosen absolute path to the draft without reading the file", async () => {
  const onPickFile = vi.fn(() => Promise.resolve("/tmp/notes.md"));
  render(<Harness initial="draft text" onPickFile={onPickFile} />);

  fireEvent.click(screen.getByRole("button", { name: "Attachment" }));

  await waitFor(() => expect(screen.getByPlaceholderText("Tell Gentle what you need…")).toHaveValue("draft text /tmp/notes.md"));
  expect(onPickFile).toHaveBeenCalledTimes(1);
});

it("appends the path without a leading space when the draft is empty", async () => {
  render(<Harness onPickFile={() => Promise.resolve("/tmp/notes.md")} />);

  fireEvent.click(screen.getByRole("button", { name: "Attachment" }));

  await waitFor(() => expect(screen.getByPlaceholderText("Tell Gentle what you need…")).toHaveValue("/tmp/notes.md"));
});

it("changes nothing when the picker resolves to null", async () => {
  render(<Harness initial="kept" onPickFile={() => Promise.resolve(null)} />);

  fireEvent.click(screen.getByRole("button", { name: "Attachment" }));

  await waitFor(() => expect(screen.getByPlaceholderText("Tell Gentle what you need…")).toHaveValue("kept"));
});

it("does not render the attachment action without onPickFile", () => {
  render(<Composer value="" working={false} onChange={vi.fn()} onSend={vi.fn()} onAbort={vi.fn()} />);

  expect(screen.queryByRole("button", { name: "Attachment" })).not.toBeInTheDocument();
});

it("renders the microphone always but disabled, with the reason in its accessible name", () => {
  render(<Composer value="" working={false} onChange={vi.fn()} onSend={vi.fn()} onAbort={vi.fn()} />);

  const microphone = screen.getByRole("button", { name: /Microphone/ });
  expect(microphone).toBeDisabled();
  expect(microphone).toHaveAccessibleName(/no audio capture/);
});
});

// ---------------------------------------------------------------------------
// The slash-command list (desktop-pending-work T6, S6): the list is ONLY
// what the child answered for `get_commands`, filtered by the typed token,
// completing through the same draft contract — never a hardcoded replica.
// ---------------------------------------------------------------------------

describe("Composer: slash command list (desktop-pending-work T6, S6)", () => {
  it("renders no list without a commands prop", () => {
    const { textarea } = renderSlashComposer();
    fireEvent.change(textarea, { target: { value: "/rev" } });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(textarea).toHaveAttribute("aria-expanded", "false");
  });

  it("renders no list when the draft has no slash token", () => {
    const { textarea } = renderSlashComposer({ commands: DEMO_COMMANDS });
    fireEvent.change(textarea, { target: { value: "hello" } });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("renders no popup for an empty command list — no empty box, no placeholder entry", () => {
    const { textarea } = renderSlashComposer({ commands: [] });
    fireEvent.change(textarea, { target: { value: "/" } });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("opens on /, lists the child's commands in the order received, and exposes the list through aria", () => {
    const { textarea } = renderSlashComposer({ commands: DEMO_COMMANDS });
    fireEvent.change(textarea, { target: { value: "/" } });

    const listbox = screen.getByRole("listbox", { name: "Slash commands" });
    expect(textarea).toHaveAttribute("aria-expanded", "true");
    expect(textarea).toHaveAttribute("aria-controls", listbox.id);
    const options = within(listbox).getAllByRole("option");
    // The order is the child's: the list is never sorted or rebuilt locally.
    expect(options.map((option) => option.textContent)).toEqual([
      "/reviewRun the rdd review flow",
      "/planTurn the request into an ODD plan",
      "/skill:commit",
    ]);
  });

  it("filters case-insensitively by the typed token", () => {
    const { textarea } = renderSlashComposer({ commands: DEMO_COMMANDS });
    fireEvent.change(textarea, { target: { value: "/RE" } });

    const listbox = screen.getByRole("listbox");
    const options = within(listbox).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("/review");
    // A token matching nothing keeps the list closed (no empty popup).
    fireEvent.change(textarea, { target: { value: "/zzz" } });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("ArrowDown and ArrowUp move the highlight with wrapping", () => {
    const { textarea } = renderSlashComposer({ commands: DEMO_COMMANDS });
    fireEvent.change(textarea, { target: { value: "/" } });

    const listbox = screen.getByRole("listbox");
    const options = within(listbox).getAllByRole("option");
    expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual(["false", "false", "false"]);

    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    // Wrapping: up from the first entry lands on the last.
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual(["false", "false", "true"]);
    // Wrapping the other way: down from the last lands on the first.
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
  });

  it("completes the highlighted command on Enter instead of submitting", () => {
    const { textarea, onSend } = renderSlashComposer({ commands: DEMO_COMMANDS });
    fireEvent.change(textarea, { target: { value: "/rev" } });
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(textarea).toHaveValue("/review ");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("completes a command on click, keeping it to the same draft contract", () => {
    const { textarea, onSend } = renderSlashComposer({ commands: DEMO_COMMANDS });
    fireEvent.change(textarea, { target: { value: "/pla" } });
    fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: /plan/ }));

    expect(textarea).toHaveValue("/plan ");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("closes the list on Escape without clearing the draft, and Enter then submits normally", () => {
    const { textarea, onSend } = renderSlashComposer({ commands: DEMO_COMMANDS });
    fireEvent.change(textarea, { target: { value: "/rev" } });
    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(textarea).toHaveValue("/rev");
    expect(textarea).toHaveAttribute("aria-expanded", "false");

    // No list open: Enter keeps exactly its current behaviour.
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("keeps the list closed for the dismissed token while typing re-opens it", () => {
    const { textarea } = renderSlashComposer({ commands: DEMO_COMMANDS });
    fireEvent.change(textarea, { target: { value: "/rev" } });
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    // Any other keystroke keeps typing and the list re-filters (a token
    // that still matches). "/r" matches "review" and is not the dismissed
    // token.
    fireEvent.change(textarea, { target: { value: "/r" } });
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    // Back to the dismissed token: it stays closed.
    fireEvent.change(textarea, { target: { value: "/rev" } });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    // Completing closes the list: the draft is no longer a slash token.
    fireEvent.change(textarea, { target: { value: "/p" } });
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea).toHaveValue("/plan ");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("submits normally with commands available when the draft is not a slash token", () => {
    const { textarea, onSend } = renderSlashComposer({ commands: DEMO_COMMANDS });
    fireEvent.change(textarea, { target: { value: "hello world" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
