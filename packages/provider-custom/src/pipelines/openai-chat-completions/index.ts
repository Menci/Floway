import { customOperationPath } from '../../endpoint.ts';
import { customOperation, jsonBody, openAIError } from '../dial.ts';
import { normalizeDeepSeek } from './vendor-deepseek-normalize.ts';
import { normalizeKimi } from './vendor-kimi-normalize.ts';
import { normalizeQwen } from './vendor-qwen-normalize.ts';
import { decodeOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { parseSseResponse } from '@floway-dev/provider';

export const openaiChatCompletions = customOperation('openaiChatCompletions', {
  stages: [normalizeDeepSeek, normalizeQwen, normalizeKimi],
  parse: parseSseResponse('openaiChatCompletions', decodeOpenAIChatCompletionsStream, openAIError),
  prepare: (payload, modelId, config) => ({
    path: customOperationPath(config, '/chat/completions'),
    ...jsonBody({ ...payload, stream: true, model: modelId }),
  }),
});
