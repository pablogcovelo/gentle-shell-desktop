import {
  HELPER_STATUS,
  type AgentStatus,
  type HelperAgentState,
  type HelperAgentUsage,
  type HelperStatus,
  type HelperTask,
  type HelpersActivity,
  type HelpersSummary,
} from "@shared/bridge-types";
import { orderHelperTasks } from "./chatReducer";

/**
 * Decoder, merger and overlay for gentle-pi's subagents slice (desktop-rpc
 * T6; contract: gentle-pi `docs/desktop-rpc.md` "list_subagents",
 * "cancel_subagent" and "agents_update"). Pure domain module (hexagonal
 * main process, see src/README.md): no Node or Electron imports, never
 * throws.
 *
 * Modelling rule (same standard as usage.ts): the parser keeps exactly the
 * fields the contract documents — `id`, `agent`, `status` (the closed
 * seven-value set), `model`, and the optional `modelSource`, `fallbackFrom`,
 * `thinking`, `lastStep`, `usage` (`total`, `cost`, plus the
 * final-assistant breakdown once the run settled). Anything else on the
 * wire is ignored, and a field that does not hold the documented type is
 * dropped rather than coerced — the UI must never render a guess.
 * Malformed payloads return `undefined` (or drop the malformed entry), so
 * the caller keeps the previous state.
 *
 * One identity, two sources (desktop-rpc T6 deliverable 1): helper tasks
 * already arrive through the `gentle-agents.activity/v1` widget, which
 * narrates the thread (Task/Plan/Step/Update/Note) and owns timestamps,
 * prompt, label and counters. The RPC projection (`list_subagents`
 * snapshot, `cancel_subagent` post-action reply, `agents_update` event) is
 * the authoritative STRUCTURED state (status, model, usage, lastStep).
 * `overlayAgentsOnTasks` merges both into the same task id so the Helpers
 * tab never shows the same helper twice — the narrative stays, the state
 * fields come from the projection.
 */

/** The closed status set the RPC projection documents (docs/desktop-rpc.md
 * "list_subagents" field table). An unknown status drops the entry. */
