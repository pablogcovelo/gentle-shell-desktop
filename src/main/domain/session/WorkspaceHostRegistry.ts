import type { ChatHostDeps } from "./ChatHost";
import { ChatHost } from "./ChatHost";

/**
 * Builds the ChatHostDeps for ONE new host, called once per `createHost`.
 * Adapters that are stateless (spawner, locator) or re-resolve their state
 * per call (sessionStore, homeSettings) can be shared across hosts; what
 * matters is that each call yields deps the new ChatHost can own a child
 * process through independently of every other host.
 */
export type WorkspaceHostRegistryDeps = {
  createHostDeps: () => ChatHostDeps;
};

/**
 * T5a (desktop-rpc-client.md, U6a): owns more than one live workspace host
 * in the main process. Each host is an independent ChatHost with its own
 * `gentle-shell --mode rpc` child and its own event stream; switching focus
 * (T5b/T5c) never stops another host's child, because this registry is the
 * only place hosts are created and stopped.
 *
 * Host identity: the registry mints an opaque `host-1`, `host-2`, … id per
 * host — a monotonic counter, never a cwd, a pid or the session file
 * (desktop-rpc-client.md L22 records why no existing key works: two
 * sessions may share a project, a fresh chat has no session path yet, and
 * the SpawnedProcess port exposes no pid). The counter never decrements,
 * so a stopped host's id is never reused for a different live host.
 *
 * T5a deliberately changes NO behaviour for the window: registerHandlers
 * still binds exactly one host (the currently active one) and forwards its
 * state/error pushes unchanged, so the IPC contract stays byte-identical.
 */
export class WorkspaceHostRegistry {
  private readonly deps: WorkspaceHostRegistryDeps;
  /** Monotonic; never decremented, so ids are never reused. */
  private nextHostNumber = 1;
  /** Live hosts only, keyed by the id minted at creation. A stopped host is
   * removed here; its id still can never come back (the counter moved on). */
  private readonly hosts = new Map<string, ChatHost>();

  constructor(deps: WorkspaceHostRegistryDeps) {
    this.deps = deps;
  }

  /** Creates a new live host with a freshly minted id and stores it.
   *
   * T11: `cwd` is the absolute workspace directory the host's child must
   * run in (chosen through workspace.create's validated picker flow). It
   * is passed straight into ChatHostDeps, so every PiSession this host
   * starts is spawned with it. Undefined for hosts minted without a
   * directory choice (chat.open/chat.new) — those carry no workspace
   * directory and must never be found by findByDirectory. */
  createHost(cwd?: string): ChatHost {
    const hostId = `host-${this.nextHostNumber++}`;
    const host = new ChatHost({ ...this.deps.createHostDeps(), hostId, cwd });
    this.hosts.set(hostId, host);
    return host;
  }

  /** T11: the live host whose workspace directory is `directory`, or
   * undefined — how "a directory that is already open selects the existing
   * workspace instead of starting a second child for it" resolves. Only
   * hosts created WITH a directory match; a stopped host is no longer in
   * `hosts`, so its directory is free again and a later create mints a
   * fresh child for it. Exact string match on purpose: the picker returns
   * one canonical absolute path per directory, and any normalization here
   * would be app-owned path policy the child does not share. */
  findByDirectory(directory: string): ChatHost | undefined {
    for (const host of this.hosts.values()) {
      if (host.cwd === directory) return host;
    }
    return undefined;
  }

  /** The live host owning `hostId`, or undefined — never a fallback to an
   * unrelated live host (U6a: never fall back to an unrelated live child). */
  get(hostId: string): ChatHost | undefined {
    return this.hosts.get(hostId);
  }

  /** Every live host, in creation order. */
  list(): readonly ChatHost[] {
    return [...this.hosts.values()];
  }

  /** Stops exactly one host's child and forgets the host. Rejects for an id
   * no live host owns, so a caller routing by id can never silently act on
   * a different child (U6a: never fall back to an unrelated live child). */
  async stopHost(hostId: string): Promise<void> {
    const host = this.hosts.get(hostId);
    if (!host) throw new Error(`WorkspaceHostRegistry: no host for id "${hostId}"`);
    this.hosts.delete(hostId);
    // ChatHost.stop() joins the host's start chain first, so a queued
    // open/new cannot outlive this stop and leave a child behind.
    await host.stop();
  }

  /** Stops every live host (app quit). Never throws, even when a host is
   * already gone — by quit time nothing is left to route to. */
  async stopAll(): Promise<void> {
    const hosts = this.list();
    this.hosts.clear();
    await Promise.all(hosts.map((host) => host.stop()));
  }
}
