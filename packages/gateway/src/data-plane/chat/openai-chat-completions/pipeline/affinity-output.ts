import { defineStage } from '../../pipeline/facts.ts';
import { transformProtocolFrames } from '../../pipeline/stream-transform.ts';
import { wrapOpenAIChatCompletionsAffinityEgress } from '../affinity/egress.ts';
import { materializeOpaqueBlobCompatibilityIdentity } from '@floway-dev/protocols/common';
import type { UpstreamEvent } from '@floway-dev/upstream';

export const openaiChatCompletionsAffinityOutput = defineStage({
  name: 'openaiChatCompletions.affinity-output',
  through: {
    request: { needs: ['model', 'upstream', 'aliasRules'], provides: [], consumes: [] },
    response: { needs: ['openaiChatCompletions'], provides: ['openaiChatCompletions'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const outcome = answer.openaiChatCompletions;
    if (outcome.kind !== 'stream') return answer;

    const { model, upstream, aliasRules } = facts;
    const affinity = {
      upstreamId: upstream.id,
      modelId: model.id,
      ...(Object.keys(aliasRules).length === 0 ? {} : { rules: aliasRules }),
      opaqueBlobCompatibilityIdentity: materializeOpaqueBlobCompatibilityIdentity(model.opaqueBlobCompatibilityScope, upstream.id, model.upstreamModelId),
    };
    type Event = UpstreamEvent<'openaiChatCompletions'>;
    const stream = scope.wrapStream(outcome.stream, (source, producer) => transformProtocolFrames<Event, Event>(source, producer,
      frames => wrapOpenAIChatCompletionsAffinityEgress(frames, { affinity, codec: producer.services.affinity })));
    return { ...answer, openaiChatCompletions: { kind: 'stream', stream } };
  },
});
