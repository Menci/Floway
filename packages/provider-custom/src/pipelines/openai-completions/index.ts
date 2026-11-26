import { customOperationPath } from '../../endpoint.ts';
import { customOperation, jsonBody, openAIError } from '../dial.ts';
import { decodeOpenAICompletionsResult, decodeOpenAICompletionsStream } from '@floway-dev/protocols/openai-completions';
import { parseHttpResponse, parseJsonBody } from '@floway-dev/provider';

export const openaiCompletions = customOperation('openaiCompletions', {
  parse: parseHttpResponse('openaiCompletions', {
    select: payload => payload.stream === true ? 'stream' : 'result',
    stream: decodeOpenAICompletionsStream,
    result(bytes) {
      const parsed = parseJsonBody(bytes);
      return parsed.ok ? decodeOpenAICompletionsResult(parsed.value) : parsed;
    },
    format: openAIError,
  }),
  prepare: (payload, modelId, config) => ({
    path: customOperationPath(config, '/completions'),
    ...jsonBody({ ...payload, model: modelId }),
  }),
});
