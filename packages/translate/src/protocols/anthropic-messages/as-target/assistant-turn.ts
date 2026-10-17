import type { IRJSONObject } from '../../../ir/types.ts';
import type { AnthropicMessagesAssistantContentBlock } from '@floway-dev/protocols/anthropic-messages';

export type AnthropicMessagesInputAssistantTurn = {
  role: 'assistant';
  content: (
    Exclude<AnthropicMessagesAssistantContentBlock, { type: 'tool_use' }>
    | (Extract<AnthropicMessagesAssistantContentBlock, { type: 'tool_use' }> & { input: IRJSONObject })
  )[];
};
