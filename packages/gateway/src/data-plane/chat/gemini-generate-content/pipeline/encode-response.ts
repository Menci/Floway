import { encodeResponse, renderJsonResult } from '../../../pipeline/encode-response.ts';
import { jsonResponseBody, responseHead } from '../../../pipeline/response.ts';
import { encodeProtocolSse } from '../../../shared/encode-protocol-sse.ts';
import { collectChatOutcome } from '../../pipeline/collect.ts';
import { geminiGenerateContentInternalErrorPayload, googleRpcHttpStatusCode, isGeminiGenerateContentErrorResponse } from '../errors.ts';
import { eventFrame, sseRawFrame } from '@floway-dev/protocols/common';
import { collectGeminiGenerateContentProtocolEventsToResult, createGeminiGenerateContentCandidateCompletion, geminiGenerateContentProtocolFrameToSSEFrame, GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE, isGeminiGenerateContentTerminalEvent } from '@floway-dev/protocols/gemini-generate-content';
import { toInternalDebugError } from '@floway-dev/provider';

const responseKey = 'response.geminiGenerateContent';

const protocolErrorBody = (status: number, cause: unknown) => {
  const body = cause instanceof Error ? cause.cause : cause;
  return isGeminiGenerateContentErrorResponse(body) ? body : geminiGenerateContentInternalErrorPayload(status, toInternalDebugError(cause));
};

export const encodeGeminiGenerateContent = encodeResponse(responseKey, async (outcome, http, delivery, scope) => {
  if (delivery.kind !== 'geminiGenerateContent') throw new TypeError('Expected Gemini generateContent delivery');
  if (outcome.kind !== 'stream') throw new TypeError('Expected Gemini generateContent generation stream');
  if (!delivery.stream) {
    const result = await collectChatOutcome(outcome.stream, scope, collectGeminiGenerateContentProtocolEventsToResult,
      (_message, cause) => protocolErrorBody(502, cause));
    return result.kind === 'result' ? renderJsonResult(result, http)
      : jsonResponseBody(responseHead(googleRpcHttpStatusCode(result.error.error.code)), result.error);
  }

  const completion = createGeminiGenerateContentCandidateCompletion();
  return encodeProtocolSse(http, outcome.stream, scope, event => {
    completion.observe(event);
    return geminiGenerateContentProtocolFrameToSSEFrame(eventFrame(event));
  }, undefined, {
    errorFrame: ({ cause }) => sseRawFrame(JSON.stringify(protocolErrorBody(500, cause))),
    terminal: isGeminiGenerateContentTerminalEvent,
    eof: () => completion.isComplete() ? undefined : { kind: 'protocol', cause: new Error(GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE) },
  });
});

export const encodeGeminiGenerateContentCountTokens = encodeResponse(responseKey, (outcome, http, delivery) => {
  if (delivery.kind !== 'json') throw new TypeError('Expected JSON delivery for Gemini countTokens');
  if (outcome.kind !== 'result') throw new TypeError('Expected Gemini countTokens result');
  return outcome.result === null ? http : renderJsonResult(outcome, http);
});
