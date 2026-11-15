// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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

});
