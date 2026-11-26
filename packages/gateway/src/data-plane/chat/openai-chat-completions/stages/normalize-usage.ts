import { asJsonObject } from '../../../../shared/json-helpers.ts';
import { defineStage } from '../../../pipeline/facts.ts';

// Spec-compliant OpenAI Chat Completions usage chunk shape. The OpenAI spec puts the
// final `usage` on a `choices: []` carrier chunk
// (https://platform.openai.com/docs/api-reference/chat-streaming). Some
// upstreams have been observed to attach `usage` to the same chunk that
// carries the final delta and `finish_reason`. We strip `usage` from such a
// chunk and re-emit it on a synthesized spec-compliant carrier chunk
// immediately after, so downstream consumers can rely on the standard shape.
//
// Provider normalization stages already map vendor cache fields to
// `usage.prompt_tokens_details.cached_tokens` on the response path.

export const normalizeUsage = defineStage({
  name: 'openaiChatCompletions.normalize-usage',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['response.openaiChatCompletions'], provides: ['response.openaiChatCompletions'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const outcome = answer['response.openaiChatCompletions'];
    if (outcome.kind !== 'stream') return answer;
    const stream = scope.wrapStream(outcome.stream, async function* (inner, producer) {
      for await (const item of producer.read(inner)) {
        if (!item.ok) {
          producer.discard(inner);
          yield item;
          return;
        }
        const chunk = item.value;
        const { usage, ...withoutUsage } = chunk;
        if (usage == null || !asJsonObject(usage) || chunk.choices.length === 0) {
          yield item;
          continue;
        }
        yield { ok: true, value: withoutUsage };
        yield { ok: true, value: { ...withoutUsage, choices: [], usage } };
      }
    });
    return { ...answer, 'response.openaiChatCompletions': { kind: 'stream', stream } };
  },
});
