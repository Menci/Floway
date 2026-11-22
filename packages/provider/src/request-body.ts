import { jsonByteChunks } from './json-request.ts';
import { Bytes, type ManagedStream } from '@floway-dev/pipeline';

export interface MultipartFile {
  readonly bytes: Bytes;
  readonly filename: string;
  readonly contentType: string;
}

export type MultipartField =
  | { readonly kind: 'text'; readonly name: string; readonly value: string }
  | ({ readonly kind: 'file'; readonly name: string } & MultipartFile);

export interface MultipartRequestBody {
  readonly kind: 'multipart';
  readonly parts: readonly MultipartField[];
}

export interface JsonRequestBody {
  readonly kind: 'json';
  readonly value: object;
}

export type ProviderRequestBody = Bytes | ManagedStream<Bytes> | JsonRequestBody | MultipartRequestBody | null;

const normalizeNewlines = (value: string): string => value.replace(/\r\n|\r|\n/g, '\r\n');

// https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#multipart-form-data
const escapeQuotedValue = (value: string): string =>
  value.replaceAll('\r', '%0D').replaceAll('\n', '%0A').replaceAll('"', '%22');

export const encodeMultipartFormData = (
  parts: readonly MultipartField[],
  boundary: string,
): Bytes => {
  if (!/^[\w-]{1,70}$/.test(boundary)) throw new TypeError('Invalid multipart boundary');
  const chunks: Bytes[] = [];
  const crlf = Bytes.fromUtf8('\r\n');
  for (const part of parts) {
    const name = escapeQuotedValue(normalizeNewlines(part.name));
    const disposition = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"`;
    if (part.kind === 'text') {
      chunks.push(Bytes.fromUtf8(`${disposition}\r\n\r\n${normalizeNewlines(part.value)}\r\n`));
    } else {
      if (/[\r\n]/.test(part.contentType)) throw new TypeError('Invalid multipart file media type');
      const filename = escapeQuotedValue(part.filename);
      const contentType = part.contentType || 'application/octet-stream';
      chunks.push(Bytes.fromUtf8(`${disposition}; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`), part.bytes, crlf);
    }
  }
  chunks.push(Bytes.fromUtf8(`--${boundary}--\r\n`));
  return Bytes.concat(chunks);
};

export const encodeJsonRequest = (value: object): Bytes =>
  Bytes.concat(Array.from(jsonByteChunks(value), Bytes.adopt));
