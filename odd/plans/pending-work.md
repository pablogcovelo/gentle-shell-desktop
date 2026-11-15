# Desktop ADE — single index of pending work

**Read this first.** Every pending item for the desktop app lives here, ordered, with its owner, its evidence and its blocker. Other documents keep the history; this one keeps the queue. If an item is not in this file, it is not pending. If a document disagrees with this file about what is pending, this file wins and the other document gets corrected.

Working branch for both repositories: `develop` (owner decision, 2026-11-15).

Companion host index: `gentle-pi` `odd/tasks/desktop-gui-parity.md`. Anything needing a gentle-shell change is specified there and appears here only as a dependency.

## Rule that governs the whole queue

The app presents what gentle-shell already computes; it never invents a capability, a policy, an authority or a substitute flow. Host needs are specified in `gentle-pi`'s document before any app work depends on them. A missing host capability is a blocker, never an app-side workaround.

## v1 — the ordered queue

| ID | Item | Source of the report | Where | Blocked by | Risk |
| --- | --- | --- | --- | --- | --- |
| P1 | Bind `chat.open` to the chat's own directory so a reopened chat's child spawns in its workspace, not in Electron's launch directory. Closes the gap recorded in L30/T11 and is why the footer's worktree group appears only for created workspaces today | agent report 1; `desktop-rpc-client.md` L30 | `ChatHost` open path + `PiSession` cwd + `chat.open` handler | none (host already accepts cwd) | item 1 (path passed to a spawn) |
| P2 | A workspace-close affordance: a production caller for `chat.close`, plus snapshot-cache eviction for the closed host. Without it, closing only happens at app quit and the renderer cache grows with every chat opened | agent report 3 and 5; `desktop-rpc-client.md` L27, L29 | renderer sidebar/header + `closedHosts` bound | P1 (a workspace must have an identity to close) | none |
| P3 | `closeChat` best-effort hardening: a failed late close must not leave a live host without a visible signal. Cleanup is already in `finally` (L28); what remains is the *report* of that failure to the renderer | agent report 2 (R3-001 of the last review) | `WorkspaceHostRouter` close path | none | item 4 (host lifetime) |
| P4 | Make `hostId` required on `HelpersContainer`, so the compiler refuses a parent that forgets it — the exact defect that shipped once (L24, two blockers) only because the prop was optional | agent report 4; `desktop-rpc-client.md` L24 | `HelpersContainer` props + its call site | none | item 3 (component contract) |
| P5 | ODD phase indicator in the header, consuming `oddPhase` from `session_state_changed`. Never inferred from transcript text, never derived from a tool name | owner decision (Log L2.7); C1 | reducer + header | **host T2** (`gentle-pi` S7/T2) | none |
| P6 | Command discovery for the composer: `/` lists what the child answers for `get_commands` (pi command, no host change), submits through `prompt`, and never keeps a hardcoded `/gentle:*` replica. Interactive results route through the existing dialogs | U4 (this document's plan-units file); host S4/T4 | `PiSession` command list + composer | **host T4 probe** (confirmation only; the command already exists in pi's RPC mode) | item 3 if the command union changes |
| P7 | Tool-call detail recovery on reopen: `toolCalls` is live-only today, `history.ts` keeps text parts only, so a reload loses args/result/error | agent report 7; `desktop-rpc-client.md` L18 | `rpc/history.ts` + reducer | none, but it starts by reading pi's resolved message types — guessing shapes would trade a doc lie for a code lie | item 3 (history is shared by messages and rows) |
| P8 | Worktree changes: **three states, one render**. (a) measured and clean → `0 files · +0/-0`; (b) measured with partial data → the counts the child did supply, with the unmeasured file marked; (c) unmeasured (failed root, unborn root, refused answer) → **also `0 files · +0/-0`**, and the group is never omitted. Accepted consequence, recorded: (c) becomes visually indistinguishable from (a), so the footer stops telling "not measured" apart from "nothing changed"; the distinction survives in the host payload, and an optional `title`/`aria-label` ("changes were not measured") may carry it without changing the visible copy. Requires splitting the single flag into `countsUnavailable` (root) and `filesUnmeasured` (per file) and reworking the footer render + the pins that encode the current single-state rule | `desktop-rpc-client.md` L31, L33; owner decision (Log L4, L5) | `src/main/domain/rpc/workspaceInfo.ts`, `src/shared/bridge-types.ts`, `Footer.tsx` | none (app-side only) | item 3 (the bridge type changes what the renderer sees) |

Sequencing: P1 → P2 → P3 → P4 are all workspace-lifetime work and are cheapest as two slices (P1 alone; P2+P3 together; P4 anywhere). P5 waits for the host field. P6 is independent and small. P7 is the largest single item in v1. P8 is a decision, not a build.

## v2 — deliberately deferred

| Item | Why deferred | What unblocks it |
| --- | --- | --- |
| Review/RDD panel: switch state, current lineage, findings | Owner decision: "Review/RDD si puede quedar para v2" | host `desktop-gui-parity` T5 |
| Diff/patch text viewer | No owner publishes patch text; adding it is a new host feature and is out by the scope rule | an explicit owner decision, then a new host method |
| Restore open workspaces on relaunch in waves (U6b) | No delivery spec; the only large unit left in the recommended sequence | a spec in this file once P1–P3 land, since it depends on workspace identity and close semantics |
| Steer / follow-up queue (U5) | Contracts unconfirmed; `PromptResult.queued` means accepted, not queued | protocol validation before any UI |

