import { gatewayErrorStatus, geminiGenerateContentInternalErrorPayload, googleRpcHttpStatusCode, isGeminiGenerateContentErrorResponse } from './errors.ts';
import type { GeminiGenerateContentDelivery } from './parse.ts';
import { encode, jsonResponse, localResponseHead } from '../../pipeline/encode.ts';
import type { ChatCollectionFailure, ChatCollector } from '../shared/collect.ts';
import { chatSse } from '../shared/encode.ts';
import { eventFrame, sseRawFrame } from '@floway-dev/protocols/common';
import { createGeminiGenerateContentEventAccumulator, geminiGenerateContentProtocolFrameToSSEFrame } from '@floway-dev/protocols/gemini-generate-content';
import { toInternalDebugError, type ProtocolStreamError } from '@floway-dev/provider';

export const collectGeminiGenerateContentStreamError = (error: ProtocolStreamError): ChatCollectionFailure => {
  const event = error.kind === 'protocol' ? error.event : undefined;
  const rpc = isGeminiGenerateContentErrorResponse(event);
  const status = rpc ? googleRpcHttpStatusCode(event.error.code) : error.kind === 'abort' ? 499 : 502;
  return {
    kind: 'error',
    source: error.kind === 'abort' ? 'local' : 'upstream',
    status,
    error: rpc ? event : geminiGenerateContentInternalErrorPayload(status, toInternalDebugError(error.cause)),
  };
};

export const collectGeminiGenerateContent = (): ChatCollector<'geminiGenerateContent'> => {
  const accumulator = createGeminiGenerateContentEventAccumulator();
  return {
    push: accumulator.accept,
    finish: () => ({ kind: 'result', result: accumulator.result() }),
  };
};

export const encodeGeminiGenerateContent = encode<'geminiGenerateContent', GeminiGenerateContentDelivery>('geminiGenerateContent', ({ outcome, http }, scope) => {
  if (outcome.kind === 'error') {
    const head = http ?? localResponseHead(outcome.source === 'upstream' ? 502 : 499);
    const status = outcome.source === 'local' ? head.status
      : isGeminiGenerateContentErrorResponse(outcome.error) ? googleRpcHttpStatusCode(outcome.error.error.code)
        : gatewayErrorStatus(head.status) === 'INTERNAL' ? 500 : head.status;
    return jsonResponse(status === head.status ? head : { ...head, status, statusText: '' }, outcome.error);
  }
  if (http === null) throw new Error('Gemini generateContent success requires an HTTP response');
  if (outcome.kind === 'result') return jsonResponse(http, outcome.result);
  return chatSse(http, outcome.stream, scope, {
    event: event => geminiGenerateContentProtocolFrameToSSEFrame(eventFrame(event)),
    error: error => (error.kind === 'protocol' && error.event !== undefined
      ? sseRawFrame(JSON.stringify(error.event))
      : sseRawFrame(JSON.stringify(geminiGenerateContentInternalErrorPayload(500, toInternalDebugError(error.cause))))),
  });
}, 'request.delivery');
