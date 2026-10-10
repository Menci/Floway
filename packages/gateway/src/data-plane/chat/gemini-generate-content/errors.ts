import { appendFailedUpstreams } from '../../shared/failed-upstreams.ts';
import type { ChatServeFailure } from '../shared/errors.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent, GeminiGenerateContentErrorResponse } from '@floway-dev/protocols/gemini-generate-content';
import { internalDebugErrorFields, type ExecuteResult, type PerformanceTelemetryContext, type InternalDebugError } from '@floway-dev/provider';
import type { TranslatorInputError } from '@floway-dev/translate';

// Google RPC Status envelope, used by Gemini's `error` channel everywhere
// (HTTP body, SSE-tunnelled error event).
export const geminiGenerateContentStatusForHttpStatus = (status: number): string => {
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

// ProtoJSON Any encodes the well-known Struct's arbitrary JSON under value.
// https://protobuf.dev/programming-guides/json/#any
// https://github.com/googleapis/googleapis/blob/e09e85d32ca349e1b205514a412817a7692595c6/google/rpc/error_details.proto#L97-L104
export const geminiGenerateContentInternalErrorPayload = (status: number, error: InternalDebugError): GeminiGenerateContentErrorResponse => {
  const { stack, ...fields } = internalDebugErrorFields(error);
  return {
    error: {
      code: status,
      message: error.message,
      status: geminiGenerateContentStatusForHttpStatus(status),
      details: [
        ...(stack === undefined ? [] : [{ '@type': 'type.googleapis.com/google.rpc.DebugInfo', stackEntries: stack.split('\n') }]),
        { '@type': 'type.googleapis.com/google.protobuf.Struct', value: { type: error.type, ...fields } },
      ],
    },
  };
};

const geminiGenerateContentRpcErrorResult = (status: number, message: string, performance?: PerformanceTelemetryContext): ExecuteResult<ProtocolFrame<GeminiGenerateContentStreamEvent>> => ({
  type: 'api-error',
  source: 'gateway',
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: new TextEncoder().encode(JSON.stringify({
    error: { code: status, message, status: geminiGenerateContentStatusForHttpStatus(status) },
  })),
  ...(performance ? { performance } : {}),
});

// Translator surfaced a caller-input violation (unsupported content part,
// disallowed role, missing required field, etc.). Render as a 400
// INVALID_ARGUMENT envelope so the caller sees a Gemini-generateContent-shaped failure
// instead of the internal-error 500 envelope. `performance` carries the
// throwing candidate's telemetry attribution when the throw fired
// mid-attempt (see AttemptState.telemetry).
export const translatorInputErrorResult = (
  error: TranslatorInputError,
  performance?: PerformanceTelemetryContext,
): ExecuteResult<ProtocolFrame<GeminiGenerateContentStreamEvent>> =>
  geminiGenerateContentRpcErrorResult(400, error.message, performance);

// `endpoint` selects between `:generateContent` and `:countTokens` only in
// the `model-unsupported` message string.
export const renderGeminiGenerateContentFailure = (
  failure: ChatServeFailure,
  endpoint: 'generate' | 'countTokens',
): ExecuteResult<ProtocolFrame<GeminiGenerateContentStreamEvent>> => {
  switch (failure.kind) {
  case 'routing-unavailable':
    return geminiGenerateContentRpcErrorResult(400, failure.message);
  case 'model-missing':
    return geminiGenerateContentRpcErrorResult(404, appendFailedUpstreams(`Model ${failure.model} is not available on any configured upstream.`, failure.failedUpstreams));
  case 'model-unsupported':
    return geminiGenerateContentRpcErrorResult(400, appendFailedUpstreams(`Model ${failure.model} does not support ${endpoint === 'countTokens' ? 'countTokens' : 'the Gemini generateContent endpoint'}.`, failure.failedUpstreams));
  }
};