## Debt recorded, not hidden

| Debt | State | Owner |
| --- | --- | --- |
| T3 usage review never closed: lineage left in `targeted_validation_required` after a provider defect rejected the validator binding (`desktop-rpc-client.md` L12). The work is implemented, corrected and locally verified | open | provider defect, not app code; do not re-review the candidate, a fresh review of the *range* is the route if the owner wants a closing verdict |
| Four comments in the T5 candidate are stale and two findings are real work already fixed in T5c (`desktop-rpc-client.md` L24) | closed by T5c | — |
| Task table `Commit` column goes stale whenever work lands in line | corrected in this delivery for `desktop-rpc-client.md` T4–T8; from now on a delivered row cites its Log entry, and `git log` remains the authority for hashes | every writer |

## Out of scope — not in the queue and not to be re-litigated

Provider authentication/login (C2), extension installation (C3), structured feature/document state (C6), cross-process session ownership (C7), persona, dictation, app-control CLI, plugin marketplace, and every host-side new feature listed in `gentle-pi` `desktop-gui-parity` S9 (file feed, action inbox, folder guard, Herdr mods/installer, `ancestors`, roots registry, JSONL offset reading, identity method, diff text).

## Already delivered — do not re-open

M1 (chat core), M2 (helpers, including the async `cancel_subagent` transition), M3 (ODD task card, per-chat boundary), the desktop RPC client base (T1), statuses/notifications (T2a/T2b), usage meters (T3, debt above), session stats/model/thinking read (T4), multi-workspace routing and lifecycle (T5a–T5d), helper stop (T6), tool activity rows live (T7), footer workspace facts (T8b: MCP inventory, active profile, worktree counts), hero intro (T9b), reference corrections (T10), add-workspace with directory (T11), and the workspace shell/fidelity slices (`desktop-workspace-shell.md` T1–T10).

## Where the history lives

| Document | Holds |
| --- | --- |
| `desktop-rpc-client.md` | the client contract and its Log L1–L31: every delivery, review and correction |
| `desktop-m1-chat-core.md`, `desktop-m2-helpers.md`, `desktop-m3-odd-panel.md` | the first three milestones |
| `desktop-workspace-shell.md`, `workspace-fidelity.md` | the Workspace board implementation and its fidelity checks |
| `desktop-ade-app-units.md` | the capability units; U1–U3, U6a delivered, U4 answered by the host, U5 and U6b still unspecified |
| `desktop-ade-deferred-contracts.md` | capability history and the contract questions; points here for anything requiring a host change |
| `../gentle-pi/odd/tasks/desktop-gui-parity.md` | every host-side need, its specs and its tasks |

## Log

### L1 (owner, verbatim)

"deja todo centralizado y acotado porque por ejemplo en ../gentle-shell-desktop creo que hay varias implementaciones todavía pendienes repartidos en varios documentos y se pierde el orden de trabajo y la trazabilidad de lo pendiente"

### L2 (owner, verbatim, scope decisions binding on this file)

1. "A día de hoy no quiero agregar funcionaliades nuevas a este repo solo quiero implementar las comunicaciones pertinentes, RPC u otras, para que la GUI sea plenamente funcional en el repo ../gentle-shell-desktop".
2. "Review/RDD si puede quedar para v2".
3. "el indicador de fase de ODD entra en v1".
4. "Seguimos la política" (duplicate dialog handling) and "Preguntamos" (closing the window with a live turn): both already implemented and unchanged.
5. "la GUI muestra paths que representan carpetas "espacios de trabajo" del usuario en su equipo, nada tiene que ver con las rutas ~/.pi/agent o ~/.gentle-shell/agent".
6. "IMPORTANTE, recuerda que las ramas actuales de trabajo de ambos repositorios son develop".

### L3 (consolidation, 2026-11-15)
Created as the single queue. Contents reconciled against: the ten open items reported by the app session; `desktop-rpc-client.md` L12–L31; `desktop-ade-app-units.md` U4/U5/U6b; `desktop-ade-deferred-contracts.md` C1–C7; and the host surface read in `../gentle-pi` (`lib/desktop-rpc-*.ts`, `docs/desktop-rpc.md`). Nothing in this file claims an implementation; every row is a queue entry for a later session.

### L4 (owner decision, P8 worktree counts, verbatim)

"Seguimos la lógica del TUI de gentle-shell mostrando los conteos que si se tienen pero la GUI NO puede mostrar unavailable mostrará 0 +0 -0."

Read as the three-state rule in P8: zeros when the workspace is genuinely clean, partial counts instead of collapsing to "unavailable", and the unmeasured case resolved as own L5 below.

### L5 (owner decision, closing the unmeasured case, verbatim)

"0 files · +0/-0 también en la raíz fallida, no omitimos el grupo".

Applied as stated, and the consequence is recorded rather than argued again: a failed or unborn root now renders `0 files · +0/-0`, so the footer can no longer distinguish "nothing changed" from "nothing could be measured". That distinction stays in the host payload (`failedRoots`/`unbornRoots`/`countsUnavailable`) and may be surfaced accessibly through `title`/`aria-label` without changing the visible copy. This supersedes T8b's "never as zero files and zero lines" clause, which is why `desktop-rpc-client.md` L33 carries the amendment instead of a silent edit.
