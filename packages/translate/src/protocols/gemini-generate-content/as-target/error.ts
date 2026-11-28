import type { HttpErrorResponse } from '../../../composition/index.ts';
import type { IRErrorPayload } from '../../../ir/output/error.ts';
import {
  extractStandardIRError,
  mergeErrorExtensions,
  parseJSONErrorBody,
  unwrapErrorEnvelope,
} from '../../../shared/api-error.ts';
import { isPlainJSONObject } from '../../../shared/json/object.ts';
import { geminiGenerateContentStatusForHttpStatus } from '@floway-dev/protocols/gemini-generate-content';

// Google's HTTP/JSON error representation of `google.rpc.Status` uses numeric HTTP `code`
// and canonical `google.rpc.Code` `status` enum names without a `type` string.
// https://cloud.google.com/apis/design/errors#http11json-representation
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

const stringOf = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

// Keep numeric `code` and canonical RPC `status` under their wire names inside
// `provider_specific_fields` while mapping `status` to canonical `type`.
const googleRpcErrorToIR = (
  source: Readonly<Record<string, unknown>>,
  envelopeDetails: readonly Readonly<Record<string, unknown>>[],
  requireMessage: boolean,
): IRErrorPayload | undefined => {
  const message = stringOf(source.message) ?? stringOf(source.msg);
  if (requireMessage && message === undefined) return undefined;

  const status = stringOf(source.status);
  const httpStatus = typeof source.code === 'number' ? geminiGenerateContentStatusForHttpStatus(source.code) : undefined;
  const inferredType = (status === undefined ? undefined : googleRpcErrorType(status))
    ?? (httpStatus === undefined ? undefined : googleRpcErrorType(httpStatus));

  if (typeof source.code !== 'number' && inferredType === undefined) {
    return extractStandardIRError(source, envelopeDetails, { requireMessage });
  }

  const explicitType = stringOf(source.type);
  const type = explicitType ?? inferredType;
  const param = source.param === null ? null : stringOf(source.param);
  const represented = new Set([
    ...(message === undefined ? [] : [typeof source.message === 'string' ? 'message' : 'msg']),
    ...(explicitType === undefined ? [] : ['type']),
    ...(param === undefined ? [] : ['param']),
  ]);
  const extra = mergeErrorExtensions(source, represented, envelopeDetails);
  return {
    message: message ?? '',
    ...(type === undefined ? {} : { type }),
    ...(param === undefined ? {} : { param }),
    ...(extra === undefined ? {} : { provider_specific_fields: extra }),
  };
};

export const readGeminiGenerateContentErrorBody = ({ body }: HttpErrorResponse): IRErrorPayload | undefined => {
  const parsed = parseJSONErrorBody(body);
  // Non-SSE `:streamGenerateContent` responses stream a JSON array, so HTTP errors arrive as `[{ error: ... }]`.
  // https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
  const unwrapped = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
  if (!isPlainJSONObject(unwrapped)) return undefined;
  const { source, envelopeDetails } = unwrapErrorEnvelope(unwrapped);
  return googleRpcErrorToIR(source, envelopeDetails, true);
};

export const geminiGenerateContentErrorFromEvent = (event: unknown): IRErrorPayload => {
  const { source, envelopeDetails } = unwrapErrorEnvelope(isPlainJSONObject(event) ? event : {});
  return googleRpcErrorToIR(source, envelopeDetails, false)!;
};
