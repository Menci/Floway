import { rewriteChatRequest } from '../../shared/rewrite-stage.ts';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';

// https://www.alibabacloud.com/help/en/model-studio/deep-thinking
export const normalizeQwenRequest = rewriteChatRequest(
  'normalizeQwenRequest', 'request.openaiChatCompletions', (payload: OpenAIChatCompletionsPayloadEx, { providerModel }) => {
    if (!providerModel.enabledFlags.includes('vendor-qwen') || payload.reasoning_effort !== 'none') return payload;
    const { reasoning_effort: _stripped, ...rest } = payload;
    return { ...rest, enable_thinking: false } as OpenAIChatCompletionsPayloadEx;
  },
);
