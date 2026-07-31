import type { ApiKey, ControlPlaneModel, UpstreamOption } from '../../api/types';

export type { UpstreamOption } from '../../api/types';

// `null` is a fetch that failed, distinct from a deployment that genuinely
// holds no keys: an empty table invites an operator to create a second copy of
// a key they already have.
export interface ApiKeysPageData {
  keys: ApiKey[] | null;
  upstreams: UpstreamOption[] | null;
  models: ControlPlaneModel[] | null;
  error: string | null;
}
