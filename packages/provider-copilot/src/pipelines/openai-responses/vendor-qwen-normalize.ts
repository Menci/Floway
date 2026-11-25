import { rewritePayload } from '../shared/rewrite-request.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

// Qwen uses enable_thinking to disable reasoning.
// https://www.alibabacloud.com/help/en/model-studio/deep-thinking
export const normalizeQwen = rewritePayload.openaiResponses('normalizeQwen', (payload, model) => {
  if (!model.enabledFlags.includes('vendor-qwen') || payload.reasoning?.effort !== 'none') return payload;
  const { reasoning: _reasoning, ...rest } = payload;
  return { ...rest, enable_thinking: false } as CanonicalOpenAIResponsesPayload;
});
