# Desktop ADE — deferred gentle-pi host contracts

Backlog only, not a new protocol or an implementation commitment. App-only work proceeds through [the work-unit plan](desktop-ade-app-units.md), and **the ordered queue of what is still open lives in [`pending-work.md`](pending-work.md)** — this file keeps the capability history and the contract questions behind it. Host changes to gentle-pi are now scheduled and specified in that repository's `odd/tasks/desktop-rpc-client-gaps.md`; this backlog keeps the capabilities that still have no contract after the desktop RPC channel.

## Ownership

The GUI consumes gentle-shell capabilities; gentle-shell retains workflow, permissions and review authority. Desktop presentation must not bypass a TUI gate by simulating a terminal, invent consent or reproduce authority in Electron.

## Deferred capabilities

Each row carries a status; `deferred` means the gap still exists after the desktop RPC channel, `scheduled` means a delivery task now owns it.

| ID | Capability | Status | Current evidence / uncertainty | Contract question for later |
| --- | --- | --- | --- | --- |
| C1 | ODD phase | Scheduled (v1) | Owner decision 2026-11-15: the phase indicator enters v1. Upstream publication is specified as `oddPhase` inside `session_state_changed` in `gentle-pi` `odd/tasks/desktop-gui-parity.md` S7/T2; the app side is P5 in [`pending-work.md`](pending-work.md) | Phase updates and clearing through the existing event, where omission clears. Never inferred from transcript text or from a tool name. |
| C2 | Provider authentication | Deferred | No supported login/logout RPC primitive was established by this investigation; slash `/login` behavior is unconfirmed | Define a safe host authentication flow and effective account state. Do not move credentials into renderer state. |
| C3 | Extension/configuration management | Deferred | Configuration management is now available through the desktop RPC config slice (`get_snapshot`, `get_config`, `set_config` with revisions and allowlisted stores); extension installation and management remain unavailable | Define supported extension discovery, installation and change operations for the remaining gap. TUI keymaps/layout need not become GUI settings. |
| C4 | Review/RDD host integration | Deferred (v2) | Both clients inherit child authority. Selectors crossing RPC do not prove reachable controller consent; version-specific admission needs revalidation (below) | Inventory supported consent routes and missing host state. Preserve native exact bindings, budgets, consent answers, stop/gates and user authority in the host; never add an Electron review engine. Owner decision 2026-11-15: "Review/RDD si puede quedar para v2"; the contract question is carried as T5 in `gentle-pi`'s `desktop-gui-parity.md`. |
| C5 | Helper lifecycle controls | Delivered | `cancel_subagent` shipped in [`../tasks/desktop-rpc-client.md`](../tasks/desktop-rpc-client.md) T6 (Log L13): the response never reports success, the transition arrives through `agents_update` | Handle the asynchronous transition: the response can still report the helper as running and the real transition arrives as an event; never report success from the response alone. Do not emulate it with guessed slash prompts. |
| C6 | Structured job/feature/document state | Deferred (jobs delivered) | Structured jobs are delivered (`list_jobs`, `cancel_job`, `jobs_update`); feature and document state remain unavailable and stay out of the queue | Define snapshots/events for feature and document state only where a GUI capability needs them. Retain per-session identity and reconnect semantics. |
| C7 | Cross-process session ownership | Deferred | Earlier investigation found duplicate session opens unguarded; M3 Log L9 deferred ownership upstream | Decide ownership/duplicate-open semantics in gentle-shell. U6 must not claim to lock out external terminals. |

## Validation before any contract change

For each capability, re-read the then-current implementation: the investigation is a backlog, not proof that every review/configuration path is blocked. Record the actual unavailable operation and gate, existing working paths, schema/versioning, errors and cancellation, session scope and recovery. Specify public functional checks before implementation.

A current unsupported RPC result is a deferred capability, not permission to add app-owned policy. Existing `select`, `confirm`, `input` and `editor` dialogs remain supported and should not be described as wholly missing review integration.

### C4 — Version-specific leads, not a universal blocked claim

Static evidence from public [gentle-shell v4.7.0](https://github.com/Gentleman-Programming/gentle-shell/tree/8e11f0e2fb19af2a28233d1774848f7a3a33bbf1) (`8e11f0e2fb19af2a28233d1774848f7a3a33bbf1`):
- [`lib/review-consent-ui.ts`](https://github.com/Gentleman-Programming/gentle-shell/blob/8e11f0e2fb19af2a28233d1774848f7a3a33bbf1/lib/review-consent-ui.ts) has a non-TUI `select` fallback. Its existence alone does not establish controller reachability.
- [`extensions/gentle-ai.ts`](https://github.com/Gentleman-Programming/gentle-shell/blob/8e11f0e2fb19af2a28233d1774848f7a3a33bbf1/extensions/gentle-ai.ts) requires `eligiblePending` and `initialIdentity` for the call; [`lib/review-session-standing-permission.ts`](https://github.com/Gentleman-Programming/gentle-shell/blob/8e11f0e2fb19af2a28233d1774848f7a3a33bbf1/lib/review-session-standing-permission.ts) rejects non-TUI identity. Revalidate the complete route against the actual child version, not just the selector.

The [Viewer static comparison](desktop-ade-app-units.md#viewer-static-comparison--regression-guidance-not-runtime-proof) found desktop forwarding of `select`/`input`/`confirm` and cancellation of `editor`/unknown requests. Its web server retains `editor`, but shared UI code does not prove a supported editor response. This is not a claim of usable Viewer editor support, nor does it remove this app's existing `select`/`confirm`/`input`/`editor` support. No Viewer functional evaluation or test execution occurred; these are leads, not complete ODD/RDD parity evidence.

## Explicitly not scheduled

Voice dictation, app-control CLI, cloud/mobile, emulators and a plugin marketplace are outside the current objective. Terminal chrome, raw terminal-input handlers and component factories are not themselves features to port; map their useful capabilities instead.

## Source and limitations

- [`../tasks/desktop-m3-odd-panel.md`](../tasks/desktop-m3-odd-panel.md): S2, S6, Log L5, L7–L9.
- `README.md`: Known limitations records helper Stop, ODD phase and terminal-only provider/extension administration.
- Host-side investigation identified TUI coupling in `lib/voice-command.ts`, `extensions/gentle-shell.ts`, and `lib/review-session-standing-permission.ts` in gentle-pi. Those findings are leads for future revalidation, not a versioned contract frozen here.
- Earlier discussion overstated the evidence: not every review path is TUI-only, authentication dispatch remains unconfirmed, and a consumer-specific contract log is not an inventory proving that almost no capability crosses RPC.

User decision: "El contrato de gentle-pi lo documentamos pero lo abordamos más adelante" (historical; superseded — host changes are now scheduled via gentle-pi's `odd/tasks/desktop-rpc-client-gaps.md`).
