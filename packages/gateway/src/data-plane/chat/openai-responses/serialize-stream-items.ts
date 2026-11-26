import { defineStage } from '../../pipeline/facts.ts';
import { serializeOpenAIResponsesStream, shouldSerializeStreamItems } from '../shared/stream-compatibility/index.ts';
import { getHeader } from '@floway-dev/http';

export const serializeOpenAIResponsesClientStream = defineStage({
  name: 'openaiResponses.serialize-stream-items',
  through: {
    request: { needs: ['request.http', 'provider.model'], provides: [], consumes: [] },
    response: { needs: ['response.openaiResponses'], provides: ['response.openaiResponses'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const outcome = answer['response.openaiResponses'];
    if (outcome.kind !== 'stream') return answer;

    const userAgent = getHeader(facts['request.http'].headers, 'user-agent');
    const enabled = shouldSerializeStreamItems(new Set(facts['provider.model'].enabledFlags), 'openaiResponses',
      typeof userAgent === 'string' ? userAgent : null);
    if (!enabled) return answer;

    const stream = scope.wrapStream(outcome.stream, async function* (inner, producer) {
      const cursor = producer.read(inner);
      let held = true;
      const frames = {
        [Symbol.asyncIterator]: () => ({
          async next() {
            const item = await cursor.next();
            if (item.done) held = false;
            return item;
          },
        }),
      };
      for await (const item of serializeOpenAIResponsesStream(frames, true)) {
        if (!item.ok && held) producer.discard(inner);
        yield item;
        if (!item.ok) return;
      }
    });
    return { ...answer, 'response.openaiResponses': { kind: 'stream', stream } };
  },
});
