import { isPlainJSONObject } from './json/object.ts';
import { rawJSON } from './json/raw-json.ts';
import type { IRErrorPayload } from '../ir/output/error.ts';
import { parseJSONWithRawNumbers } from '@floway-dev/protocols/common';

const stringOf = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

const hasErrorMessage = (
  value: Readonly<Record<string, unknown>>,
): value is Readonly<Record<string, unknown>> & { readonly message: string } =>
  stringOf(value.message) !== undefined;

/**
 * Decode a UTF-8 JSON error body with raw numeric preservation.
 * Returns `undefined` for invalid UTF-8 or non-JSON text so callers preserve the original body untouched.
 */
export const parseJSONErrorBody = (body: Uint8Array): unknown | undefined => {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return undefined;
  }
  try {
    return parseJSONWithRawNumbers(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
};

/**
 * Unwrap an optional `{ error: { ... } }` container while keeping remaining outer envelope fields
 * as diagnostic extensions. Protocol-specific transport discriminants are listed by the caller.
 */
export const unwrapErrorEnvelope = (
  envelope: Readonly<Record<string, unknown>>,
  transportFields: readonly string[] = [],
): {
  readonly source: Readonly<Record<string, unknown>>;
  readonly envelopeDetails: readonly Readonly<Record<string, unknown>>[];
} => {
  const nested = isPlainJSONObject(envelope.error) ? envelope.error : undefined;
  if (nested !== undefined) {
    return {
      source: nested,
      envelopeDetails: extensionNamespacesOf(envelope, new Set(['error', ...transportFields])),
    };
  }
  if (transportFields.length === 0) return { source: envelope, envelopeDetails: [] };
  const dropped = new Set(transportFields);
  return {
    source: Object.fromEntries(Object.entries(envelope).filter(([key]) => !dropped.has(key))),
    envelopeDetails: [],
  };
};

/**
 * Extract canonical `{ message, type, code, param }` fields from an error record,
 * preserving every unrepresented field and outer envelope detail in `provider_specific_fields`.
 */
export const extractStandardIRError = (
  source: Readonly<Record<string, unknown>>,
  envelopeDetails: readonly Readonly<Record<string, unknown>>[] = [],
  options?: { readonly requireMessage?: boolean },
): IRErrorPayload | undefined => {
  const message = stringOf(source.message) ?? stringOf(source.msg);
  if (options?.requireMessage === true && message === undefined) return undefined;
  const type = stringOf(source.type);
  const code = source.code === null ? null : stringOf(source.code);
  const param = source.param === null ? null : stringOf(source.param);
  const represented = new Set([
    ...(message === undefined ? [] : [typeof source.message === 'string' ? 'message' : 'msg']),
    ...(type === undefined ? [] : ['type']),
    ...(code === undefined ? [] : ['code']),
    ...(param === undefined ? [] : ['param']),
  ]);
  const extra = mergeErrorExtensions(source, represented, envelopeDetails);
  return {
    message: message ?? '',
    ...(type === undefined ? {} : { type }),
    ...(code === undefined ? {} : { code }),
    ...(param === undefined ? {} : { param }),
    ...(extra === undefined ? {} : { provider_specific_fields: extra }),
  };
};

// After merging, loose fields live only in the container so source projection cannot add them again.
const withEnvelopeDetails = (
  payload: IRErrorPayload,
  envelopeDetails: readonly Readonly<Record<string, unknown>>[],
): IRErrorPayload => {
  if (envelopeDetails.length === 0) return payload;
  const extension = mergeErrorExtensions(payload, new Set(['message', 'type', 'code', 'param']), envelopeDetails);
  return {
    message: payload.message,
    ...(payload.type === undefined ? {} : { type: payload.type }),
    ...(payload.code === undefined ? {} : { code: payload.code }),
    ...(payload.param === undefined ? {} : { param: payload.param }),
    ...(extension === undefined ? {} : { provider_specific_fields: extension }),
  };
};

/**
 * Normalize a wire error payload from protocols whose canonical fields already match `IRErrorPayload`.
 * Retains object identity when `message` is present and the outer envelope adds no metadata.
 */
export const irErrorFromStandardWire = (
  source: Readonly<Record<string, unknown>>,
  envelopeDetails: readonly Readonly<Record<string, unknown>>[] = [],
): IRErrorPayload => {
  if (hasErrorMessage(source)) return withEnvelopeDetails(source, envelopeDetails);
  const aliasMessage = stringOf(source.msg);
  if (aliasMessage !== undefined) {
    const { msg: _msg, ...fields } = source;
    return withEnvelopeDetails({ ...fields, message: aliasMessage }, envelopeDetails);
  }
  // Failures without message text still need an error frame; preserve structured fields alongside an empty message.
  return extractStandardIRError(source, envelopeDetails)!;
};

const extensionNamespacesOf = (
  error: Readonly<Record<string, unknown>>,
  representedFields: ReadonlySet<string>,
) => {
  const own = isPlainJSONObject(error.provider_specific_fields) ? error.provider_specific_fields : undefined;
  const rest = Object.fromEntries(Object.entries(error).filter(([key]) => !representedFields.has(key) && key !== 'provider_specific_fields'));
  return [...(own === undefined ? [] : [own]), ...(Object.keys(rest).length === 0 ? [] : [rest])];
};

const sameJSONValue = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (rawJSON.isRawJSON(left) || rawJSON.isRawJSON(right)) return JSON.stringify(left) === JSON.stringify(right);
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((value, index) => sameJSONValue(value, right[index]));
  if (!isPlainJSONObject(left) || !isPlainJSONObject(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameJSONValue(left[key], right[key]));
};

// Inner fields precede outer fields, and each upstream container precedes its loose fields.
// Reserve every original key before suffix allocation so generated names cannot take explicit names.
export const mergeErrorExtensions = (
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
  mergeErrorExtensions(error, new Set(representedFields));

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
