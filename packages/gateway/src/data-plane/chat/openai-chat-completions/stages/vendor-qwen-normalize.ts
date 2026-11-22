// Qwen accepts the canonical request shape except that its disabled-reasoning
// spelling is top-level `enable_thinking: false`, not `reasoning_effort: 'none'`.
// Its response fields match the subset of OpenAI shapes read by the gateway.
// https://www.alibabacloud.com/help/en/model-studio/deep-thinking
import type { ChatAttemptOutcome, ChatPipelineServices, OpenAIChatCompletionsAttemptInput } from '../../pipeline/index.ts';
import { defineStage } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { hasEnabledFlag, type ChatTargetApi } from '@floway-dev/provider';

interface Facts extends OpenAIChatCompletionsAttemptInput {
  readonly 'route.targetApi': ChatTargetApi;
}

// The stage is always attached and flag-gated.
export const vendorQwenNormalize = defineStage<
  Facts,
  Pick<Facts, 'request.payload'>,
  ChatAttemptOutcome<OpenAIChatCompletionsStreamEvent>,
  ChatAttemptOutcome<OpenAIChatCompletionsStreamEvent>,
  never,
  ChatPipelineServices
>({
  name: 'vendorQwenNormalize',
  provides: ['request.payload'],
  execute: async (facts, next) => {
    const payload = facts['request.payload'];
    if (!hasEnabledFlag(facts['route.candidate'].providerModel, 'vendor-qwen')
      || payload.reasoning_effort !== 'none') {
      return await next({ 'request.payload': facts['request.payload'] });
    }
    const { reasoning_effort: _stripped, ...rest } = payload;
    return await next({ 'request.payload': { ...rest, enable_thinking: false } as OpenAIChatCompletionsPayloadEx });
  },
});
