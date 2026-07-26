import type { UpstreamRecord } from './model.ts';

// Slim upstream-state surface for providers that own runtime state (e.g.
// Codex's rotated tokens). Reached from the data plane as a request runs and
// from operator-triggered control-plane actions alike, so every write goes
// through the same read-modify-CAS. Structurally compatible with the full
// UpstreamRepo in packages/gateway, so the wiring stays a single accessor.
export interface UpstreamsRepoSlim {
  getById(id: string): Promise<UpstreamRecord | null>;
  saveState(id: string, newState: unknown, options: { expectedState: unknown }): Promise<{ updated: boolean }>;
}

export interface ProviderRepo {
  upstreams: UpstreamsRepoSlim;
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
