import type { IRErrorPayload } from '../../../ir/output/error.ts';
import {
  errorEnvelopeOf,
  errorPayloadFromWire,
  errorPayloadOf,
  extensionOf,
  readErrorBodyEnvelope,
  recordOf,
  stringOf,
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
const geminiRpcErrorPayloadOf = (
  error: Readonly<Record<string, unknown>>,
  envelopeDetails: readonly Readonly<Record<string, unknown>>[],
  requireMessage: boolean,
): IRErrorPayload | undefined => {
  const status = stringOf(error.status);
  const rpcStatus = (status !== undefined && status !== '' ? status : undefined)
    ?? (typeof error.code === 'number' ? geminiGenerateContentStatusForHttpStatus(error.code) : undefined);
  const mappedType = rpcStatus === undefined ? undefined : googleRpcErrorType(rpcStatus);
  if (typeof error.code !== 'number' && mappedType === undefined) return undefined;
  const message = stringOf(error.message) ?? stringOf(error.msg);
  if (message === undefined && requireMessage) return undefined;
  const explicitType = stringOf(error.type);
  const type = explicitType ?? mappedType;
  const represented = new Set([
    ...(message === undefined ? [] : [typeof error.message === 'string' ? 'message' : 'msg']),
    ...(explicitType === undefined ? [] : ['type']),
  ]);
  const extra = extensionOf(error, represented, envelopeDetails);
  return {
    message: message ?? '',
    ...(type === undefined ? {} : { type }),
    ...(extra === undefined ? {} : { provider_specific_fields: extra }),
  };
};

// Non-SSE `:streamGenerateContent` responses stream a JSON array, so HTTP errors arrive as `[{ error: ... }]`.
// https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
const unwrapSingleElementArray = (parsed: unknown): unknown =>
  Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;

export const readGeminiGenerateContentErrorBody = (body: Uint8Array): IRErrorPayload | undefined => {
  const envelope = readErrorBodyEnvelope(body, unwrapSingleElementArray);
  if (envelope === undefined) return undefined;
  return geminiRpcErrorPayloadOf(envelope.source, envelope.details, true)
    ?? errorPayloadOf(envelope.source, envelope.details);
};

export const geminiGenerateContentErrorPayloadFromWire = (wire: unknown): IRErrorPayload => {
  const record = recordOf(wire);
  if (record !== undefined) {
    const { source, details } = errorEnvelopeOf(record);
    const payload = geminiRpcErrorPayloadOf(source, details, false);
    if (payload !== undefined) return payload;
  }
  return errorPayloadFromWire(wire);
};
