import type { AffinityEgressOptions } from './affinity-egress.ts';
import { affinityTargetForCandidate } from './candidate.ts';
import { AffinityCodec } from './codec.ts';
import type { AffinityTarget } from './types.ts';
import type { ChatGatewayCtx, GatewayCtx } from '../gateway-ctx.ts';
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

  selectedTarget(): AffinityTarget {
    if (this.#selectedCandidate === undefined) throw new Error('Affinity target requested before a candidate was selected');
    return affinityTargetForCandidate(this.#selectedCandidate);
  }
}

export const affinityEgressOptions = (ctx: GatewayCtx): AffinityEgressOptions => {
  if (!('affinity' in ctx)) throw new Error('Chat event result reached responder without affinity context');
  const chatCtx = ctx as ChatGatewayCtx;
  return { codec: chatCtx.affinity.codec, affinity: chatCtx.affinity.selectedTarget() };
};
