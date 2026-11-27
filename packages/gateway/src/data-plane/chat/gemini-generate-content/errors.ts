import { mergeForwardedUpstreamHeaders } from '../../shared/upstream-response.ts';
import { inputErrorFields, type ChatServeFailure, type InputErrorDetails } from '../shared/errors.ts';
import { geminiGenerateContentStatusForHttpStatus, type GeminiGenerateContentErrorResponse } from '@floway-dev/protocols/gemini-generate-content';
import { decodeResponseBody, internalDebugErrorFields, type ApiErrorResult, type PerformanceTelemetryContext, type InternalDebugError, type InternalErrorResult } from '@floway-dev/upstream';

// Google RPC Status envelope, used by Gemini's `error` channel everywhere
// (HTTP body, SSE-tunnelled error event).
export const gatewayErrorStatus = (status: number): string => {
  switch (status) {
  case 400:
  case 401:
  case 403:
  case 404:
  case 429:
  case 500:
  case 502:
  case 503:
    return geminiGenerateContentStatusForHttpStatus(status)!;
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
      status: gatewayErrorStatus(status),
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
  http: { status, headers: new Headers({ 'content-type': 'application/json' }) },
  body: new TextEncoder().encode(JSON.stringify({
    error: {
      code: status,
      message,
      status: gatewayErrorStatus(status),
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
    return geminiGenerateContentRpcErrorResult(404, `Model ${failure.model} is not available on any configured upstream.`);
  case 'model-unsupported':
    return geminiGenerateContentRpcErrorResult(400, `Model ${failure.model} does not support ${endpoint === 'countTokens' ? 'countTokens' : 'the Gemini generateContent endpoint'}.`);
  }
};

export const googleRpcHttpStatusCode = (status: number): number => (Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500);

export const geminiGenerateContentRpcErrorPayload = (status: number, message: string): GeminiGenerateContentErrorResponse => {
  const code = googleRpcHttpStatusCode(status);
  return {
    error: { code, message, status: gatewayErrorStatus(code) },
  };
};

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

export const isGeminiGenerateContentErrorResponse = (value: unknown): value is GeminiGenerateContentErrorResponse => {
  if (!value || typeof value !== 'object' || !('error' in value)) return false;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return false;
  const payload = error as Partial<GeminiGenerateContentErrorResponse['error']>;
  return typeof payload.code === 'number' && typeof payload.message === 'string' && typeof payload.status === 'string';
};

const gatewayRpcStatus = (status: number): number =>
  gatewayErrorStatus(status) === 'INTERNAL' ? 500 : status;

export const normalizeGeminiGenerateContentFailure = (result: ApiErrorResult | InternalErrorResult): ApiErrorResult | InternalErrorResult => {
  const { http } = result;
  if (result.type === 'internal-error') {
    const status = gatewayRpcStatus(http.status);
    return status === http.status ? result : { ...result, http: { ...http, status } };
  }
  if (result.source === 'gateway') return result;

  const message = decodeResponseBody(result.body).trim();
  const parsed = parseJson(message);
  const unwrapped = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
  if (isGeminiGenerateContentErrorResponse(unwrapped)) {
    return { ...result, http: { ...http, status: googleRpcHttpStatusCode(unwrapped.error.code) } };
  }

  const status = gatewayRpcStatus(http.status);
  return {
    ...result,
    http: { status, headers: mergeForwardedUpstreamHeaders({ 'content-type': 'application/json' }, http.headers) },
    body: new TextEncoder().encode(JSON.stringify(geminiGenerateContentRpcErrorPayload(
      status,
      message || 'Upstream Gemini generateContent request failed.',
    ))),
  };
};
