import type { IRErrorPayload } from '../ir/output/error.ts';
import { rawJSON } from './json/raw-json.ts';
import { parseJSONWithRawNumbers } from '@floway-dev/protocols/common';

const recordOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;

const stringOf = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

/**
 * Recognize structured upstream error envelopes for cross-protocol rendering. Undefined includes
 * malformed JSON, invalid UTF-8 and unrecognized bodies, preserving the original response untouched.
 */
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
  return errorPayloadOf(source, details);
};

/** Restatement requires a message; preserve every unrepresented field in diagnostic details. */
export const errorPayloadOf = (
  error: Readonly<Record<string, unknown>>,
  envelopeDetails: readonly Readonly<Record<string, unknown>>[] = [],
): IRErrorPayload | undefined => {
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
  const extra = extensionOf(error, represented, envelopeDetails);
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
    details: extensionNamespacesOf(envelope, new Set(['error', ...transportFields])),
  };
  return { source: envelope, details: [] };
};

// After merging, loose fields live only in the container so source projection cannot add them again.
const withEnvelopeDetails = (payload: IRErrorPayload, details: readonly Readonly<Record<string, unknown>>[]): IRErrorPayload =>
  details.length === 0 ? payload : {
    message: payload.message,
    ...(payload.type === undefined ? {} : { type: payload.type }),
    ...(payload.code === undefined ? {} : { code: payload.code }),
    ...(payload.param === undefined ? {} : { param: payload.param }),
    provider_specific_fields: extensionOf(payload, new Set(['message', 'type', 'code', 'param']), details),
  };

const errorEventPayloadOf = (event: Readonly<Record<string, unknown>>) => {
  const { type: _type, sequence_number: _sequenceNumber, ...payload } = event;
  return payload;
};

export const errorPayloadFromEvent = (event: Readonly<Record<string, unknown>>): IRErrorPayload =>
  errorPayloadFromWire(errorEventPayloadOf(event));

/** Target adapters own wire shaping; source writers own extension-field projection. */
// Canonical wire payloads retain identity when their envelope adds no metadata.
export const errorPayloadFromWire = (wire: unknown): IRErrorPayload => {
  const { source, details } = errorEnvelopeOf(recordOf(wire) ?? {});
  if (hasErrorMessage(source)) return withEnvelopeDetails(source, details);
  const aliasMessage = stringOf(source.msg);
  if (aliasMessage !== undefined) {
    const { msg: _msg, ...fields } = source;
    return withEnvelopeDetails({ ...fields, message: aliasMessage }, details);
  }
  // Failures without message text still need an error frame; use an empty message.
  const extra = extensionOf(source, NAMED_ERROR_FIELDS, details);
  return { message: '', ...(extra === undefined ? {} : { provider_specific_fields: extra }) };
};

const hasErrorMessage = (value: Readonly<Record<string, unknown>>): value is Readonly<Record<string, unknown>> & { readonly message: string } =>
  stringOf(value.message) !== undefined;
const NAMED_ERROR_FIELDS: ReadonlySet<string> = new Set(['message', 'msg', 'type', 'code', 'status', 'param']);

const extensionNamespacesOf = (error: Readonly<Record<string, unknown>>, representedFields: ReadonlySet<string>) => {
  const own = recordOf(error.provider_specific_fields);
  const rest = Object.fromEntries(Object.entries(error).filter(([key]) => !representedFields.has(key) && key !== 'provider_specific_fields'));
  return [...(own === undefined ? [] : [own]), ...(Object.keys(rest).length === 0 ? [] : [rest])];
};

const sameJSONValue = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (rawJSON.isRawJSON(left) || rawJSON.isRawJSON(right)) return JSON.stringify(left) === JSON.stringify(right);
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((value, index) => sameJSONValue(value, right[index]));
  const leftObject = recordOf(left);
  const rightObject = recordOf(right);
  if (leftObject === undefined || rightObject === undefined) return false;
  const keys = Object.keys(leftObject);
  return keys.length === Object.keys(rightObject).length && keys.every(key => Object.hasOwn(rightObject, key) && sameJSONValue(leftObject[key], rightObject[key]));
};

// Inner fields precede outer fields, and each upstream container precedes its loose fields.
// Reserve every original key before suffix allocation so generated names cannot take explicit names.
const extensionOf = (
  error: Readonly<Record<string, unknown>>,
  representedFields: ReadonlySet<string>,
  envelopeDetails: readonly Readonly<Record<string, unknown>>[] = [],
): Readonly<Record<string, unknown>> | undefined => {
  const namespaces = [...extensionNamespacesOf(error, representedFields), ...envelopeDetails];
  if (namespaces.length === 0) return undefined;
  const values = new Map<string, unknown[]>();
  for (const namespace of namespaces) {
    for (const [key, value] of Object.entries(namespace)) {
      // A named field already carries this value; another source writer can project it once.
      if (representedFields.has(key) && sameJSONValue(error[key], value)) continue;
      const previous = values.get(key);
      if (previous === undefined) values.set(key, [value]);
      else if (!previous.some(existing => sameJSONValue(existing, value))) previous.push(value);
    }
  }
  if (namespaces.length === 1 && values.size === Object.keys(namespaces[0]).length) return namespaces[0];
  const merged: Record<string, unknown> = Object.fromEntries([...values].map(([key, entries]) => [key, entries[0]]));
  for (const [key, entries] of values) {
    for (const value of entries.slice(1)) {
      let suffix = 1;
      while (Object.hasOwn(merged, `${key}_${suffix}`)) suffix++;
      merged[`${key}_${suffix}`] = value;
    }
  }
  return merged;
};

/** Each source writer lists fields represented in its envelope; all remaining values stay in diagnostic extensions. */
export const errorDetailsOf = (error: IRErrorPayload, representedFields: readonly string[]): Readonly<Record<string, unknown>> | undefined =>
  extensionOf(error, new Set(representedFields));

/**
 * Return a JSON envelope without transport encoding. Preserve semantic upstream headers while
 * replacing the media type and removing length and encoding headers tied to the replaced body.
 */
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
  // A replacement body can change length and encoding, so remove both upstream body headers.
  kept.delete('content-length');
  kept.delete('content-encoding');
  return kept;
};