export const AGENT_STATUS: ReadonlySet<AgentStatus> = new Set([
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

/**
 * Maps the RPC projection's status vocabulary onto the shared
 * `HelperStatus` vocabulary the renderer already renders. The two sets
 * agree on `queued`/`running`/`waiting`/`failed`/`cancelled` and differ on
 * two terminal statuses the activity path folds into `done`/`failed`:
 *
 * - `completed` -> `done` (same terminal success),
 * - `timed_out` -> `failed` (a terminal failure; the projection's closed
 *   `lastStep` vocabulary still carries `timed_out` as the exact reason,
 *   so nothing is lost by the bucket mapping).
 *
 * Never guessed: every value of the documented RPC set is mapped
 * explicitly, so an added status cannot silently fall into a wrong bucket.
 */
export function toHelperStatus(status: AgentStatus): HelperStatus {
  switch (status) {
    case "completed":
      return HELPER_STATUS.DONE;
    case "timed_out":
      return HELPER_STATUS.FAILED;
    default:
      return status;
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parses the `data` of a `list_subagents` response or an `agents_update`
 * event (`data.agents`, the same whitelisted bounded projection). Returns
 * `undefined` when the payload is not the documented shape at all (no
 * object, or `agents` is not an array): the caller must keep whatever
 * helpers state it already had. A malformed entry is dropped individually,
 * keeping the usable rest; the owner-loaded empty list parses to `[]`.
 */
export function parseAgentList(data: unknown): HelperAgentState[] | undefined {
  if (!isRecord(data) || !Array.isArray(data.agents)) return undefined;
  return data.agents.map(toAgentState).filter((agent): agent is HelperAgentState => agent !== undefined);
}

/**
 * Parses the `data` of a `cancel_subagent` response (`data.agent`, the
 * post-action state re-read from the owner — never an echo of the
 * request).
 */
export function parseAgentEntry(data: unknown): HelperAgentState | undefined {
  if (!isRecord(data)) return undefined;
  return toAgentState(data.agent);
}

function toAgentState(value: unknown): HelperAgentState | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) return undefined;
  if (typeof value.status !== "string" || !isAgentStatus(value.status)) return undefined;

  const usage = toAgentUsage(value.usage);

  const agent: HelperAgentState = {
    id: value.id,
    agent: typeof value.agent === "string" ? value.agent : "",
    status: value.status,
    // `model` is documented as always present, but a present-but-wrongly
    // typed one is dropped rather than coercing a guess (same rule as
    // every other field here).
    ...(typeof value.model === "string" && value.model.length > 0 ? { model: value.model } : {}),
    ...(typeof value.modelSource === "string" && value.modelSource.length > 0 ? { modelSource: value.modelSource } : {}),
    ...(typeof value.fallbackFrom === "string" && value.fallbackFrom.length > 0 ? { fallbackFrom: value.fallbackFrom } : {}),
    ...(typeof value.thinking === "string" && value.thinking.length > 0 ? { thinking: value.thinking } : {}),
    ...(typeof value.lastStep === "string" && value.lastStep.length > 0 ? { lastStep: value.lastStep } : {}),
    ...(usage ? { usage } : {}),
  };
  return agent;
}

function isAgentStatus(value: string): value is AgentStatus {
  return (AGENT_STATUS as ReadonlySet<string>).has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toAgentUsage(value: unknown): HelperAgentUsage | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.total !== "number" || !Number.isFinite(value.total)) return undefined;
  if (typeof value.cost !== "number" || !Number.isFinite(value.cost)) return undefined;

  return {
    total: value.total,
    cost: value.cost,
    // The final-assistant breakdown is absent for an in-flight task and
    // for a restored finished task whose run never recorded one.
    ...(finiteNumber(value.input) !== undefined ? { input: finiteNumber(value.input) } : {}),
    ...(finiteNumber(value.output) !== undefined ? { output: finiteNumber(value.output) } : {}),
    ...(finiteNumber(value.cache) !== undefined ? { cache: finiteNumber(value.cache) } : {}),
    ...(finiteNumber(value.reasoning) !== undefined ? { reasoning: finiteNumber(value.reasoning) } : {}),
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/**
 * Folds one post-action `cancel_subagent` entry into the authoritative
 * projection list: the entry with the same id is replaced in place, an
 * unknown one is appended (the response carries ONE agent, not the whole
 * list — the following `agents_update` event carries the full list).
 */
export function mergeAgentEntry(existing: readonly HelperAgentState[] | undefined, entry: HelperAgentState): HelperAgentState[] {
  const list = [...(existing ?? [])];
  const index = list.findIndex((agent) => agent.id === entry.id);
  if (index === -1) list.push(entry);
  else list[index] = entry;
  return list;
}

/**
 * Re-applies the authoritative projection (`helpers.agents`) onto the
 * activity-merged task list, so an activity frame that arrives after an
 * RPC transition never regresses the structured state the projection
 * already reported. Applies the same rules as `applyAgentState` below.
 */
export function overlayAgentsOnTasks(tasks: readonly HelperTask[], agents: readonly HelperAgentState[], now: string): HelperTask[] {
  const pending = new Map(agents.map((agent) => [agent.id, agent] as const));

  const merged: HelperTask[] = [];
  for (const task of tasks) {
    const agent = pending.get(task.id);
    if (!agent) {
      merged.push(task);
      continue;
    }
    pending.delete(task.id);
    merged.push(mergeTaskWithAgent(task, agent, now));
  }
  for (const agent of pending.values()) merged.push(taskFromAgent(agent, now));

  return orderHelperTasks(merged);
}

/**
 * Merges the authoritative projection into the activity path's state and
 * overlays it onto the tasks (one identity per helper id), recomputing the
 * summary from the merged list so the summary line never contradicts it.
 */
export function applyAgentState(helpers: HelpersActivity, agents: readonly HelperAgentState[], now: string): HelpersActivity {
  const tasks = overlayAgentsOnTasks(helpers.tasks, agents, now);
  // Spread first so fields the caller attached to the slice (the Stop
  // channel state) survive the rebuild.
  return { ...helpers, summary: summaryFor(tasks), tasks, agents: [...agents] };
}

/** A projection entry merged into an existing activity task: the narrative (thread, prompt, label, createdAt, counters) stays, the structured state comes from the projection. */
function mergeTaskWithAgent(task: HelperTask, agent: HelperAgentState, now: string): HelperTask {
  const status = toHelperStatus(agent.status);
  return {
    ...task,
    status,
    lastStep: agent.lastStep ?? task.lastStep,
    model: agent.model ?? task.model,
    thinking: agent.thinking ?? task.thinking,
    usage: agent.usage ?? task.usage,
    // A terminal projection fills a missing endedAt from the fold time —
    // the same fallback the activity merge uses when gentle-pi drops a
    // finished task from its frame — and never invents one while running.
    endedAt: isTerminal(status) && !task.endedAt ? now : task.endedAt,
  };
}

/** A helper the activity path has not reported yet (typically after reopening a chat): built from the projection alone, with an empty thread until the next activity frame narrates it. */
function taskFromAgent(agent: HelperAgentState, now: string): HelperTask {
  const status = toHelperStatus(agent.status);
  return {
    id: agent.id,
    agent: agent.agent,
    label: agent.agent,
    prompt: "",
    status,
    createdAt: now,
    turns: 0,
    toolCalls: 0,
    thread: { version: 0, dropped: 0, items: [] },
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.thinking ? { thinking: agent.thinking } : {}),
    ...(agent.usage ? { usage: agent.usage } : {}),
    ...(agent.lastStep ? { lastStep: agent.lastStep } : {}),
    ...(isTerminal(status) ? { endedAt: now } : {}),
  };
}

function isTerminal(status: HelperStatus): boolean {
  return status === HELPER_STATUS.DONE || status === HELPER_STATUS.FAILED || status === HELPER_STATUS.CANCELLED;
}

function summaryFor(tasks: readonly HelperTask[]): HelpersSummary {
  return {
    running: tasks.filter((task) => task.status === HELPER_STATUS.RUNNING).length,
    queued: tasks.filter((task) => task.status === HELPER_STATUS.QUEUED).length,
    waiting: tasks.filter((task) => task.status === HELPER_STATUS.WAITING).length,
    finished: tasks.filter((task) => isTerminal(task.status)).length,
  };
}
