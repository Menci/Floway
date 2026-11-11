import { isJSONRecord, parseJSONObject } from './json/object.ts';
import type { IRErrorPayload } from '../ir/common/error.ts';
import type { RestatedSourceError, TranslatedApiError } from '../types.ts';

const recordOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  isJSONRecord(value) ? value : undefined;

const stringOf = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

/**
 * Reads a failed request's body as the error payload the IR carries.
 *
 * A protocol's error envelope nests a message and usually a machine-readable
 * type or code, and every protocol we translate between puts them in one of a
 * few places. Recognizing that shape is what lets a cross-protocol failure be
 * restated in the client's own envelope.
 *
 * `undefined` means the body is not an error envelope this package recognizes.
 * That is not a failure to parse: the answer is to leave the upstream's own
 * status, headers, and bytes alone rather than inventing a shape for them.
 */
export const irErrorPayloadFromBody = (upstream: TranslatedApiError): IRErrorPayload | undefined => {
  const text = new TextDecoder().decode(upstream.body);
  let parsed: Readonly<Record<string, unknown>>;
  try {
    parsed = parseJSONObject(text);
  } catch {
    return undefined;
  }
  // A protocol nests the error object inside its body envelope; the enclosing
  // object is the error itself only when nothing is nested.
  const nested = recordOf(parsed.error);
  return errorPayloadOf(nested ?? parsed);
};

/**
 * The error payload an upstream error object states.
 *
 * `undefined` means the object names no message, so it is not an error this
 * package can restate. Everything else the object states travels in the
 * extension container, because a protocol may state fields the source protocol
 * has no place for and dropping them would describe the failure less completely
 * than the upstream did.
 */
export const errorPayloadOf = (error: Readonly<Record<string, unknown>>): IRErrorPayload | undefined => {
  const message = stringOf(error.message) ?? stringOf(error.msg);
  if (message === undefined) return undefined;
  const type = stringOf(error.type);
  const code = stringOf(error.code) ?? stringOf(error.status);
  // `param` names the request field the failure is about, and a client that
  // retries reads it. It is stated here so the pre-stream envelope and the
  // mid-stream one agree.
  const param = stringOf(error.param);
  const extra = extensionOf(error);
  return {
    message,
    ...(type === undefined ? {} : { type }),
    ...(code === undefined ? {} : { code }),
    ...(param === undefined ? {} : { param }),
    ...(extra === undefined ? {} : { provider_specific_fields: extra }),
  };
};

/**
 * Reads an upstream error object that an adapter already shaped.
 *
 * A target protocol's own events already state the error as its wire does, so
 * the object travels into the IR as it arrived; a source writer gathers the
 * unnamed fields when it states the failure back.
 */
export const errorPayloadFromWire = (wire: unknown): IRErrorPayload => {
  const stated = recordOf(wire) ?? {};
  // An envelope may nest the error object; the enclosing object is the error
  // itself only when it states the message.
  const nested = recordOf(stated.error);
  const source = nested ?? stated;
  // A wire object that states a message is already the IR's shape, so it
  // travels as it arrived. One that states none still has to be reported, and
  // the message is the only field the IR requires.
  if (isErrorPayload(source)) return source;
  // Gathered rather than nested again: this object may itself carry the
  // container, and wrapping it whole would state one inside another.
  const extra = extensionOf(source);
  return { message: '', ...(extra === undefined ? {} : { provider_specific_fields: extra }) };
};

const isErrorPayload = (value: Readonly<Record<string, unknown>>): value is IRErrorPayload & Readonly<Record<string, unknown>> =>
  stringOf(value.message) !== undefined || stringOf(value.msg) !== undefined;

// The fields the IR names, so a payload can state everything else instead of
// losing it.
const NAMED_ERROR_FIELDS: ReadonlySet<string> = new Set(['message', 'msg', 'type', 'code', 'status', 'param']);

/**
 * The protocol-specific fields an error carries, gathered into one object.
 *
 * An upstream may state its own `provider_specific_fields` and any number of
 * other keys its protocol defines. Both travel in one container: the IR has no
 * vocabulary for either, so keeping them apart would only invent a second
 * non-standard slot beside the one this payload already is. An upstream that
 * states the container has already decided what its non-standard data is, so
 * the loose keys beside it are a legacy spelling of the same thing and do not
 * widen it.
 */
const extensionOf = (error: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | undefined => {
  const own = recordOf(error.provider_specific_fields);
  if (own !== undefined) return own;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error)) {
    if (NAMED_ERROR_FIELDS.has(key) || key === 'provider_specific_fields') continue;
    rest[key] = value;
  }
  return Object.keys(rest).length === 0 ? undefined : rest;
};

/**
 * The protocol-specific fields an IR error carries.
 *
 * The error object a target protocol reads travels into the IR as it arrived,
 * so this gathers what it states at the point a source writer writes it back.
 */
export const errorDetailsOf = (error: IRErrorPayload): Readonly<Record<string, unknown>> | undefined => extensionOf(error);

/**
 * Restates a failure in the client's envelope while keeping what it can.
 *
 * The body stays a JSON value: an error envelope is one in every protocol we
 * speak, so the envelope is not encoded here and each caller renders it where
 * its transport needs bytes.
 *
 * The upstream's status stands unless the recognized error means something the
 * client's protocol spells with a different code, and every header the upstream
 * sent is carried over — retry hints and request ids are as meaningful to the
 * caller as the body is.
 */
export const restateError = (
  upstream: TranslatedApiError,
  body: unknown,
  status?: number,
): RestatedSourceError => ({
  status: status ?? upstream.status,
  headers: restatedHeaders(upstream.headers),
  body,
});

const restatedHeaders = (headers: Headers): Headers => {
  const kept = new Headers(headers);
  // The body is JSON whatever the upstream said, because it is one of ours now.
  kept.set('content-type', 'application/json');
  // A re-encoded body has a different length than the bytes it replaces.
  kept.delete('content-length');
  kept.delete('content-encoding');
  return kept;
};
