import type { UpstreamRecord } from '../../src/api/types';

// Everything a record carries that no suite is about. The kind, its config and
// its state come from the caller because the union correlates them; the rest
// is the same for every kind, so a new required field on `UpstreamRecord` is
// one edit here rather than one per suite.
const commonFields = {
  name: 'Upstream',
  enabled: true,
  sort_order: 1,
  created_at: '',
  updated_at: '',
  flag_overrides: {},
  flag_defaults: {},
  disabled_public_model_ids: [],
  proxy_fallback_list: [],
  model_prefix: null,
  color: null,
  modelsCache: { fetchedAt: null, lastError: null, modelCount: null },
} satisfies Omit<UpstreamRecord, 'id' | 'kind' | 'config' | 'state'>;

// Distributed over the union so that a kind can only be paired with its own
// config and state, which is what a cast would throw away.
type UpstreamRecordSeed<R = UpstreamRecord> = R extends UpstreamRecord
  ? Pick<R, 'kind' | 'config' | 'state'> & Partial<R>
  : never;

export const upstreamRecord = (id: string, seed: UpstreamRecordSeed): UpstreamRecord => ({
  ...commonFields,
  id,
  ...seed,
});
