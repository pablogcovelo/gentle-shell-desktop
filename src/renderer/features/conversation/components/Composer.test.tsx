// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Composer } from "./Composer";

function Harness(props: { readonly initial?: string; readonly onPickFile?: () => Promise<string | null>; readonly onOpenPalette?: () => void }) {
  const [value, setValue] = useState(props.initial ?? "");
  return (
    <Composer
      value={value}
      working={false}
      onChange={setValue}
      onSend={vi.fn()}
      onAbort={vi.fn()}
      onPickFile={props.onPickFile}
      onOpenPalette={props.onOpenPalette}
    />
  );
}

describe("Composer", () => {
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
    expect(
      screen.getByText("Enter to send · Shift+Enter for a new line · Esc Esc to stop the agent"),
    ).toBeInTheDocument();
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

  it("removes the emoji picker while Attachment and the disabled Microphone remain", () => {
    render(<Harness onPickFile={() => Promise.resolve("/tmp/notes.md")} />);

    expect(screen.queryByRole("button", { name: "Emoji" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Emoji" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attachment" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Microphone/ })).toBeDisabled();
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

it("renders the remaining tool buttons as type=button so they never submit the form", () => {
  render(<Composer value="" working={false} onChange={vi.fn()} onSend={vi.fn()} onAbort={vi.fn()} />);

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

// ---------------------------------------------------------------------------
// The double-Esc stop gesture (S2): two consecutive Escape presses inside a
// 1500 ms window stop the agent while it is working; a single Escape keeps
// its non-destructive job and never stops the agent.
// ---------------------------------------------------------------------------

describe("Composer: double-Esc stop gesture (S2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function renderWorkingComposer(onAbort: () => void) {
    render(<Composer value="" working onChange={vi.fn()} onSend={vi.fn()} onAbort={onAbort} />);
    return screen.getByPlaceholderText("Tell Gentle what you need…");
  }

  it("stops the agent when Escape is pressed twice inside the 1500 ms window", () => {
    const onAbort = vi.fn();
    const textarea = renderWorkingComposer(onAbort);

    fireEvent.keyDown(textarea, { key: "Escape" });
    vi.advanceTimersByTime(1000);
    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it("does not stop the agent on a single Escape", () => {
    const onAbort = vi.fn();
    const textarea = renderWorkingComposer(onAbort);

    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(onAbort).not.toHaveBeenCalled();
  });

  it("does not stop the agent when the two presses fall outside the window", () => {
    const onAbort = vi.fn();
    const textarea = renderWorkingComposer(onAbort);

    fireEvent.keyDown(textarea, { key: "Escape" });
    vi.advanceTimersByTime(1501);
    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(onAbort).not.toHaveBeenCalled();
  });

  it("never stops a non-working agent, even on repeated Escapes", () => {
    const onAbort = vi.fn();
    render(<Composer value="" working={false} onChange={vi.fn()} onSend={vi.fn()} onAbort={onAbort} />);
    const textarea = screen.getByPlaceholderText("Tell Gentle what you need…");

    fireEvent.keyDown(textarea, { key: "Escape" });
    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(onAbort).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// S21: the slash affordance left the composer — no list, no /resume entry,
// no special keys. The composer keeps only a quiet Commands button that
// opens the palette owned by ConversationContainer.
// ---------------------------------------------------------------------------

describe("Composer: command affordance removed, Commands button kept (S21)", () => {
  it("renders no slash list, no options and no aria wiring for one while typing a slash token", () => {
    render(<Harness />);
    const textarea = screen.getByPlaceholderText("Tell Gentle what you need…");

    fireEvent.change(textarea, { target: { value: "/rev" } });

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(textarea).not.toHaveAttribute("aria-expanded");
    expect(textarea).not.toHaveAttribute("aria-controls");
  });

  it("keeps sending a slash draft as plain text instead of completing it", () => {
    const onSend = vi.fn();
    function StatefulHarness() {
      const [value, setValue] = useState("");
      return <Composer value={value} working={false} onChange={setValue} onSend={onSend} onAbort={vi.fn()} />;
    }
    render(<StatefulHarness />);
    const textarea = screen.getByPlaceholderText("Tell Gentle what you need…");

    fireEvent.change(textarea, { target: { value: "/resume" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("offers the quiet Commands button with its accessible name and opens the palette with it", () => {
    const onOpenPalette = vi.fn();
    render(<Harness onOpenPalette={onOpenPalette} />);

    const button = screen.getByRole("button", { name: "Commands" });
    expect(button).toHaveAttribute("type", "button");
    expect(button.getAttribute("title") ?? "").toMatch(/command palette/i);
    expect(button.textContent).toContain("Commands");

    fireEvent.click(button);
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
  });

  it("does not render the Commands button without onOpenPalette", () => {
    render(<Harness />);
    expect(screen.queryByRole("button", { name: "Commands" })).not.toBeInTheDocument();
  });
});
