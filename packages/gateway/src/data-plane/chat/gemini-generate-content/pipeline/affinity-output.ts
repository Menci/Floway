import { defineStage } from '../../pipeline/facts.ts';
import { transformProtocolFrames } from '../../pipeline/stream-transform.ts';
import { wrapGeminiGenerateContentAffinityEgress } from '../affinity/egress.ts';
import { materializeOpaqueBlobCompatibilityIdentity } from '@floway-dev/protocols/common';
import type { UpstreamEvent } from '@floway-dev/upstream';

export const geminiGenerateContentAffinityOutput = defineStage({
  name: 'geminiGenerateContent.affinity-output',
  through: {
    request: { needs: ['model', 'upstream', 'aliasRules'], provides: [], consumes: [] },
    response: { needs: ['geminiGenerateContent'], provides: ['geminiGenerateContent'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const outcome = answer.geminiGenerateContent;
    if (outcome.kind !== 'stream') return answer;

    const { model, upstream, aliasRules } = facts;
    const affinity = {
      upstreamId: upstream.id,
      modelId: model.id,
      ...(Object.keys(aliasRules).length === 0 ? {} : { rules: aliasRules }),
      opaqueBlobCompatibilityIdentity: materializeOpaqueBlobCompatibilityIdentity(model.opaqueBlobCompatibilityScope, upstream.id, model.upstreamModelId),
    };
    type Event = UpstreamEvent<'geminiGenerateContent'>;
    const stream = scope.wrapStream(outcome.stream, (source, producer) => transformProtocolFrames<Event, Event>(source, producer,
      frames => wrapGeminiGenerateContentAffinityEgress(frames, { affinity, codec: producer.services.affinity })));
    return { ...answer, geminiGenerateContent: { kind: 'stream', stream } };
  },
});
