import { fromDeepSeekChatCompletions, toDeepSeekChatCompletions } from './deepseek.ts';
import { fromKimiChatCompletions } from './kimi.ts';
import { toMistralChatCompletions } from './mistral.ts';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { FlagId } from '@floway-dev/upstream';

// https://www.alibabacloud.com/help/en/model-studio/deep-thinking
const toQwenChatCompletions = (payload: OpenAIChatCompletionsPayloadEx): OpenAIChatCompletionsPayloadEx => {
  if (payload.reasoning_effort !== 'none') return payload;
  const { reasoning_effort: _effort, ...rest } = payload;
  const wire = { ...rest, enable_thinking: false };
  return wire;
};

export const azureChatCompletionsWirePayload = (payload: OpenAIChatCompletionsPayloadEx, flags: readonly FlagId[]): object => {
  const deepseek = flags.includes('vendor-deepseek') ? toDeepSeekChatCompletions(payload) : payload;
  const qwen = flags.includes('vendor-qwen') ? toQwenChatCompletions(deepseek) : deepseek;
  return flags.includes('vendor-mistral') ? toMistralChatCompletions(qwen) : qwen;
};

type NormalizeEvent = (event: OpenAIChatCompletionsStreamEvent) => OpenAIChatCompletionsStreamEvent;

export const azureChatCompletionsEventNormalizer = (flags: readonly FlagId[]): NormalizeEvent | undefined => {
  const deepseek = flags.includes('vendor-deepseek');
  const kimi = flags.includes('vendor-kimi');
  if (deepseek && kimi) return event => fromDeepSeekChatCompletions(fromKimiChatCompletions(event));
  if (deepseek) return fromDeepSeekChatCompletions;
  if (kimi) return fromKimiChatCompletions;
  return undefined;
};
