# Workspace registry and child diagnostics

Feature: the Workspaces panel becomes a real, persisted workspace list with a remove action and a
true empty state; and the app stops failing silently when the child cannot run a turn. Four user
reports, one root cause each, all verified against the running `gentle-shell` child.

## Specs

S1. "El botón Add workspace no esta agregando las carpetas al panel de lista de workspaces"

S2. "Las carpetas añadidas se guardan y se listan hasta que el usuario las elimine del workspace."

S3. "El panel cnetral solo muestra placeholder cuando no existan workspaces, si existen siempre debe
haber uno seleccionado y su chat acivo"

S4. "Si no hay ningun workspace abierto/seleccionado no debería mostrarse chat de conversación y
actualmente SIEMPRE se muestra un chat de conversación activo"

S5. "Estoy ejecutando el proyecto con el comando <<GENTLE_SHELL_NO_AUTO_SETUP=1
GENTLE_SHELL_BIN=\"$PWD/../gentle-pi/bin/gentle-shell.mjs\" pnpm dev:local-pi>> proporcionado por tí
mismo y no parce estarse comunicando con gentle-pi porque no recibo respuesta ninguna de los agentes"

S6. "en el footbar no se listan mcps, slkills, extensions ni se muestra el modelo activo"

S7. "¿No se había cableado ya el conteo mediante RPC en el repo de ../gentle-pi?"

S8. "¿Y porque no puedo ejecutar comandos de pi como /login para regustrar suscripciones y usar
modelos? ¿O comandos de gentle-shell como /gentle:prfiles?"

S9 (verified, decides S7): `docs/desktop-rpc.md` in ../gentle-pi declares `mcp_status`, `get_snapshot`
and `tool_vocabulary`, and no skills or extensions count method anywhere in the contract. The footer's
`0` for skills and extensions is a literal placeholder (`Footer.tsx`), never bridge data. The earlier
owner decision stands and is not reversed here: those two indicators stay rendered with the zero
fallback and their "not reported by the bridge" tooltip, because GUI elements must not appear and
disappear on their own. Real counts require a new gentle-pi contract method, which is out of this
repository's scope and needs separate authorization.

S10 (verified, decides S8): `/login` is a TUI command, not an RPC command. Sent as a prompt to
`--mode rpc` it returns `{"command":"prompt","success":false,"error":"No API key found for the
selected model. Use /login to log into a provider via OAuth or API key."}`. The app must show that
text; it must not implement an in-app OAuth flow.

S11 (owner decision, decides S3/S4): placeholder only when no workspace exists at all. When at least
one workspace exists, exactly one is always selected and its chat is the active pane.

## Tasks

| ID | Specs | Route | Commit |
| --- | --- | --- | --- |
| T1 | S1, S2 | worker (main + panel) | work unit 1 |
| T2 | S3, S4, S11 | worker (shell) | work unit 1 |
| T3 | S5, S8, S10 | worker (child) | work unit 2 |
| T4 | S6, S7, S9 | worker (footer) | work unit 2 |

### T1 — persisted workspace registry

- Persist the directories the user adds in the app config alongside `home`; the picker result is
  stored, not just held in a live host's `cwd`.
- The Workspaces panel lists one row per workspace directory: the persisted directories union the
  directories pi already has sessions for, so an added folder appears immediately even though pi
  has not written a session for it yet.
- Each row keeps today's chat rows underneath it and gains one remove action. Remove deletes only
  the persisted entry; it never deletes a session file, a directory, or a chat.
