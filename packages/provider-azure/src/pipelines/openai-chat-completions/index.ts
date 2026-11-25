import { azureOpenAIUrl, azureOperation, jsonBody, openAIError } from '../dial.ts';
import { normalizeDeepSeek } from './vendor-deepseek-normalize.ts';
import { normalizeKimi } from './vendor-kimi-normalize.ts';
import { normalizeQwen } from './vendor-qwen-normalize.ts';
import { decodeOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { parseSseResponse } from '@floway-dev/provider';

export const openaiChatCompletions = azureOperation('openaiChatCompletions', {
  stages: [normalizeDeepSeek, normalizeQwen, normalizeKimi],
  parse: parseSseResponse('openaiChatCompletions', decodeOpenAIChatCompletionsStream, openAIError),
  prepare: (payload, model, endpoint) => ({
    url: azureOpenAIUrl(endpoint, '/chat/completions'),
    ...jsonBody({ ...payload, stream: true, model: model.upstreamModelId }),
  }),
});
