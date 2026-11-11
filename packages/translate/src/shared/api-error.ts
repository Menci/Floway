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
  const nested = recordOf(envelopeRecord.error);
  if (nested === undefined) {
    const { type: _type, sequence_number: _sequenceNumber, ...failure } = envelopeRecord;
    return errorPayloadOf(envelopeRecord.type === 'error' ? failure : envelopeRecord);
  }
  const payload = errorPayloadOf(nested);
  if (payload === undefined) return undefined;
  const envelope = extensionOf(envelopeRecord, new Set(['error', ...(envelopeRecord.type === 'error' ? ['type', 'sequence_number'] : [])]));
  return envelope === undefined ? payload : {
    ...payload,
    provider_specific_fields: { ...envelope, ...payload.provider_specific_fields },
  };
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

// Canonical wire payloads retain identity for native errors carried through the IR.
export const errorPayloadFromWire = (wire: unknown): IRErrorPayload => {
  const stated = recordOf(wire) ?? {};
  const nested = recordOf(stated.error);
  const source = nested ?? stated;
  if (hasErrorMessage(source)) return source;
  const aliasMessage = stringOf(source.msg);
  if (aliasMessage !== undefined) {
    const { msg: _msg, ...fields } = source;
    return { ...fields, message: aliasMessage };
  }
  const extra = extensionOf(source, NAMED_ERROR_FIELDS);
  return { message: '', ...(extra === undefined ? {} : { provider_specific_fields: extra }) };
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
