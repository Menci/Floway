import { responsesPayloadStage } from './facts.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

// https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
export const vendorDeepSeekNormalize = responsesPayloadStage('vendorDeepSeekNormalize', (payload, facts) => {
  if (!facts['route.candidate'].providerModel.enabledFlags.includes('vendor-deepseek') || payload.reasoning?.effort !== 'none') return payload;
  const { reasoning: _stripped, ...rest } = payload;
  const disabled: CanonicalOpenAIResponsesPayload & { thinking: { type: 'disabled' } } = { ...rest, thinking: { type: 'disabled' } };
  return disabled;
});
