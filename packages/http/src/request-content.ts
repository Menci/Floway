import { stringifyChunked } from '@discoveryjs/json-ext';

import type { ReplayableBody } from './types.ts';
import { isSecret } from '@floway-dev/pipeline';

export interface HttpFile {
  readonly name: string;
  readonly type: string;
  readonly lastModified?: number;
  readonly bytes: Uint8Array;
}

export interface HttpFormEntry {
  readonly name: string;
  readonly value: string | HttpFile;
}

export interface HttpMultipartBody {
  readonly boundary: string;
  readonly entries: readonly HttpFormEntry[];
}

export type HttpBody = object | string | Uint8Array | null;
export type HttpBodyEncoding = 'json' | 'multipart' | 'direct';

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const quoted = (value: string): string => value.replaceAll('\r', '%0D').replaceAll('\n', '%0A').replaceAll('"', '%22');
const normalizeNewlines = (value: string): string => value.replace(/\r\n|\r|\n/g, '\r\n');

// Preserve Fetch's multipart wire encoding while retaining shared upload bytes.
// https://github.com/nodejs/undici/blob/01a912e49a50c48009ed2639d2a457a6ec26752a/lib/web/fetch/body.js
const multipartChunks = function* (body: HttpMultipartBody): Generator<Uint8Array> {
  for (const { name, value } of body.entries) {
    const disposition = `--${body.boundary}\r\nContent-Disposition: form-data; name="${quoted(normalizeNewlines(name))}"`;
    if (typeof value === 'string') {
      yield encode(`${disposition}\r\n\r\n${normalizeNewlines(value)}\r\n`);
    } else {
      const filename = value.name.length === 0 ? '' : `; filename="${quoted(value.name)}"`;
      yield encode(`${disposition}${filename}\r\nContent-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`);
      yield value.bytes;
      yield encode('\r\n');
    }
  }
  yield encode(`--${body.boundary}--\r\n`);
};

export const jsonByteChunks = function* (value: object): Generator<Uint8Array> {
  for (const chunk of stringifyChunked(value, (_key: string, field: unknown) => isSecret(field) ? field.reveal() : field)) yield encode(chunk);
};

const replayable = (chunks: () => Generator<Uint8Array>): ReplayableBody => {
  let contentLength = 0;
  for (const chunk of chunks()) {
    contentLength += chunk.byteLength;
    if (!Number.isSafeInteger(contentLength)) throw new RangeError('HTTP request content exceeds the supported content length');
  }
  return {
    contentLength,
    open: () => {
      const iterator = chunks();
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        cancel() {
          iterator.return(undefined);
        },
      });
    },
  };
};

export const serializeHttpBody = (body: HttpBody, encoding: HttpBodyEncoding): string | ReplayableBody | null => {
  if (encoding === 'json') {
    if (body === null || typeof body !== 'object' || body instanceof Uint8Array) throw new TypeError('JSON HTTP content must be a parsed object');
    return replayable(() => jsonByteChunks(body));
  }
  if (encoding === 'multipart') {
    const multipart = body as HttpMultipartBody;
    return replayable(() => multipartChunks(multipart));
  }
  if (body instanceof Uint8Array) return replayable(function* () { yield body; });
  if (body === null || typeof body === 'string') return body;
  throw new TypeError('Direct HTTP content must be text or bytes');
};

export const multipartBody = (entries: readonly HttpFormEntry[]): HttpMultipartBody => ({
  boundary: `floway-${crypto.randomUUID()}`,
  entries,
});
