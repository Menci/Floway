import { TranslateInputException } from '../../../shared/input-error.ts';

const DATA_URL = /^data:([^,]*),([\s\S]*)$/;
const BASE64_MARKER = ';base64';

export interface ParsedDataURL {
  readonly media_type?: string;
  readonly data: string;
}

const bytesOfPercentEncodedData = (value: string): number[] => {
  const bytes: number[] = [];
  for (let index = 0; index < value.length;) {
    const encoded = value[index] === '%' ? value.slice(index + 1, index + 3) : '';
    if (/^[0-9a-f]{2}$/i.test(encoded)) {
      bytes.push(Number.parseInt(encoded, 16));
      index += 3;
      continue;
    }
    const codePoint = value.codePointAt(index)!;
    bytes.push(...new TextEncoder().encode(String.fromCodePoint(codePoint)));
    index += codePoint > 0xffff ? 2 : 1;
  }
  return bytes;
};

const stringOfBytes = (bytes: readonly number[]): string => {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return value;
};

export const parseDataURL = (url: string): ParsedDataURL => {
  const match = DATA_URL.exec(url);
  if (match === null) throw new TranslateInputException(`Expected a data URL, got '${url.slice(0, 32)}'.`);
  const header = match[1]!;
  const body = match[2]!;
  const encodedAsBase64 = header.toLowerCase().endsWith(BASE64_MARKER);
  const mediaType = encodedAsBase64 ? header.slice(0, -BASE64_MARKER.length) : header;
  const normalizedMediaType = mediaType.startsWith(';') ? `text/plain${mediaType}` : mediaType;
  const bytes = bytesOfPercentEncodedData(body);
  return {
    ...(normalizedMediaType === '' ? {} : { media_type: normalizedMediaType }),
    data: encodedAsBase64 ? stringOfBytes(bytes) : btoa(stringOfBytes(bytes)),
  };
};
