import { rewritePayload } from '../shared/rewrite-request.ts';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';

// Qwen uses enable_thinking to disable reasoning.
// https://www.alibabacloud.com/help/en/model-studio/deep-thinking
export const normalizeQwen = rewritePayload.openaiChatCompletions('normalizeQwen', (payload, model) => {
  if (!model.enabledFlags.includes('vendor-qwen') || payload.reasoning_effort !== 'none') return payload;
  const { reasoning_effort: _effort, ...rest } = payload;
  return { ...rest, enable_thinking: false } as OpenAIChatCompletionsPayloadEx;
});
