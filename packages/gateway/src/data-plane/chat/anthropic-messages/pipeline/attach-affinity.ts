import { transformAnthropicMessagesFrames } from './protocol-stream.ts';
import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { affinityIdentityForCandidate } from '../../shared/affinity/index.ts';
import { wrapAnthropicMessagesAffinityEgress } from '../affinity/egress.ts';
import { move, transform } from '@floway-dev/pipeline';

const { defineStage } = gatewayFactSpace<Pick<GatewayServices, 'affinityCodec'>>();
const responseKey = 'response.anthropicMessages';

export const attachAnthropicMessagesAffinity = defineStage({
  name: 'anthropicMessages.attach-affinity',
  through: {
    request: { needs: ['serve.candidate'], provides: [], consumes: [] },
    response: { needs: [responseKey], provides: [responseKey], consumes: [] },
  },
  execute: transform(scope => {
    let affinity: ReturnType<typeof affinityIdentityForCandidate>;
    return {
      request: facts => {
        affinity = affinityIdentityForCandidate(facts['serve.candidate']);
        return facts;
      },
      response: facts => {
        const outcome = facts[responseKey];
        if (outcome.kind !== 'stream') return facts;
        const codec = scope.services.affinityCodec();
        const stream = scope.wrapStream(outcome.stream, (items, producer) =>
          transformAnthropicMessagesFrames(items,
            frames => wrapAnthropicMessagesAffinityEgress(frames, { codec, affinity }),
            () => { producer.abort(facts); }));
        return { ...facts, [responseKey]: move({ kind: 'stream', stream } as const) };
      },
    };
  }),
});
