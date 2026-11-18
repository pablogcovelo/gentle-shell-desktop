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
| T6 | S1, S2, S5 | Review corrections: keep the message of a tool-only turn, and let the wire's final text win inside a tool-bearing turn | done — `3c2da02` |
| T7 | S5 | Review correction 2: history recovery keeps a tool-bearing text-less turn, so its rows replay in place (thinking-only turns still skipped) | done — `daa790d` |
| T8 | S2, S3, S5 | Review correction 3: interleaved rows keep their place when the wire's text disagrees with the stream, and the relative countdown stays out of the chat-stack card | done — `59fd330` |
| T9 | S2 | Reported from real use: `MessageThread` dropped text-less assistant turns before computing the claim set, so a tool-only turn's rows fell into the no-turn region again | done — `0729c3c` |
| T10 | S2 | Reported from real use again, measured live with Playwright against the built app: the REAL child emits `message_end` (already carrying the toolCall blocks) BEFORE `tool_execution_start`, so `closeAssistantMessage` saw no streamed tool part and dropped the text-less turn; the later `tool_execution_start` then bound to no message and the row landed in the foot orphan list. `chatReducer` now treats the wire's toolCall blocks as the authority on tool-bearing (live parity with the replay path) | done (this commit) |

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

**L7** (review, lineage `review-cee8e3f4903bfae2`): the native review ran risk, readability and
reliability plus one refuter and returned `correction_required` with two CRITICAL reliability
findings:
- `R3-001` — a tool-only turn was still dropped on `message_end`, so its rows had no part and
  fell into the no-turn region at the end of the thread: the very list S2 removed.
- `R3-002` — a tool-bearing turn kept its streamed text even when the wire's final message
  disagreed, so the live view and a history replay could show different words (S5).
Both are fixed in `3c2da02` (T6): the message of a tool-only turn is kept, and disagreeing text
collapses into one part carrying the wire's final text, on the side of the rows where the
streamed text started. Red first: 2 failures; green 120/120 focused, 945/945 suite, typecheck 0.

**L8** (blocked, needs a human): submitting the provider-issued correction plan
(`review.capture-correction-plan`, request hash `sha256:43b537e5…`, revision
`sha256:d2cf8176…`) is rejected by the Pi facade with
`capture-binding-rejected: collectBinding is missing or stale for current STATUS`, although the
binding is copied verbatim from bound STATUS, tried as an object and serialized, both with the
correction committed and with the frozen target restored. STATUS keeps re-offering the same slot,
so the correction loop cannot advance from this session. Options: resolve it natively with
`gentle-ai`, or disable receipt-driven development for this clone
(`gentle-ai review mode disable --scope clone`).

**L9** (review 2, lineage `review-8868ca70509f26b0`): a fresh review of the corrected candidate
(three lenses plus one refuter, same forecasts relayed) returned `correction_required` again with
two CRITICAL deterministic findings, both correct and both the same defect seen from two lenses:
`R2-001` and `R3-TOOLONLY-REPLAY` — `history.ts` returned on the empty-text guard *before*
extracting parts, so a reopened chat dropped the tool-only turn the live path now keeps, and its
rows became orphans at the end (S5/S2). Fixed in `daa790d` (T7): recovery extracts parts first and
skips a text-less turn only when it has no tool part. Red first: 1 failure; green 120/120 focused,
946/946 suite, typecheck 0.

**L10** (blocked, confirmed): the correction-plan capture is not accepted by the Pi facade on
this lineage either, and this time the binding was submitted **before any edit**, on a fresh
lineage with a freshly issued `request_hash` (`sha256:0d758314…`, revision
`sha256:64cd4574…`): `capture-binding-rejected: collectBinding is missing or stale for current
STATUS`. Five attempts across two lineages, both orderings (edit-then-plan and plan-then-edit),
object and serialized binding forms, all rejected; STATUS keeps re-offering the same slot. The
defect is in the facade's correction-slot validation, not in the caller input or the ordering.
Both lineages stay in `correction_required`; the code corrections are committed and green but
unrecorded. Needs a human: resolve natively with `gentle-ai`, or disable receipt-driven
development for this clone (`gentle-ai review mode disable --scope clone`).

