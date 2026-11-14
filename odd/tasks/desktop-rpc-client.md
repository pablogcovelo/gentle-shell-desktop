# Desktop — desktop-rpc client: real session data, subagent Stop, action detail and independent workspaces

Makes the Workspace artboard (`design/slack-gentle/01-workspace.html`) implementable by consuming gentle-pi's `gentle-shell.desktop-rpc/v1` channel and pi's own `get_session_stats`/`get_state`, and by routing every control action by process/session identity instead of by window focus. Contract work that must land in gentle-pi first is specified in that repo's `odd/tasks/desktop-rpc-client-gaps.md`; this document is the app side only. Capability authority for the covered features is `odd/plans/desktop-ade-app-units.md` (units U1–U6b); this document delivers a subset of that plan and adds units the plan does not contain (RPC client base, action detail, footer composition, welcome hero).

Documentation only: no application change is authorized by this file yet.

## Specs

S1. Authorization (verbatim): "Si tenemos todo bien definido y acotado generamos la documentación pertienente para la posterior implementacion porque entiendo que los cuatro bloqueos del unto 4 tienen su solución propuesta. Corrige también las dos rutas de README.md y types.ts." Deliverable is documentation plus the two documentation corrections, not the client.

S2. Document ownership (verbatim): "la documentació odd que afecte a gentle-shell debe vivir en ../gentle-pi y se trabajará con una sesión en su propio repo y la documentación odd que afecte a gentle-shell-desktop vivira es este mismo repo y se trabajará con sesiones en este mismo repo". Consequence: gentle-pi-side methods are specified in that repo, and each side is implemented by a session in its own repository. Neither document authorizes editing the other repository's source.

S3. Process model: one independent `gentle-shell --mode rpc` child per open workspace, never in-process `switch_session` recycling (recorded decision, `odd/plans/desktop-ade-app-units.md:79`, unit U6a). Routing is by process/session identity, never by cwd alone, because two sessions may share a project (`:81`). User's model (verbatim): "El planteamiento es que cada workspace sean sesiones independientes de gentle-shell" and "¿Siendo sesiones independientes como te planteo en 4.2 no sería como tener dos terminales independientes de gentle-shell y que uno reciba uno de estos diálogos? Cada uno viviría en su propia sesión". Independent children are the intended end state; this document does not re-specify U6a beyond what the dialog, state and error routing requires.

S4. Footer profile is the agent-model routing profile (verbatim): "profile-name es el nombre del perfil que el usuario tiene activo desde /gentle:profiles, no la identidad del usuario". It renders the session-effective label the TUI footer shows — `name (session)`, `(local)`, `(repo)` or the bare global name (`gentle-pi/extensions/gentle-shell.ts:248-266`) — not an account identity, and never an invented one.

S5. Footer MCP is honest inventory, not health (user asked, verbatim): "Para el footer de MCP igual podemos investigar este repo https://github.com/oniricosistemas/mcp-sidebar#readme si todavía no es posible recuperar información de los MCP por RPC ¿Podemos crear e RPC en gentle-shell?" Outcome: `pi.getMcpStatus()` does not exist in the pi builds this app or gentle-pi resolve, and `pi.getMcpServers()` covers extension-registered servers only. So the footer may show configured count and tool namespaces, and must never claim "connected". A green state is out of scope until pi ships that API.

S6. Git changes belong to gentle-pi. `lib/shell-changes.ts` already holds the gathering and aggregation behind an injected `GitRunner`; the app renders numbers and never spawns git for policy. A workspace is a GUI host/session context, not a new owner of branch or worktree policy (`odd/plans/desktop-ade-app-units.md:79`).

S7. Action categories come from gentle-pi as data, glyphs stay in the app. The native vocabularies are three separate constant tables plus Engram's memory chrome, all embedded in pi-tui rendering modules, so they are copied into a published vocabulary rather than imported. The GUI keeps its own glyphs (robot for delegation) as already designed in the artboard.

S8. The welcome hero is app-local animation (verbatim): "Si, el hero de bienvenida anmado es animación en app-local". It is not driven by pi: the native choreography paints through `ctx.ui.setHeader`, which RPC does not expose.

S9. The task-card percentage is derived (verbatim): "Si, derivamos el porcentaje por el conteo de tasks". No new field is requested from gentle-pi for it.

