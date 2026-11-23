import { rewriteChatRequest } from '../../shared/rewrite-stage.ts';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';

export const normalizeEmptyToolsToolChoice = rewriteChatRequest(
  'normalizeEmptyToolsToolChoice', 'request.openaiChatCompletions',
  (payload: OpenAIChatCompletionsPayloadEx, { providerModel }) =>
    providerModel.enabledFlags.includes('empty-tools-tool-choice-none') && Array.isArray(payload.tools) && payload.tools.length === 0
      ? { ...payload, tool_choice: 'none' }
      : payload,
);
