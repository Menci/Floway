import { isJSONRecord } from './json/object.ts';
import type { IRErrorPayload } from '../ir/common/error.ts';
import { parseJSONWithRawNumbers } from '@floway-dev/protocols/common';

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
  if (!isJSONRecord(parsed)) return undefined;
  const nested = recordOf(parsed.error);
  if (nested === undefined) return errorPayloadOf(parsed);
  const payload = errorPayloadOf(nested);
  if (payload === undefined) return undefined;
  const envelope = extensionOf(parsed, new Set(['error', ...(parsed.type === 'error' ? ['type'] : [])]));
  return envelope === undefined ? payload : {
    ...payload,
    provider_specific_fields: { ...envelope, ...payload.provider_specific_fields },
  };
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
  const code = error.code === null ? null : stringOf(error.code) ?? stringOf(error.status);
  // `param` names the request field the failure is about, and a client that
  // retries reads it. It is stated here so the pre-stream envelope and the
  // mid-stream one agree.
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
  if (hasErrorMessage(source)) return source;
  const aliasMessage = stringOf(source.msg);
  if (aliasMessage !== undefined) {
    const { msg: _msg, ...fields } = source;
    return { ...fields, message: aliasMessage };
  }
  // Gathered rather than nested again: this object may itself carry the
  // container, and wrapping it whole would state one inside another.
  const extra = extensionOf(source, NAMED_ERROR_FIELDS);
  return { message: '', ...(extra === undefined ? {} : { provider_specific_fields: extra }) };
};

const hasErrorMessage = (value: Readonly<Record<string, unknown>>): value is Readonly<Record<string, unknown>> & { readonly message: string } =>
  stringOf(value.message) !== undefined;

// The fields the IR names, so a payload can state everything else instead of
// losing it.
const NAMED_ERROR_FIELDS: ReadonlySet<string> = new Set(['message', 'msg', 'type', 'code', 'status', 'param']);

/**
 * The protocol-specific fields an error carries, gathered into one object.
 *
 * An upstream may state its own `provider_specific_fields` and any number of
 * other keys its protocol defines. Unrepresented fields travel in one
 * container. Its own values win a name collision, while unrelated loose keys
 * remain alongside them.
 */
const extensionOf = (error: Readonly<Record<string, unknown>>, representedFields: ReadonlySet<string>): Readonly<Record<string, unknown>> | undefined => {
  const own = recordOf(error.provider_specific_fields);
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error)) {
    if (representedFields.has(key) || key === 'provider_specific_fields' || own !== undefined && Object.hasOwn(own, key)) continue;
    rest[key] = value;
  }
  return Object.keys(rest).length === 0 ? own : { ...rest, ...own };
};

/**
 * The protocol-specific fields an IR error carries.
 *
 * The error object a target protocol reads travels into the IR as it arrived,
 * so each writer names the fields its envelope already represents. Everything
 * else remains in its extension container.
 */
export const errorDetailsOf = (error: IRErrorPayload, representedFields: readonly string[]): Readonly<Record<string, unknown>> | undefined =>
  extensionOf(error, new Set(representedFields));

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
  // The body is JSON whatever the upstream said, because it is one of ours now.
  kept.set('content-type', 'application/json');
  // A re-encoded body has a different length than the bytes it replaces.
  kept.delete('content-length');
  kept.delete('content-encoding');
  return kept;
};
