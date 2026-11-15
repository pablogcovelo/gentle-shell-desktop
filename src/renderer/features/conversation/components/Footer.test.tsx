// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WorktreeChanges } from "@shared/bridge-types";
import { Footer } from "./Footer";

const MCP = {
  health: "unknown" as const,
  configuredStatus: "present",
  configuredNames: ["github", "linear"],
  registered: [],
  namespaces: ["mcp__github__search"],
};

afterEach(() => cleanup());

describe("Footer (desktop-rpc T8, T11 path)", () => {
  it("renders the child-supplied fields beside the workspace path", () => {
    render(<Footer workspace={{ profile: { label: "opensourcing" } }} workspacePath="/home/dev/gentle" />);

    const footer = screen.getByLabelText("Session footer");
    expect(footer).toHaveTextContent("opensourcing");
    expect(footer).toHaveTextContent("/home/dev/gentle");
    expect(within(footer).queryByText("MCP")).not.toBeInTheDocument();
    expect(within(footer).queryByText("model")).not.toBeInTheDocument();
    expect(within(footer).queryByText("cost")).not.toBeInTheDocument();
  });

  // T11 — the footer's path is ALWAYS rendered: the full path of the open
  // workspace when one is known, and `~/` when no workspace is open. This
  // replaces the old "renders nothing at all when nothing was supplied"
  // behaviour, which the owner's footer contract (T11) supersedes: the path
  // field no longer depends on the child supplying anything.
  it("shows the open workspace's full path (T11)", () => {
    render(<Footer workspacePath="/home/dev/projects/gentle" />);

    const footer = screen.getByLabelText("Session footer");
    expect(within(footer).getByText("/home/dev/projects/gentle")).toBeInTheDocument();
  });

  it("shows ~/ when no workspace path is known, never an invented path (T11)", () => {
    render(<Footer />);

    const footer = screen.getByLabelText("Session footer");
    expect(within(footer).getByText("~/")).toBeInTheDocument();
  });

  it("describes MCP as inventory and never claims a connection", () => {
    render(<Footer workspace={{ mcp: MCP }} />);

    const footer = screen.getByLabelText("Session footer");
    expect(footer).toHaveTextContent("2 configured");
    expect(footer).toHaveTextContent("1 tool groups");
    // The word the contract forbids: pi exposes no health, so none is claimed.
    expect(footer.textContent?.toLowerCase()).not.toContain("connected");
    // `health` is carried but never rendered.
    expect(footer.textContent?.toLowerCase()).not.toContain("unknown");
  });

  it("says none configured for an absent MCP inventory instead of a zero", () => {
    render(
      <Footer
        workspace={{ mcp: { ...MCP, configuredStatus: "absent", configuredNames: [], namespaces: [] } }}
      />,
    );

    expect(screen.getByLabelText("Session footer")).toHaveTextContent("none configured");
  });

  // T8b — the worktree group, fed by get_worktree_changes for the open
  // workspace's root. Every number is the child's own; nothing is derived.
  const WORKTREE: WorktreeChanges = {
    root: "/home/dev/gentle",
    branch: "main",
    files: ["src/a.ts", "src/b.ts"],
    added: 12,
    deleted: 3,
  };

  it("renders the worktree group from the child's own answer when a root is known (T8b)", () => {
    render(<Footer workspace={{ worktree: WORKTREE }} workspacePath="/home/dev/gentle" />);

    const footer = screen.getByLabelText("Session footer");
    expect(within(footer).getByText("branch")).toBeInTheDocument();
    expect(footer).toHaveTextContent("main");
    expect(footer).toHaveTextContent("2 files");
    expect(footer).toHaveTextContent("+12/-3");
  });

  it("renders unavailable for countsUnavailable — never as zero files and zero lines (T8b)", () => {
    render(
      <Footer
        workspace={{ worktree: { root: "/home/dev/gentle", files: [], countsUnavailable: true } }}
        workspacePath="/home/dev/gentle"
      />,
    );

    const footer = screen.getByLabelText("Session footer");
    expect(footer).toHaveTextContent("unavailable");
    expect(footer.textContent).not.toContain("0 files");
    expect(footer.textContent).not.toContain("+0");
    expect(footer.textContent).not.toContain("-0");
  });

  it("renders no worktree group at all when no root is known (T8b)", () => {
    render(<Footer workspace={{ worktree: WORKTREE }} />);

    const footer = screen.getByLabelText("Session footer");
    expect(within(footer).queryByText("branch")).not.toBeInTheDocument();
    expect(within(footer).queryByText("changes")).not.toBeInTheDocument();
  });

  it("renders nothing invented before the child answers (T8b)", () => {
    render(<Footer workspacePath="/home/dev/gentle" />);

    const footer = screen.getByLabelText("Session footer");
    expect(within(footer).queryByText("branch")).not.toBeInTheDocument();
    expect(within(footer).queryByText("changes")).not.toBeInTheDocument();
  });


it("never prints zero counts when the child supplied no numbers", () => {
  // A worktree with files but without tallies must read as unavailable, not as
  // "0 files · +0/-0": a number the child did not send cannot be invented.
  render(
    <Footer
      workspace={{
        ...WORKTREE,
        worktree: { root: "/repo", files: ["a.ts"] },
      }}
      workspacePath="/repo"
    />,
  );

  expect(screen.queryByText(/\+0\/-0/)).not.toBeInTheDocument();
  expect(screen.getByText(/unavailable/i)).toBeInTheDocument();
});
});
