import type { UpstreamRecord } from './model.ts';

// Slim upstream-state surface for providers that own autonomous runtime state
// (e.g. Codex's rotated tokens). Structurally compatible with the full
// UpstreamRepo in packages/gateway, so the wiring stays a single accessor.
export interface UpstreamsRepoSlim {
  getById(id: string): Promise<UpstreamRecord | null>;
  saveState(id: string, newState: unknown, options: { expectedState: unknown }): Promise<{ updated: boolean }>;
}

// Cross-instance Cursor session scalars (the durable half of a live agent
// turn — the read stream lives in the DurableHttpSession). Persisted in D1 so
// a tool-result follow-up landing on a different isolate can resume the
// upstream RunSSE without the in-process transport. See migration
// 0049_cursor_sessions.sql. Structurally matched by the gateway SqlRepo.
export interface CursorSessionRow {
  sessionKey: string;
  requestId: string;
  /** Next BidiAppend seqno. bigint in the transport; a safe JS number here. */
  appendSeqno: number;
  /** RunSSE bytes read past the exec_mcp frame but unconsumed (usually empty). */
  leftover: Uint8Array | null;
}

export interface CursorSessionsRepoSlim {
  /**
   * Atomically claim (lock for ttlMs) and return the row — single-flight so two
   * concurrent follow-ups can't both drive the same stream. Returns null if the
   * session is missing or already claimed (caller cold-resumes).
   */
  claim(sessionKey: string, ttlMs: number): Promise<CursorSessionRow | null>;
  /** Upsert the scalars, clear the claim lock, and refresh the sweep timestamp. */
  put(row: CursorSessionRow): Promise<void>;
  delete(sessionKey: string): Promise<void>;
}

export interface ProviderRepo {
  upstreams: UpstreamsRepoSlim;
  cursorSessions: CursorSessionsRepoSlim;
  /**
   * Resolve an upstream's proxy fallback list into ordered, opaque
   * `@floway-dev/proxy` ProxyConfig objects (direct entries dropped) for a
   * provider that must dial a streaming upstream through the proxy itself
   * (cursor's RunSSE — see DurableHttpSessionInit.proxies). Optional so test
   * mocks that don't exercise proxying can omit it (callers fall back to direct).
   */
  proxies?: ProxyResolverSlim;
}

export interface ProxyResolverSlim {
  resolveForUpstream(upstreamId: string): Promise<unknown[]>;
}

let _accessor: (() => ProviderRepo) | null = null;

// Called once at boot from packages/gateway; gives provider helpers a callable
// that returns the live repo (lazy so the accessor can run after initRepo).
export const initProviderRepo = (accessor: () => ProviderRepo): void => {
  _accessor = accessor;
};

export const getProviderRepo = (): ProviderRepo => {
  if (!_accessor) throw new Error('Provider repo not initialized — call initProviderRepo() first');
  return _accessor();
};
