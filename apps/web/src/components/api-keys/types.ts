import type { ApiKey, ControlPlaneModel, UpstreamOption } from '../../api/types';

export type { UpstreamOption } from '../../api/types';

export interface ApiKeysPageData {
  keys: ApiKey[];
  upstreams: UpstreamOption[];
  models: ControlPlaneModel[];
  error: string | null;
}
