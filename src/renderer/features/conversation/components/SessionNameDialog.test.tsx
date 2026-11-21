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
