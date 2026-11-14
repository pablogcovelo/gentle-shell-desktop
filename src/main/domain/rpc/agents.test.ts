import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HELPER_STATUS, type HelperTask, type HelpersActivity } from "@shared/bridge-types";
import { applyAgentState, mergeAgentEntry, overlayAgentsOnTasks, parseAgentEntry, parseAgentList, toHelperStatus } from "./agents";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * `agents-contract.jsonl` carries the documented wire frames of gentle-pi's
 * subagents contract (`docs/desktop-rpc.md` "list_subagents",
 * "cancel_subagent" and "agents_update"), verbatim — plus one
 * contract-shaped variant of the still-running post-action cancel reply
 * the contract describes ("a running task is cancelled asynchronously: the
 * response reports the still-running state"). The documented examples ARE
 * the canonical payload shapes, so the tests read them off the fixture
 * instead of re-typing them.
 */
function readFixtureEnvelope(index: number): { data?: unknown } {
  const raw = readFileSync(path.join(__dirname, "__fixtures__", "agents-contract.jsonl"), "utf8");
  const line = raw.split("\n")[index];
  if (!line) throw new Error(`fixture agents-contract.jsonl has no line ${index}`);
  const frame = JSON.parse(line) as { widgetLines?: string[] };
  return JSON.parse(frame.widgetLines![0]!);
}

describe("parseAgentList", () => {
  it("parses the documented list_subagents projection field for field", () => {
    const envelope = readFixtureEnvelope(0);

    expect(parseAgentList(envelope.data)).toEqual([
      {
        id: "m3a1-worker",
        agent: "worker",
        status: "completed",
        model: "anthropic/claude-sonnet-4",
        modelSource: "binding",
        fallbackFrom: "anthropic/claude-opus-4",
        thinking: "high",
        lastStep: "answered",
        usage: { total: 15234, cost: 0.0421, input: 12000, output: 3234, cache: 5000, reasoning: 4000 },
      },
    ]);
  });

  it("parses the documented agents_update event list (the same projection)", () => {
    const envelope = readFixtureEnvelope(2);

    expect(parseAgentList(envelope.data)).toEqual([
      {
        id: "m3a1-worker",
        agent: "worker",
        status: "cancelled",
        model: "anthropic/claude-sonnet-4",
        lastStep: "completed",
        usage: { total: 15234, cost: 0.0421 },
      },
    ]);
  });

  it("accepts the owner-loaded empty list and returns undefined for payloads that are not the documented shape", () => {
    expect(parseAgentList({ agents: [] })).toEqual([]);

    expect(parseAgentList(undefined)).toBeUndefined();
    expect(parseAgentList("nope")).toBeUndefined();
    expect(parseAgentList({ agents: "nope" })).toBeUndefined();
    expect(parseAgentList({})).toBeUndefined();
  });

  it("drops malformed entries individually and keeps the usable rest", () => {
    const list = parseAgentList({
      agents: [
        { id: "ok-1", agent: "worker", status: "running" },
        { agent: "worker", status: "running" }, // no id
        { id: "bad-status", agent: "worker", status: "zombie" }, // not in the closed status set
        { id: "ok-2", status: "running" }, // agent name missing -> ""
        "not an object",
      ],
    });

    expect(list).toEqual([
      { id: "ok-1", agent: "worker", status: "running" },
      { id: "ok-2", agent: "", status: "running" },
    ]);
  });

  it("drops wrongly-typed optional fields instead of coercing a guess", () => {
    const list = parseAgentList({
      agents: [
        {
          id: "a",
          agent: "worker",
          status: "running",
          model: 42,
          thinking: true,
          lastStep: 7,
          usage: { total: "many", cost: null },
        },
      ],
    });

    expect(list).toEqual([{ id: "a", agent: "worker", status: "running" }]);
  });

  it("keeps only finite numbers in the usage breakdown; a usage object without a usable total/cost is dropped whole", () => {
    expect(
      parseAgentList({
        agents: [
          { id: "a", agent: "w", status: "running", usage: { total: 10, cost: 0.5, input: NaN, output: 3 } },
          { id: "b", agent: "w", status: "running", usage: { total: 10 } },
          { id: "c", agent: "w", status: "running", usage: "nope" },
        ],
      }),
    ).toEqual([
      { id: "a", agent: "w", status: "running", usage: { total: 10, cost: 0.5, output: 3 } },
      { id: "b", agent: "w", status: "running" },
      { id: "c", agent: "w", status: "running" },
    ]);
  });
});

describe("parseAgentEntry", () => {
  it("parses the documented cancel_subagent post-action agent", () => {
    const envelope = readFixtureEnvelope(1);

    expect(parseAgentEntry(envelope.data)).toEqual({
      id: "m3a1-worker",
      agent: "worker",
      status: "cancelled",
      model: "anthropic/claude-sonnet-4",
      lastStep: "cancelled",
      usage: { total: 15234, cost: 0.0421 },
    });
  });

  it("parses the still-running post-action variant the contract describes for an async cancel", () => {
    const envelope = readFixtureEnvelope(3);

    expect(parseAgentEntry(envelope.data)).toEqual({
      id: "m3a1-runner",
      agent: "runner",
      status: "running",
      model: "anthropic/claude-sonnet-4",
      lastStep: "running",
      usage: { total: 900, cost: 0.002 },
    });
  });

  it("returns undefined for a payload without an agent object", () => {
    expect(parseAgentEntry(undefined)).toBeUndefined();
    expect(parseAgentEntry({ agent: "nope" })).toBeUndefined();
    expect(parseAgentEntry({ agent: { status: "running" } })).toBeUndefined();
  });
});

describe("toHelperStatus", () => {
  // The activity vocabulary (`gentle-agents.activity/v1`) and the RPC
  // projection vocabulary differ on two terminal statuses; the mapping is
  // documented, never guessed: completed -> done, timed_out -> failed
  // (the closed lastStep vocabulary still carries the exact reason).
  it("maps the RPC status set onto the shared HelperStatus vocabulary", () => {
    expect(toHelperStatus("queued")).toBe(HELPER_STATUS.QUEUED);
    expect(toHelperStatus("running")).toBe(HELPER_STATUS.RUNNING);
    expect(toHelperStatus("waiting")).toBe(HELPER_STATUS.WAITING);
    expect(toHelperStatus("completed")).toBe(HELPER_STATUS.DONE);
    expect(toHelperStatus("failed")).toBe(HELPER_STATUS.FAILED);
    expect(toHelperStatus("cancelled")).toBe(HELPER_STATUS.CANCELLED);
    expect(toHelperStatus("timed_out")).toBe(HELPER_STATUS.FAILED);
  });
});

describe("overlayAgentsOnTasks", () => {
  const NOW = "2026-09-23T10:00:00.000Z";

  function task(overrides: Partial<HelperTask> = {}): HelperTask {
    return {
      id: "m3a1-worker",
      agent: "worker",
      label: "Audit the loaders",
      prompt: "Find every config reader.",
      status: HELPER_STATUS.RUNNING,
      createdAt: "2026-09-23T09:00:00.000Z",
      startedAt: "2026-09-23T09:00:05.000Z",
      turns: 3,
      toolCalls: 5,
      thread: { version: 2, dropped: 0, items: [{ kind: "text", text: "Working on it." }] },
      ...overrides,
    };
  }

  it("merges the projection into the SAME task identity: narrative stays, state fields come from the projection", () => {
    const merged = overlayAgentsOnTasks(
      [task()],
      [
        {
          id: "m3a1-worker",
          agent: "worker",
          status: "completed",
          model: "anthropic/claude-sonnet-4",
          lastStep: "answered",
          usage: { total: 15234, cost: 0.0421 },
        },
      ],
      NOW,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "m3a1-worker",
      label: "Audit the loaders",
      prompt: "Find every config reader.",
      createdAt: "2026-09-23T09:00:00.000Z",
      startedAt: "2026-09-23T09:00:05.000Z",
      turns: 3,
      toolCalls: 5,
      thread: { version: 2, dropped: 0, items: [{ kind: "text", text: "Working on it." }] },
      status: HELPER_STATUS.DONE,
      model: "anthropic/claude-sonnet-4",
      lastStep: "answered",
      usage: { total: 15234, cost: 0.0421 },
      endedAt: NOW,
    });
  });

  it("a projection-only helper is appended once, with an empty thread and the agent name as label", () => {
    const merged = overlayAgentsOnTasks(
      [],
      [{ id: "m3a1-runner", agent: "runner", status: "running", model: "openai/gpt-5", lastStep: "running" }],
      NOW,
    );

    expect(merged).toEqual([
      {
        id: "m3a1-runner",
        agent: "runner",
        label: "runner",
        prompt: "",
        status: HELPER_STATUS.RUNNING,
        createdAt: NOW,
        turns: 0,
        toolCalls: 0,
        thread: { version: 0, dropped: 0, items: [] },
        model: "openai/gpt-5",
        lastStep: "running",
      },
    ]);
  });

  it("a non-terminal projection never invents endedAt, and a terminal one fills it only when missing", () => {
    const running = overlayAgentsOnTasks([task()], [{ id: "m3a1-worker", agent: "worker", status: "running" }], NOW);
    expect(running[0]?.endedAt).toBeUndefined();

    const withEndedAt = overlayAgentsOnTasks(
      [task({ status: HELPER_STATUS.RUNNING, endedAt: "2026-09-23T09:59:00.000Z" })],
      [{ id: "m3a1-worker", agent: "worker", status: "cancelled" }],
      NOW,
    );
    expect(withEndedAt[0]?.endedAt).toBe("2026-09-23T09:59:00.000Z");
  });

  it("orders like the activity merge does: running, waiting, queued, then finished by endedAt desc", () => {
    const merged = overlayAgentsOnTasks(
      [
        task({ id: "finished", label: "Finished", status: HELPER_STATUS.DONE, endedAt: "2026-09-23T09:30:00.000Z" }),
        task({ id: "queued", label: "Queued", status: HELPER_STATUS.QUEUED }),
      ],
      [{ id: "fresh-runner", agent: "runner", status: "running" }],
      NOW,
    );

    expect(merged.map((entry: HelperTask) => entry.id)).toEqual(["fresh-runner", "queued", "finished"]);
  });
});

