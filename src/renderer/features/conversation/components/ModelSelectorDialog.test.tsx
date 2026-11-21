// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AvailableModelsResult, GentleBridge, ModelOptionView } from "@shared/bridge-types";
import { mockBridge } from "@renderer/shared/bridge/mockBridge";
import { ModelSelectorDialog } from "./ModelSelectorDialog";

const MODELS: readonly ModelOptionView[] = [
  { provider: "openai", id: "gpt-5", label: "GPT-5" },
  { provider: "anthropic", id: "claude-sonnet-4", label: "Claude Sonnet 4" },
  { provider: "anthropic", id: "claude-opus-4", label: "Claude Opus 4" },
];

function bridgeWith(result: AvailableModelsResult): GentleBridge {
  return { ...mockBridge, availableModels: vi.fn().mockResolvedValue(result) };
}

const MANY_MODELS: readonly ModelOptionView[] = Array.from({ length: 12 }, (_, index) => ({
  provider: "pi",
  id: `model-${index}`,
  label: `Model ${index}`,
}));

describe("ModelSelectorDialog", () => {
  it("moves the selection with the arrows no matter which element holds focus", async () => {
    window.gentle = bridgeWith({ kind: "ok", truncated: false, models: MODELS });
    render(<ModelSelectorDialog hostId="host-1" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const options = await screen.findAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    // The filter input must NOT hold focus: navigation has to stay active
    // while any other element of the dialog has it (L8 failure 1).
    const cancel = screen.getByRole("button", { name: "Cancel" });
    cancel.focus();
    expect(cancel).toHaveFocus();

    // The keydown is dispatched on the LIST, not on the input.
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Models" }), { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
  });

  it("moves the selection with the arrows and confirms with Enter even when nothing in the dialog holds focus (S11)", async () => {
    const onConfirm = vi.fn();
    window.gentle = bridgeWith({ kind: "ok", truncated: false, models: MODELS });
    render(<ModelSelectorDialog hostId="host-1" onConfirm={onConfirm} onCancel={vi.fn()} />);
    await screen.findAllByRole("option");

    // Park focus on body: nothing inside the dialog holds it.
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    // The keydown is dispatched on document.body — where the browser parks
    // focus after the app window loses and regains it.
    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");

    // Enter still confirms exactly once.
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith("anthropic/claude-sonnet-4");
  });

  it("restores focus to the filter input when the app window regains focus, and the arrows still navigate (S11)", async () => {
    window.gentle = bridgeWith({ kind: "ok", truncated: false, models: MODELS });
    render(<ModelSelectorDialog hostId="host-1" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    await screen.findAllByRole("option");
    const input = screen.getByRole("combobox", { name: "Filter models" });
    expect(input).toHaveFocus();

    // The app window loses focus (a click outside the GUI) — the browser
    // parks focus on body — and then the window regains it.
    input.blur();
    fireEvent(window, new Event("focus"));

    expect(input).toHaveFocus();
    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
  });

  it("scrolls the newly selected row into view when arrows move past the visible window", async () => {
    const calls: Array<{ element: Element | undefined; arg: unknown }> = [];
    const spy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(function (this: Element, arg) {
        calls.push({ element: this, arg });
      });
    try {
      // 12 rows overflow the list's 320px max-height: arrowing from the
      // first row to the fifth leaves the visible window (L8 failure 1).
      window.gentle = bridgeWith({ kind: "ok", truncated: false, models: MANY_MODELS });
      render(<ModelSelectorDialog hostId="host-1" onConfirm={vi.fn()} onCancel={vi.fn()} />);
      await screen.findAllByRole("option");
      calls.length = 0; // drop the initial mount scroll

      const list = screen.getByRole("listbox", { name: "Models" });
      fireEvent.keyDown(list, { key: "ArrowDown" });
      fireEvent.keyDown(list, { key: "ArrowDown" });
      fireEvent.keyDown(list, { key: "ArrowDown" });
      fireEvent.keyDown(list, { key: "ArrowDown" });

      expect(calls).toHaveLength(4);
      expect(calls[3]!.element).toBe(screen.getAllByRole("option")[4]);
      expect(calls[3]!.arg).toEqual({ block: "nearest" });
    } finally {
      spy.mockRestore();
    }
  });

  it("scrolls the selected row into view after a filter change even when the selection index did not move (R3-002)", async () => {
    const calls: Array<{ element: Element | undefined; arg: unknown }> = [];
    const spy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(function (this: Element, arg) {
        calls.push({ element: this, arg });
      });
    try {
      window.gentle = bridgeWith({ kind: "ok", truncated: false, models: MANY_MODELS });
      render(<ModelSelectorDialog hostId="host-1" onConfirm={vi.fn()} onCancel={vi.fn()} />);
      await screen.findAllByRole("option");
      calls.length = 0; // drop the initial mount scroll

      // The user wheel-scrolls the list down without moving the selection:
      // row 0 stays highlighted but is out of the visible window.
      const list = screen.getByRole("listbox", { name: "Models" });
      list.scrollTop = list.scrollHeight;
      calls.length = 0;

      // A filter change keeps the selection on the first match and must
      // bring it back into view — Enter would otherwise confirm a row the
      // user cannot see.
      fireEvent.change(screen.getByRole("combobox", { name: "Filter models" }), { target: { value: "model-0" } });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.element).toBe(screen.getAllByRole("option")[0]);
      expect(calls[0]!.arg).toEqual({ block: "nearest" });
    } finally {
      spy.mockRestore();
    }
  });

  it("lists the child's models with the current model preselected and first, and confirms the exact provider/id", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    window.gentle = bridgeWith({ kind: "ok", truncated: false, models: MODELS });
    render(<ModelSelectorDialog hostId="host-1" currentModel={{ provider: "anthropic", id: "claude-sonnet-4" }} onConfirm={onConfirm} onCancel={onCancel} />);

    // Before the read answers, the list is a loading status — never a
    // fabricated option.
    expect(screen.getByRole("status")).toHaveTextContent("Loading models…");
    const dialog = await screen.findByRole("dialog", { name: "Choose a model" });
    const options = await within(dialog).findAllByRole("option");
    // The current model is ordered first and marked selected; the rest keep
    // the child's reported order.
    expect(options[0]).toHaveTextContent("Claude Sonnet 4");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveTextContent("GPT-5");
    expect(options[2]).toHaveTextContent("Claude Opus 4");
    expect(bridgeWith as unknown).toBeDefined();

    // Enter confirms the selection with provider/id as the value.
    fireEvent.keyDown(within(dialog).getByRole("combobox"), { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith("anthropic/claude-sonnet-4");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("renders a nameless entry as provider/id and never invents a name", async () => {
    window.gentle = bridgeWith({
      kind: "ok",
      truncated: false,
      models: [{ provider: "anthropic", id: "claude-sonnet-4", label: "anthropic/claude-sonnet-4" }],
    });
    render(<ModelSelectorDialog hostId="host-1" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(await screen.findByText("anthropic/claude-sonnet-4")).toBeInTheDocument();
  });

  it("narrows the list while the user types", async () => {
    window.gentle = bridgeWith({ kind: "ok", truncated: false, models: MODELS });
    render(<ModelSelectorDialog hostId="host-1" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const input = await screen.findByRole("combobox", { name: "Filter models" });
    fireEvent.change(input, { target: { value: "opus" } });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Claude Opus 4");
  });

  it("cancels with Escape and confirms nothing", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    window.gentle = bridgeWith({ kind: "ok", truncated: false, models: MODELS });
    render(<ModelSelectorDialog hostId="host-1" onConfirm={onConfirm} onCancel={onCancel} />);
    await screen.findByRole("option", { name: /GPT-5/ });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Filter models" }), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("selects the first reported entry when the current model is not in the list — never a preselection of an unlisted model", async () => {
    window.gentle = bridgeWith({ kind: "ok", truncated: false, models: MODELS });
    render(<ModelSelectorDialog hostId="host-1" currentModel={{ provider: "mistral", id: "mistral-large" }} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const options = await screen.findAllByRole("option");
    expect(options[0]).toHaveTextContent("GPT-5");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("mistral-large")).not.toBeInTheDocument();
  });

  it("says when the reported list is truncated", async () => {
    window.gentle = bridgeWith({ kind: "ok", truncated: true, models: MODELS });
    render(<ModelSelectorDialog hostId="host-1" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(await screen.findByText(/truncated/)).toBeInTheDocument();
  });

  it.each(["unsupported", "failed"] as const)("degrades to a typed input when the child cannot answer (%s), with the right source label", async (kind) => {
    const onConfirm = vi.fn();
    window.gentle = bridgeWith({ kind });
    render(<ModelSelectorDialog hostId="host-1" currentModel={{ provider: "anthropic", id: "claude-sonnet-4" }} onConfirm={onConfirm} onCancel={vi.fn()} />);

    // The selector is gone; the field says the list did not come from the child.
    expect(await screen.findByText(/did not report its available models/)).toBeInTheDocument();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "Model" });
    fireEvent.change(input, { target: { value: "  openai/gpt-5  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith("openai/gpt-5");
  });

  it("refuses an empty value in the degraded input", async () => {
    const onConfirm = vi.fn();
    window.gentle = bridgeWith({ kind: "unsupported" });
    render(<ModelSelectorDialog hostId="host-1" onConfirm={onConfirm} onCancel={vi.fn()} />);
    const input = await screen.findByRole("textbox", { name: "Model" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Use model" })).toBeDisabled();
  });

  it("degrades to the typed input when the bridge has no availableModels method at all (R2-001/R3-001)", async () => {
    const onConfirm = vi.fn();
    // A bridge that simply lacks the method — the short-circuit case: the
    // optional call yields undefined, and the documented degradation must
    // still settle instead of the dialog sitting on "Loading…" forever.
    const { availableModels: _omitted, ...bridgeWithoutMethod } = mockBridge;
    window.gentle = bridgeWithoutMethod as GentleBridge;
    render(<ModelSelectorDialog hostId="host-1" onConfirm={onConfirm} onCancel={vi.fn()} />);

    expect(await screen.findByText(/did not report its available models/)).toBeInTheDocument();
    expect(screen.queryByText("Loading models…")).not.toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "Model" });
    fireEvent.change(input, { target: { value: "openai/gpt-5" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith("openai/gpt-5");
  });

  it("an ok answer with no models also degrades to the typed input", async () => {
    const onConfirm = vi.fn();
    window.gentle = bridgeWith({ kind: "ok", truncated: false, models: [] });
    render(<ModelSelectorDialog hostId="host-1" onConfirm={onConfirm} onCancel={vi.fn()} />);
    expect(await screen.findByText(/reported no models/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Model" }), { target: { value: "openai/gpt-5" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Model" }), { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith("openai/gpt-5");
  });

  it("traps focus and restores the trigger, isolating Escape from global shortcuts", async () => {
    window.gentle = bridgeWith({ kind: "ok", truncated: false, models: MODELS });
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const onCancel = vi.fn();
    const globalKey = vi.fn();
    window.addEventListener("keydown", globalKey);
    const view = render(<ModelSelectorDialog hostId="host-1" onConfirm={vi.fn()} onCancel={onCancel} />);
    await screen.findByRole("option", { name: /GPT-5/ });
    const input = screen.getByRole("combobox", { name: "Filter models" });
    expect(input).toHaveFocus();
    // Focus cycles through the dialog's own focusables in document order:
    // ✕ close, filter input, footer Cancel — never to the page behind.
    const close = screen.getByRole("button", { name: "Cancel model choice" });
    const last = screen.getByRole("button", { name: "Cancel" });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(globalKey).not.toHaveBeenCalled();
    view.unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
    window.removeEventListener("keydown", globalKey);
  });

  it("keeps the current pill on the applied model when the highlight moves", async () => {
    window.gentle = bridgeWith({ kind: "ok", truncated: false, models: MODELS });
    render(<ModelSelectorDialog hostId="host-1" currentModel={{ provider: "anthropic", id: "claude-sonnet-4" }} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const options = await screen.findAllByRole("option");
    expect(within(options[0]!).getByText("current")).toBeInTheDocument();

    // Arrow off the applied model: the highlight moves, the applied mark
    // stays with the model the chat is actually running (S9).
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Models" }), { key: "ArrowDown" });
    const moved = screen.getAllByRole("option");
    expect(moved[1]).toHaveAttribute("aria-selected", "true");
    expect(within(moved[0]!).getByText("current")).toBeInTheDocument();
    expect(within(moved[1]!).queryByText("current")).not.toBeInTheDocument();
  });

  it("keeps focus inside the dialog while loading and retargets it to the filter input when the read answers", async () => {
    window.gentle = bridgeWith({ kind: "ok", truncated: false, models: MODELS });
    render(<ModelSelectorDialog hostId="host-1" onConfirm={vi.fn()} onCancel={vi.fn()} />);

    // Same shape as the thinking screen: while "Loading models…" shows,
    // focus is already inside the modal, not on the page behind it.
    const dialog = screen.getByRole("dialog", { name: "Choose a model" });
    expect(dialog.contains(document.activeElement)).toBe(true);

    // When the answer lands, the filter input takes focus back.
    const input = await screen.findByRole("combobox", { name: "Filter models" });
    expect(input).toHaveFocus();
  });

  it("the list obeys the shared dialog list contract, not a screen-only stylesheet", async () => {
    window.gentle = bridgeWith({ kind: "ok", truncated: false, models: MODELS });
    render(<ModelSelectorDialog hostId="host-1" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(await screen.findByRole("listbox", { name: "Models" })).toHaveClass("gc-dialog__list");
  });

});
