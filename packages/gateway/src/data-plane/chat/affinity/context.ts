import { affinityTargetForCandidate } from './candidate.ts';
import { AffinityCodec } from './codec.ts';
import type { AffinityTarget } from './types.ts';
import type { ModelCandidate } from '@floway-dev/provider';

export class AffinityRequestContext {
  readonly codec: AffinityCodec;
  #selectedCandidate: ModelCandidate | undefined;

  constructor(secret: string) {
    this.codec = new AffinityCodec(secret);
  }

  select(candidate: ModelCandidate): void {
    this.#selectedCandidate = candidate;
  }

  selectedTarget(mode: AffinityTarget['mode'] = 'prefer'): AffinityTarget {
    if (this.#selectedCandidate === undefined) throw new Error('Affinity target requested before a candidate was selected');
    return affinityTargetForCandidate(this.#selectedCandidate, mode);
  }
}
