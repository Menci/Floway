import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { move, transform } from '@floway-dev/pipeline';

const { defineStage } = gatewayFactSpace<{}>();
const key = 'request.openaiChatCompletions';

// Request usage for metering. Client delivery retains its own include_usage option.
// https://platform.openai.com/docs/api-reference/chat/create
export const includeUsageStreamOptions = defineStage({
  name: 'openaiChatCompletions.include-usage-stream-options',
  through: {
    request: { needs: [key], provides: [key], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => {
      const payload = facts[key];
      return { ...facts, [key]: move({ ...payload, stream_options: { ...payload.stream_options, include_usage: true } }) };
    },
  })),
});
