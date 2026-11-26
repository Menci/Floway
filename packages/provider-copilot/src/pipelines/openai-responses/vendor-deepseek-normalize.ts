import { rewritePayload } from '../shared/rewrite-payload.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

// DeepSeek uses a distinct thinking field to disable reasoning.
// https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
export const normalizeDeepSeek = rewritePayload('openaiResponses', 'normalizeDeepSeek', (payload, model) => {
  if (!model.enabledFlags.includes('vendor-deepseek') || payload.reasoning?.effort !== 'none') return payload;
  const { reasoning: _reasoning, ...rest } = payload;
  return { ...rest, thinking: { type: 'disabled' } } as CanonicalOpenAIResponsesPayload;
});
