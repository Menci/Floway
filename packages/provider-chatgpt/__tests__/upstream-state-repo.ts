import { vi } from 'vitest';

import { UpstreamGoneError, type UpstreamRecord, type UpstreamsRepoSlim } from '@floway-dev/provider';

export interface UpstreamStateRepoStub {
  getById: ReturnType<typeof vi.fn<UpstreamsRepoSlim['getById']>>;
  saveState: ReturnType<typeof vi.fn<UpstreamsRepoSlim['saveState']>>;
  // Documents actually written, in order. A mutator that hands back the state
  // it was given leaves this empty, which is how a suite asserts that a write
  // path decided there was nothing to do.
  writes: unknown[];
}

// Stand-in for the SQL upstream repo, faithful to the parts the ChatGPT state
// writers depend on: the mutator sees the stored document, a result that
// serializes identically to it is not written, and a missing row throws.
export const createUpstreamStateRepoStub = (
  read: () => UpstreamRecord | null,
  commit: (state: unknown) => void,
): UpstreamStateRepoStub => {
  const writes: unknown[] = [];
  return {
    getById: vi.fn(async () => {
      const record = read();
      return record === null ? null : { ...record, configVersion: 1 };
    }),
    saveState: vi.fn(async (id, mutate) => {
      const row = read();
      if (!row) throw new UpstreamGoneError(id);
      const next = mutate(row.state, 1);
      if (JSON.stringify(next) === JSON.stringify(row.state)) return;
      writes.push(next);
      commit(next);
    }),
    writes,
  };
};
