import { anthropicMessagesInternalErrorPayload } from './errors.ts';
import type { AnthropicMessagesDelivery } from './parse.ts';
import { encode, jsonResponse, localResponseHead } from '../../pipeline/encode.ts';
import type { ChatCollectionFailure, ChatCollector } from '../shared/collect.ts';
import { chatSse } from '../shared/encode.ts';
import { anthropicMessagesProtocolFrameToSSEFrame, createAnthropicMessagesEventAccumulator } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, sseFrame } from '@floway-dev/protocols/common';
import { toInternalDebugError, type ProtocolStreamError } from '@floway-dev/provider';

export const collectAnthropicMessagesStreamError = (error: ProtocolStreamError): ChatCollectionFailure => ({
  kind: 'error',
  source: error.kind === 'abort' ? 'local' : 'upstream',
  status: error.kind === 'abort' ? 499 : 502,
  error: error.kind === 'protocol' && error.event !== undefined
    ? error.event
    : anthropicMessagesInternalErrorPayload(toInternalDebugError(error.cause)),
});

export const collectAnthropicMessages = (): ChatCollector<'anthropicMessages'> => {
  const accumulator = createAnthropicMessagesEventAccumulator();
  let started = false;
  return {
    push(event) {
      if (event.type === 'message_start') started = true;
      if (event.type === 'message_delta' && !started) {
        return collectAnthropicMessagesStreamError({ kind: 'protocol', cause: new Error('Messages message_delta arrived before message_start') });
      }
      accumulator.accept(event);
    },
    finish() {
      if (!started) return collectAnthropicMessagesStreamError({ kind: 'protocol', cause: new Error('Messages stream ended without message_start') });
      return { kind: 'result', result: accumulator.result() };
    },
  };
};

export const encodeAnthropicMessages = encode<'anthropicMessages', AnthropicMessagesDelivery>('anthropicMessages', ({ outcome, http }, scope) => {
  if (outcome.kind === 'error') return jsonResponse(http ?? localResponseHead(outcome.source === 'upstream' ? 502 : 499), outcome.error);
  if (http === null) throw new Error('Anthropic Messages success requires an HTTP response');
  if (outcome.kind === 'result') return jsonResponse(http, outcome.result);
  return chatSse(http, outcome.stream, scope, {
    event: event => anthropicMessagesProtocolFrameToSSEFrame(eventFrame(event)),
    error(error) {
      if (error.kind === 'protocol' && error.event !== undefined) return sseFrame(JSON.stringify(error.event), 'error');
      const payload = anthropicMessagesInternalErrorPayload(toInternalDebugError(error.cause));
      return sseFrame(JSON.stringify({ ...payload, error: { ...payload.error, type: 'api_error' } }), 'error');
    },
    keepAlive: sseFrame(JSON.stringify({ type: 'ping' }), 'ping'),
  });
}, 'request.delivery');