**L11** (review 3, lineage `review-ce36b0a316af656d`): same three lenses plus the refuter. The first
reviewer batch was refused at admission because the risk reviewer's payload was not a complete
JSON object (`2 objects opened, 1 closed`); the provider preserved it under
`.git/gentle-ai/rejected-results/` and asked for a fresh STATUS plus a new run, which then
admitted all three. The refuter returned `correction_required` with two CRITICAL findings, both
correct:
- `R3-001` — a tool-bearing turn whose streamed text disagreed with the wire's text collapsed its
  parts to one side of every row, so `row, text, row` came back as `row, row, text` while history
  kept the interleaving (S5).
- `R3-002` — the relative reset countdown leaked into the chat-stack card, a surface the design
  comment did not name.
Fixed in `59fd330` (T8): the final text lands where the streamed text started and every row keeps
its place; the card keeps its absolute instant and only the inspector counts down. Red first:
1 failure; green 110/110 focused, 948/948 suite, typecheck 0.

**L12** (blocked, third lineage): the correction-plan capture was rejected again —
`capture-binding-rejected: collectBinding is missing or stale for current STATUS` — on this
lineage's own freshly issued `request_hash` (`sha256:35f622a9…`). That makes six rejections
across three lineages and both orderings. **No correction can be recorded through this facade.**
Recommended exits, in order: `gentle-ai review mode disable --scope clone` (the code is corrected
and green; the review gate is what cannot advance), or resolve the authority natively with
`gentle-ai`. Three lineages sit in `correction_required`
(`review-cee8e3f4903bfae2`, `review-8868ca70509f26b0`, `review-ce36b0a316af656d`).

**L13** (owner report, real session): «Las acciones de bash, read, etc... Siguen apareciendo como una
lista siempre en el pié del chat, no son comentarios individuales en orden de llegada». Diagnosis
against the running `electron-vite dev` app (which serves `src/renderer`, so not a stale build): the
reducer and the history path both keep a text-less tool-bearing turn *with its parts*, but
`MessageThread`'s empty-bubble filter (`role === assistant && streaming !== true && text.trim() === ""`)
removed it before the claim set was computed, so every row of such a turn was unclaimed by
construction and landed in `gc-thread__orphan-actions`. Fixed by keeping a message that carries a
tool part. Red first: 1 failure; green 172/172 focused, 949/949 suite, typecheck 0. Boundary left as
is: if the child emits `tool_execution_*` after `message_end` for a text-less turn, the reducer has
no live part for it and the row is only re-bound when the chat is reopened from history.

**L14** (owner report, real session, T10): «Las acciones read, bash, etc... se siguen
encapsulando en una lista siempre en el pie del chat en lugar de ser comentarios individuales que
fluyen como si fuese una conversación de chat». Unit tests were green, so the evidence came from the
running app: Playwright driving `out/main/index.js` with an isolated profile and a real `gentle-pi`
child. First, a raw probe of the child's own wire (`--mode rpc`, prompt captured live) proved the
real event order the fixtures never encoded: `message_start` → `toolcall_start/delta/end` →
`message_end` (content `[{toolCall}]`, no text) → **then** `tool_execution_start` — the reverse of
`tool-only-message.jsonl`. Under that order `closeAssistantMessage`'s tool-bearing check read the
streamed parts (still empty) and dropped the text-less turn; the later `tool_execution_start` found
the user message last, appended no part, and the row landed in `gc-thread__orphan-actions`. Measured
before the fix in the real app: a live tool-first turn put its `$ bash done` row in the orphan
region (orphanRows=1, screenshot `/tmp/gc-verify/live-before3.png`); text-bearing turns were
unaffected, which is why the list grows only when the agent acts before it speaks. Fixed in
`chatReducer.ts`: the wire's toolCall blocks now count as tool-bearing (matching what `history.ts`
replay already did — the two paths disagreed, S5), and a kept text-less toolCall turn gets no
synthesized empty text part. One existing test contradicted its own name ("thinking-only content"
feeding a `toolCall` into `message_end`) and encoded the wrong assumption; corrected to actually
thinking-only content. Red first: 2 failures; green 97/97 focused, 954/954 suite, typecheck 0.
Re-measured in the same real app after the fix: tool-first live turn renders `$ bash done` inside
its own turn article and the interleaved prompt renders text → row → text, `gc-orphan-actions`
absent both times (screenshots `/tmp/gc-verify/live-after.png`, `/tmp/gc-verify/live-after2.png`).
Boundary now: a text-less turn kept by its wire toolCall block is invisible in the thread until its
`tool_execution_start` lands (milliseconds in the observed flow) — no empty bubble, no orphan row;
if the call never executes, nothing shows and nothing strands.
