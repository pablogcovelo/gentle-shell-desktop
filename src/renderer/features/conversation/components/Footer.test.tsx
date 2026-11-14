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

describe("Footer (desktop-rpc T8)", () => {
  it("renders only the fields the child supplied", () => {
    render(<Footer workspace={{ profile: { label: "opensourcing" } }} />);

    const footer = screen.getByLabelText("Session footer");
    expect(footer).toHaveTextContent("opensourcing");
    expect(within(footer).queryByText("MCP")).not.toBeInTheDocument();
    expect(within(footer).queryByText("model")).not.toBeInTheDocument();
    expect(within(footer).queryByText("cost")).not.toBeInTheDocument();
  });

  it("renders nothing at all when nothing was supplied", () => {
    render(<Footer />);
    expect(screen.queryByLabelText("Session footer")).not.toBeInTheDocument();
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