S10. Channel facts that bind the client (all verified against gentle-pi `docs/desktop-rpc.md` and `lib/`):
 - The gate is already satisfied: requests answer only when `mode === "rpc"` and `GENTLE_SHELL_INTERACTIVE_HOST === "1"` (`lib/rpc-host.ts:15-17`), which the app has set since M2 (`PiSession.ts:70-78`).
 - A request is a `/gentle:desktop <json>` prompt; the domain answer never comes back as that prompt's `response` (`docs/desktop-rpc.md:32-43`).
 - `requestId` is required, 1..128 characters, and correlates the `setWidget` reply; it is not the prompt `id` (`lib/desktop-rpc.ts:46-48`).
 - The reply is an `extension_ui_request` with `method: "setWidget"`, `widgetKey: "gentle-desktop-rpc"`, JSON in `widgetLines[0]` (`lib/desktop-rpc.ts:3,116-133`, `extensions/gentle-desktop-rpc.ts:38-42`).
 - When the channel is disabled the extension is silent while the prompt still reports `disposition: "handled"`, so success must never be inferred from the prompt response; correlate by `requestId` and time out (`tests/desktop-rpc.test.ts:240-252`).
 - Schema is `gentle-shell.desktop-rpc/v1`; unknown schema is `invalid_request`, unknown method is `unsupported_method`, `capabilities` is the only support probe (`lib/desktop-rpc.ts:1,69,151-155`).
 - Requests are not queued; outcomes settle independently; one response per request (`docs/desktop-rpc.md:1071`).
 - Mid-turn dispatch is proven, not assumed: registered extension commands are handled before the streaming guard in both resolved builds (`rpc-mode.js`/`agent-session.js`, comment "Handle extension commands first (execute immediately, even during streaming)"), so a `/gentle:desktop` request is answered while the assistant streams, whereas a plain prompt without `streamingBehavior` is rejected. A request landing inside the `agent_settled` emission window is deferred rather than dropped, and the client must read a latency spike as deferred, never as lost.

S11. Control traffic is separated from user prompts, and its replies are intercepted before the chat reducer. `ChatState` must not receive `gentle-desktop-rpc` widget frames or the generic `setStatus` frames it currently drops (`chatReducer.ts:206-207`); `setStatus` is instead passed through so an installed MCP or future health publisher can surface real state without a second RPC method.

S12. Telemetry truthfulness: model, thinking level, context usage and cost have no push event today. The client refreshes them on demand and after `agent_settled`, marks them as last-known rather than live, and distinguishes unavailable from zero. Once gentle-pi publishes a state event, the client subscribes instead of polling.

S13. Dialogs are keyed by chat. A pending `select`/`confirm`/`input`/`editor` request belongs to the child that asked it, is answered on that child's stdin, and survives focus changes. No dialog may be destroyed by opening another chat, and no answer may reach an unrelated child. The process model, workspace lifecycle and concurrency risks behind this routing belong to U6a (`odd/plans/desktop-ade-app-units.md`); S13 only names the chat-id keyed dialog route this program implements on top of it.

S14. Action detail is modeled, not dropped. `tool_execution_start` args, `tool_execution_end` result and `isError` are decoded, folded into chat state and recovered from history; the artboard's collapsed rows and their detail come from that data.

S15. High-risk items are declared per task below and each affected unit gets its own commit, so native review can take it alone.

S16. Boundary: gentle-shell owns worktree, branch and ODD directives; the app presents and communicates with it and never competes with that policy. Terminal chrome, raw terminal-input handlers and component factories are not features to port; map the capability instead. The app adds no prompt queue and no app-owned workflow engine.

S17. Capability adoption: U1 is delivered entirely by T2. T3 and T4 are governed by U3's acceptance boundaries (display only data the child supplies; unavailable is never rendered as zero; context occupancy is never derived from accumulated session tokens and no context-window fallback is guessed; usage and async responses stay bound to their source session; refresh happens at meaningful lifecycle boundaries; provider quota is never presented as inferred from session cost — `odd/plans/desktop-ade-app-units.md`, "U3 — Session usage and context"). The subscription-usage meters come from a real subscription usage source, which is not the inference U3 forbids, so both rules coexist. T4 covers the READ half of U2 only — displaying the effective model and thinking level reported by the child, never the last requested choice; selecting model or thinking level remains U2 and is outside this program. The process model behind T5 belongs to U6a, which is the authority; this document only depends on it and specifies nothing of its own. Existing `select`, `confirm`, `input` and `editor` dialogs already cross RPC and must not be described as missing review integration. U4, U5 and U6b remain unscheduled plan units and are not part of this program.

