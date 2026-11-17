// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WorktreeChanges } from "@shared/bridge-types";
import { Footer } from "./Footer";

const MCP = {
  health: "unknown" as const,
  configuredStatus: "ok",
  configuredNames: ["github", "linear"],
  registered: [],
  namespaces: ["github"],
};

afterEach(() => cleanup());

describe("Footer (desktop-workspace-shell T7 — the design's footer, S9/S10/S11)", () => {
  // S10 — the owner's decision ("Implementa el footer tal cual está en el
  // diseño") supersedes the old "one home per datum" split: the session
  // identity facts now live HERE, in the footer, and the assertion that
  // used to forbid `model` in the footer is rewritten accordingly. Cost is
  // not part of the design's footer groups — its home stays the usage
  // summary in the inspector.
  it("renders the path, the session identity and MCP beside each other", () => {
    render(
      <Footer
        workspace={{ profile: { label: "opensourcing" }, mcp: MCP }}
        workspacePath="/home/dev/gentle"
        session={{ modelId: "claude-sonnet-4-20250514", modelName: "Claude Sonnet 4" }}
      />,
    );

    const footer = screen.getByLabelText("Session footer");
    expect(footer).toHaveTextContent("/home/dev/gentle");
    expect(footer).toHaveTextContent("Claude Sonnet 4");
    expect(footer).toHaveTextContent("opensourcing");
    expect(within(footer).getByLabelText("MCP: 2 configured servers")).toHaveTextContent("2");
    // Cost keeps its single home in the inspector's usage summary.
    expect(footer.textContent).not.toContain("$");
  });

  it("renders the full path and never truncates it with an ellipsis", () => {
    render(
      <Footer workspacePath="/home/dev/a-very-long-directory-path-that-would-otherwise-be-cut" />,
    );

    const footer = screen.getByLabelText("Session footer");
    expect(
      within(footer).getByText("/home/dev/a-very-long-directory-path-that-would-otherwise-be-cut"),
    ).toBeInTheDocument();
    expect(footer.innerHTML).not.toContain("…");
  });

  it("shows ~/ when no workspace path is known, never an invented path", () => {
    render(<Footer />);

    const footer = screen.getByLabelText("Session footer");
    expect(within(footer).getByText("~/")).toBeInTheDocument();
  });

  describe("changes group", () => {
    // Every number is the child's own; nothing is derived.
    const WORKTREE: WorktreeChanges = {
      root: "/home/dev/gentle",
      branch: "main",
      files: ["src/a.ts", "src/b.ts"],
      added: 12,
      deleted: 3,
    };

    it("renders the files count, +added in green and -deleted in red, from the child's own answer", () => {
      const { container } = render(
        <Footer workspace={{ worktree: WORKTREE }} workspacePath="/home/dev/gentle" />,
      );

      const footer = screen.getByLabelText("Session footer");
      expect(within(footer).getByText("changes")).toBeInTheDocument();
      expect(within(footer).getByText("2 files")).toBeInTheDocument();
      const added = within(footer).getByText("+12");
      expect(added).toHaveClass("gc-footer__added");
      const deleted = within(footer).getByText("-3");
      expect(deleted).toHaveClass("gc-footer__deleted");
      // The design's changes group carries no branch: the path group is the
      // only place the directory appears.
      expect(footer.textContent).not.toContain("main");
      expect(container.querySelector(".gc-footer__added")).not.toBeNull();
    });

    it("renders 0 files · +0/-0 for a root nobody could measure, and keeps the caveat out of the visible copy (P8)", () => {
      render(
        <Footer
          workspace={{ worktree: { root: "/home/dev/gentle", files: [], countsUnavailable: true } }}
          workspacePath="/home/dev/gentle"
        />,
      );

      const footer = screen.getByLabelText("Session footer");
      expect(within(footer).getByText("changes")).toBeInTheDocument();
      expect(within(footer).getByText("0 files")).toBeInTheDocument();
      expect(within(footer).getByText("+0")).toBeInTheDocument();
      expect(within(footer).getByText("-0")).toBeInTheDocument();
      // Owner L4/L5: the app never prints the word, and the group is never
      // omitted. The distinction survives accessibly, not visually.
      expect(footer).not.toHaveTextContent("unavailable");
      expect(within(footer).getByRole("group", { name: "Workspace changes" })).toHaveAttribute(
        "title",
        "changes were not measured",
      );
    });

    it("renders 0 files · +0/-0 when tallies are missing, with the same caveat (P8)", () => {
      render(
        <Footer
          workspace={{ worktree: { root: "/repo", files: ["a.ts"] } }}
          workspacePath="/repo"
        />,
      );

      const footer = screen.getByLabelText("Session footer");
      expect(within(footer).getByText("0 files")).toBeInTheDocument();
      expect(within(footer).getByText("+0")).toBeInTheDocument();
      expect(within(footer).getByText("-0")).toBeInTheDocument();
      expect(footer).not.toHaveTextContent("unavailable");
      expect(within(footer).getByRole("group", { name: "Workspace changes" })).toHaveAttribute(
        "title",
        "changes were not measured",
      );
    });

    it("renders the partial sums the child did supply and marks only the unmeasured file (P8)", () => {
      render(
        <Footer
          workspace={{
            worktree: {
              root: "/home/dev/gentle",
              files: ["src/index.ts", "scratch/notes.md"],
              filesUnmeasured: ["scratch/notes.md"],
              added: 12,
              deleted: 3,
            },
          }}
          workspacePath="/home/dev/gentle"
        />,
      );

      const footer = screen.getByLabelText("Session footer");
      // State (b): the counts are real, so they are printed; the unmeasured
      // file is marked, so nobody reads the sums as complete.
      expect(within(footer).getByText("2 files")).toBeInTheDocument();
      expect(within(footer).getByText("+12")).toBeInTheDocument();
      expect(within(footer).getByText("-3")).toBeInTheDocument();
      expect(within(footer).getByRole("group", { name: "Workspace changes" })).toHaveAttribute(
        "title",
        "1 of 2 files were not measured (scratch/notes.md): the counts are partial",
      );
    });

    it("renders no changes group at all when no root is known", () => {
      render(<Footer workspace={{ worktree: WORKTREE }} />);

      const footer = screen.getByLabelText("Session footer");
      expect(within(footer).queryByText("changes")).not.toBeInTheDocument();
      expect(within(footer).queryByText("2 files")).not.toBeInTheDocument();
    });
  });

  describe("capabilities group", () => {
    it.each([
      { label: "empty", commands: [] },
      { label: "non-skill", commands: [{ name: "extension", source: "extension" as const }, { name: "prompt", source: "prompt" as const }] },
    ])("reports a known zero for a $label catalog", ({ commands }) => {
      render(<Footer commands={commands} />);
      const skills = screen.getByRole("img", { name: "Skills: 0" });
      expect(skills).toHaveTextContent("0");
      expect(skills).toHaveAttribute("title", "Skills: 0 — loaded skills reported by get_commands");
    });

    it("counts only skills from the live catalog while preserving capability nodes and other inventories", () => {
      const { rerender } = render(<Footer workspace={{ mcp: MCP }} />);
      const skills = screen.getByRole("img", { name: "Skills: 0" });
      const extensions = screen.getByRole("img", { name: "Extensions: 0" });

      rerender(<Footer workspace={{ mcp: MCP }} commands={[
        ...Array.from({ length: 15 }, (_, i) => ({ name: `skill:${i}`, source: "skill" as const })),
        { name: "extension-command", source: "extension" },
        { name: "prompt-command", source: "prompt" },
      ]} />);
      expect(screen.getByRole("img", { name: "Skills: 15" })).toBe(skills);
      expect(skills).toHaveTextContent("15");
      expect(skills).toHaveAttribute("title", "Skills: 15 — loaded skills reported by get_commands");
      expect(screen.getByRole("img", { name: "Extensions: 0" })).toBe(extensions);
      expect(extensions).toHaveTextContent("0");
      expect(extensions).toHaveAttribute("title", "Extensions: 0 — count not reported by the bridge");
      expect(screen.getByRole("img", { name: "MCP: 2 configured servers" })).toHaveTextContent("2");

      rerender(<Footer commands={[]} />);
      expect(screen.getByRole("img", { name: "Skills: 0" })).toBe(skills);
      expect(skills).toHaveTextContent("0");
      expect(skills).toHaveAttribute("title", "Skills: 0 — loaded skills reported by get_commands");
      rerender(<Footer />);
      expect(screen.getByRole("img", { name: "Skills: 0" })).toBe(skills);
      expect(skills).toHaveAttribute("title", "Skills: 0 — command catalog has not been reported");
    });

    it("describes MCP as inventory and never claims a connection", () => {
      render(<Footer workspace={{ mcp: MCP }} />);

      const footer = screen.getByLabelText("Session footer");
      expect(within(footer).getByLabelText("MCP: 2 configured servers")).toHaveTextContent("2");
      expect(footer).not.toHaveTextContent("tool groups");
      // The word the contract forbids: pi exposes no health, so none is claimed.
      expect(footer.textContent?.toLowerCase()).not.toContain("connected");
      // `health` is carried but never rendered.
      expect(footer.textContent?.toLowerCase()).not.toContain("unknown");
    });

    it("consumes namespace-only MCP inventory without claiming configured or connected servers", () => {
      render(<Footer workspace={{ mcp: { ...MCP, configuredStatus: "absent", configuredNames: [], namespaces: ["codegraph", "context7", "engram"] } }} />);

      const indicator = screen.getByRole("img", { name: "MCP: 3 tool namespaces" });
      expect(indicator).toHaveTextContent("3");
      expect(indicator).toHaveAttribute("title", "Configured servers (absent): none; Registered servers: none; Tool namespaces: codegraph, context7, engram; Connection health is not reported");
    });

    it("keeps configured counts without adding normalized tool namespaces as extra servers", () => {
      render(<Footer workspace={{ mcp: { ...MCP, configuredNames: ["dev-docs"], namespaces: ["dev_docs"] } }} />);

      const indicator = screen.getByRole("img", { name: "MCP: 1 configured servers" });
      expect(indicator).toHaveTextContent("1");
      expect(indicator).toHaveAttribute("title", "Configured servers (ok): dev-docs; Registered servers: none; Tool namespaces: dev_docs; Connection health is not reported");
    });

    it("labels registered-only MCP inventory as registered rather than configured", () => {
      render(<Footer workspace={{ mcp: { ...MCP, configuredStatus: "absent", configuredNames: [], registered: ["github"], namespaces: [] } }} />);

      const indicator = screen.getByRole("img", { name: "MCP: 1 registered servers" });
      expect(indicator).toHaveTextContent("1");
      expect(indicator).toHaveAttribute("title", "Configured servers (absent): none; Registered servers: github; Tool namespaces: none; Connection health is not reported");
    });

    it("renders zero for an empty MCP inventory", () => {
      render(
        <Footer
          workspace={{ mcp: { ...MCP, configuredStatus: "absent", configuredNames: [], namespaces: [] } }}
        />,
      );

      expect(screen.getByLabelText("MCP: 0 configured servers")).toHaveTextContent("0");
    });

    it("keeps skills and extensions visible with zero when their counts are unavailable", () => {
      const { rerender } = render(<Footer />);
      const capabilities = screen.getByRole("group", { name: "Capabilities" });
      const skills = within(capabilities).getByRole("img", { name: "Skills: 0" });
      const extensions = within(capabilities).getByRole("img", { name: "Extensions: 0" });
      expect(skills).toHaveTextContent("0");
      expect(extensions).toHaveTextContent("0");
      expect(skills).toHaveAttribute("title", "Skills: 0 — command catalog has not been reported");
      expect(extensions).toHaveAttribute("title", expect.stringContaining("not reported"));
      expect(within(capabilities).getByLabelText("MCP: 0 configured servers")).toHaveTextContent("0");

      rerender(<Footer workspace={{ mcp: MCP }} />);
      expect(screen.getByRole("group", { name: "Capabilities" })).toBe(capabilities);
      expect(within(capabilities).getByRole("img", { name: "Skills: 0" })).toBe(skills);
      expect(within(capabilities).getByRole("img", { name: "Extensions: 0" })).toBe(extensions);
      expect(within(capabilities).getByLabelText("MCP: 2 configured servers")).toHaveTextContent("2");

      rerender(<Footer />);
      expect(within(capabilities).getByRole("img", { name: "Skills: 0" })).toBe(skills);
      expect(within(capabilities).getByRole("img", { name: "Extensions: 0" })).toBe(extensions);
      expect(within(capabilities).getByLabelText("MCP: 0 configured servers")).toHaveTextContent("0");
    });
  });

  describe("session identity group (S10 — moved out of the status line)", () => {
    const FULL_IDENTITY = {
      modelId: "claude-sonnet-4-20250514",
      modelName: "Claude Sonnet 4",
      thinkingLevel: "medium" as const,
      contextPercent: 30,
      sessionCost: 0.45,
    };

    it("renders model · thinking · profile from the session and the workspace profile", () => {
      render(
        <Footer
          workspace={{ profile: { label: "opensourcing" } }}
          session={FULL_IDENTITY}
        />,
      );

      const identity = screen.getByLabelText("Session identity");
      expect(identity).toHaveTextContent("Claude Sonnet 4");
      expect(identity).toHaveTextContent("medium");
      expect(identity).toHaveTextContent("opensourcing");
      // `·`-separated facts, in the design's order.
      expect(identity.textContent).toContain("·");
    });

    it("falls back to the model id when the child supplies no display name", () => {
      render(<Footer session={{ ...FULL_IDENTITY, modelName: undefined }} />);

      expect(screen.getByLabelText("Session identity")).toHaveTextContent("claude-sonnet-4-20250514");
    });

    it("renders only the identity facts that were supplied", () => {
      render(<Footer session={{ modelId: "gpt-6.1" }} />);

      const identity = screen.getByLabelText("Session identity");
      expect(identity).toHaveTextContent("gpt-6.1");
      expect(identity.textContent).not.toContain("medium");
    });

    it("renders no identity group at all when no session is supplied", () => {
      render(<Footer workspace={{ profile: { label: "opensourcing" } }} />);

      expect(screen.queryByLabelText("Session identity")).not.toBeInTheDocument();
      expect(screen.queryByText("opensourcing")).not.toBeInTheDocument();
    });

    // S6 (desktop-workspace-registry-and-diagnostics): the isolated home
    // signs in to no model, and its `get_state` answers the literal
    // "unknown" — which sessionStats normalizes away upstream. What reaches
    // this footer is a read identity with NO model: render an explicit,
    // actionable hint instead of the wire literal or a silently missing
    // fact.
    it("shows the explicit no-model hint when the identity was read and no model is signed in", () => {
      render(<Footer session={{ thinkingLevel: "off" }} />);

      const identity = screen.getByLabelText("Session identity");
      expect(identity).toHaveTextContent("No model — sign in with /login");
      expect(identity.textContent?.toLowerCase()).not.toContain("unknown");
      // Actionable, not a dead label: the tooltip says where /login lives.
      expect(identity.querySelector(".gc-footer__model--none")).toHaveAttribute(
        "title",
        expect.stringContaining("/login"),
      );
    });

    it("keeps the hint beside the thinking level it was read with, separated like every other fact", () => {
      render(<Footer session={{ thinkingLevel: "low" }} />);

      const identity = screen.getByLabelText("Session identity");
      expect(identity.textContent).toContain("·");
      expect(identity).toHaveTextContent("low");
    });

    it("renders no hint before the identity read has folded — a session without a model answer is not yet a no-model chat", () => {
      // Only the stats half of the identity has arrived so far: claiming
      // "No model" now would be a lie, not a hint.
      render(<Footer session={{ contextPercent: 30 }} />);

      expect(screen.queryByLabelText("Session identity")).not.toBeInTheDocument();
      expect(screen.queryByText(/No model/)).not.toBeInTheDocument();
    });
  });

  describe("context group", () => {
    it("renders the context meter plus the real percent", () => {
      render(<Footer session={{ contextPercent: 18 }} />);

      const context = screen.getByLabelText("Context used");
      expect(context).toHaveTextContent("18%");
      const meter = context.querySelector(".gc-footer__meter");
      expect(meter).not.toBeNull();
      expect(meter?.querySelector("span")?.style.width).toBe("18%");
    });

    // S5: the child reports the percentage with many decimals; the footer
    // shows whole numbers with the TUI's rounding, and the meter agrees with
    // the number beside it.
    it("rounds the context percent to whole numbers with the TUI's rounding", () => {
      const { rerender } = render(<Footer session={{ contextPercent: 30.4 }} />);

      let context = screen.getByLabelText("Context used");
      expect(context).toHaveTextContent("30%");
      expect(context.querySelector<HTMLElement>(".gc-footer__meter span")?.style.width).toBe("30%");

      rerender(<Footer session={{ contextPercent: 30.5 }} />);

      context = screen.getByLabelText("Context used");
      expect(context).toHaveTextContent("31%");
      expect(context.querySelector<HTMLElement>(".gc-footer__meter span")?.style.width).toBe("31%");
    });

    it("renders nothing for a context supplied as unknown (null right after compaction)", () => {
      render(<Footer session={{ contextTokens: null, contextWindow: 200000, contextPercent: null }} />);

      expect(screen.queryByLabelText("Context used")).not.toBeInTheDocument();
      expect(screen.queryByText(/%$/)).not.toBeInTheDocument();
    });

    it("renders nothing when no context percent was supplied — never 0%", () => {
      render(<Footer />);

      expect(screen.queryByLabelText("Context used")).not.toBeInTheDocument();
      expect(screen.queryByText("0%")).not.toBeInTheDocument();
    });
  });

  describe("app version", () => {
    it("prefixes the real bare app version", () => {
      render(<Footer appVersion="0.1.0" />);
      expect(within(screen.getByLabelText("Session footer")).getByText("v0.1.0", { exact: true })).toBeInTheDocument();
    });

    it("renders the version right-aligned without doubling an existing prefix", () => {
      render(<Footer appVersion="v1.2" />);

      expect(within(screen.getByLabelText("Session footer")).getByText("v1.2")).toBeInTheDocument();
    });

    it("renders no version when none was supplied", () => {
      render(<Footer />);

      expect(screen.queryByText("v1.2")).not.toBeInTheDocument();
    });
  });

  it("separates a supplied model and profile even without a thinking level", () => {
    render(<Footer session={{ modelId: "real-model" }} workspace={{ profile: { label: "real-profile" } }} />);
    expect(screen.getByLabelText("Session identity").textContent).toBe("real-model·real-profile");
  });

  it("renders the aria-label the contract pins", () => {
    render(<Footer />);

    expect(screen.getByLabelText("Session footer")).toHaveAttribute("tabindex", "0");
  });
});
