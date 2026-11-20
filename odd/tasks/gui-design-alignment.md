# GUI design ↔ implementation alignment

Bring `design/slack-gentle/01-workspace.html` and `src/renderer` into agreement, resolving each
discrepancy with an explicit decision from the maintainer (see `## Log`). The design board is
updated wherever the implementation wins, and the implementation wherever the design wins.

## Specs

S1. Workspace row close control: `aria-label="Close workspace <name>"`, `title="Close this workspace — Pi sessions and files are kept"`.
S2. Composer hint reads exactly `Enter to send · Shift+Enter for a new line · Esc Esc to stop the agent`. Two consecutive `Esc` presses inside the stop window (1500 ms) stop the agent while it is working; a single `Esc` keeps its current job (dismiss the command list, close a dialog) and never stops the agent.
S3. The Todo section renders neither `A small plan. A clear next step.` nor the percentage progress bar. The section head meta (`2/4 · 50%`) stays.
S4. Workspaces panel heading: `font-size: 19px`, `letter-spacing: -0.5px`, `font-weight: 400`.
S5. The rail's workspaces button always carries the current-section highlight, independent of whether the workspaces panel is visible.
S6. The conversation header renders no close control; `canCloseWorkspace`/`onCloseWorkspace` leave the component.
S7. Dialogs keep the `div` + `role="dialog"` + `aria-modal` pattern; width `min(480px, ...)` and backdrop opacity `0.88`.
S8. Each inspector Agents row is flat, one line: `<status glyph> <agent name> · <status word>`. No `<details>`, no label, no counters, no task id, no thread.
S9. Status glyphs and words: `◐` Running, `✓` Done, `✕` Failed, `⊘` Cancelled, `○` Queued, `○` Waiting.
S10. The Agents section head carries an eye button that opens the helpers view (`aria-label="Open helpers"`); it replaces the `Open helpers` text button.
S11. The helpers view is kept as-is: list, thread, footer, Stop, `Earlier · N finished`, and the way back to the chat.
S12. The chat keeps errors only: an error belongs to the conversation, renders in the chat pane and stays visible until the wire clears it — never auto-hidden. Keyed statuses and notifications are diagnostics that never enter the chat flow and stay in the helpers view, which keeps the complete status surface. Notifications stay bounded by the reducer cap, so the diagnostics pane can never be implemented as unbounded retention.
S13. Orphan action rows (tool calls bound to no turn) are kept and must be represented in the design board.
S14. An expanded action row shows its vocabulary variants as chips, derived from the published vocabulary: one chip per distinct glyph in the row's category, the current one marked with `aria-current`. The label is `phases` when every entry of that category carries a `heading`, otherwise `also reports`. The row appears only when the category publishes two or more distinct glyphs.
S15. The footer extensions counter stays `0` with its existing title explaining the bridge does not report it.
S16. Unchanged by decision: no date grouping in the thread; no summary card; no composer preview line; empty-chat copy `Start a conversation with Gentle.`; two separate inspector empty notes; no per-task subtitle; send stays disabled with no draft; `+`/`−` chevron on expandable rows; the emoji picker is removed from the composer and attachments stay; the microphone stays disabled.
S17. The command runner in the Ctrl/⌘+K dialog and the removal of `/` commands from the composer are the next task, not this one. The composer keeps its working command list until then.
S18. Orphan code from earlier iterations is removed from the app and from the design board.

S19. Ctrl/Cmd+K opens the command palette (artboard `design/command-palette/01-spotlight-overlay.html`, chosen by the maintainer): a centred modal over the dimmed workspace, an input prefixed with `/`, one list grouped `PROMPT` / `SKILL` / `EXTENSION` with a per-group count, real `name`/`description?`/`source` data and no invented argument hint, a selected row, `↑`/`↓`/`Enter`/`Esc`, an honest empty state, and a footer with those keys. Running a row sends the command to the active chat; the desktop's own `/resume` entry opens the resume dialog instead of sending text, and carries an `app` badge because the wire does not publish it.
S20. The palette replaces the chat search entirely: Ctrl/Cmd+K no longer filters chats, and the app's search state, the sidebar's query filter and their copy are removed.
S21. The composer no longer reads `/` as a command affordance: the command list, its keyboard handling and the `/resume` shortcut leave the composer, which keeps a quiet `Commands` button (shortcut label per platform) that opens the palette.

## Tasks

T1 — S1, S3, S4, S5, S6, S7 · copy and structure alignment in the renderer · `3014c52`
T2 — S10, S11 · eye button in Agents, helpers view kept · `3014c52`
T3 — S12 · persistent in-chat status, error and notification entries · `3014c52`
T4 — S8, S9 · flat subagent rows in the inspector · `3014c52`
T5 — S14 · vocabulary variant chips in the action detail · `fa40d32`
T6 — S2, S16 · composer hint, double-Esc stop, emoji removal · `01a5b74`
T7 — S13, S18 · design board: flat agents, eye, chips, orphan region, status entry, dead CSS · `fd5feb1` (amended)
T8 — S12 · informational cards leave the chat · `afd5706`
T9 — S19, S20, S21 · command palette, chat search removed, slash typing removed from the composer · `ae04f1c`
T10 — S19, S20, S21 · palette hardening (nested modals, focus containment, stale error, empty host, label, typed slash commands) · `ef90fc2`
T11 — S8, S12, S14 · close the review advisories (Variants API, label rule, memory test, reachable eye, stale refusal) · commit pending

