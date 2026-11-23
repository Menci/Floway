import { rewriteChatRequest } from '../../shared/rewrite-stage.ts';
import type { OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsMessage, OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsReasoningItemEx } from '@floway-dev/protocols/openai-chat-completions';

// DeepSeek replays thinking as reasoning_content and requires that field for tool-call loops.
// https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
const replayDeepSeekThinking = (message: OpenAIChatCompletionsMessage): OpenAIChatCompletionsMessage => {
  if (message.role !== 'assistant') return message;
  const { reasoning_text: reasoningText, reasoning_opaque: _opaque, reasoning_items: reasoningItems, ...rest } = message as OpenAIChatCompletionsAssistantMessageEx;
  const items = reasoningItems as OpenAIChatCompletionsReasoningItemEx[] | null | undefined;
  const summary = items?.flatMap(item => item.summary?.map(part => part.text) ?? []) ?? [];
  const text = typeof reasoningText === 'string' ? reasoningText : summary.length === 0 ? undefined : summary.join('');
  return text === undefined ? rest : { ...rest, reasoning_content: text } as OpenAIChatCompletionsAssistantMessageEx;
};

// DeepSeek disables thinking with thinking.type and accepts only json_object for structured output.
// https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
// https://api-docs.deepseek.com/guides/json_mode
const deepSeekRequest = (payload: OpenAIChatCompletionsPayloadEx): OpenAIChatCompletionsPayloadEx => {
  let wire = payload;
  if (payload.reasoning_effort === 'none') {
    const { reasoning_effort: _removed, ...rest } = payload;
    wire = { ...rest, thinking: { type: 'disabled' } } as OpenAIChatCompletionsPayloadEx;
  }
  if (wire.response_format?.type === 'json_schema') wire = { ...wire, response_format: { type: 'json_object' } };
  return { ...wire, messages: wire.messages.map(replayDeepSeekThinking) };
};

export const normalizeDeepSeekRequest = rewriteChatRequest(
  'normalizeDeepSeekRequest', 'request.openaiChatCompletions', (payload: OpenAIChatCompletionsPayloadEx, { providerModel }) =>
    providerModel.enabledFlags.includes('vendor-deepseek') ? deepSeekRequest(payload) : payload,
);
