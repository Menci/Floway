import type { ChatPipelineServices, OpenAIChatCompletionsAttemptInput } from '../../pipeline/index.ts';
import { defineRequestStage } from '@floway-dev/pipeline';
import type { ChatTargetApi } from '@floway-dev/provider';

interface TargetPicker {
  readonly pick: (endpoints: OpenAIChatCompletionsAttemptInput['route.candidate']['endpoints']) => ChatTargetApi;
}

interface PreparedFacts extends OpenAIChatCompletionsAttemptInput {
  readonly 'route.targetApi': ChatTargetApi;
}

// OpenAI only emits its usage-only chunk when `stream_options.include_usage`
// is enabled. The gateway needs that chunk for both metering and non-streaming
// reassembly, while the HTTP entry retains the client's original visibility
// preference for SSE rendering.
// https://platform.openai.com/docs/api-reference/chat/create
export const createIncludeUsageStreamOptionsStage = (targetPicker: TargetPicker) => defineRequestStage<
  OpenAIChatCompletionsAttemptInput,
  Pick<PreparedFacts, 'request.payload' | 'route.targetApi'>,
  never,
  ChatPipelineServices
>({
  name: 'includeUsageStreamOptions',
  provides: ['request.payload', 'route.targetApi'],
  execute: async (facts, next) => {
    const candidate = facts['route.candidate'];
    const payload = {
      ...facts['request.payload'],
      model: candidate.modelId,
      stream_options: {
        ...facts['request.payload'].stream_options,
        include_usage: true,
      },
    };
    return await next({
      'request.payload': payload,
      'route.targetApi': targetPicker.pick(candidate.endpoints),
    });
  },
});
