import { AffinityCodec, type AffinityTarget } from './carrier.ts';
import type { GatewayCtx } from '../../../shared/gateway-ctx.ts';
import type { ChatGatewayCtx } from '../gateway-ctx.ts';
import type { ModelCandidate } from '@floway-dev/provider';

export interface AffinityEgressOptions {
  readonly codec: Pick<AffinityCodec, 'wrap'>;
  readonly affinity: AffinityTarget;
}

const affinityTargetForCandidate = (candidate: ModelCandidate): AffinityTarget => ({
  upstreamId: candidate.provider.upstreamId,
  modelId: candidate.model.id,
  ...(candidate.rules !== undefined ? { rules: candidate.rules } : {}),
});

export class AffinityRequestContext {
  readonly codec: AffinityCodec;
  #selectedCandidate: ModelCandidate | undefined;

  constructor(serverSecret: string) {
    this.codec = new AffinityCodec(serverSecret);
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
