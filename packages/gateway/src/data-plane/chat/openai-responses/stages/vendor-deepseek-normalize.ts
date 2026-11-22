import type { OpenAIResponsesStageFacts, OpenAIResponsesStageOutcome } from './facts.ts';
import type { ChatPipelineServices } from '../../pipeline/index.ts';
import { defineStage } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { hasEnabledFlag } from '@floway-dev/provider';

interface DeepSeekDisableField {
  thinking?: { type: 'disabled' };
}

type DeepSeekPayload = Omit<CanonicalOpenAIResponsesPayload, 'reasoning'> & DeepSeekDisableField;

const stripCanonicalReasoningSentinel = (payload: CanonicalOpenAIResponsesPayload): CanonicalOpenAIResponsesPayload => {
  if (payload.reasoning?.effort !== 'none') return payload;
  const { reasoning: _stripped, ...rest } = payload;
  return { ...rest, thinking: { type: 'disabled' } } as DeepSeekPayload as CanonicalOpenAIResponsesPayload;
};

// DeepSeek represents disabled reasoning with a top-level `thinking` object.
// https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
export const vendorDeepSeekNormalize = defineStage<
  OpenAIResponsesStageFacts,
  Pick<OpenAIResponsesStageFacts, 'request.payload'>,
  OpenAIResponsesStageOutcome,
  OpenAIResponsesStageOutcome,
  never,
  ChatPipelineServices
>({
  name: 'vendorDeepSeekNormalize',
  provides: ['request.payload'],
  execute: async (facts, next) => {
    if (!hasEnabledFlag(facts['route.candidate'].providerModel, 'vendor-deepseek')) {
      return await next({ 'request.payload': facts['request.payload'] });
    }
    const payload = stripCanonicalReasoningSentinel(facts['request.payload']);
    return await next({ 'request.payload': payload });
  },
});
