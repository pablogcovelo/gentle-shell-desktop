# Gentle Shell Desktop: workspace shell (design/slack-gentle/01-workspace)

Feature document (ODD). Repository: Gentleman-Programming/gentle-shell-desktop. Tracker branch: `feat/desktop-workspace-shell`. Locator: `odd/tasks/desktop-workspace-shell.md`. Engram mirror: `odd/desktop-workspace-shell/tasks`. Design source: `design/slack-gentle/01-workspace.html` (artboard "Workspace") + `design/system.md` (tokens).

## Specs

- **S1** The artboard's declared tradeoff is the contract: "Closest to Slack: familiar chat navigation with a fixed three-section panel (tasks, usage, agents) beside the conversation; uses more horizontal space."
- **S2** The shell is three fixed chrome rows/columns: a compact top bar, a directory rail, the chat sidebar, the open conversation. Layout values come from the artboard: chrome `33.5px`, rail `84px`, sidebar `260px`, info panel `280px`.
- **S3** The right panel is ONE fixed panel with three equal, independently scrolling sections in this order: `Todo`, `Usage`, `Agents`.
- **S4** Colors, typography, spacing, radius and shadows come only from `design/system.md` / `src/renderer/shared/theme/tokens.css`. No new color, no shadow.
- **S5** Never invent data. Every section is fed by the existing per-chat bridge state: `ChatState.todo`, `ChatState.usage` (+ `usageChannelUnavailable`), `ChatState.helpers`. A section with no data says so; it never renders a fabricated zero, percentage or agent.
- **S6** No dead controls. A button either performs its stated action or is not rendered. The artboard's window controls, emoji/attachment/microphone placeholders and settings/shortcut dialogs are explicitly design previews and are NOT implemented.
- **S7** Existing behavior contracts stay intact: chat selection, new chat, add workspace, helper stop routing, dialogs, the composer shortcuts, and the "one home per datum" rule (model/reasoning/context/cost live in the status line, never duplicated in the footer).

## Tasks

| ID | Specs | Route | Outcome |
| --- | --- | --- | --- |
| T1 | S1, S2 | inline | App shell: `TopBar` + `AppRail` + `App.css` grid; real panel-visibility toggles. |
| T2 | S2, S4, S7 | inline | Sidebar restyled to the artboard directory panel; chat items gain a directory meta line. |
| T3 | S1, S3, S5 | inline | `InspectorPanel` with the three sections; `TodoCard`/`UsageMeters` gain a flat `panel` variant. |
| T4 | S2, S4, S7 | inline | Conversation chrome: context bar, thread/composer/footer restyle, `ConversationContainer` body grid. |
| T5 | S6, S7 | inline | Contracts updated where the artboard supersedes them; full suite + typecheck green. |

## Log

### L1 (user, verbatim)

Implement the design artboard design/slack-gentle/01-workspace.html

Artboard: design/slack-gentle/01-workspace.html
Title: Workspace
Tradeoff: Closest to Slack: familiar chat navigation with a fixed three-section panel (tasks, usage, agents) beside the conversation; uses more horizontal space.

Implement it in the project's real stack. Use the artboard as the visual spec: map its parts to the project's existing components and styles, and do not copy the artboard HTML verbatim.
Take colors, typography, spacing, radius and shadows from design/system.md, the project's token source.

Report progress with the gentle_design tool: action "handoff", target "slack-gentle/01-workspace.html", status "in_progress" when you start; status "implemented" when it is done, with previewUrl set to the running app's loopback URL (localhost, 127.0.0.1 or [::1]) when one is running, so the canvas can compare it with the artboard.
This design is not linked to an ODD feature document: size it under the project's ODD rules as usual.
This handoff itself commits nothing.

### L2 (decision, 2026-11-15)

The sidebar keeps the real entity the bridge serves — chats — and borrows the artboard's directory-panel anatomy (eyebrow, heading, add-workspace + new-chat actions, one entry per chat with its directory as the secondary line). The bridge exposes no workspace list; `ChatSummary.cwd` is the only directory fact, so a workspace-only sidebar would have meant inventing data (S5).

### L3 (decision, 2026-11-15)

The task card moves out of the chat stack into the inspector's `Todo` section, so the pinned "task card before the composer in document order" rule (desktop-m3-odd-panel S5) is superseded at the panel layout: the panel sits beside the conversation. The rule's intent — the prompt is the last thing in reach — is preserved because the composer stays the final element of the conversation column. The assertion in `ConversationContainer.test.tsx` is rewritten to the new placement and renamed accordingly.

### L4 (decision, 2026-11-15)

The footer stays inside the conversation column instead of spanning the whole app: every fact it shows (path, branch, changes, MCP, profile) is per-chat state, and lifting it to `App` would have required hoisting the single-chat bridge state. The artboard's footer groups are kept; the artboard's `model · reasoning · context` group stays in the status line per the existing "one home per datum" rule (S7).
