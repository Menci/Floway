import type { IRErrorPayload } from '../ir/types.ts';
import { parseJSONWithRawNumbers } from '@floway-dev/protocols/common';

const recordOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;

const stringOf = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

// Unknown bodies keep their original bytes; parser failures other than invalid syntax propagate.
export const irErrorPayloadFromBody = (body: Uint8Array): IRErrorPayload | undefined => {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = parseJSONWithRawNumbers(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
  const envelopeRecord = recordOf(parsed);
  if (envelopeRecord === undefined) return undefined;
  const { source, details } = errorEnvelopeOf(envelopeRecord.type === 'error' ? errorEventPayloadOf(envelopeRecord) : envelopeRecord);
  const payload = errorPayloadOf(source);
  return payload === undefined ? undefined : withEnvelopeDetails(payload, details);
};

export const errorPayloadOf = (error: Readonly<Record<string, unknown>>): IRErrorPayload | undefined => {
  const message = stringOf(error.message) ?? stringOf(error.msg);
  if (message === undefined) return undefined;
  const type = stringOf(error.type);
  const code = error.code === null ? null : stringOf(error.code) ?? stringOf(error.status);
  const param = error.param === null ? null : stringOf(error.param);
  const represented = new Set([
    typeof error.message === 'string' ? 'message' : 'msg',
    ...(type === undefined ? [] : ['type']),
    ...(code === undefined ? [] : [error.code === null || typeof error.code === 'string' ? 'code' : 'status']),
    ...(param === undefined ? [] : ['param']),
  ]);
  const extra = extensionOf(error, represented);
  return {
    message,
    ...(type === undefined ? {} : { type }),
    ...(code === undefined ? {} : { code }),
    ...(param === undefined ? {} : { param }),
    ...(extra === undefined ? {} : { provider_specific_fields: extra }),
  };
};

const errorEnvelopeOf = (envelope: Readonly<Record<string, unknown>>) => {
  const nested = recordOf(envelope.error);
  const transportFields = envelope.type === 'error' ? ['type', 'sequence_number'] : [];
  if (nested !== undefined) return {
    source: nested,
    details: extensionOf(envelope, new Set(['error', ...transportFields])),
  };
  return { source: envelope, details: undefined };
};

// Error-level extension fields take precedence over envelope metadata in their shared container.
const withEnvelopeDetails = (payload: IRErrorPayload, details: Readonly<Record<string, unknown>> | undefined): IRErrorPayload =>
  details === undefined ? payload : {
    ...payload,
    provider_specific_fields: { ...details, ...errorDetailsOf(payload, ['message', 'type', 'code', 'param']) },
  };

const errorEventPayloadOf = (event: Readonly<Record<string, unknown>>) => {
  const { type: _type, sequence_number: _sequenceNumber, ...payload } = event;
  return payload;
};

export const errorPayloadFromEvent = (event: Readonly<Record<string, unknown>>): IRErrorPayload =>
  errorPayloadFromWire(errorEventPayloadOf(event));

// Canonical wire payloads retain identity when their envelope adds no metadata.
export const errorPayloadFromWire = (wire: unknown): IRErrorPayload => {
  const { source, details } = errorEnvelopeOf(recordOf(wire) ?? {});
  if (hasErrorMessage(source)) return withEnvelopeDetails(source, details);
  const aliasMessage = stringOf(source.msg);
  if (aliasMessage !== undefined) {
    const { msg: _msg, ...fields } = source;
    return withEnvelopeDetails({ ...fields, message: aliasMessage }, details);
  }
  const extra = extensionOf(source, NAMED_ERROR_FIELDS);
  return withEnvelopeDetails({ message: '', ...(extra === undefined ? {} : { provider_specific_fields: extra }) }, details);
};

const hasErrorMessage = (value: Readonly<Record<string, unknown>>): value is Readonly<Record<string, unknown>> & { readonly message: string } =>
  stringOf(value.message) !== undefined;
const NAMED_ERROR_FIELDS: ReadonlySet<string> = new Set(['message', 'msg', 'type', 'code', 'status', 'param']);

// The upstream container wins collisions; loose fields share that same container.
const extensionOf = (error: Readonly<Record<string, unknown>>, representedFields: ReadonlySet<string>): Readonly<Record<string, unknown>> | undefined => {
  const own = recordOf(error.provider_specific_fields);
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error)) {
    if (representedFields.has(key) || key === 'provider_specific_fields' || own !== undefined && Object.hasOwn(own, key)) continue;
    rest[key] = value;
  }
  return Object.keys(rest).length === 0 ? own : { ...rest, ...own };
};

export const errorDetailsOf = (error: IRErrorPayload, representedFields: readonly string[]): Readonly<Record<string, unknown>> | undefined =>
  extensionOf(error, new Set(representedFields));

export const restateError = (
  status: number,
  headers: Headers,
  body: unknown,
) => ({
  status,
  headers: restatedHeaders(headers),
  body,
});

const restatedHeaders = (headers: Headers): Headers => {
  const kept = new Headers(headers);
  kept.set('content-type', 'application/json');
  kept.delete('content-length');
  kept.delete('content-encoding');
  return kept;
};
