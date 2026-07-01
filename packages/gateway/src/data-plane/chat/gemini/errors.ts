import { appendFailedUpstreams } from '../../shared/failed-upstreams.ts';
import type { ChatServeFailure } from '../shared/errors.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import type { ExecuteResult } from '@floway-dev/provider';
import type { TranslatorInputError } from '@floway-dev/translate';

// Google RPC Status envelope, used by Gemini's `error` channel everywhere
// (HTTP body, SSE-tunnelled error event).
export const geminiStatusForHttpStatus = (status: number): string => {
  switch (status) {
  case 400:
    return 'INVALID_ARGUMENT';
  case 401:
    return 'UNAUTHENTICATED';
  case 403:
    return 'PERMISSION_DENIED';
  case 404:
    return 'NOT_FOUND';
  case 429:
    return 'RESOURCE_EXHAUSTED';
  case 500:
    return 'INTERNAL';
  case 502:
  case 503:
    return 'UNAVAILABLE';
  default:
    return 'INTERNAL';
  }
};

const geminiRpcErrorResult = (status: number, message: string): ExecuteResult<ProtocolFrame<GeminiStreamEvent>> => ({
  type: 'api-error',
  source: 'gateway',
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: new TextEncoder().encode(JSON.stringify({
    error: { code: status, message, status: geminiStatusForHttpStatus(status) },
  })),
});

// Translator surfaced a caller-input violation (unsupported content part,
// disallowed role, missing required field, etc.). Render as a 400
// INVALID_ARGUMENT envelope so the caller sees a Gemini-shaped failure
// instead of the internal-error 500 envelope.
export const translatorInputErrorResult = (
  error: TranslatorInputError,
): ExecuteResult<ProtocolFrame<GeminiStreamEvent>> =>
  geminiRpcErrorResult(400, error.message);

// `endpoint` selects between `:generateContent` and `:countTokens` only in
// the `model-unsupported` message string.
export const renderGeminiFailure = (
  failure: ChatServeFailure,
  endpoint: 'generate' | 'countTokens',
): ExecuteResult<ProtocolFrame<GeminiStreamEvent>> => {
  switch (failure.kind) {
  case 'item-not-found':
    return geminiRpcErrorResult(404, `Item with id '${failure.itemId}' not found.`);
  case 'routing-unavailable':
    return geminiRpcErrorResult(400, failure.message);
  case 'model-missing':
    return geminiRpcErrorResult(404, appendFailedUpstreams(`Model ${failure.model} is not available on any configured upstream.`, failure.failedUpstreams));
  case 'model-unsupported':
    return geminiRpcErrorResult(400, appendFailedUpstreams(`Model ${failure.model} does not support ${endpoint === 'countTokens' ? 'countTokens' : 'the Gemini generateContent endpoint'}.`, failure.failedUpstreams));
  }
};