## Tasks

| ID | Specs | Route | Risk | Commit |
| --- | --- | --- | --- | --- |
| T0 | S10 | done — answered from both resolved builds' dispatch code plus a live child probe (L6); no client code written | item 6 (an unverified transport assumption would have invalidated T1-T7) | evidence only, no code |
| T1 | S10, S11 | done — `src/main/domain/rpc/desktopRpc.ts`: envelope build/parse, `requestId`, correlation map with timeout, `capabilities` probe, schema guard, server-code preservation; 24 focused tests over a real captured fixture | none (new isolated module, no existing behaviour touched) | this commit |
| T2a | S11, S17 | done — main process only: `gentle-desktop-rpc` setWidget frames intercepted before the reducer and fed to the client; `setStatus`/`notify` verified against pi's own docs (`statusKey` + `statusText`, where omitting the text IS the wire's clear; `message` + `notifyType`), folded into `ChatState` as keyed statuses and notifications, malformed payloads ignored; control traffic bypasses the user-prompt guard and `disposition: "handled"` never settles a request; two real defects fixed from T1's advisory list. 25 new tests | item 3 (changes what existing chat rendering sees) | this commit |
| T2b | S17 | pending — renderer presentation of the keyed statuses and notification severity from U1. Fields are optional in `ChatState`, so nothing renders them yet and no existing surface changed | none (presentation of already-scoped state) | pending |
| T3 | S12, S17 | delegated writer — `get_subscription_usage` + `rate_limit` event into the Usage section meters; header-only providers stay `pending` and say so; governed by U3's acceptance boundaries (S17) | item 6 (meters are the feature's only proof) | pending |
| T4 | S12, S17 | delegated writer — covers the READ half of U2 only: `get_session_stats` (pi command, correlated by `id`) for cost, tokens and `contextUsage.percent`, plus `get_state` for the effective model and thinking level reported by the child, never the last requested choice; selecting model or thinking level remains U2 and is outside this program; refresh on `agent_settled`; governed by U3's acceptance boundaries (S17); never render unavailable as zero | item 3 (new `RpcCommand` member must not disturb existing prompt/abort framing) | pending |
| T5 | S13 | delegated writer, after U6a lands — the process model, routing by process/session identity, background accumulation, focus-only full-rate rendering, close/quit handling, child-failure locality, the no-workspace-count-cap rule and the concurrency risk all belong to U6a (`odd/plans/desktop-ade-app-units.md`, "U6a"), which is the authority; this document only depends on it and specifies nothing of its own, implementing the chat-id keyed dialog route U6a already demands | item 4 (concurrent children, dialog/answer races), item 1 (workspace records written without validation) | pending |
| T6 | S12 | inline — `list_subagents`/`cancel_subagent` + `agents_update`; enables the Stop control and closes the README limitation | item 3 (README claim changes) | pending |
| T7 | S14 | delegated writer — decode `tool_execution_*` args/result/`isError`, fold into state, recover from history, render disclosure rows with the category from S7 | item 6 | pending |
| T8 | S4-S7 | inline — footer composition once the gentle-pi methods exist: path, worktree changes, capabilities, session-effective profile, model/thinking, context, version. Two honesty rules bind it: worktree counts render only when the child supplies them, so `countsUnavailable` or a failed/unborn root is displayed as such instead of an invented number; and the profile field shows the label the session actually resolved, which differs from the global `active` when a profile is bound | none (presentation of verified data) | pending |
| T9 | S8, S9 | inline — welcome hero animation and derived task percentage | none (app-local presentation) | pending |
| T10 | S1 | inline — README limitation and `types.ts` protocol routes corrected in this slice | none (documentation) | pending |

## Slices

