import { DIRECT_PROXY_ID } from './proxy-fallback-list.ts';
import type { Repo } from './types.ts';
import { initProviderRepo } from '@floway-dev/provider';
import { parseProxyUri } from '@floway-dev/proxy';

let _repo: Repo | null = null;

// Resolve an upstream's proxy fallback list into ordered ProxyConfig objects
// (direct entries + malformed/missing rows dropped), for providers that dial
// streaming upstreams through the proxy directly rather than through the
// gateway's buffered proxy Fetcher (which rejects streaming bodies). Returned
// opaque (unknown[]) across the slim provider-repo boundary.
const resolveDirectDialProxies = async (repo: Repo, upstreamId: string): Promise<unknown[]> => {
  const upstream = await repo.upstreams.getById(upstreamId);
  if (!upstream) return [];
  const proxyIds = upstream.proxyFallbackList.filter(e => e.id !== DIRECT_PROXY_ID).map(e => e.id);
  if (proxyIds.length === 0) return [];
  const byId = new Map((await repo.proxies.list()).map(p => [p.id, p] as const));
  const out: unknown[] = [];
  for (const id of proxyIds) {
    const row = byId.get(id);
    if (!row) continue;
    try { out.push(parseProxyUri(row.url)); } catch { /* skip malformed row */ }
  }
  return out;
};

export function initRepo(repo: Repo): void {
  _repo = repo;
  // Hand provider-package helpers (models-store, cursor session reuse, etc.) a
  // lazy accessor for the same singleton so they read through the live repo.
  initProviderRepo(() => {
    const live = getRepo();
    return {
      upstreams: live.upstreams,
      cursorSessions: live.cursorSessions,
      proxies: { resolveForUpstream: (upstreamId: string) => resolveDirectDialProxies(live, upstreamId) },
    };
  });
}

export function getRepo(): Repo {
  if (!_repo) throw new Error('Repo not initialized — call initRepo() first');
  return _repo;
}
