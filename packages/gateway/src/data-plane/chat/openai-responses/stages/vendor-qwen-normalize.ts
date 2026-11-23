import { responsesPayloadStage } from './facts.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

// https://www.alibabacloud.com/help/en/model-studio/deep-thinking
export const vendorQwenNormalize = responsesPayloadStage('vendorQwenNormalize', (payload, facts) => {
  if (!facts['route.candidate'].providerModel.enabledFlags.includes('vendor-qwen') || payload.reasoning?.effort !== 'none') return payload;
  const { reasoning: _stripped, ...rest } = payload;
  const disabled: CanonicalOpenAIResponsesPayload & { enable_thinking: false } = { ...rest, enable_thinking: false };
  return disabled;
});
