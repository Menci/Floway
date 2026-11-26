import { wrapOpenAIResponsesAffinityEgress } from './egress.ts';
import { defineStage } from '../../../pipeline/facts.ts';
import { affinityIdentityForCandidate } from '../../shared/affinity/context.ts';
import { openAIResponsesFailureEvents, openAIResponsesProtocolError } from '../stream-error.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ProtocolStreamError } from '@floway-dev/provider';

export const openAIResponsesAffinityOutput = defineStage({
  name: 'openaiResponses.affinity-output',
  through: {
    request: { needs: ['provider.model', 'provider.upstream', 'request.aliasRules?'], provides: [], consumes: [] },
    response: { needs: ['response.openaiResponses'], provides: ['response.openaiResponses'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const outcome = answer['response.openaiResponses'];
    if (outcome.kind !== 'stream') return answer;

    const rules = facts['request.aliasRules'];
    const affinity = affinityIdentityForCandidate({
      model: facts['provider.model'],
      upstream: facts['provider.upstream'],
      ...(rules === undefined ? {} : { rules }),
    });
    const stream = scope.wrapStream(outcome.stream, async function* (inner, producer) {
      const cursor = producer.read(inner);
      let exhausted = false;
      let failure: ProtocolStreamError | undefined;
      let projected: ReturnType<typeof openAIResponsesFailureEvents> | undefined;
      const pending: OpenAIResponsesStreamEventEx[] = [];

      const frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> = {
        [Symbol.asyncIterator]: () => ({
          async next() {
            const queued = pending.shift();
            if (queued !== undefined) return { done: false, value: eventFrame(queued) };
            if (exhausted) return { done: true, value: undefined };
            const item = await cursor.next();
            if (item.done) {
              exhausted = true;
              return item;
            }
            if (item.value.ok) return { done: false, value: eventFrame(item.value.value) };

            failure = item.value.error;
            exhausted = true;
            producer.discard(inner);
            const { notification, failed } = openAIResponsesFailureEvents(failure);
            if (notification && failed) pending.push(failed);
            const event = notification ?? failed;
            return event === undefined ? { done: true, value: undefined } : { done: false, value: eventFrame(event) };
          },
        }),
      };

      for await (const frame of wrapOpenAIResponsesAffinityEgress(frames, { affinity, codec: producer.services.affinity })) {
        if (frame.type !== 'event') continue;
        if (failure === undefined) {
          yield { ok: true, value: frame.event };
        } else if (frame.event.type === 'error') {
          projected = { ...projected, notification: frame.event };
        } else if (frame.event.type === 'response.failed') {
          projected = { ...projected, failed: frame.event };
        }
      }

      // The protocol frame projector stops at the terminal resource. The HTTP
      // decoder still owns the body and can observe a later transport failure.
      while (!exhausted) {
        const tail = await cursor.next();
        if (tail.done) break;
        if (!tail.value.ok) {
          failure = tail.value.error;
          producer.discard(inner);
          break;
        }
      }
      if (failure !== undefined) {
        yield { ok: false, error: projected === undefined ? failure : openAIResponsesProtocolError(failure.cause, projected) };
      }
    });
    return { ...answer, 'response.openaiResponses': { kind: 'stream', stream } };
  },
});
