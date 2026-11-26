import { defineStage } from '../../../pipeline/facts.ts';

// Upstream usage is required for metering. The encoder reads the caller's
// original preference from request.delivery.
// https://platform.openai.com/docs/api-reference/chat/create
export const includeUsageStreamOptions = defineStage({
  name: 'openaiChatCompletions.include-usage-stream-options',
  through: {
    request: { needs: ['request.openaiChatCompletions'], provides: ['request.openaiChatCompletions'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts['request.openaiChatCompletions'];
    return await scope.next({
      ...facts,
      'request.openaiChatCompletions': { ...payload, stream_options: { ...payload.stream_options, include_usage: true } },
    });
  },
});
