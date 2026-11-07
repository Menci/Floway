import type { IRErrorPayload } from '../ir/common/error.ts';
import { parseJSONObject } from './json/object.ts';
import type { TranslatedApiError } from '../types.ts';

const recordOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;

const stringOf = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

/**
 * Reads a protocol's non-2xx body as the error payload the IR carries.
 *
 * An upstream that fails a request answers with the same envelope its stream
 * would have reported, so reading it here is what lets a failure travel the
 * same path as a mid-stream error instead of a private one. A body that is not
 * the protocol's JSON envelope carries no machine-readable field; its text, if
 * any, still becomes the message so a caller can surface something.
 */
export const irErrorPayloadFromBody = (upstream: TranslatedApiError): IRErrorPayload => {
  const text = new TextDecoder().decode(upstream.body);
  let parsed: Readonly<Record<string, unknown>> | undefined;
  try {
    parsed = recordOf(parseJSONObject(text));
  } catch {
    parsed = undefined;
  }

  const error = recordOf(parsed?.error) ?? parsed;
  const message = stringOf(error?.message) ?? stringOf(error?.msg) ?? stringOf(parsed?.message) ?? text;
  const type = stringOf(error?.type);
  const code = stringOf(error?.code) ?? stringOf(error?.status);

  return {
    message,
    ...(type === undefined ? {} : { type }),
    ...(code === undefined ? {} : { code }),
  };
};
