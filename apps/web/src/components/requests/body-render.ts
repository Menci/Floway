import { errorMessage } from '../../lib/error-message';
import type { DecodedStreamRef } from '@floway-dev/dump/browser';
import { Bytes } from '@floway-dev/pipeline/browser';
import { encodeBase64, isTextualMediaType, parseMediaType } from '@floway-dev/protocols/browser';

export interface RenderedBody {
  text: string;
  copyText: string;
  decodeError: string | null;
  isJson: boolean;
}

export const EMPTY_BODY: RenderedBody = { text: '', copyText: '', decodeError: null, isJson: false };

export const contentTypeOf = (headers: ReadonlyArray<readonly [string, unknown]>): string => {
  const value = headers.find(([name, value]) => name.toLowerCase() === 'content-type' && typeof value === 'string')?.[1];
  return typeof value === 'string' ? value : '';
};

const renderMultipart = (bytes: Uint8Array, contentType: string): string | null => {
  const boundaryMatch = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) return null;

  // Keep one code unit per byte so the multipart delimiter can be located
  // without a text decoder rewriting arbitrary binary parts.
  let wire = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    wire += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  const chunks = wire.split(`--${boundary}`);
  if (chunks.length < 3) return null;

  const rendered: string[] = [];
  for (const chunk of chunks.slice(1, -1)) {
    const part = chunk.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const separator = part.indexOf('\r\n\r\n');
    if (separator < 0) return null;
    const headers = part.slice(0, separator);
    const data = Uint8Array.from(part.slice(separator + 4), c => c.charCodeAt(0));
    const type = /^content-type:\s*(.+)$/im.exec(headers)?.[1]?.trim() ?? '';
    const text = !type || isTextualMediaType(type)
      ? new TextDecoder().decode(data)
      : encodeBase64(data).replace(/.{76}(?=.)/g, '$&\n');
    rendered.push(`${headers}\r\n\r\n${text}`);
  }
  return `--${boundary}\r\n${rendered.join(`\r\n--${boundary}\r\n`)}\r\n--${boundary}--\r\n`;
};

export const renderWireBody = (
  body: Bytes | DecodedStreamRef | null,
  headers: ReadonlyArray<readonly [string, unknown]>,
): RenderedBody => {
  if (!(body instanceof Bytes) || body.byteLength === 0) return EMPTY_BODY;
  const bytes = body.toUint8Array();
  const contentType = contentTypeOf(headers);
  if (parseMediaType(contentType)?.type === 'multipart') {
    const text = renderMultipart(bytes, contentType);
    if (text !== null) return { text, copyText: encodeBase64(bytes), decodeError: null, isJson: false };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    const encoded = encodeBase64(bytes);
    return { text: encoded, copyText: encoded, decodeError: errorMessage(error), isJson: false };
  }
  try {
    const pretty = JSON.stringify(JSON.parse(text) as unknown, null, 2);
    return { text: pretty, copyText: pretty, decodeError: null, isJson: true };
  } catch {
    return { text, copyText: text, decodeError: null, isJson: false };
  }
};
