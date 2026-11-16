# Desktop pending work — implementing the v1 queue

Executes the ordered queue of `odd/plans/pending-work.md` on `develop`. This document adds no requirement: every Spec quotes that file verbatim and every Task names the P-row it implements.

Work units commit on `develop` (owner decision, L2.6) with tests and docs alongside the behaviour.

## Specs

S1 (P1). "Bind `chat.open` to the chat's own directory so a reopened chat's child spawns in its workspace, not in Electron's launch directory. Closes the gap recorded in L30/T11 and is why the footer's worktree group appears only for created workspaces today". Where: "`ChatHost` open path + `PiSession` cwd + `chat.open` handler". Blocked by: "none (host already accepts cwd)". Risk: "item 1 (path passed to a spawn)".

S2 (P2). "A workspace-close affordance: a production caller for `chat.close`, plus snapshot-cache eviction for the closed host. Without it, closing only happens at app quit and the renderer cache grows with every chat opened". Where: "renderer sidebar/header + `closedHosts` bound". Blocked by: "P1 (a workspace must have an identity to close)". Risk: "none".

S3 (P3). "`closeChat` best-effort hardening: a failed late close must not leave a live host without a visible signal. Cleanup is already in `finally` (L28); what remains is the *report* of that failure to the renderer". Where: "`WorkspaceHostRouter` close path". Blocked by: "none". Risk: "item 4 (host lifetime)".

S4 (P4). "Make `hostId` required on `HelpersContainer`, so the compiler refuses a parent that forgets it — the exact defect that shipped once (L24, two blockers) only because the prop was optional". Where: "`HelpersContainer` props + its call site". Blocked by: "none". Risk: "item 3 (component contract)".

S5 (P5). "ODD phase indicator in the header, consuming `oddPhase` from `session_state_changed`. Never inferred from transcript text, never derived from a tool name". Where: "reducer + header". Blocked by: "**host T2** (`gentle-pi` S7/T2)".

S6 (P6). "Command discovery for the composer: `/` lists what the child answers for `get_commands` (pi command, no host change), submits through `prompt`, and never keeps a hardcoded `/gentle:*` replica. Interactive results route through the existing dialogs". Where: "`PiSession` command list + composer". Blocked by: "**host T4 probe** (confirmation only; the command already exists in pi's RPC mode)". Risk: "item 3 if the command union changes".

S7 (P7). "Tool-call detail recovery on reopen: `toolCalls` is live-only today, `history.ts` keeps text parts only, so a reload loses args/result/error". Where: "`rpc/history.ts` + reducer". Blocked by: "none, but it starts by reading pi's resolved message types — guessing shapes would trade a doc lie for a code lie". Risk: "item 3 (history is shared by messages and rows)".

S8 (P8). "Worktree changes: **three states, one render**. (a) measured and clean → `0 files · +0/-0`; (b) measured with partial data → the counts the child did supply, with the unmeasured file marked; (c) unmeasured (failed root, unborn root, refused answer) → **also `0 files · +0/-0`**, and the group is never omitted. Accepted consequence, recorded: (c) becomes visually indistinguishable from (a), so the footer stops telling \"not measured\" apart from \"nothing changed\"; the distinction survives in the host payload, and an optional `title`/`aria-label` (\"changes were not measured\") may carry it without changing the visible copy. Requires splitting the single flag into `countsUnavailable` (root) and `filesUnmeasured` (per file) and reworking the footer render + the pins that encode the current single-state rule". Where: "`src/main/domain/rpc/workspaceInfo.ts`, `src/shared/bridge-types.ts`, `Footer.tsx`". Risk: "item 3 (the bridge type changes what the renderer sees)".

S9 (sequencing). "Sequencing: P1 → P2 → P3 → P4 are all workspace-lifetime work and are cheapest as two slices (P1 alone; P2+P3 together; P4 anywhere). P5 waits for the host field. P6 is independent and small. P7 is the largest single item in v1. P8 is a decision, not a build."

S10 (owner decisions already taken, verbatim from that file).

L2.6: "IMPORTANTE, recuerda que las ramas actuales de trabajo de ambos repositorios son develop".
L4: "Seguimos la lógica del TUI de gentle-shell mostrando los conteos que si se tienen pero la GUI NO puede mostrar unavailable mostrará 0 +0 -0."
L5: "0 files · +0/-0 también en la raíz fallida, no omitimos el grupo".

S11 (rule that governs the queue). "The app presents what gentle-shell already computes; it never invents a capability, a policy, an authority or a substitute flow. Host needs are specified in `gentle-pi`'s document before any app work depends on them. A missing host capability is a blocker, never an app-side workaround."

## Tasks

| ID | P | Spec | Route | Commit |
| --- | --- | --- | --- | --- |
| T1 | P1 | S1 | inline | see `git log` |
| T2 | P2 | S2 | inline | see `git log` |
| T3 | P3 | S3 | inline | see `git log` |
| T4 | P4 | S4 | inline | see `git log` |
| T5 | P5 | S5 | blocked: host `gentle-pi` S7/T2 (`oddPhase` field) | — |
| T6 | P6 | S6 | inline | see `git log` |
| T7 | P7 | S7 | inline | see `git log` |
| T8 | P8 | S8, S10 | inline | see `git log` |
| T9 | review | R3-001, R3-002, R3-003 (L6) | inline | see `git log` |

