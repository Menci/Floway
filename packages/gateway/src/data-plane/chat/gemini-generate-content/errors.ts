import { appendFailedUpstreams } from '../../shared/failed-upstreams.ts';
import { mergeForwardedUpstreamHeaders } from '../../shared/upstream-response.ts';
import type { ChatAttemptOutcome } from '../pipeline/index.ts';
import type { ChatServeFailure } from '../shared/errors.ts';
import { geminiGenerateContentStatusForHttpStatus, type GeminiGenerateContentErrorResponse } from '@floway-dev/protocols/gemini-generate-content';
import { decodeResponseBody, internalDebugErrorFields, type InternalDebugError } from '@floway-dev/provider';

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

export const geminiGenerateContentInternalErrorPayload = (
  status: number,
  error: InternalDebugError,
): GeminiGenerateContentErrorResponse => {
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

export const googleRpcHttpStatusCode = (status: number): number =>
  Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;

export const geminiGenerateContentRpcErrorPayload = (
  status: number,
  message: string,
): GeminiGenerateContentErrorResponse => {
  const code = googleRpcHttpStatusCode(status);
  return { error: { code, message, status: gatewayErrorStatus(code) } };
};

export const isGeminiGenerateContentErrorResponse = (
  value: unknown,
): value is GeminiGenerateContentErrorResponse => {
  if (!value || typeof value !== 'object' || !('error' in value)) return false;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return false;
  const payload = error as Partial<GeminiGenerateContentErrorResponse['error']>;
  return typeof payload.code === 'number' && typeof payload.message === 'string' && typeof payload.status === 'string';
};

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const gatewayRpcStatus = (status: number): number =>
  gatewayErrorStatus(status) === 'INTERNAL' ? 500 : status;

export const normalizeGeminiChatFailure = <TEvent>(
  outcome: ChatAttemptOutcome<TEvent>,
): ChatAttemptOutcome<TEvent> => {
  if (outcome.type !== 'api-error' || outcome.source === 'gateway') return outcome;
  const status = gatewayRpcStatus(outcome.http.status);
  const message = decodeResponseBody(outcome.body).trim();
  const parsed = parseJson(message);
  const code = isGeminiGenerateContentErrorResponse(parsed)
    ? googleRpcHttpStatusCode(parsed.error.code)
    : status;
  return {
    ...outcome,
    http: {
      ...outcome.http,
      status: code,
      headers: Object.freeze([...mergeForwardedUpstreamHeaders(
        { 'content-type': 'application/json' },
        new Headers(outcome.http.headers.map(([name, value]) => [name, typeof value === 'string' ? value : value.reveal()])),
      ).entries()].map(([name, value]) => Object.freeze([name, value] as const))),
    },
    body: isGeminiGenerateContentErrorResponse(parsed)
      ? outcome.body
      : new TextEncoder().encode(JSON.stringify(geminiGenerateContentRpcErrorPayload(
          code,
          message || 'Upstream Gemini generateContent request failed.',
        ))),
  };
};

const geminiGenerateContentFailureOutcome = (
  status: number,
  message: string,
): Extract<ChatAttemptOutcome<never>, { type: 'api-error' }> => ({
  type: 'api-error',
  source: 'gateway',
  http: {
    status,
    headers: Object.freeze([Object.freeze(['content-type', 'application/json'] as const)]),
  },
  body: new TextEncoder().encode(JSON.stringify(geminiGenerateContentRpcErrorPayload(status, message))),
});

export const renderGeminiGenerateContentFailure = (
  failure: ChatServeFailure,
  endpoint: 'generate' | 'countTokens',
): Extract<ChatAttemptOutcome<never>, { type: 'api-error' }> => {
  switch (failure.kind) {
  case 'routing-unavailable':
    return geminiGenerateContentFailureOutcome(400, failure.message);
  case 'model-missing':
    return geminiGenerateContentFailureOutcome(
      404,
      appendFailedUpstreams(`Model ${failure.model} is not available on any configured upstream.`, failure.failedUpstreams),
    );
  case 'model-unsupported':
    return geminiGenerateContentFailureOutcome(
      400,
      appendFailedUpstreams(
        `Model ${failure.model} does not support ${endpoint === 'countTokens' ? 'countTokens' : 'the Gemini generateContent endpoint'}.`,
        failure.failedUpstreams,
      ),
    );
  }
};
