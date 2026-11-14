# Desktop ADE — app-only work units

Plan only: implement capability parity with gentle-shell through a desktop GUI, not a copy of terminal rendering. No runtime behavior is changed by this document. All units below are unimplemented.

## Boundaries

- gentle-shell owns worktree/branch/ODD directives and tools; the app presents and communicates with it. Do not implement a competing workflow engine.
- Keep the existing provisional placement. The TUI is a placement reference until a desktop design exists, not a constraint on desktop interaction.
- No dictation, app-control CLI, cloud/mobile, emulator, or plugin marketplace in this plan.
- Host contracts are now in scope and specified in gentle-pi's `odd/tasks/desktop-rpc-client-gaps.md`; gaps that still have no contract go to [the deferred contract backlog](desktop-ade-deferred-contracts.md), not an app workaround. The app never substitutes app-owned policy for a missing host capability. This supersedes the earlier "contract documented but addressed later" decision (Decision 6).
- Preserve M3 and its per-chat todo/helpers boundaries. ODD phase remains deferred; do not infer it from transcript text.
- Work stays in the fork. Preserve `main`; publishing remains a separate decision (M3 Log L12).

## Execution order

Each row is a behavior unit with its own tests and documentation, not a mandate to implement every row in one feature. Before implementation, read the actual launcher's supported protocol, freeze the unit's acceptance criteria, and classify its risk. Unsupported commands move to the deferred backlog; they must not silently acquire an app-owned substitute.

| Unit | Outcome | Dependency | Starting surfaces |
| --- | --- | --- | --- |
| U1 | Show existing status entries and notifications | None | `rpc/types.ts`, `rpc/codec.ts`, `rpc/chatReducer.ts`, conversation UI |
| U2 | Select model and thinking level | Confirm base-pi command contracts | `session/PiSession.ts`, bridge, conversation controls |
| U3 | Show session usage and context information | Confirm stats/state schemas; reuse U2 response handling | Same session/bridge boundary; existing header/status area |
| U4 | Discover and submit available extension commands | Confirm discovery and slash dispatch contracts | Session/bridge, composer command suggestions |
| U5 | Steer active work and queue follow-ups | Confirm queue commands/events | Session/bridge, composer |
| U6a | Keep independent workspaces alive when switching focus | Existing per-child primitive | `session/ChatHost.ts`, `PiSession.ts`, bridge, chat selection |
| U6b | Restore open workspaces in waves on app relaunch | U6a | App configuration, host lifecycle, workspace state |

Recommended sequence: U1 → U2 → U3 → U4 → U5 → U6a → U6b. These are sequencing recommendations, not claims that all are equally small. U6 is concurrency-sensitive and is deliberately split; do not label it a trivial quick win.

Prerequisite: U1, U2-read, U3 and the workspace unit consume the desktop RPC client base (`../tasks/desktop-rpc-client.md` T1/T2), so the client base lands before them; the recommended U1 → U6b sequence is unchanged for capability order. Delivery specs: U1 → `desktop-rpc-client.md` T2 (delivered there in full); U2 → the read half in T4, with selection still open here; U3 → T3/T4; U6a → the process-model authority referenced by T5. U4, U5 and U6b have no delivery spec and remain unscheduled.

Paths in the table are relative to `src/main/domain/` unless they name the bridge/UI. They are starting points, not finalized worker edit permissions.

## Acceptance boundaries

### U1 — Existing status and notification feedback

Delivery spec: `../tasks/desktop-rpc-client.md` T2 delivers this unit in full; its acceptance criteria govern there.

Consume `extension_ui_request` methods `setStatus` and `notify`, currently discarded by the reducer. Validate actual field names before adding typed payloads.

- Keep status entries keyed, replace/clear them according to the wire contract, and render notification severity without adding conversation messages.
- Scope all feedback, including async responses, to its source session; errors and notifications must not be duplicated. Generic keyed status replacement/clearing is distinct from unrelated completion notifications.
- Test replacement, clearing, malformed payloads and unchanged dialog/helpers/todo behavior. Verify presentation in the running renderer.
- Do not invent phase state or OS sound/notification behavior; upstream publication of `odd-phase` is deferred.

### U2 — Model and thinking controls

Delivery spec: the READ half ships in `../tasks/desktop-rpc-client.md` T4; model/thinking selection remains open in this plan.

Validate candidate base-pi commands `get_state`, `get_available_models`, `set_model` and `set_thinking_level` against the launcher actually used by the app. Their presence in newer pi documentation is not sufficient proof.

- List only available choices and show effective model/thinking state reported by the child, not merely the last requested choice.
- Handle unsupported thinking levels, rejected changes and busy-state behavior according to the protocol. A failed change must not look successful.
- Correlate command responses and validate their data at the session boundary. Preserve existing history/live-state protections.
- Test success, rejection and stale/interleaved responses, including project switches and switch-away-and-back. If model/thinking selection takes two steps, failure of the second must not falsely report the pair as successful; keep requested and confirmed effective state distinct. Verify controls with a real child. No login or credential management.

