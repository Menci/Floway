import { asJsonObject } from '../../../../shared/json-helpers.ts';
import { defineStage } from '../../pipeline/facts.ts';

// https://platform.openai.com/docs/api-reference/chat-streaming
export const normalizeOpenAIChatCompletionsUsageChunks = defineStage({
  name: 'openaiChatCompletions.normalize-usage',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['openaiChatCompletions'], provides: ['openaiChatCompletions'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const outcome = answer.openaiChatCompletions;
    if (outcome.kind !== 'stream') return answer;
    const stream = scope.wrapStream(outcome.stream, async function* (source, producer) {
      for await (const item of producer.read(source)) {
        if (!item.ok) {
          producer.discard(source);
          yield item;
          return;
        }
        const { usage, ...chunk } = item.value;
        if (!asJsonObject(usage) || chunk.choices.length === 0 || usage == null) {
          yield item;
          continue;
        }
        yield { ok: true, value: chunk };
        yield { ok: true, value: { ...chunk, choices: [], usage } };
      }
    });
    return { ...answer, openaiChatCompletions: { kind: 'stream', stream } };
  },
});
