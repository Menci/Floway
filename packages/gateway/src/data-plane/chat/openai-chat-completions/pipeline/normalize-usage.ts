import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { move, transform } from '@floway-dev/pipeline';

const { defineStage } = gatewayFactSpace<{}>();
const key = 'response.openaiChatCompletions';

// Some upstreams attach usage to the final choice. OpenAI defines a separate
// chunk with an empty choices array for usage, which clients can opt into.
// https://platform.openai.com/docs/api-reference/chat-streaming
export const normalizeUsage = defineStage({
  name: 'openaiChatCompletions.normalize-usage',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: [key], provides: [key], consumes: [] },
  },
  execute: transform(scope => ({
    response: facts => {
      const outcome = facts[key];
      if (outcome.kind !== 'stream') return facts;
      const stream = scope.wrapStream(outcome.stream, async function* (items) {
        for await (const item of items) {
          if (!item.ok || item.value.usage == null || item.value.choices.length === 0) {
            yield item;
            continue;
          }
          const { usage, ...chunk } = item.value;
          yield { ok: true, value: chunk };
          yield { ok: true, value: { ...chunk, choices: [], usage } };
        }
      });
      return { ...facts, [key]: move({ kind: 'stream', stream } as const) };
    },
  })),
});
