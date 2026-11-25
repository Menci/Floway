import { encodeResponse, renderJsonResult } from '../../../pipeline/encode-response.ts';
import { jsonResponseBody, responseHead } from '../../../pipeline/response.ts';
import { encodeProtocolSse } from '../../../shared/encode-protocol-sse.ts';
import { collectChatOutcome } from '../../pipeline/collect.ts';
import { ANTHROPIC_MESSAGES_MISSING_TERMINAL_MESSAGE, anthropicMessagesProtocolFrameToSSEFrame, collectAnthropicMessagesProtocolEventsToResult } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, sseFrame } from '@floway-dev/protocols/common';
import { internalDebugErrorFields, toInternalDebugError } from '@floway-dev/provider';

const responseKey = 'response.anthropicMessages';

export const encodeAnthropicMessages = encodeResponse(responseKey, async (outcome, http, delivery, scope) => {
  if (delivery.kind !== 'anthropicMessages') throw new TypeError('Expected Anthropic Messages delivery');
  if (outcome.kind !== 'stream') throw new TypeError('Expected Anthropic Messages generation stream');
  if (delivery.stream) {
    return encodeProtocolSse(http, outcome.stream, scope, event => anthropicMessagesProtocolFrameToSSEFrame(eventFrame(event)), undefined, {
      keepAlive: sseFrame(JSON.stringify({ type: 'ping' }), 'ping'),
      errorFrame: ({ cause }) => sseFrame(JSON.stringify(internalErrorBody(cause, true)), 'error'),
      terminal: event => event.type === 'message_stop' || event.type === 'error',
      eof: () => ({ kind: 'protocol', cause: new Error(ANTHROPIC_MESSAGES_MISSING_TERMINAL_MESSAGE) }),
    });
  }

  const result = await collectChatOutcome(outcome.stream, scope, collectAnthropicMessagesProtocolEventsToResult, (_message, cause) => internalErrorBody(cause));
  return result.kind === 'result' ? renderJsonResult(result, http) : jsonResponseBody(responseHead(502), result.error);
});

export const encodeAnthropicMessagesCountTokens = encodeResponse(responseKey, (outcome, http, delivery) => {
  if (delivery.kind !== 'json') throw new TypeError('Expected JSON delivery for Anthropic Messages count_tokens');
  if (outcome.kind !== 'result') throw new TypeError('Expected Anthropic Messages count_tokens result');
  return outcome.result === null ? http : renderJsonResult(outcome, http);
});

const internalErrorBody = (cause: unknown, stream = false) => {
  const error = toInternalDebugError(cause);
  return {
    type: 'error',
    error: { type: stream ? 'api_error' : error.type, message: error.message, provider_specific_fields: internalDebugErrorFields(error) },
  };
};
