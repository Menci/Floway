import type { UpstreamRecord } from './model.ts';

// Slim upstream-state surface for providers that own runtime state (e.g.
// Codex's rotated tokens). Reached from the data plane as a request runs and
// from operator-triggered control-plane actions alike, so every write goes
// through the same read-modify-CAS. Structurally compatible with the full
// UpstreamRepo in packages/gateway, so the wiring stays a single accessor.
//
// `saveState` takes the change as a function rather than a finished document
// because the write is retried: a caller that computed its document from an
// earlier read would, on losing the race, either overwrite the winner's fields
// or have to re-derive the change itself. The mutator is re-run against
// whatever state won, so both writers' changes survive. It must therefore be
// pure, and returning the state unchanged skips the write.
export interface UpstreamsRepoSlim {
  getById(id: string): Promise<UpstreamRecord | null>;
  saveState(id: string, mutate: (current: unknown) => unknown): Promise<void>;
}

// Thrown when the row a write targets no longer exists. Distinct from a
// storage failure so a best-effort writer can tolerate the operator having
// deleted the upstream mid-request, while a write that must not be lost — a
// rotated refresh token — still propagates.
export class UpstreamGoneError extends Error {
  constructor(readonly upstreamId: string) {
    super(`Upstream ${upstreamId} disappeared before its state could be written`);
    this.name = 'UpstreamGoneError';
  }
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
