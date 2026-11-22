import { formatDecodedJson } from './format-value';
import { decodeWebBase64, decodeWebBase64BinaryString, encodeBase64BinaryString } from '../../lib/base-encoding';
import { errorMessage } from '../../lib/error-message';
import { isDecodedStreamRef } from '@floway-dev/pipeline/browser';
import { isTextualMediaType, parseMediaType } from '@floway-dev/protocols/browser';

export interface RenderedBody {
  text: string;
  copyText: string;
  decodeError: string | null;
  isJson: boolean;
}

export const EMPTY_BODY: RenderedBody = { text: '', copyText: '', decodeError: null, isJson: false };

export const contentTypeOf = (headers: ReadonlyArray<readonly [string, unknown]>): string =>
  headers.find(([name, value]) => name.toLowerCase() === 'content-type' && typeof value === 'string')?.[1] as string | undefined ?? '';

export const renderBody = (body: { readonly encoding: 'utf8' | 'base64'; readonly data: string }, contentType: string): RenderedBody => {
  if (!body.data) return EMPTY_BODY;
  if (parseMediaType(contentType)?.type === 'multipart' && body.encoding === 'base64') {
    const multipart = renderMultipart(body.data, contentType);
    if (multipart !== null) {
      return { text: multipart, copyText: body.data, decodeError: null, isJson: false };
    }
  }

  let text = body.data;
  if (body.encoding === 'base64') {
    try {
      const bytes = decodeWebBase64(body.data);
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      return {
        text: body.data,
        copyText: body.data,
        decodeError: errorMessage(error),
        isJson: false,
      };
    }
  }

  try {
    const pretty = JSON.stringify(JSON.parse(text) as unknown, null, 2);
    return { text: pretty, copyText: pretty, decodeError: null, isJson: true };
  } catch {
    return { text, copyText: text, decodeError: null, isJson: false };
  }
};

const encodeBytes = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const renderMultipartParts = (parts: readonly unknown[]): RenderedBody => {
  const rendered: string[] = [];
  const boundary = parts.some(part => isRecord(part) && part.kind === 'file')
    ? 'floway-multipart-file'
    : 'floway-multipart';
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (part.kind === 'text' && typeof part.name === 'string' && typeof part.value === 'string') {
      rendered.push(`Content-Disposition: form-data; name=${JSON.stringify(part.name)}\r\n\r\n${part.value}`);
      continue;
    }
    if (part.kind === 'file' && typeof part.name === 'string' && part.bytes instanceof Uint8Array) {
      const type = typeof part.contentType === 'string' ? part.contentType : 'application/octet-stream';
      const filename = typeof part.filename === 'string' ? `; filename=${JSON.stringify(part.filename)}` : '';
      rendered.push(`Content-Disposition: form-data; name=${JSON.stringify(part.name)}${filename}\r\nContent-Type: ${type}\r\n\r\n[binary, ${part.bytes.byteLength} bytes, content-type=${type}]`);
    }
  }
  const text = rendered.length === 0
    ? ''
    : `--${boundary}\r\n${rendered.join(`\r\n--${boundary}\r\n`)}\r\n--${boundary}--\r\n`;
  return { text, copyText: text, decodeError: null, isJson: false };
};

export const renderWireBody = (body: unknown, headers: ReadonlyArray<readonly [string, unknown]>): RenderedBody => {
  if (body === null || body === undefined || isDecodedStreamRef(body)) return EMPTY_BODY;
  const contentType = contentTypeOf(headers);
  if (typeof body === 'string') return renderBody({ encoding: 'utf8', data: body }, contentType);
  if (body instanceof Uint8Array) {
    if (parseMediaType(contentType)?.type === 'multipart') {
      return renderBody({ encoding: 'base64', data: encodeBytes(body) }, contentType);
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
      try {
        const pretty = JSON.stringify(JSON.parse(text) as unknown, null, 2);
        return { text: pretty, copyText: pretty, decodeError: null, isJson: true };
      } catch {
        return { text, copyText: text, decodeError: null, isJson: false };
      }
    } catch (error) {
      const base64 = encodeBytes(body);
      return { text: base64, copyText: base64, decodeError: errorMessage(error), isJson: false };
    }
  }
  if (isRecord(body) && body.kind === 'json' && 'value' in body) {
    const formatted = formatDecodedJson(body.value);
    return { text: formatted, copyText: formatted, decodeError: null, isJson: true };
  }
  if (isRecord(body) && body.kind === 'raw' && body.bytes instanceof Uint8Array) {
    const nestedContentType = typeof body.contentType === 'string' && body.contentType ? body.contentType : contentType;
    return renderWireBody(body.bytes, [['content-type', nestedContentType]]);
  }
  if (isRecord(body) && body.kind === 'multipart' && Array.isArray(body.parts)) {
    return renderMultipartParts(body.parts);
  }
  const formatted = formatDecodedJson(body);
  return { text: formatted, copyText: formatted, decodeError: null, isJson: true };
};

const renderMultipart = (base64: string, contentType: string): string | null => {
  const boundaryMatch = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) return null;

  try {
    // The wire stays a binary string with one code unit per byte, so slicing it
    // and encoding a part back through the byte codec round-trips. Decoding it
    // through a text encoding first does not: the Encoding Standard resolves
    // latin1 to windows-1252 (https://encoding.spec.whatwg.org/#names-and-labels),
    // which maps 0x80-0x9F -- a PNG signature leads with 0x89 -- to code points
    // above 255.
    const wire = decodeWebBase64BinaryString(base64);
    const chunks = wire.split(`--${boundary}`);
    if (chunks.length < 3) return null;

    const rendered = chunks.slice(1, -1).map(chunk => {
      const part = chunk.replace(/^\r\n/, '').replace(/\r\n$/, '');
      const separator = part.indexOf('\r\n\r\n');
      if (separator < 0) throw new Error('Malformed multipart body');
      const headers = part.slice(0, separator);
      const data = part.slice(separator + 4);
      const type = /^content-type:\s*(.+)$/im.exec(headers)?.[1]?.trim() ?? '';
      const textual = !type || isTextualMediaType(type);
      if (textual) return `${headers}\r\n\r\n${new TextDecoder().decode(Uint8Array.from(data, c => c.charCodeAt(0)))}`;
      const encoded = encodeBase64BinaryString(data).replace(/.{76}(?=.)/g, '$&\n');
      return `${headers}\r\n\r\n[binary, ${data.length} bytes, content-type=${type}]\r\n${encoded}`;
    });
    return `--${boundary}\r\n${rendered.join(`\r\n--${boundary}\r\n`)}\r\n--${boundary}--\r\n`;
  } catch {
    return null;
  }
};