Slice 1 (documentation, `98c7348` plus its evidence update): the feature document, the gentle-pi companion document, `README.md` Stop limitation, `types.ts` protocol routes. No application source, no tests.

Slice 2 (T0, T1, T2) is the base: a client that can prove the channel works before any feature depends on it.

Slice 3 (T3, T4, T6) delivers the artboard's data: Usage meters, session identity, context, subagent Stop. Depends on slice 2 only.

Slice 4 (T5, T7) delivers the interaction model: independent children with dialog routing, and action detail. T5 depends on U6a; T7 depends on slice 2. Both are the largest review burden and ship as separate commits.

Slice 5 (T8, T9) completes the artboard's presentation on top of verified data.

Delivery: local work-unit commits on a feature branch; push, PR and merge remain the owner's decisions.

## Verification

Per task, the checks the implementation session must run — these are the contracts, not yet evidence:

- T0: one real child, `capabilities` answered while idle; then the same request sent while a turn streams, with the outcome recorded either way. A refusal is a finding that reshapes T1, not a failure to work around.
- T1: focused tests for envelope validation (schema mismatch, missing `requestId`, oversized payload, unknown method), correlation of a reply to its `requestId`, timeout when the extension is silent, and rejection of a reply for a different or expired `requestId`. Fixtures recorded as JSONL under `src/main/domain/rpc/__fixtures__/`.
- T2: the reducer never sees `gentle-desktop-rpc` frames; `setStatus` reaches state with its `statusKey`/`statusText`; `notify` renders with its severity and adds no conversation message; feedback stays scoped to its source session; U1's test list (replacement, clearing, malformed payloads, unchanged dialog/helpers/todo behaviour) is binding; existing chat fixtures stay byte-identical.
- T3: a provider with data renders its windows; a header-less provider stays `pending` and never renders zero; a `rate_limit` event updates an already-rendered meter.
- T4: unavailable is rendered as unavailable, never as zero or as a guessed window; only `agent_settled` or an explicit user action triggers a refresh; a late response for a previous chat cannot overwrite the current one.
- T5: two children alive at once; a dialog in A answerable while B is focused; closing A does not touch B; an answer for A never reaches B; two sessions in one cwd are distinguished.
- T6: Stop on a running subagent leaves it non-terminal until `agents_update` confirms, and never reports success from the response alone.
- T7: args, result and error survive a reload via history; an unknown tool renders neutrally with its raw name.
- T8: no field renders without a source; the MCP count never claims a connection state; a worktree root whose counts are unavailable or failed is labelled, never rendered as zero files or zero lines; a bound profile label is distinguishable from the global active profile.
- T9: reduced-motion starts static, the intro plays once per opened chat and settles on restore.
- T10: both corrected references resolve on disk.

U1's and U3's test lists are binding wherever T2–T4 cover them. T5 sits on the concurrency-sensitive workspace unit U6a and requires independent verification when implemented.

Repository-wide, after each slice: `pnpm vitest run` and `pnpm typecheck` clean.

## Log

L1. Original user request (verbatim): "Revisa el tablero Workspace presente en design dime qué cosas no son actualmente implementables, si necesitas revisar gentle-shell puedes hacerlo en el directorio ../gentle-pi".

L2. Follow-up decisions (verbatim, decisive lines): "¿Lo que no es implementable como está dibujado porque no tiene fuente posible tampoco podemos crear al fuente? Recuerda que podemos trabajar en gentle-shell para realizar agregaciones, adaptaciones, correcciones, …"; "profile-name es el nombre del perfil que el usuario tiene activo desde /gentle:profiles, no la identidad del usuario"; "¿Podemos crear e RPC en gentle-shell?"; "¿Cómo solventamos el footer de changes? ¿Lo trabajamos en gentle-shell o trabajo propio en gentle-shell-desktop?"; "¿Cómo solventmos los glifos semánticos read/edit/memory/delegation/rdd que están implementados en gentle-shell?"; "Si, el hero de bienvenida anmado es animación en app-local"; "Si, derivamos el porcentaje por el conteo de tasks"; "no sé porque necesitas apuntar a esas rutas".

L3. Authorization (verbatim): "Si tenemos todo bien definido y acotado generamos la documentación pertienente para la posterior implementacion porque entiendo que los cuatro bloqueos del unto 4 tienen su solución propuesta. Corrige también las dos rutas de README.md y types.ts." Document ownership clarified in the same message, quoted in S2.

