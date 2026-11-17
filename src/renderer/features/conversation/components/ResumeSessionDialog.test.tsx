// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CHAT_STATE, type ChatSummary } from "@shared/bridge-types";
import { mockBridge } from "@renderer/shared/bridge/mockBridge";
import { ResumeSessionDialog } from "./ResumeSessionDialog";

const CHAT: ChatSummary = { id: "saved-a", title: "Saved work", cwd: "/project/a", updatedAt: "2026-09-21T09:00:00.000Z", messageCount: 2, state: CHAT_STATE.IDLE };

describe("ResumeSessionDialog", () => {
  it("shows loading, only exact-directory sessions, dates, and keyboard-accessible selection", async () => {
    let resolve!: (chats: ChatSummary[]) => void;
    window.gentle = { ...mockBridge, listChats: vi.fn(() => new Promise<ChatSummary[]>((done) => { resolve = done; })) };
    const onSelect = vi.fn();
    render(<ResumeSessionDialog directory="/project/a" onCancel={vi.fn()} onSelect={onSelect} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading sessions…");
    await act(async () => { resolve([CHAT, { ...CHAT, id: "elsewhere", title: "Wrong directory", cwd: "/project/ab" }]); });
    const choice = screen.getByRole("button", { name: /Saved work/ });
    expect(choice.querySelector("time")).toHaveAttribute("datetime", CHAT.updatedAt);
    expect(screen.queryByText("Wrong directory")).not.toBeInTheDocument();
    choice.focus();
    expect(choice).toHaveFocus();
    fireEvent.click(choice);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(CHAT);
  });

  it.each(["empty", "error"])("shows the %s state without opening anything", async (state) => {
    window.gentle = { ...mockBridge, listChats: state === "empty" ? vi.fn().mockResolvedValue([]) : vi.fn().mockRejectedValue(new Error("History unavailable")) };
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    render(<ResumeSessionDialog directory="/project/a" onCancel={onCancel} onSelect={onSelect} />);
    if (state === "empty") expect(await screen.findByText("No saved sessions in this directory.")).toBeInTheDocument();
    else expect(await screen.findByRole("alert")).toHaveTextContent("Could not load sessions: History unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("traps focus, isolates Escape from global shortcuts, and restores the trigger", async () => {
    window.gentle = { ...mockBridge, listChats: vi.fn().mockResolvedValue([CHAT]) };
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const onCancel = vi.fn();
    const globalKey = vi.fn();
    window.addEventListener("keydown", globalKey);
    const view = render(<ResumeSessionDialog directory="/project/a" onCancel={onCancel} onSelect={vi.fn()} />);
    await screen.findByRole("button", { name: /Saved work/ });
    const first = screen.getByRole("button", { name: "Cancel resume" });
    const last = screen.getByRole("button", { name: "Cancel" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(globalKey).not.toHaveBeenCalled();
    view.unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
    window.removeEventListener("keydown", globalKey);
  });

  it("cancels on the backdrop, not panel content", () => {
    window.gentle = { ...mockBridge, listChats: vi.fn().mockResolvedValue([]) };
    const onCancel = vi.fn();
    render(<ResumeSessionDialog directory="/project/a" onCancel={onCancel} onSelect={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    fireEvent.mouseDown(dialog);
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.mouseDown(dialog.parentElement!);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("discards stale directory responses rather than exposing old choices", async () => {
    let resolveOld!: (chats: ChatSummary[]) => void;
    window.gentle = { ...mockBridge, listChats: vi.fn().mockImplementationOnce(() => new Promise<ChatSummary[]>((done) => { resolveOld = done; })).mockResolvedValue([]) };
    const onSelect = vi.fn();
    const view = render(<ResumeSessionDialog directory="/project/a" onCancel={vi.fn()} onSelect={onSelect} />);
    view.rerender(<ResumeSessionDialog directory="/project/b" onCancel={vi.fn()} onSelect={onSelect} />);
    await screen.findByText("No saved sessions in this directory.");
    await act(async () => { resolveOld([CHAT]); });
    expect(screen.queryByRole("button", { name: /Saved work/ })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveTextContent("/project/b");
    expect(onSelect).not.toHaveBeenCalled();
  });
});
