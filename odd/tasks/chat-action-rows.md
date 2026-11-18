# Chat action rows: chronological, individually coloured

Feature: one row per agent action, in the order it happened, with the glyph colours the
artboard defines. Design reference: `design/slack-gentle/01-workspace.html` (`.chat-action`
rows). Owner request: Log L1.

## Specs

**S1 — One line per action, in the order it happened.** «prefiero que cada una de estas
acciones tengan su propia linea de comentario individual en el chat». Every tool execution
renders as its own row in the conversation flow, at its chronological position: an assistant
turn that streams text, runs a tool, then streams more text must render text → row → text.
What an action reads is unchanged: the vocabulary glyph, the heading or tool name, and the
state word.

**S2 — An action never migrates.** «esta lista de acciones se va anidando siempre al final
del chat convirtiendose en una lista infinita». A row is bound to the turn position where it
started and stays there. The `MessageThread` fallbacks that attach unbound calls to the last
assistant message, and the trailing group outside every bubble, are removed: an action with
no assistant text around it is still its own row, in place.

**S3 — Glyph colours come from the design.** «Para las acciones del agente no veo que se
estén respetando los iconos con los colores definidos en el design». Each row carries its
category and takes that category's colour, from the artboard's own rules
(`design/slack-gentle/01-workspace.html`, `.chat-action[data-action=…] .action-glyph`):

| category | tools | colour | token |
| --- | --- | --- | --- |
| read | `read` | `#a9c7ee` | `--blue` |
| search | `grep`, `find` | `#a9c7ee` | `--blue` |
| list | `ls` | `#d2cbd0` | `--text-2` |
| bash | `bash` | `#e0c27a` | `--champagne` |
| write | `write` | `#b4e7c7` | `--green` |
| edit | `edit` | `#f2b86d` | `--amber` |
| delegation | `subagent_*` | `#a9c7ee` | `--blue` |
| rdd | `gentle_review*` | artwork, not a tinted glyph | — |
| memory | `mem_*` | `#f095c8` | `--accent` |

`--blue`, `--green` and `--champagne` are not in `src/renderer/shared/theme/tokens.css`
today; add them there with those exact values and use them, never an undefined
`var(--gc-…, fallback)`.

**S4 — Memory is a category the app owns.** The artboard's first row is `Engram · search
“empty chat”` with a brain glyph in `--accent`. The child's published vocabulary does not
know memory (by design, `toolVocabulary.test.ts` certifies its absence), so the renderer maps
the `mem_*` family to category `memory`, heading `Engram`, glyph `🧠`, parented to the accent
colour. The emoji keeps its own colours; the row's label and state use the accent. Do not
invent protocol vocabulary and do not touch the wire contract for this.

**S5 — Replay matches the live view.** Reopening a chat from history shows the same rows in
the same order. No text is duplicated, reordered or invented; the markdown of a text block is
untouched.

## Tasks

| ID | Specs | Route | Status |
| --- | --- | --- | --- |
| T1 | S1, S2, S5 | Model: ordered parts on the assistant message (`bridge-types` + `chatReducer`), text and tool parts appended at arrival position; `text` and `toolCalls` stay as they are for compatibility | done — `d99b999` |
| T2 | S1, S5 | History replay emits the same parts as the live stream (`history.ts`) | done — `d99b999` |
| T3 | S1, S2 | Render parts in order (`MessageBubble`, `MessageThread`); delete the last-assistant and trailing-group fallbacks | done — `04ce47e` |
| T4 | S3 | Category colours: `data-category` → glyph colour rules in `ActionRows.css` through the theme tokens, no undefined `--gc-*` fallbacks (`--blue`, `--green` and `--champagne` already existed in `tokens.css`) | done — `04ce47e` |
| T5 | S4 | `mem_*` → `memory` category (renderer-side fallback, glyph `🧠`, heading `Engram`, accent colour) | done — `04ce47e` |

Commits: two work units, `d99b999` (T1+T2, the model) and `04ce47e` (T3+T4+T5, rendering and
colour), each with its tests. Both sit on `develop`; the branch is far past the ~400-line slice
against `origin/main`, so delivery needs the feature's own branch or PR strategy before the next
commit — owner's decision, nothing pushed.

## Log

**L1** (owner, verbatim): «Para las acciones del agente no veo que se estén respetando los
iconos con los colores definidos en el design [Image#1] además también veo que esta lista de
acciones se va anidando siempre al final del chat convirtiendose en una lista infinita,
prefiero que cada una de estas acciones tengan su propia linea de comentario individual en el
chat»

**L2** (evidence): the artboard already renders one `<details class="chat-action">` per
action, each with its own `data-action`, glyph colour and state word, but the app renders a
single `<ul class="gc-action-rows">` appended after the message text, with no per-category
colour rule at all (`ActionRows.css` has none) and undefined `--gc-*` token fallbacks.

**L3** (evidence): `ChatMessage.text` is one concatenated string and `ToolCallView` has no
ordering key — only a `messageId` bound at start time; `message_end` drops a text-less
assistant message, which is why unbound calls get re-attached to the last message and the list
keeps growing.

**L4** (owner): «Haz previamente commit de los cambios existentes en el repo». Done:
`be71cd9` (design) and `6fc0d5d` (usage panel + welcome hero) on `develop`.

**L5** (evidence, T1/T2): `chatReducer` now appends one tool part per execution start on the
message it binds to and replaces the row in place on the end frame; `message_end` keeps the
streamed segmentation when the turn has rows and replaces it with a single text part when it
does not. History recovery emits the same segmentation. Red first: 16 failures across
`chatReducer.test.ts` and `history.test.ts`; green 118/118 focused, 939/939 suite, typecheck 0.

**L6** (evidence, T3/T4/T5): the bubble walks `parts`, each row is a standalone `div` (no
`<ul>/<li>`), and calls without a turn get their own region after the thread. Category colours
come from the tokens (`#a9c7ee` read/search/delegation, `#d2cbd0` list, `#e0c27a` bash,
`#b4e7c7` write, `#f2b86d` edit, accent memory). Red first: 8 failures across
`MessageBubble.test.tsx` and `MessageThread.test.tsx`; green 86/86 focused, 943/943 suite,
typecheck 0. Not carried over into the preview fixture: `mockBridge` still pushes no `parts`,
so the browser preview shows its two demo rows in the no-turn region; making the fixture
interleave would break the mock's "fresh host has no messages" tests, so it stays as is.
