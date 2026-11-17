# Chat behavior refinements

Refine the GUI conversation behavior: free scrolling, tool actions inline in the message, no
transient notice card in the chat, a symmetric selected workspace row with its close control in the
corner, integer context percentages, and the artboards kept in sync with all of it.

## Specs

**S1 — Free scrolling.** The user said: "El chat siempre se mueve al final cada vez que hay una
actualización. Quiero que el chat sea libre y que si no se está en el final del mismo no te mueva
hacia el que solo actualice al final si ya se está en el final del chat". An update scrolls the
transcript to the bottom only when the reader was already at the bottom before that update; when the
reader scrolled up, the position is preserved. A freshly opened, never-scrolled chat still follows.

**S2 — Tool actions inside the message.** The user said: "La lista de Tool activiti que se muestra
en el chat debe desaparecer. Las acciones de read/edit/write/search/list/bash/delegation/rdd debe
aparecer en el propio comentario igual que se visauliza en la TUI para mantener un comportamieno
homogeneo". No standalone tool activity list survives at the end of the transcript. Each tool action
renders inside the message that produced it, using the native vocabulary: read ≡ · edit ✎ · write +
· search ⌕/⌖ · list ☷ · bash $ · delegation → ◎ ↩ ⨯ ✉ ↻ ☰ · rdd 🌹.

**S3 — No notice card in the chat.** The user said: "También hay una tarejta con comentrios en azul
que se actualiza y se muestra constantemente en el chat, esto debe desaparecer", scoped as "Solo del
chat". The conversation pane renders neither extension status entries nor child notifications. Real
errors still render in the chat. The Helpers pane keeps its current status line.

**S4 — Selected workspace row.** The user said: "Que el recuadro de selección del workspace tenga el
mismo magen en el lado derecho que en el lado izquierdo y ponemos la x para cerrarlo en la esquina
superior derecha del recuadro", clarified as "el resaltado de workspace seleccionado en la lista de
workspaces y sus x". The highlighted box is the row itself, with the same inset on the left and on
the right, and the remove control sits in that box's top-right corner.

**S5 — Integer context percentage.** The user said: "El contexto ahora mismo muestra MUCHOS
decimales, que solo muestre números enteros empelando el mismo redondeo que en la TUI". The context
percentage renders as an integer with the TUI's rounding, and the meter width agrees with the
rendered number. A missing or `null` percentage still renders nothing, never 0%.

**S6 — Design aligned with the implementation.** The user said: "Recuerda actualizar también en el
diseño los cambios que te he ido pidiendo para que design e implementación estén alineados". The
`design/slack-gentle/` artboards show the behavior of S1–S5: no activity list at the transcript end,
actions inside the message, no blue notice card in the chat, a symmetric selected workspace row with
its close control in the corner, and integer context percentages.

## Tasks

| ID | Spec | Route | What |
| --- | --- | --- | --- |
| T1 | S1 | inline | Pin-aware scroll in `MessageThread` plus a test that scrolled-up readers are not moved. |
| T2 | S2 | worker | Bind tool calls to their message (domain + history + types) and render them inside the bubble; delete the standalone list. |
| T3 | S3 | inline | Chat pane stops rendering statuses and notifications; errors stay. |
| T4 | S4 | inline | Selected workspace row owns the highlight box; symmetric inset; close control in the top-right corner. |
| T5 | S5 | inline | Integer context percent through one shared formatter, label and meter agreeing. |
| T6 | S6 | inline | Align `design/slack-gentle/` artboards with S1–S5. |
| T7 | all | inline | `pnpm test` and `pnpm typecheck`, then the due native review. |

## Log

**L1.** "Vale ahora varios comentarios sobre el comportamiento del chat de la GUI que quiero cambiar:
1. El chat siempre se mueve al final cada vez que hay una actualización. Quiero que el chat sea libre
y que si no se está en el final del mismo no te mueva hacia el que solo actualice al final si ya se
está en el final del chat
2. La lista de Tool activiti que se muestra en el chat debe desaparecer. Las acciones de
read/edit/write/search/list/bash/delegation/rdd debe aparecer en el propio comentario igual que se
visauliza en la TUI para mantener un comportamieno homogeneo
3. También hay una tarejta con comentrios en azul [Image#1] que se actualiza y se muestra
constantemente en el chat, esto debe desaparecer
4. Que el recuadro de selección del workspace tenga el mismo magen en el lado derecho que en el lado
izquierdo y ponemos la x para cerrarlo en la esquina superior derecha del recuadro
5. El contexto ahora mismo muestra MUCHOS decimales, que solo muestre números enteros empelando el
mismo redondeo que en la TUI"

**L2.** "Recuerda actualizar también en el diseño los cambios que te he ido pidiendo para que design
e implementación estén alineados" → S6 and T6.

**L3.** Clarification: item 4 is "el resaltado de workspace seleccionado en la lista de workspaces y
sus x" (not a dialog), and item 3 is scoped to "Solo del chat" — the Helpers pane keeps its status
line and real errors keep rendering in the chat.

**L4.** Evidence from discovery: `ToolCallView` carries only `toolCallId`, so S2 needs a message
binding; `historyToToolCalls` walks message content in order and can carry the enclosing message id.
The blue card is the `StatusLine` notification stack (`border-left: 2px solid currentColor`,
`--info` = blue), re-shown because its visibility window restarts on every new `notifications` array.

**L5.** Delivery strategy and evidence. The branch already carried 24,650 authored lines since
`origin/main` (the workspaces/child-diagnostics work it stacks on), so this feature is delivered as
its own slice: `feat(chat)` behavior change, the feature document, and the artboard alignment,
each a separate commit on `feat/chat-behavior-refinements`.

Verified checks (2026-05-19):

- T1 RED `MessageThread` "follows new activity only while the reader is at the bottom" → GREEN;
  the tool-call grouping moved into `groupCallsByMessage` to keep the component readable.
- T2 RED `chatReducer`/`history` binding tests and `MessageThread`/`MessageBubble` "Tool actions"
  tests → GREEN (118 focused, then the conversation+rpc sweep).
- T3 RED `ConversationContainer` "renders no keyed statuses in the chat pane" (genuine RED only
  after awaiting a pushed message — the absence assertion passed trivially before that) → GREEN;
  added "keeps the keyed status surface in the Helpers pane" so the scoped removal cannot quietly
  take the Helpers pane with it.
- T4 RED `ChatList` "draws the selected workspace highlight on the row itself" → GREEN.
- T5 RED `Footer` "rounds the context percent to whole numbers" (observed `context30.4%`) → GREEN.
- T7 `pnpm test`: 58 files, 908 tests passed. `pnpm typecheck`: clean.
- T6 artboard: the action rows moved inside the assistant message, the standalone list and its
  legend are gone, the workspace row owns the highlight box with its close control in the corner,
  and the context sample documents whole-percent rounding.

