import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

export type MessagePayload = Omit<AnthropicMessagesPayload, 'model'>;
