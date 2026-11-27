import { defineStage } from '../../pipeline/facts.ts';

// https://platform.openai.com/docs/api-reference/chat/create
export const includeOpenAIChatCompletionsUsage = defineStage({
  name: 'openaiChatCompletions.include-usage-stream-options',
  through: {
    request: { needs: ['openaiChatCompletions'], provides: ['openaiChatCompletions'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.openaiChatCompletions;
    return await scope.next({
      ...facts,
      openaiChatCompletions: { ...payload, stream_options: { ...payload.stream_options, include_usage: true } },
    });
  },
});
