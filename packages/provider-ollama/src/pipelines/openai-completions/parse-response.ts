import { formatOpenAIError } from '../errors.ts';
import { decodeOpenAICompletionsResult, decodeOpenAICompletionsStream } from '@floway-dev/protocols/openai-completions';
import { parseHttpResponse, parseJsonBody } from '@floway-dev/provider';

export const parseResponse = parseHttpResponse('openaiCompletions', {
  select: body => body.stream === true ? 'stream' : 'result',
  stream: decodeOpenAICompletionsStream,
  result: bytes => {
    const parsed = parseJsonBody(bytes);
    return parsed.ok ? decodeOpenAICompletionsResult(parsed.value) : parsed;
  },
  format: formatOpenAIError,
});