describe("applyAgentState", () => {
  const NOW = "2026-09-23T10:00:00.000Z";

  function activity(tasks: HelperTask[]): HelpersActivity {
    return {
      summary: { running: 1, queued: 0, waiting: 0, finished: 0 },
      tasks,
    };
  }

  function task(overrides: Partial<HelperTask> = {}): HelperTask {
    return {
      id: "m3a1-worker",
      agent: "worker",
      label: "Audit the loaders",
      prompt: "Find every config reader.",
      status: HELPER_STATUS.RUNNING,
      createdAt: "2026-09-23T09:00:00.000Z",
      turns: 3,
      toolCalls: 5,
      thread: { version: 0, dropped: 0, items: [] },
      ...overrides,
    };
  }

  it("stores the projection as the authoritative state and overlays it onto the tasks, recomputing the summary from the merged list", () => {
    const next = applyAgentState(activity([task()]), [{ id: "m3a1-worker", agent: "worker", status: "completed" }], NOW);

    expect(next.agents).toEqual([{ id: "m3a1-worker", agent: "worker", status: "completed" }]);
    expect(next.tasks).toHaveLength(1);
    expect(next.tasks[0]?.status).toBe(HELPER_STATUS.DONE);
    expect(next.summary).toEqual({ running: 0, queued: 0, waiting: 0, finished: 1 });
  });

  it("keeps the activity summary when the projection is empty of changes for existing tasks... and still recounts added ones", () => {
    const next = applyAgentState(
      activity([task({ id: "done-1", status: HELPER_STATUS.DONE }), task({ id: "run-1", status: HELPER_STATUS.RUNNING })]),
      [{ id: "fresh", agent: "runner", status: "running" }],
      NOW,
    );

    expect(next.summary).toEqual({ running: 2, queued: 0, waiting: 0, finished: 1 });
  });
});

describe("mergeAgentEntry", () => {
  it("replaces the entry with the same id and appends unknown ones", () => {
    const existing = [{ id: "a", agent: "worker", status: "running" as const }];

    expect(mergeAgentEntry(existing, { id: "a", agent: "worker", status: "cancelled" as const })).toEqual([
      { id: "a", agent: "worker", status: "cancelled" },
    ]);
    expect(mergeAgentEntry(existing, { id: "b", agent: "worker", status: "running" as const })).toHaveLength(2);
  });
});
