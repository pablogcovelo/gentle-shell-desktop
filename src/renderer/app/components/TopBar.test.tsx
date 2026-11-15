// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TopBar } from "./TopBar";

const props = () => ({
  sidebarVisible: true,
  inspectorVisible: true,
  onToggleSidebar: vi.fn(),
  onToggleInspector: vi.fn(),
});

describe("TopBar", () => {
  it("keeps panel toggles functional without restoring removed controls", () => {
    const callbacks = props();
    render(<TopBar {...callbacks} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide workspaces" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide general information" }));
    expect(callbacks.onToggleSidebar).toHaveBeenCalledOnce();
    expect(callbacks.onToggleInspector).toHaveBeenCalledOnce();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /settings|shortcuts/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Window controls" })).not.toBeInTheDocument();
  });

  it("preserves all native window actions when supplied", () => {
    const controls = { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() };
    render(<TopBar {...props()} windowControls={controls} />);
    fireEvent.click(screen.getByRole("button", { name: "Minimize window" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize window" }));
    fireEvent.click(screen.getByRole("button", { name: "Close window" }));
    expect(controls.minimize).toHaveBeenCalledOnce();
    expect(controls.toggleMaximize).toHaveBeenCalledOnce();
    expect(controls.close).toHaveBeenCalledOnce();
  });
});