- The list is re-read after add and after remove. A full app restart still shows the added folders.
- A persisted workspace with no chat yet is still a row; selecting it opens a new chat for that
  directory (today's T11 creation path, minus the extra picker).

### T2 — selection and empty state

- `ActiveChat` gains the absence of a chat. The app must be able to represent "no workspace".
- No workspace at all: the center shows the placeholder, and no child is spawned.
- At least one workspace: one is always selected, and its active chat is shown (S11). An existing
  most-recent session is reopened when the workspace has one; otherwise a new chat is created for
  that workspace.
- The very first paint must not spawn a synthetic chat before the workspace list resolves.

### T3 — surface what the child actually answers

- A `response` whose `command` is `prompt` and whose `success` is false folds its `error` into
  `ChatState.lastError` (the status line already renders that), so a home with no credentials says
  why instead of showing nothing.
- Keep child stderr off `lastError` (routine pi logs) but never drop a protocol error.
- The capabilities probe must fire when the child proves it is alive, not only after a first
  settled turn: with no model no turn ever settles, which is exactly why the identity, MCP and
  session facts never arrived. Waiting for a settled turn stays as a fallback, not the only trigger.
- A session whose model is absent/unknown must render as a clear "no model" hint rather than a
  literal `unknown` or an empty footer.

### T4 — footer

- MCP and model indicators work for a fresh chat (they depend on T3's probe timing), including a
  home where the model resolves to `unknown`: that case renders the owner-visible "no model" hint
  instead of a literal `unknown` or a silently missing group.
- The skills and extensions indicators keep their zero fallback and tooltip (S9). Their DOM nodes
  stay stable; only the README sentence is corrected to state that MCP and model are real and these
  two are an explicit fallback awaiting a gentle-pi contract method.

## Log

L1 (verbatim, original request):

1. El botón Add workspace no esta agregando las carpetas al panel de lista de workspaces
2. Estoy ejecutando el proyecto con el comando <<GENTLE_SHELL_NO_AUTO_SETUP=1 GENTLE_SHELL_BIN="$PWD/../gentle-pi/bin/gentle-shell.mjs" pnpm dev:local-pi>> proporcionado por tí mismo y no parce estarse comunicando con gentle-pi porque no recibo respuesta ninguna de los agentes
3. Otro motivo por el que no parece estarse comunicando con gentle-pi es que en el footbar no se listan mcps, slkills, extensions ni se muestra el modelo activo
4. Si no hay ningun workspace abierto/seleccionado no debería mostrarse chat de conversación y actualmente SIEMPRE se muestra un chat de conversación activo

L2 (owner answers, verbatim): "Las carpetas añadidas se guardan y se listan hasta que el usuario las
elimine del workspace. El panel cnetral solo muestra placeholder cuando no existan workspaces, si
existen siempre debe haber uno seleccionado y su chat acivo" — "¿Y porque no puedo ejecutar comandos
de pi como /login para regustrar suscripciones y usar modelos? ¿O comandos de gentle-shell como
/gentle:prfiles?" — "¿No se había cableado ya el conteo mediante RPC en el repo de ../gentle-pi?"

L3 (evidence): app config holds `{"home":"isolated"}`; `~/.gentle-shell/agent/auth.json` is `{}` and
its `settings.json` has no default model. `get_state` in the isolated home answers
`"model":{"id":"unknown","name":"unknown"}`; the same command with `--link` answers
`"id":"deepseek-v4.1-flash"`. A prompt in the isolated home answers `success:false` with the
"No API key found" error. `/gentle:profiles` answers `disposition:"handled"` plus
`extension_error: "Cannot read properties of undefined (reading 'saveFirst')"` (gentle-pi side).
`get_commands` lists `gentle:desktop`, so the control channel exists in gentle-shell 4.8.0.

L4 (evidence): the panel lists pi session directories and loads them once on mount
(`ChatsContainer` `listChats` effect) with no push channel and no refetch; the only persisted app
state is `home` (`appConfigStore`). `ActiveChat` has no absence variant and `App` renders
`ConversationContainer` unconditionally, resolving a synthetic `{kind:"new",epoch:0}` chat that
spawns a child on mount.

L5 (decision): skills/extensions indicators stay visible with their zero fallback per the earlier
owner decision; wiring real counts is a separate cross-repository task against gentle-pi's
desktop-rpc contract, not part of this feature.

L6 (delivery): branch `fix/desktop-workspaces-and-child-diagnostics` off `develop`. Commits:
`058abaa` docs, `3db2ddb` T1/T2 (workspace registry, removal, empty state), `5c2fc91` T3/T4 (failed
prompt surfacing, probe at readiness, model normalization, footer hint) plus README. Checks on the
combined tree: `pnpm test` 828/828 in 53 files, `pnpm typecheck` clean, `pnpm smoke:electron` OK.
Slice boundary for review: T1/T2 and T3/T4 are the two reviewable units; the branch is not a PR by
itself (it sits on `develop`, far ahead of `origin/main`), so the delivery strategy stays the
owner's decision.

L7 (worker-reported limits, not fixed here): exact-string path dedup means a trailing-slash variant
of the same directory would render two rows; the Add flow persists before spawning, so a failed child
start leaves a chatless persisted row that retries when selected; a failed desktop-rpc control prompt
(e.g. a child without the extension) now also folds into `lastError` by design.

L8 (independent verification): `gentle-ai-verify` returned PASS on the diff, against the real child
as well as the suites: start stays silent and the probe rides the first frame, a user prompt sent at
the same moment is still answered in order, a reopened chat keeps `[get_messages, capabilities]`
ordering, and the isolated home produces the "No model" hint while `--link` produces a real model
label. Its advisories were triaged: the sticky `lastError` was corrected (a successful prompt now
clears the refusal), the two missing registry safety pins were added (a session file and its
directory survive remove byte-identical; a refused add and an unknown remove leave the filesystem
untouched), and the remaining ones are recorded in L7 or are latent only (a future caller that
re-`start()`s one `PiSession` would never re-probe). Checks after the correction: `pnpm test`
831/831 in 53 files, `pnpm typecheck` clean.
