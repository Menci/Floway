import { vi } from 'vitest';

import { UpstreamGoneError, UpstreamKindMismatchError, type UpstreamRecord, type UpstreamStateWriteGuard } from '@floway-dev/provider';

export interface UpstreamStateRepoStub {
  getById: ReturnType<typeof vi.fn<(id: string) => Promise<UpstreamRecord | null>>>;
  saveState: ReturnType<typeof vi.fn<(id: string, mutate: (current: unknown) => unknown, guard: UpstreamStateWriteGuard) => Promise<void>>>;
  // Documents actually written, in order. A mutator that hands back the state
  // it was given leaves this empty, which is how a suite asserts that a write
  // path decided there was nothing to do.
  writes: unknown[];
}

// Stand-in for the SQL upstream repo, faithful to the parts the Codex state
// writers depend on: the mutator sees the stored document, a result that
// serializes identically to it is not written, and a missing row throws.
export const createUpstreamStateRepoStub = (
  read: () => UpstreamRecord | null,
  commit: (state: unknown) => void,
): UpstreamStateRepoStub => {
  const writes: unknown[] = [];
  return {
    getById: vi.fn(async () => read()),
    saveState: vi.fn(async (id, mutate, guard) => {
      const row = read();
      if (!row) throw new UpstreamGoneError(id);
      if (row.kind !== guard.kind) throw new UpstreamKindMismatchError(id, guard.kind, row.kind);
      const next = mutate(row.state);
      if (JSON.stringify(next) === JSON.stringify(row.state)) return;
      writes.push(next);
      commit(next);
    }),
    writes,
  };
};
