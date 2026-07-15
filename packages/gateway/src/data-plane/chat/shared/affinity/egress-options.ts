import type { AffinityCodec } from './codec.ts';
import type { AffinityTarget } from './types.ts';

export interface AffinityEgressOptions {
  readonly codec: Pick<AffinityCodec, 'wrap'>;
  readonly affinity: AffinityTarget;
}
