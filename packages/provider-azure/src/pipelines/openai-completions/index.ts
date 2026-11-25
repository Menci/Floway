import { azureOpenAIUrl, azureOperation, jsonBody, openAIError } from '../dial.ts';
import { decodeOpenAICompletionsResult, decodeOpenAICompletionsStream } from '@floway-dev/protocols/openai-completions';
import { parseHttpResponse, parseJsonBody } from '@floway-dev/provider';

export const openaiCompletions = azureOperation('openaiCompletions', {
  parse: parseHttpResponse('openaiCompletions', {
    select: payload => payload.stream === true ? 'stream' : 'result',
    stream: decodeOpenAICompletionsStream,
    result(bytes) {
      const parsed = parseJsonBody(bytes);
      return parsed.ok ? decodeOpenAICompletionsResult(parsed.value) : parsed;
    },
    format: openAIError,
  }),
  prepare: (payload, model, endpoint) => ({
    url: azureOpenAIUrl(endpoint, '/completions'),
    ...jsonBody({ ...payload, model: model.upstreamModelId }),
  }),
});
