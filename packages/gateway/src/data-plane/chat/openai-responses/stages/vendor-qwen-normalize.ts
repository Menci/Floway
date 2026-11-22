import type { OpenAIResponsesStageFacts, OpenAIResponsesStageOutcome } from './facts.ts';
import type { ChatPipelineServices } from '../../pipeline/index.ts';
import { defineStage } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { hasEnabledFlag } from '@floway-dev/provider';

// Qwen represents disabled reasoning with `enable_thinking: false`.
// https://www.alibabacloud.com/help/en/model-studio/deep-thinking
export const vendorQwenNormalize = defineStage<
  OpenAIResponsesStageFacts,
  Pick<OpenAIResponsesStageFacts, 'request.payload'>,
  OpenAIResponsesStageOutcome,
  OpenAIResponsesStageOutcome,
  never,
  ChatPipelineServices
>({
  name: 'vendorQwenNormalize',
  provides: ['request.payload'],
  execute: async (facts, next) => {
    const payload = facts['request.payload'];
    if (!hasEnabledFlag(facts['route.candidate'].providerModel, 'vendor-qwen') || payload.reasoning?.effort !== 'none') {
      return await next({ 'request.payload': payload });
    }
    const { reasoning: _stripped, ...rest } = payload;
    return await next({
      'request.payload': { ...rest, enable_thinking: false } as CanonicalOpenAIResponsesPayload,
    });
  },
});
