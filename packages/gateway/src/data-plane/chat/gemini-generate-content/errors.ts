import { appendFailedUpstreams } from '../../shared/failed-upstreams.ts';
import { inputErrorFields, type ChatServeFailure, type InputErrorDetails } from '../shared/errors.ts';
import type { GeminiGenerateContentErrorResponse } from '@floway-dev/protocols/gemini-generate-content';
import { internalDebugErrorFields, type ApiErrorResult, type PerformanceTelemetryContext, type InternalDebugError } from '@floway-dev/provider';

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

// ProtoJSON Any wraps a Struct's arbitrary JSON in value.
// https://protobuf.dev/programming-guides/json/#any
const geminiGenerateContentRpcErrorResult = (
  status: number,
  message: string,
  performance?: PerformanceTelemetryContext,
  extension?: Record<string, unknown>,
): ApiErrorResult => ({
  type: 'api-error',
  source: 'gateway',
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: new TextEncoder().encode(JSON.stringify({
    error: {
      code: status,
      message,
      status: geminiGenerateContentStatusForHttpStatus(status),
      ...(extension === undefined ? {} : { details: [{ '@type': 'type.googleapis.com/google.protobuf.Struct', value: extension }] }),
    },
  })),
  ...(performance ? { performance } : {}),
});

// Validation failures retain the telemetry of the candidate whose attempt rejected the request.
export const inputErrorResult = (
  error: InputErrorDetails,
  performance?: PerformanceTelemetryContext,
): ApiErrorResult =>
  geminiGenerateContentRpcErrorResult(400, error.message, performance, inputErrorFields(error));

// `endpoint` selects between `:generateContent` and `:countTokens` only in
// the `model-unsupported` message string.
export const renderGeminiGenerateContentFailure = (
  failure: ChatServeFailure,
  endpoint: 'generate' | 'countTokens',
): ApiErrorResult => {
  switch (failure.kind) {
  case 'routing-unavailable':
    return geminiGenerateContentRpcErrorResult(400, failure.message);
  case 'model-missing':
    return geminiGenerateContentRpcErrorResult(404, appendFailedUpstreams(`Model ${failure.model} is not available on any configured upstream.`, failure.failedUpstreams));
  case 'model-unsupported':
    return geminiGenerateContentRpcErrorResult(400, appendFailedUpstreams(`Model ${failure.model} does not support ${endpoint === 'countTokens' ? 'countTokens' : 'the Gemini generateContent endpoint'}.`, failure.failedUpstreams));
  }
};