### U3 — Session usage and context

Delivery spec: `../tasks/desktop-rpc-client.md` T3/T4 deliver the usage and session-identity displays under this unit's boundaries.

Validate `get_session_stats` and relevant `get_state` fields, including units and context semantics.

- Display only data the child supplies; distinguish unavailable data from zero. Accumulated session tokens are not occupied context; do not derive context occupancy from them or guess a fallback context-window size.
- Keep usage and async responses bound to their source session, refresh at meaningful lifecycle boundaries, and avoid claiming a provider quota from session costs.
- Test payload validation, refresh and failures; verify values against the same child's responses. No account/quota manager.

### U4 — Command discovery

Validate `get_commands` and slash-command dispatch through `prompt` before adding discoverability to the composer.

- Surface only commands/categories returned by the child. A static palette or local built-ins do not establish host discovery parity; do not maintain a hardcoded replica of `/gentle:*`.
- Preserve argument entry and route interactive results through existing dialogs. Verify whether command text belongs in the transcript before using ordinary prompt echo.
- Test discovery failure, selection, arguments, dialog-producing commands and busy-state behavior.
- Built-in `/login` support is unconfirmed; do not advertise terminal-only capabilities as usable commands.

### U5 — Steering and follow-ups

Validate `steer`, `follow_up`, queue inspection/update and clearing semantics. Current `PromptResult.queued` means accepted submission, not an existing execution queue.

- Make immediate steering distinct from a later follow-up. The child owns ordering and execution; the app does not add its own competing prompt queue.
- Display actual queued state when the protocol supplies it. Transport support for `steer`/`followUp` is not a queue UI or authoritative queue state; optimistic echoes prove neither ordering nor clearing. Do not expose clearing unless a supported command exists.
- Test order, acceptance/rejection, consumption, cancellation and abort/drop interactions against real child behavior through the protocol; preserve ordinary idle submission.

### U6a — Independent live workspaces

Delivery spec: `../tasks/desktop-rpc-client.md` T5 depends on this unit; the process model stays authoritative here.

Preserve the process model decided before M3: one independent `gentle-shell --mode rpc` child per open workspace, not in-process `switch_session` recycling. A workspace is a GUI host/session context, not a new owner of branch or worktree policy.

- Switching focus must not stop another workspace's child. Route prompts, aborts, dialogs, state and errors by process/session identity, not just cwd: two sessions may share a project. Never fall back to an unrelated live child.
- Background workspaces keep consuming and accumulating state; only the focused workspace renders at full delta rate and refreshes on focus.
- Closing a workspace stops only its child; app quit handles all children, including starts in flight. A child failure remains local.
- No new arbitrary workspace-count cap. Reuse an already open session within this app rather than creating an accidental duplicate; do not claim cross-process session locking.
- Test independent in-flight starts and cancellation, two sessions in the same project, focus switches, routing isolation, background accumulation, close/quit and child failure. Run a real two-workspace check in isolated session state.
- Risk: concurrency. Requires independent verification when implemented, unlike ordinary presentation-only work.

### U6b — Restore workspaces in waves

- Persist only the GUI information needed to reopen workspaces and recover focus, not credentials or a second copy of session contents.
- Restore in bounded waves, as agreed in M3 Log L9; choose/document the wave size during implementation. A wave size is not a total workspace cap. Reconnecting a browser to a still-live server is not evidence of app-restart restoration waves.
- Handle missing sessions and failed children without blocking other restores or reopening duplicates inside the app.
- Test persistence/relaunch, partial restore failure, focus recovery and quit during restore. Reuse U6a isolation checks.
- Session ownership across terminals/processes remains an upstream concern, not an app lock implementation.

## Evidence and confidence

- M3 placement, scope and prior workspace decisions: [`../tasks/desktop-m3-odd-panel.md`](../tasks/desktop-m3-odd-panel.md), S1–S6 and Log L2, L4–L9, L12.
- Existing single-child host: `src/main/domain/session/ChatHost.ts:60–79,144–165`. Each switch currently stops the previous child.
- Per-child launch and prompt boundary: `src/main/domain/session/PiSession.ts:119–136,163–187`.
- Generic responses already decode, but only history has result handling: `src/main/domain/rpc/codec.ts:203–212`; `PiSession.ts:246–297`. New command failures cannot be left silently ignored.
- Existing status/notify event transport: `src/main/domain/rpc/types.ts:101–103,148–153`; reducer drops them at `chatReducer.ts:188–211`.
- The app's current command union does not type U2–U5 commands (`rpc/types.ts:27–43`). Those units are conditional on protocol validation, not confirmed ready-made integrations.
- Installed dependency versions and the externally resolved launcher may differ. Pin evidence to the actual launcher during implementation.

### Viewer static comparison — regression guidance, not runtime proof

