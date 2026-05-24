import { chatCompletionsErrorPayloadMessage } from '@floway-dev/protocols/chat-completions';
import type { ChatCompletionChunk } from '@floway-dev/protocols/chat-completions';

export const CHAT_COMPLETIONS_MISSING_DONE_MESSAGE = 'Chat Completions stream ended without a DONE sentinel.';

export const isChatCompletionErrorEvent = (event: ChatCompletionChunk) => chatCompletionsErrorPayloadMessage(event) !== null;
