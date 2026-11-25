import { localResponseHead } from '../../pipeline/encode.ts';
import { geminiGenerateContentStatusForHttpStatus, type GeminiGenerateContentErrorResponse } from '@floway-dev/protocols/gemini-generate-content';
import { internalDebugErrorFields, type InternalDebugError } from '@floway-dev/provider';

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

export const googleRpcHttpStatusCode = (status: number): number => (Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500);

export const geminiGenerateContentRpcErrorPayload = (status: number, message: string): GeminiGenerateContentErrorResponse => {
  const code = googleRpcHttpStatusCode(status);
  return {
    error: { code, message, status: gatewayErrorStatus(code) },
  };
};

// ProtoJSON Any wraps a Struct's arbitrary JSON in value.
// https://protobuf.dev/programming-guides/json/#any
export const geminiGenerateContentLocalError = (status: number, message: string, extension?: Record<string, unknown>) => ({
  http: { ...localResponseHead(status), body: null },
  outcome: {
    kind: 'error' as const,
    source: 'local' as const,
    error: {
      error: {
        code: status,
        message,
        status: gatewayErrorStatus(status),
        ...(extension === undefined ? {} : { details: [{ '@type': 'type.googleapis.com/google.protobuf.Struct', value: extension }] }),
      },
    },
  },
});

export const isGeminiGenerateContentErrorResponse = (value: unknown): value is GeminiGenerateContentErrorResponse => {
  if (!value || typeof value !== 'object' || !('error' in value)) return false;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return false;
  const payload = error as Partial<GeminiGenerateContentErrorResponse['error']>;
  return typeof payload.code === 'number' && typeof payload.message === 'string' && typeof payload.status === 'string';
};