Delivery slices on `feat/gui-design-alignment`, none pushed:
`3014c52` shell structure, agents and status surfaces · `01a5b74` composer ·
`fa40d32` vocabulary chips · `fd5feb1` design board. Push, PR and merge stay the
maintainer's decision.

## Log

L1 (original request): "Dime que discrepancias hay entre el diseño y la implementación a nivel de GUI en este repositorio. Separalo entre aspectos presentes en el diseño que no están implementados, mal implementados y aspectos que están implementados pero no están presentes en el diseño"

L2 (decisions, first round): 1.1 keep no date grouping · 1.2 discard the summary card · 1.3 add the chips to the implementation · 1.4 keep the current subagent detail · 1.5 keep the implemented model-absence report · 2.1 keep `Start a conversation with Gentle.` · 2.2 keep two separate notes · 2.3 `Remove workspace` → `Close workspace` · 2.6 discard intro and percentage bar · 2.7 no per-task subtitle · 2.9 send stays disabled · 2.11 follow the design heading · 2.12 keep zero · 2.13 align the implementation · 2.14 drop emoji, keep attachments · 3.1 remove the header Close · 3.7 keep

L3 (decisions, second round): "2.4.1 Tienes razón no ponemos el texto y nos quedamos con lo dicho en 3.4" · "2.4.2 Cambiamos también el comportamiento" · "2.10 Que la implementación adopte el mismo comportamiento que el diseño" · "2.12 a) lo dejamos a cero" · "3.1 Ok, se quita"

L4 (decisions, third round): "1.2 Descartamos" · "2.4 Confirmo" · "3.2 / 3.3 Vamos a cambiar el enfoque, entiendo que helpers vine siendo como un visor de subagentes. En lugar de tener un botón \"Helpers\" vamos a poner un \"ojo\" en el panel de Agents que lleve a esta vista ¿si?" · "3.5 Ok, pero en este caso los mantendría como mensajes persistentes en el propio chat, en rojo para indicar error o lo que sea necesario, si solo se muestran por un periodo de tiemp limitado es muy fácil que el usuario se pierda estos StatusLine" · "3.6 Lo mantenemos pero entonces es necesario representarlo en el diseño" · "1.4 Mostramos solo ◐ gentle-ai-explore · Running... / ✕ gentle-ai-explore · Error/Fail / ✓ gentle-ai-explore · Complete/Finish"

L5 (scope): 3.4 (commands in ⌘K, `/` out of the composer) stays as the next task because the ⌘K dialog still needs its own design. The composer hint therefore drops `/` now and the command list keeps working until that task lands.

L6 (T8, revision of S12): "Estas tarjetas que son como informativas no deben aparecer en el chat" — the maintainer saw the running app and rejected the informational cards inside the conversation (`gentle:mode Permissions: NORMAL`, a keyed status, and the child's long notification). They are StatusLine entries, not messages. Errors stay persistent and red, as decided in L4. The helpers view keeps its complete status surface: it is a diagnostic pane, not the chat.

L7 (3.4 design): `design/command-palette/` opened with three alternatives for the ⌘K command palette that will replace the chat-search dialog (S17): `01-spotlight-overlay.html` (centred spotlight over a dimmed workspace, flat list grouped by source), `02-composer-sheet.html` (sheet anchored above the composer, list left + detail column right), and `03-docked-panel.html` (panel docked in place of the inspector, no overlay). One will be chosen for implementation; the other two remain alternatives. The composer loses `/` typing in the same change, per L5.

L8 (choice): the maintainer chose artboard 01 of `design/command-palette/` — "01 · Spotlight overlay (modal centrado)" — for implementation; 02 and 03 stay as alternatives.

L9 (T10): "Aplica la uniad de corrección que propones y /resume escrito a mano se va, los comandos quedan relegados a ctrl+k" — the maintainer authorized the T9 palette-hardening unit: no palette over an open app dialog, real focus containment, stale refusal cleared, no send to an empty host, the Commands label names ⌘K/Ctrl+K, and a typed "/resume" is plain text for the child — the resume dialog is reachable only from the palette's app entry, per S21.

L10 (T11): "1. Déjalo morir 2. Adelante, hazlo en la unidad que propones" — the maintainer closed the T10 review advisories with this follow-up unit: the Variants API keeps one value (the resolved entry; the current chip follows `entry.glyph`), the `phases` label rule is named and pinned as deliberately data-driven, the memory-fallback test renders real vocabulary, the Agents eye is reachable with no agents (S12 diagnostics must never lose their only surface), and the stale-refusal coverage the frozen 21-line budget could not fit is restored, plus the S12 sentence on the reducer cap.
