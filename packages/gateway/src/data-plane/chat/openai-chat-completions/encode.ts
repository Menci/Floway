import type { OpenAIChatCompletionsDelivery } from './parse.ts';
import { encode, jsonResponse, localResponseHead } from '../../pipeline/encode.ts';
import { openaiInternalErrorPayload } from '../../shared/openai-errors.ts';
import type { ChatCollectionFailure, ChatCollector } from '../shared/collect.ts';
import { chatSse } from '../shared/encode.ts';
import { eventFrame, sseFrame } from '@floway-dev/protocols/common';
import { createOpenAIChatCompletionsEventAccumulator, openaiChatCompletionsProtocolFrameToSSEFrame } from '@floway-dev/protocols/openai-chat-completions';
import { toInternalDebugError, type ProtocolStreamError } from '@floway-dev/provider';

export const collectOpenAIChatCompletionsStreamError = (error: ProtocolStreamError): ChatCollectionFailure => ({
  kind: 'error',
  source: error.kind === 'abort' ? 'local' : 'upstream',
  status: error.kind === 'abort' ? 499 : 502,
  error: error.kind === 'protocol' && error.event !== undefined
    ? error.event
    : openaiInternalErrorPayload(toInternalDebugError(error.cause)),
});

export const collectOpenAIChatCompletions = (): ChatCollector<'openaiChatCompletions'> => {
  const accumulator = createOpenAIChatCompletionsEventAccumulator();
  return {
    push: accumulator.accept,
    finish: () => ({ kind: 'result', result: accumulator.result() }),
  };
};

export const encodeOpenAIChatCompletions = encode<'openaiChatCompletions', OpenAIChatCompletionsDelivery>('openaiChatCompletions', ({ delivery, outcome, http }, scope) => {
  if (outcome.kind === 'error') return jsonResponse(http ?? localResponseHead(outcome.source === 'upstream' ? 502 : 499), outcome.error);
  if (http === null) throw new Error('OpenAI Chat Completions success requires an HTTP response');
  if (outcome.kind === 'result') return jsonResponse(http, outcome.result);
  return chatSse(http, outcome.stream, scope, {
    event: event => openaiChatCompletionsProtocolFrameToSSEFrame(eventFrame(event), { includeUsageChunk: delivery.includeUsageChunk }),
    error: error => sseFrame(JSON.stringify(error.kind === 'protocol' && error.event !== undefined
      ? error.event
      : openaiInternalErrorPayload(toInternalDebugError(error.cause)))),
    done: sseFrame('[DONE]'),
  });
}, 'request.delivery');
