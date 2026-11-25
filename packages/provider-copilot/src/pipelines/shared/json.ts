import { setHeader, type HttpRequestFact } from '@floway-dev/http';
import { move, type Result } from '@floway-dev/pipeline';
import { isJsonObject, type JsonObject } from '@floway-dev/protocols/common';
import { parseJsonBody } from '@floway-dev/provider';

export const serializeJsonRequest = (request: HttpRequestFact, path: string, value: object): HttpRequestFact => move({
  ...request,
  method: 'POST',
  url: path,
  headers: setHeader(request.headers, 'content-type', 'application/json'),
  body: JSON.stringify(value),
});

export const parseJsonObject = (bytes: Uint8Array): Result<JsonObject, SyntaxError | TypeError> => {
  const parsed = parseJsonBody(bytes);
  if (!parsed.ok) return parsed;
  if (!isJsonObject(parsed.value)) return { ok: false, error: new TypeError('Expected a Copilot JSON response object') };
  return { ok: true, value: parsed.value };
};
