import type {
  DumpBody,
  DumpRecord,
  DumpResponseBody,
  StoredDumpRecord,
  StoredDumpResponseBody,
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

// Sole place the storage shape crosses into the wire shape. Called once,
// at the control-plane HTTP boundary, just before `c.json(...)`. A run's stream
// is decoded UTF-8-fatal rather than sniffed: the gateway wrote those bytes
// itself, so anything that fails to decode is a corrupted record and says so.
export const dumpRecordToWire = (record: StoredDumpRecord): DumpRecord => {
  if (record.shape === 'run') {
    return {
      shape: 'run',
      meta: record.meta,
      events: new TextDecoder('utf-8', { fatal: true }).decode(record.events),
    };
  }
  return {
    shape: 'edge',
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
    },
  };
};
