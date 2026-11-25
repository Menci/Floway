import type { Result } from '@floway-dev/pipeline';
import { isJsonObject, type JsonObject } from '@floway-dev/protocols/common';

export const parseJsonObject = (bytes: Uint8Array, parse: (text: string) => unknown = JSON.parse): Result<JsonObject, SyntaxError | TypeError> => {
  let value: unknown;
  try {
    value = parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { ok: false, error };
  }
  return isJsonObject(value)
    ? { ok: true, value }
    : { ok: false, error: new TypeError('Expected a JSON object in the upstream response') };
};
