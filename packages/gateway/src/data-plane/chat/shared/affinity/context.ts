import { AffinityCodec, type AffinityIdentity } from './carrier.ts';
import { resolveLegacyOpaqueBlobCompatibilityIdentity } from './legacy.ts';
import { compatibilityIdentityForCandidate } from './selection.ts';
import type { ServeCandidate } from '../../../pipeline/facts.ts';
import type { GatewayCtx } from '../../../shared/gateway-ctx.ts';
import type { ChatGatewayCtx } from '../gateway-ctx.ts';

export interface AffinityEgressOptions {
  readonly codec: Pick<AffinityCodec, 'wrap'>;
  readonly affinity: AffinityIdentity;
}

export const affinityIdentityForCandidate = (candidate: ServeCandidate): AffinityIdentity => ({
  upstreamId: candidate.upstream.id,
  modelId: candidate.model.id,
  ...(candidate.rules !== undefined ? { rules: candidate.rules } : {}),
  opaqueBlobCompatibilityIdentity: compatibilityIdentityForCandidate(candidate),
});

export const createAffinityCodec = (serverSecret: string): AffinityCodec =>
  new AffinityCodec(serverSecret, resolveLegacyOpaqueBlobCompatibilityIdentity);

export class AffinityRequestContext {
  readonly codec: AffinityCodec;
  #selectedCandidate: ServeCandidate | undefined;

  constructor(serverSecret: string) {
    this.codec = createAffinityCodec(serverSecret);
  }

  select(candidate: ServeCandidate): void {
    this.#selectedCandidate = candidate;
  }

  selectedTarget(): AffinityIdentity {
    if (this.#selectedCandidate === undefined) throw new Error('Affinity target requested before a candidate was selected');
    return affinityIdentityForCandidate(this.#selectedCandidate);
  }
}

export const affinityEgressOptions = (ctx: GatewayCtx): AffinityEgressOptions => {
  if (!('affinity' in ctx)) throw new Error('Chat event result reached responder without affinity context');
  const chatCtx = ctx as ChatGatewayCtx;
  return { codec: chatCtx.affinity.codec, affinity: chatCtx.affinity.selectedTarget() };
};
