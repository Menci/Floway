import { defineStage } from '../../pipeline/facts.ts';
import { serializeAnthropicMessagesStream, shouldSerializeStreamItems } from '../shared/stream-compatibility/index.ts';
import { getHeader } from '@floway-dev/http';

export const serializeAnthropicMessagesItems = defineStage({
  name: 'anthropicMessages.serialize-stream-items',
  through: {
    request: { needs: ['request.http', 'provider.model'], provides: [], consumes: [] },
    response: { needs: ['response.anthropicMessages'], provides: ['response.anthropicMessages'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const outcome = answer['response.anthropicMessages'];
    if (outcome.kind !== 'stream') return answer;
    const userAgent = getHeader(facts['request.http'].headers, 'user-agent');
    const flags = new Set(facts['provider.model'].enabledFlags);
    if (!shouldSerializeStreamItems(flags, 'anthropicMessages', typeof userAgent === 'string' ? userAgent : null)) return answer;
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
      for await (const item of serializeAnthropicMessagesStream(frames, true)) {
        if (!item.ok && held) producer.discard(inner);
        yield item;
        if (!item.ok) return;
      }
    });
    return { ...answer, 'response.anthropicMessages': { kind: 'stream', stream } };
  },
});
