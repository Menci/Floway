import type { IRErrorPayload } from '../../../ir/output/error.ts';
import {
  errorPayloadFromWire,
  irErrorPayloadFromBody,
  type ErrorPayloadClassification,
} from '../../../shared/api-error.ts';
import { geminiGenerateContentStatusForHttpStatus } from '@floway-dev/protocols/gemini-generate-content';

// Google RPC `google.rpc.Status` uses numeric HTTP `code` and canonical `status` enum names without a `type` string.
// https://github.com/googleapis/googleapis/blob/bc7e3baa28fbb223fa93782e130260fab8205bfc/google/rpc/code.proto
const googleRpcErrorType = (status: string): string | undefined => {
  switch (status) {
  case 'INVALID_ARGUMENT':
  case 'FAILED_PRECONDITION':
  case 'OUT_OF_RANGE':
    return 'invalid_request_error';
  case 'UNAUTHENTICATED':
    return 'authentication_error';
  case 'PERMISSION_DENIED':
    return 'permission_error';
  case 'NOT_FOUND':
    return 'not_found_error';
  case 'ALREADY_EXISTS':
  case 'ABORTED':
    return 'conflict_error';
  case 'RESOURCE_EXHAUSTED':
    return 'rate_limit_error';
  case 'UNAVAILABLE':
    return 'overloaded_error';
  case 'INTERNAL':
  case 'DEADLINE_EXCEEDED':
  case 'UNKNOWN':
  case 'DATA_LOSS':
  case 'UNIMPLEMENTED':
  case 'CANCELLED':
    return 'api_error';
  default:
    return undefined;
  }
};

// Keep numeric `code` and canonical RPC `status` under their wire names inside
// `provider_specific_fields` while mapping `status` to canonical `type`, avoiding
// a second `code` key that collides on sources without a top-level `code` field.
const classifyGoogleRpcError = (error: Readonly<Record<string, unknown>>): ErrorPayloadClassification | undefined => {
  const status = typeof error.status === 'string' ? error.status : undefined;
  const httpStatus = typeof error.code === 'number' ? geminiGenerateContentStatusForHttpStatus(error.code) : undefined;
  const defaultType = (status === undefined ? undefined : googleRpcErrorType(status))
    ?? (httpStatus === undefined ? undefined : googleRpcErrorType(httpStatus));
  if (typeof error.code !== 'number' && defaultType === undefined) return undefined;
  return {
    ...(defaultType === undefined ? {} : { defaultType }),
    omitStatusAsCode: true,
  };
};

// Non-SSE `:streamGenerateContent` responses stream a JSON array, so HTTP errors arrive as `[{ error: ... }]`.
// https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
const unwrapSingleElementArray = (parsed: unknown): unknown =>
  Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;

export const readGeminiGenerateContentErrorBody = (body: Uint8Array): IRErrorPayload | undefined =>
  irErrorPayloadFromBody(body, { unwrap: unwrapSingleElementArray, classify: classifyGoogleRpcError });

export const geminiGenerateContentErrorPayloadFromWire = (wire: unknown): IRErrorPayload =>
  errorPayloadFromWire(wire, { classify: classifyGoogleRpcError });
