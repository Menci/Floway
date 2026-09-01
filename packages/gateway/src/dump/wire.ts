import type {
  DumpBody,
  DumpRecord,
  DumpResponseBody,
  DumpUpstreamResponse,
  StoredDumpRecord,
  StoredDumpResponseBody,
  StoredDumpUpstreamResponse,
} from './types.ts';
import { encodeBase64, isTextualMediaType } from '@floway-dev/protocols/common';

const contentTypeOf = (headers: ReadonlyArray<readonly [string, string]>): string =>
  headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '';

// Wire encoding decision: textual content-types try UTF-8 first and fall
// back to base64 when the bytes do not decode cleanly (a content-type
// that lied about being text).
const encodeBodyForWire = (bytes: Uint8Array, contentType: string): DumpBody => {
  if (isTextualMediaType(contentType)) {
    try {
      return { encoding: 'utf8', data: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch {}
  }
  return { encoding: 'base64', data: encodeBase64(bytes) };
};

const responseBodyToWire = (body: StoredDumpResponseBody, contentType: string): DumpResponseBody => {
  switch (body.type) {
  case 'stream': return { type: 'stream', events: body.events };
  case 'bytes':  return { type: 'bytes', body: encodeBodyForWire(body.body, contentType) };
  case 'none':   return { type: 'none' };
  }
};

const upstreamResponseToWire = (
  upstream: StoredDumpUpstreamResponse | undefined,
  contentType: string,
): DumpUpstreamResponse | undefined => {
  if (upstream === undefined) return undefined;
  // The upstream body's content-type comes from the upstream response headers
  // (api-error path); the `stream` branch ignores it.
  return {
    status: upstream.status,
    headers: upstream.headers,
    body: responseBodyToWire(upstream.body, contentType),
  };
};

// Sole place the storage shape crosses into the wire shape. Called once,
// at the control-plane HTTP boundary, just before `c.json(...)`.
export const dumpRecordToWire = (record: StoredDumpRecord): DumpRecord => ({
  meta: record.meta,
  request: {
    method: record.request.method,
    path: record.request.path,
    headers: record.request.headers,
    body: encodeBodyForWire(record.request.body, contentTypeOf(record.request.headers)),
  },
  response: {
    status: record.response.status,
    headers: record.response.headers,
    body: responseBodyToWire(record.response.body, contentTypeOf(record.response.headers)),
    ...(record.response.upstream !== undefined ? {
      upstream: upstreamResponseToWire(
        record.response.upstream,
        contentTypeOf(record.response.upstream.headers),
      ),
    } : {}),
  },
});