The static audit used Viewer tree `9b80dfc8fd60ddf204fba3c2e7b7c494a8d6554c` (2026-11-11). Observed source and test definitions informed the boundaries above; tests were not executed. No functional Viewer evaluation occurred because the human declined isolated setup. Future evaluation or adoption is optional, not an approved milestone or prerequisite for U1–U6.

Source references in [Open Pi Viewer at the audited commit](https://github.com/gonzalez962/open-pi-viewer/tree/9b80dfc8fd60ddf204fba3c2e7b7c494a8d6554c):
- Desktop [`process.rs`](https://github.com/gonzalez962/open-pi-viewer/blob/9b80dfc8fd60ddf204fba3c2e7b7c494a8d6554c/src-tauri/src/process.rs), [`models.rs`](https://github.com/gonzalez962/open-pi-viewer/blob/9b80dfc8fd60ddf204fba3c2e7b7c494a8d6554c/src-tauri/src/commands/models.rs), [`mod.rs`](https://github.com/gonzalez962/open-pi-viewer/blob/9b80dfc8fd60ddf204fba3c2e7b7c494a8d6554c/src-tauri/src/commands/mod.rs) and [`connection.rs`](https://github.com/gonzalez962/open-pi-viewer/blob/9b80dfc8fd60ddf204fba3c2e7b7c494a8d6554c/src-tauri/src/commands/connection.rs): transport, response and process-routing boundaries, not end-to-end success evidence.
- [`prompt-controls-utils.ts`](https://github.com/gonzalez962/open-pi-viewer/blob/9b80dfc8fd60ddf204fba3c2e7b7c494a8d6554c/src/core/prompt-controls-utils.ts), [`commands/registry.ts`](https://github.com/gonzalez962/open-pi-viewer/blob/9b80dfc8fd60ddf204fba3c2e7b7c494a8d6554c/src/core/commands/registry.ts) and [`session-events.ts`](https://github.com/gonzalez962/open-pi-viewer/blob/9b80dfc8fd60ddf204fba3c2e7b7c494a8d6554c/src/features/chat/session-events.ts): controls, discovery and session-event regression prompts.
- [`profile-runtime-restoration.md`](https://github.com/gonzalez962/open-pi-viewer/blob/9b80dfc8fd60ddf204fba3c2e7b7c494a8d6554c/odd/tasks/profile-runtime-restoration.md): historical regression scenarios, not proof of restart behavior.
- Observed test definitions: [`profile-model-selection`](https://github.com/gonzalez962/open-pi-viewer/blob/9b80dfc8fd60ddf204fba3c2e7b7c494a8d6554c/tests/app/profile-model-selection.test.ts), [`session-context-stats`](https://github.com/gonzalez962/open-pi-viewer/blob/9b80dfc8fd60ddf204fba3c2e7b7c494a8d6554c/tests/features/sessions/session-context-stats.test.ts) and web [`session-continuity`](https://github.com/gonzalez962/open-pi-viewer/blob/9b80dfc8fd60ddf204fba3c2e7b7c494a8d6554c/tests/server/session-continuity.test.ts). These were not executed; web bridge tests do not verify desktop process behavior.

Viewer deliberately integrates the gentle-shell host; that discipline is not an exclusive differentiator for this app. Source features alone do not establish complete ODD/RDD support. These references guide independent implementation, not presumed literal code reuse: Viewer is GPLv3 and this repository is MIT, so literal incorporation requires a separate licensing review.

## Decisions — verbatim

1. "Nuestro ADE lo que suministra es una GUI para el uso de gentle-shell fuera de terminal, pero es el propio gentle-shell quien proporciona las directivas y herramientas para el modo de trabajo worktree/brach/ODD"
2. "Descartamos implementar un CLI por ahora para que el agente interactue directamente con la aplicación. De momento será simplemente una interfaz de comunicación con gentle-shell como apliación de escritorio"
3. "Por el momento no vamos a incorporar nada de dictado por voz. Primero devemos construir un ADE con GUI completamente funcional y plenamente acoplado con gentle-shell"
4. "Cuando dije \"que se vea como la TUI\" me refería a donde se coloca cada cosa mientras no exista un diseño. Pero si, el objetivo es por capacidad y que cada cosa que el\nTUI permite hacer se replique en la GUI de otra forma. En el estado actual considero que la GUI ya es bastante cercana a la TUI en el sentido de en donde se muestra cada elemento"
5. "Las victorias rápidas que no necesiten tocar gente-pi las definimos y creamos unidades de trabajo para abordarlas"
6. "El contrato de gentle-pi lo documentamos pero lo abordamos más adelante" — historical; superseded: host contracts are now in scope via gentle-pi's `odd/tasks/desktop-rpc-client-gaps.md`.

## Next step

U1 remains the first capability unit when implementation is authorized. It now ships with the desktop RPC client base (`../tasks/desktop-rpc-client.md` T1/T2) and that task's adoption of U1 (T2), with C5 (helper stop) moving into that program via its T6. This planning delivery does not begin U1 or change M3's completed status.
