import type { IRErrorPayload } from '../../../ir/output/error.ts';
import {
  errorEnvelopeOf,
  errorEventPayloadOf,
  errorPayloadFromWire,
  errorPayloadOf,
  extensionOf,
  parseErrorBodyJSON,
} from '../../../shared/api-error.ts';

const recordOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;

const stringOf = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

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
  case 'RESOURCE_EXHAUSTED':
    return 'rate_limit_error';
  case 'UNAVAILABLE':
    return 'overloaded_error';
  case 'INTERNAL':
  case 'DEADLINE_EXCEEDED':
  case 'UNKNOWN':
    return 'api_error';
  default:
    return undefined;
  }
};

// Keep numeric `code` and canonical RPC `status` under their wire names inside
// `provider_specific_fields` while mapping `status` to canonical `type`, avoiding
// a second `code` key that collides on sources without a top-level `code` field.
const geminiGenerateContentErrorPayloadOf = (
  error: Readonly<Record<string, unknown>>,
  envelopeDetails: readonly Readonly<Record<string, unknown>>[] = [],
): IRErrorPayload | undefined => {
  if (typeof error.code !== 'number') return errorPayloadOf(error, envelopeDetails);
  const message = stringOf(error.message) ?? stringOf(error.msg);
  if (message === undefined) return undefined;
  const status = stringOf(error.status);
  const explicitType = stringOf(error.type);
  const type = explicitType ?? (status === undefined ? undefined : googleRpcErrorType(status));
  const represented = new Set([
    typeof error.message === 'string' ? 'message' : 'msg',
    ...(explicitType === undefined ? [] : ['type']),
  ]);
  const extra = extensionOf(error, represented, envelopeDetails);
  return {
    message,
    ...(type === undefined ? {} : { type }),
    ...(extra === undefined ? {} : { provider_specific_fields: extra }),
  };
};

export const readGeminiGenerateContentErrorBody = (body: Uint8Array): IRErrorPayload | undefined => {
  const parsed = parseErrorBodyJSON(body);
  // Google `:streamGenerateContent` HTTP errors can arrive as a single-element JSON array `[{ error: ... }]`.
  const envelopeRecord = recordOf(Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed);
  if (envelopeRecord === undefined) return undefined;
  const { source, details } = errorEnvelopeOf(
    envelopeRecord.type === 'error' ? errorEventPayloadOf(envelopeRecord) : envelopeRecord,
  );
  return geminiGenerateContentErrorPayloadOf(source, details);
};

export const geminiGenerateContentErrorPayloadFromWire = (wire: unknown): IRErrorPayload => {
  const record = recordOf(wire);
  if (record !== undefined) {
    const { source, details } = errorEnvelopeOf(record);
    if (typeof source.code === 'number') {
      const payload = geminiGenerateContentErrorPayloadOf(source, details);
      if (payload !== undefined) return payload;
    }
  }
  return errorPayloadFromWire(wire);
};
