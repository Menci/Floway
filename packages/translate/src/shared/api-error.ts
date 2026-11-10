import { parseJSONObject } from './json/object.ts';
import type { IRErrorPayload } from '../ir/common/error.ts';
import type { TranslatedApiError } from '../types.ts';

const recordOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;

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

  const nested = recordOf(parsed.error);
  const error = nested ?? parsed;
  const message = stringOf(error.message) ?? stringOf(error.msg);
  if (message === undefined) return undefined;
  const type = stringOf(error.type);
  const code = stringOf(error.code) ?? stringOf(error.status);
  // `param` names the request field the failure is about, and a client that
  // retries reads it. It is stated here so the pre-stream envelope and the
  // mid-stream one agree.
  const param = stringOf(error.param);

  return {
    message,
    ...(type === undefined ? {} : { type }),
    ...(code === undefined ? {} : { code }),
    ...(param === undefined ? {} : { param }),
  };
};

/**
 * Restates a failure in the client's envelope while keeping what it can.
 *
 * The upstream's status stands unless the recognized error means something the
 * client's protocol spells with a different code, and every header the upstream
 * sent is carried over — retry hints and request ids are as meaningful to the
 * caller as the body is.
 */
export const restateError = (
  upstream: TranslatedApiError,
  body: Uint8Array,
  status?: number,
): TranslatedApiError => ({
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
