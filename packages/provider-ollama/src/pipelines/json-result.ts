import type { Result } from '@floway-dev/pipeline';
import { isJsonObject, type JsonObject } from '@floway-dev/protocols/common';
import { parseJsonBody } from '@floway-dev/provider';

export const parseJsonObject = (bytes: Uint8Array): Result<JsonObject, Error> => {
  const parsed = parseJsonBody(bytes);
  if (!parsed.ok) return parsed;
  return isJsonObject(parsed.value) ? { ok: true, value: parsed.value } : { ok: false, error: new Error('Expected an Ollama JSON response object') };
};
