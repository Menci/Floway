import type { OpenAIChatCompletionsAssistantMessage, OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';

export type OpenAIChatCompletionsConversationMessage = OpenAIChatCompletionsMessage | OpenAIChatCompletionsAssistantMessageEx;
export type OpenAIChatCompletionsConversationTurn =
  | { role: 'assistant'; items: [OpenAIChatCompletionsAssistantMessage | OpenAIChatCompletionsAssistantMessageEx] }
  | { role: 'bare'; items: [Exclude<OpenAIChatCompletionsMessage, { role: 'assistant' }>] };

export const partitionOpenAIChatCompletionsTurns = (messages: readonly OpenAIChatCompletionsConversationMessage[]): OpenAIChatCompletionsConversationTurn[] => messages.map(message => message.role === 'assistant'
  ? { role: 'assistant', items: [message] }
  : { role: 'bare', items: [message] });
