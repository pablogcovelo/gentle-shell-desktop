// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionNameDialog } from "./SessionNameDialog";

describe("SessionNameDialog", () => {
  it("prefills the session's current name and dispatches the typed text", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<SessionNameDialog initialName="Old name" onConfirm={onConfirm} onCancel={onCancel} />);
    const input = screen.getByRole("textbox", { name: "Session name" });
    expect(input).toHaveValue("Old name");
    fireEvent.change(input, { target: { value: "  New name  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith("New name");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("refuses an empty or whitespace-only name without dispatching", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<SessionNameDialog initialName="Old name" onConfirm={onConfirm} onCancel={onCancel} />);
    const input = screen.getByRole("textbox", { name: "Session name" });
    fireEvent.change(input, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancels with Escape and confirms nothing", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<SessionNameDialog initialName="Old name" onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Session name" }), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // Topmost-surface rule (the container passes active={!paletteOpen}):
  // while it is NOT the topmost open surface the screen claims nothing —
  // its window-level Escape/Tab capture is lifted entirely, so the keys
  // typed into the surface above it reach that surface and dispatch or
  // cancel nothing down here.
  it("claims nothing while it is not the topmost surface — Escape and Enter dispatch nothing", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<SessionNameDialog initialName="Old name" onConfirm={onConfirm} onCancel={onCancel} active={false} />);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.keyDown(document, { key: "Tab" });
    const input = screen.getByRole("textbox", { name: "Session name" });
    fireEvent.change(input, { target: { value: "New name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    // The typed value itself is untouched: the claim is lifted, the
    // screen's own state is not.
    expect(input).toHaveValue("New name");
  });

  it("opens empty when the child reported no name, and still refuses an empty value", async () => {
    const onConfirm = vi.fn();
    render(<SessionNameDialog onConfirm={onConfirm} onCancel={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: "Session name" });
    expect(input).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith("Renamed");
  });
});
