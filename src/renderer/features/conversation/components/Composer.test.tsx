// @vitest-environment jsdom
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Composer } from "./Composer";

function Harness(props: { readonly initial?: string; readonly onPickFile?: () => Promise<string | null> }) {
  const [value, setValue] = useState(props.initial ?? "");
  return (
    <Composer
      value={value}
      working={false}
      onChange={setValue}
      onSend={vi.fn()}
      onAbort={vi.fn()}
      onPickFile={props.onPickFile}
    />
  );
}

describe("Composer", () => {
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
