import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { readProtocolFrames } from '../../pipeline/protocol-frames.ts';
import { affinityIdentityForCandidate } from '../../shared/affinity/index.ts';
import { wrapOpenAIChatCompletionsAffinityEgress } from '../affinity/egress.ts';
import { move, transform } from '@floway-dev/pipeline';
import { doneFrame } from '@floway-dev/protocols/common';

const { defineStage } = gatewayFactSpace<Pick<GatewayServices, 'affinityCodec'>>();
const responseKey = 'response.openaiChatCompletions';

export const attachOpenAIChatCompletionsAffinity = defineStage({
  name: 'openaiChatCompletions.attach-affinity',
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
        const stream = scope.wrapStream(outcome.stream, async function* (items, producer) {
          const source = readProtocolFrames(items);
          const withTerminal = async function* () {
            yield* source.frames();
            if (!producer.signal.aborted) yield doneFrame();
          };
          try {
            for await (const frame of wrapOpenAIChatCompletionsAffinityEgress(withTerminal(), { codec, affinity })) {
              if (frame.type === 'event') yield { ok: true, value: frame.event };
            }
          } catch (cause) {
            if (source.failure === undefined || source.failure !== cause) throw cause;
            producer.abort(facts);
            yield { ok: false, error: source.failure };
          } finally {
            if (!source.done) {
              producer.abort(facts);
              await source.drain();
            }
          }
        });
        return { ...facts, [responseKey]: move({ kind: 'stream', stream } as const) };
      },
    };
  }),
});
