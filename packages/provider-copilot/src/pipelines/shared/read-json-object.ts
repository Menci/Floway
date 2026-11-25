import type { Result } from '@floway-dev/pipeline';
import { isJsonObject, type JsonObject } from '@floway-dev/protocols/common';
import { parseJsonBody } from '@floway-dev/provider';

export const readJsonObject = (bytes: Uint8Array): Result<JsonObject, Error> => {
  const parsed = parseJsonBody(bytes);
  if (!parsed.ok) return parsed;
  if (!isJsonObject(parsed.value)) return { ok: false, error: new TypeError('Expected a JSON object in Copilot response') };
  return { ok: true, value: parsed.value };
};