## Log

L1 (owner, verbatim)

"Lee el documento odd/plans/pending-work.md y empieza a implementarlo"

L6 (owner decision on the review's advisory findings, verbatim)

"1"

Read against the three options offered, that is: fix the three code defects the review found
in this candidate now, as their own commit, and then continue the queue with T6. The remaining
findings stay as recorded debt (L7) rather than review work on this candidate — the approved
receipt stands and its findings are non-blocking.

What T9 fixes, each with a test that failed first:

- R3-001/R2-001: `closeChat` tracked a failure with `failure !== undefined`, so a promise that
  rejected with `undefined` resolved as a successful close. The flag is now `failed`.
- R3-002: the close success callback was not scoped to the pane that asked, so a close settling
  after another chat was selected replaced that chat; and repeated clicks could issue several
  closes. The handler now compares the settled answer against the latest rendered addressing and
  allows one close in flight, withdrawing the control while it settles.
- R3-003: the control was drawn from the host address alone, even for a bridge without
  `chat.close`. The render gate now includes the capability.

L7 (debt from the approved review, not worked on purpose)

- R2-002: main's push and the renderer's own catch write the same status line for a failed close;
  with the real IPC bridge the raw rejection can overwrite the specific "process may still be
  running" message. Needs one owner for that message.
- R2-003: `measured` in `ChangesGroup` reads as "completely measured" while it only means "the
  root's counts printed"; a name like `rootMeasured` would keep the two P8 facts apart.
- R4-001: closing a workspace during a live turn stops the child with no confirmation, unlike
  closing the window. Product decision, not a patch.
- R4-002: a rejected close still evicts the snapshot and the chat→host mapping while the child may
  be live, so a retry targets a forgotten host. Needs a design decision on what a failed close
  leaves behind.
- R1-1 (the fallback spawn directory is session-recorded, not revalidated) and R1-2 (the
  registry's drop-before-await is base behaviour) are notes: neither is a defect introduced here.

L2 (delivery boundaries, recorded 2026-11-15)

Slice boundaries as instructed by the commit-path check (it measures the whole `develop`
branch against `origin/main`, which is far past ~400 lines because of the prior deliveries
listed in `pending-work.md` as already delivered; that is the branch's state, not one slice):

- Slice 1 — T1 (P1): `fix(chat-open): spawn a reopened chat's child in the chat's own directory`.
- Slice 2 — T2+T3 (P2, P3): `feat(workspace): close the open workspace and report a failed close`.
- Slice 3 — T4 (P4): `refactor(helpers): require hostId on HelpersContainer`.
- Slice 4 — T8 (P8): `feat(footer): render worktree changes in three states, never as a word`.

Push, PR and merge stay the owner's decision; `git log` holds the hashes.

L3 (routing note, P5)

T5 is not executable in this repository by S11: `oddPhase` from `session_state_changed` is a
host capability that `gentle-pi` `odd/tasks/desktop-gui-parity.md` S7/T2 must publish first.
No app-side inference is an acceptable substitute.

L4 (routing note, P7)

T7 starts by reading pi's resolved message types; the queue's own Blocked-by cell says guessing
them would trade a doc lie for a code lie, so the shape is read from the installed pi package
before any `history.ts` change.

L5 (P6 probe evidence, read from the installed pi package 0.85.1 — the queue's "host T4 probe,
confirmation only" is satisfied; nothing host-side blocks T6)

- Request: `{ id?: string, type: "get_commands" }`, no params.
- Response: `{ id?, type: "response", command: "get_commands", success: true, data: {
  commands: RpcSlashCommand[] } }`.
- `RpcSlashCommand` = `{ name, description?, source: "extension" | "prompt" | "skill",
  sourceInfo }`. Order is fixed by the child: extension commands, then prompt templates, then
  skills with a forced `skill:` prefix.
- `description` really can be absent (extension commands). There is NO argument hint on the
  wire: `argumentHint` exists only on internal types the handler never copies, so no hint may be
  rendered from wire data.
- Built-in TUI commands are excluded on purpose: "would not execute if sent via `prompt`". The
  composer must therefore offer ONLY what `get_commands` answered — which is also why no
  hardcoded `/gentle:*` replica is acceptable (S6).
- `docs/rpc.md`'s sample is stale (shows `path`/`location`); the build exposes `sourceInfo`
  instead (`CHANGELOG` 0.62.0). The types and handler are the authority.
- Repo side: `src/main/domain/rpc/types.ts`'s `RpcCommand` union does not model `get_commands`
  yet; PiSession's correlated-request pattern to copy is `requestIdentity()` /
  `applyIdentityResponse()` (`stats-…`/`state-…` counters); the state field would be a new
  optional member of `ChatState` after `session?`; no fixture carries a `get_commands` frame, so
  one must be captured or written from the shapes above; the composer has no autocomplete today
  and its `EmojiPanel` is the only in-composer popup precedent, with Enter already claimed by
  submit — a list must claim Arrow/Enter first.
- Risk stands at item 3: the `RpcCommand` union change touches a shared contract.
