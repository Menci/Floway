import { encode, encodedResponse, encodeStream, jsonResponse, localResponseHead } from '../pipeline/encode.ts';
import { openaiInternalErrorPayload } from '../shared/openai-errors.ts';
import { serializeSseFrame } from '../shared/sse.ts';
import { isJsonObject, isOpenAIUsageOnlyEventShape, sseFrame } from '@floway-dev/protocols/common';
import { toInternalDebugError } from '@floway-dev/provider';

const encoder = new TextEncoder();
const frame = (data: string): Uint8Array => encoder.encode(serializeSseFrame(sseFrame(data)));

export const encodeOpenAICompletions = encode('openaiCompletions', ({ http, outcome, request }, scope) => {
  if (outcome.kind === 'error') {
    return jsonResponse(http ?? localResponseHead(outcome.source === 'upstream' ? 502 : 499), outcome.error);
  }
  if (http === null) throw new Error('OpenAI Completions success requires an HTTP response');
  if (outcome.kind === 'result') return jsonResponse(http, outcome.result);

  const { stream_options: options } = request;
  const includeUsage = isJsonObject(options) && options.include_usage === true;
  const body = encodeStream(outcome.stream, scope, item => {
    if (!item.ok) {
      if (item.error.kind === 'abort') return [];
      const error = item.error.kind === 'protocol' && item.error.event !== undefined
        ? item.error.event
        : openaiInternalErrorPayload(toInternalDebugError(item.error.cause));
      return [frame(JSON.stringify(error))];
    }
    if (!includeUsage && isOpenAIUsageOnlyEventShape(item.value)) return [];
    return [frame(JSON.stringify(item.value))];
  }, () => [frame('[DONE]')]);
  return encodedResponse(http, body, 'text/event-stream');
}, 'request');
