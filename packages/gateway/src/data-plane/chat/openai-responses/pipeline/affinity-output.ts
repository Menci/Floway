import { defineStage } from '../../pipeline/facts.ts';
import { openAIResponsesFailureEvents } from '../../pipeline/stream-error.ts';
import { wrapOpenAIResponsesAffinityEgress } from '../affinity/egress.ts';
import { eventFrame, isJsonObject, materializeOpaqueBlobCompatibilityIdentity, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ProtocolStreamError } from '@floway-dev/upstream';

export const openaiResponsesAffinityOutput = defineStage({
  name: 'openaiResponses.affinity-output',
  through: {
    request: { needs: ['model', 'upstream', 'aliasRules'], provides: [], consumes: [] },
    response: { needs: ['openaiResponses'], provides: ['openaiResponses'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const outcome = answer.openaiResponses;
    if (outcome.kind !== 'stream') return answer;

    const { model, upstream, aliasRules } = facts;
    const affinity = {
      upstreamId: upstream.id,
      modelId: model.id,
      ...(Object.keys(aliasRules).length === 0 ? {} : { rules: aliasRules }),
      opaqueBlobCompatibilityIdentity: materializeOpaqueBlobCompatibilityIdentity(model.opaqueBlobCompatibilityScope, upstream.id, model.upstreamModelId),
    };
    const stream = scope.wrapStream(outcome.stream, async function* (source, producer) {
      const cursor = producer.read(source);
      let exhausted = false;
      let failure: ProtocolStreamError | undefined;
      const frames = async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
        while (true) {
          const item = await cursor.next();
          if (item.done) {
            exhausted = true;
            return;
          }
          if (item.value.ok) {
            yield eventFrame(item.value.value);
            continue;
          }
          exhausted = true;
          failure = item.value.error;
          producer.discard(source);
          const { notification, failed } = openAIResponsesFailureEvents(failure);
          if (notification !== undefined) yield eventFrame(notification);
          if (failed !== undefined && isJsonObject(failed.response) && Array.isArray(failed.response.output)) {
            yield eventFrame(failed);
          }
          return;
        }
      };

      let projected: ReturnType<typeof openAIResponsesFailureEvents> | undefined;
      for await (const frame of wrapOpenAIResponsesAffinityEgress(frames(), { affinity, codec: producer.services.affinity })) {
        if (frame.type !== 'event') continue;
        if (failure === undefined) {
          yield { ok: true, value: frame.event };
        } else if (frame.event.type === 'error') {
          projected = { ...projected, notification: frame.event };
        } else if (frame.event.type === 'response.failed') {
          projected = { ...projected, failed: frame.event };
        }
      }

      // The protocol frame transform can stop at the terminal resource.
      // Drive its underlying source to native done to retain late I/O errors.
      while (!exhausted) {
        const item = await cursor.next();
        if (item.done) break;
        if (!item.value.ok) {
          failure = item.value.error;
          producer.discard(source);
          break;
        }
      }
      if (failure !== undefined) {
        const error = failure.kind === 'protocol' && projected !== undefined
          ? { ...failure, event: { ...failure.event, ...projected } }
          : failure;
        yield { ok: false, error };
      }
    });
    return { ...answer, openaiResponses: { kind: 'stream', stream } };
  },
});