L4. Evidence gathered before this document (read-only): the desktop channel exists in gentle-pi and no app source references it; the app's gate variable is already set; `types.ts` points at monorepo paths that do not exist in this checkout; the README Stop claim contradicts `lib/desktop-rpc-agents.ts:280-284`; `pi.getMcpStatus()` is absent from both resolvable pi builds; `lib/shell-changes.ts` separates gathering from rendering.

L5. Open risk carried into T0: whether pi accepts a `/gentle:desktop` prompt while the assistant is streaming is unverified. Usage and Stop matter precisely during a run, so this decides whether the control plane needs a queue, a second child, or a gentle-pi-side change.

L6. T0 closed, no client code written. Code: the stdin loop dispatches each line fire-and-forget and keeps draining during a turn; `prompt` handling reaches the agent session, where registered extension commands run *before* the `isStreaming` guard in both resolved builds (pi-coding-agent 0.85.1 and the build under gentle-pi), so a `/gentle:desktop` request is answered mid-turn while a plain prompt without `streamingBehavior` gets "Agent is already processing". A prompt arriving during the `agent_settled` emission window is deferred, not dropped (newer build only). Live child probe: a real `gentle-shell --mode rpc` child with `GENTLE_SHELL_INTERACTIVE_HOST=1` answered `capabilities` in 1-2 ms with `schema: gentle-shell.desktop-rpc/v1`, 13 methods and `disposition: "handled"`; two requests sent back to back each produced their own correlated `setWidget` reply on `gentle-desktop-rpc`, confirming the no-queue/correlation rule. Consequence for the plan: T1 keeps a plain timeout, no queue and no second child for control traffic; a slow reply is deferred, not lost. Not proven live: a request during an actual model-streamed turn, because that needs one provider call and no authorization for it exists; the dispatch path is identical, so this is a confirmation gap, not a design risk.

L7. T1 closed, with one correction and one discovery. Correction: the client's first version collapsed every server error code into `invalid_request`, which would have made a later Usage view report "invalid request" when the truth was `usage_unavailable`. The authoritative envelope is `{ ok: false, error: { code, message } }` (gentle-pi `lib/desktop-rpc.ts:15`) with 19 codes, so the client now preserves any code verbatim as `server_error`, lifts out only `unsupported_method`, and keeps its own requestId validation distinct as `invalid_request_id`. It also refuses a frame whose `schema` is not `gentle-shell.desktop-rpc/v1` (`schema_mismatch`, settled rather than left to time out) and ignores the server's `requestId: null` case. Discovery: the capability list grew since this document was written — a live probe now advertises 14 methods and 7 events, including `apply_profile` and `profile_applied` from the gentle-pi session's own work. That is exactly why the client asks `capabilities` and never hardcodes a list, and why the recorded fixture is a real capture from a live child rather than a hand-built sample. Checks: 24 tests over that fixture, full suite 42 files / 398 tests, typecheck clean.

L8. Review and T2a. The T1 candidate (`1a7a4c9`, 804 lines, tier medium, four lenses) was reviewed natively and **approved**: four reviewer runs, no correction cycle, authority burned with its receipt. It returned nine informational findings, eight of them in `desktopRpc.ts`, and the closure states they must not reopen that candidate — they are later work, not a reason to re-run review. Two were real defects and are fixed in T2a with pinning tests: an `event`-kind frame could settle a pending request, and a throwing injected `send` rejected the caller's promise and leaked the pending entry until the timer fired (now `send_failed`). Two more were flagged by two independent lenses each (`326-329`, `282`); both were examined and the concrete concern in each was the event-frame settlement, fixed at the call site. The remaining four were examined and left unchanged with a recorded reason rather than cosmetic edits. T2 was split: T2a is main-process plumbing and is what this commit holds; T2b is the renderer presentation and stays pending, so nothing renders statuses or notifications yet. Wire facts verified against pi's own docs rather than assumed — notably that omitting `statusText` is the protocol's way to clear a key, so clearing is implemented instead of swallowed. Checks: T2a 25 new tests, full suite 42 files / 423 tests, typecheck clean, existing fixtures byte-identical.
