import { rewriteChatRequest } from '../../shared/rewrite-stage.ts';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';

// Upstream usage is required for metering and JSON collection. The encoder reads the client's preference from request.delivery.
// https://platform.openai.com/docs/api-reference/chat/create
export const includeUsageStreamOptions = rewriteChatRequest(
  'includeUsageStreamOptions', 'request.openaiChatCompletions', (payload: OpenAIChatCompletionsPayloadEx) => ({
    ...payload, stream_options: { ...payload.stream_options, include_usage: true },
  }),
);
