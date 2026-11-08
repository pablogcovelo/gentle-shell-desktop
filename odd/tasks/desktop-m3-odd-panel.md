# Desktop M3 — ODD task panel

A per-chat panel that shows the current task list of that chat's own session, fed by the hidden `gentle-todo-state` messages gentle-shell already writes. Provisional presentation, mirroring where the TUI puts the same information, until a desktop design exists. No gentle-pi change.

## Specs

S1. The panel shows the task list of the chat that is open, and only that. It is never a global or cross-chat list.
User: "Ok, alimentamos el panel ODD con gentle-todo + gentle-jobs y si es necesario se trabaja presentación y estilos desde Electron" and "Each chat header carries a `Chat | Helpers` toggle" is the existing precedent for per-chat surfaces.

S2. M3 shows tasks only. Phase, feature and document are out of scope.
User: "Ahora solo tareas fase/feature/documento más adelante como planteas." and, after the trade-off was explained, the scope answer "Solo tareas".

S3. `gentle-todo-state` messages never appear in the conversation transcript: no bubble, no text, no placeholder.
Rationale: they are hidden by design (`display: false`) and carry machine state, not conversation.

S4. The task state survives reloading or reopening the chat, because it is recovered from `get_messages` and not from a live-only event.
Evidence for the data source: `gentle-todo.ts:129` emits `{ customType: "gentle-todo-state", content: state }`; `rpc-mode.js:535` returns `{ messages: session.messages }` including custom messages; the state is persisted in the session file and replayed on load (`gentle-todo.ts:396`).

S5. Provisional placement mirrors the TUI: a collapsible card with a one-line summary, placed in the right rail when the window is wide and at the bottom of the work area when narrow.
User: "por simplicidad como no hay todavía un diseño para la interfaz gráfica puedes guiarte de cómo y donde se muestra ahora mismo la información en gentle-shell para replicarlo en la UI provisional mientras no esista un design definitivo para implementar".
TUI evidence: `sidebarPart(tui, "todo", bottom, rail)` in `extensions/gentle-todo.ts:265`, card has `surface: "panel"` and `summary: () => todoWorkSummary(...)`.

S6. M3 requires no change to gentle-pi.

S7. Data contract: `TodoState { tasks: TodoTask[]; nextId: number; updatedTurn: number | null }`, `TodoTask { id: number; title: string; status: TodoStatus; note?: string }` (`gentle-pi/lib/shell-todo.ts:35-47`).

## Tasks

| ID | Specs | Route | Commit |
| --- | --- | --- | --- |
| T1 | S3, S4, S7 | inline — codec keeps `gentle-todo-state` messages, reducer derives panel state | 941ed3a |
| T2 | S1, S7 | inline — no production change needed: `ChatState` is already pushed whole to the renderer, so `todo` crosses with it | n/a (contract only) |
| T3 | S5 | inline — collapsible task card, rail vs bottom by window width | 136f640 |
| T4 | S5 | inline — styles matching the existing theme tokens | 136f640 |
| T5 | S1, S6 | inline — README "What it shows", demo task list in the mock bridge, manual verification | this commit |

## Slices

Slice 1 (closed): a7bda25 the feature document, 941ed3a T1, 136f640 T3 and T4. Slice 2 (this commit) closes the feature with T5: the README, the mock-bridge demo state that makes the card visible in `pnpm dev:web`, and the recorded verification below.

## Verification

- `pnpm vitest run`: 41 files, 371 tests, all passing, after every task.
- `pnpm typecheck`: clean (`tsc --build --force`, no diagnostics).
- Proven behavior: a `gentle-todo-state` message folds into panel state and never into the transcript; a reopened chat recovers its task list from `get_messages` with no live event; the card renders nothing without tasks, summarises `done/planned` with dropped tasks off the list, expands to rows with note and status, de-emphasises done rows and renders an unknown status neutrally; the card is mounted only in the chat pane and never in Helpers.
- Pending: the wide/narrow placement (right rail at 1100px vs stacked at the bottom) is CSS-only and jsdom cannot exercise real width. Verifying it needs a browser (`pnpm exec playwright install chromium`) or a manual `pnpm dev:web` look. Not claimed as verified.

## Log

L1. User request, verbatim:
"Ok, alimentamos el panel ODD con gentle-todo + gentle-jobs y si es necesario se trabaja presentación y estilos desde Electron"

L2. User request, verbatim:
"También te aclaro que solo el workspace enfocado renderiza a plena tasa, los que no tienen el foco acumulan y refrescan al recuperar el foco"

L3. Scope decision, verbatim:
"Ahora solo tareas fase/feature/documento más adelante como planteas."

L4. Provisional-UI instruction, verbatim:
"por simplicidad como no hay todavía un diseño para la interfaz gráfica puedes guiarte de cómo y donde se muestra ahora mismo la información en gentle-shell para replicarlo en la UI provisional mientras no esista un design definitivo para implementar"

L5. Delegation of fixes to upstream, verbatim:
"Si no lo controla por el momento lo ignoramos porque cosidero que este tema es más pertinente tratarlo en gentle-shell ya que es el agente y esta aplicación únicamente es un consumidor gráfico"

L6. Scope answer in the M3 questionnaire: "Solo tareas".

L7. Phase channel decision for the later milestone: "Status key en gentle-pi", i.e. `setStatus("odd-phase", "exploring…")`.

L8. Evidence gathered before writing this document (see Engram topic `architecture/workspace-process-model`): `gentle-todo` does not cross RPC as a widget because RPC mode forwards only string arrays and ignores Component factories (`rpc-mode.js`); `setStatus` carries `statusText` strings only, so `gentle-jobs` is one line, not a panel; the structured todo state crosses as hidden custom messages.

L9. Deferred to the workspaces milestone, not M3: opening the same session twice in two children (unguarded upstream, verbatim "Si se puede evitar gratis lo contemplamos"); restoring open workspaces in waves ("Si, se restaura por oleadas, pensaba que ya lo habíamos acordado así"); rendering only the focused workspace at full delta rate (L2). The current app hosts one session at a time (`ChatHost`), so none of the three can be exercised yet.

L10. T2 turned out to need no production change: `ChatState` is pushed to the renderer whole (`registerHandlers.ts` forwards `host.onState` verbatim), so `todo` crosses the IPC boundary with it and there is no second channel to add. Recorded instead of inventing a redundant hop.

L11. The mock bridge's initial state now carries a demo task list so `pnpm dev:web` can render the card without a real child behind it. The wide/narrow placement stays visually unverified: it is CSS-only, jsdom cannot exercise real width, and downloading Playwright's browsers was not done because it was not authorized.
