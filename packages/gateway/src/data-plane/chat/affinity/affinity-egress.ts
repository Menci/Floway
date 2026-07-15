import type { AffinityTarget } from './types.ts';

export interface AffinityEgressCodec {
  wrap(value: string | undefined, affinity: AffinityTarget): Promise<string>;
}

export interface AffinityEgressOptions {
  readonly codec: AffinityEgressCodec;
  readonly affinity: AffinityTarget;
}
