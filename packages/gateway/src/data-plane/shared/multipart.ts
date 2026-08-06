export interface MultipartParseLimits {
  readonly parts: number;
  readonly fields: number;
  readonly files: number;
  readonly headerBytes: number;
  readonly fieldBytes: number;
}

// Image edits are the widest multipart schema: 16 images plus one mask. A
// 64-part structural ceiling leaves 47 text fields, comfortably beyond the
// endpoint's declared scalar surface, while preventing tiny-part amplification.
// The 256 KiB field budget also covers the documented 32,000-character prompt
// at four UTF-8 bytes per code point.
// https://github.com/openai/openai-openapi/blob/a3276900e58b8b2a92e0cb087cd2e6e005f58458/openapi.yaml#L44745-L44820
export const DEFAULT_MULTIPART_PARSE_LIMITS: MultipartParseLimits = {
  parts: 64,
  fields: 47,
  files: 17,
  headerBytes: 16 * 1024,
  fieldBytes: 256 * 1024,
};

export type MultipartLimitKind = 'parts' | 'fields' | 'files' | 'header-bytes' | 'field-bytes';

export type MultipartFormDataResult =
  | { readonly type: 'ok'; readonly form: FormData }
  | { readonly type: 'invalid' }
  | { readonly type: 'limit'; readonly kind: MultipartLimitKind; readonly max: number };

const CRLF = Uint8Array.of(0x0D, 0x0A);
const HEADER_TERMINATOR = Uint8Array.of(0x0D, 0x0A, 0x0D, 0x0A);
const DASH = 0x2D;

const assertLimit = (name: keyof MultipartParseLimits, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Multipart parse limit ${name} must be a non-negative safe integer`);
  }
};

const boundaryFromContentType = (contentType: string): Uint8Array | null => {
  const match = /(?:^|;)\s*boundary=(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/iu.exec(contentType);
  const quoted = match?.[1];
  const raw = quoted === undefined ? match?.[2] : quoted.replace(/\\(.)/gu, '$1');
  // RFC 2046 §5.1.1 caps boundary values at 70 characters.
  // https://www.rfc-editor.org/rfc/rfc2046#section-5.1.1
  if (raw === undefined || raw.length === 0 || raw.length > 70 || !/^[\x20-\x7E]+$/u.test(raw)) return null;
  return new TextEncoder().encode(raw);
};

const startsWithBytes = (source: Uint8Array, expected: Uint8Array, offset: number): boolean => {
  if (offset < 0 || offset + expected.byteLength > source.byteLength) return false;
  for (let index = 0; index < expected.byteLength; index++) {
    if (source[offset + index] !== expected[index]) return false;
  }
  return true;
};

const searchTable = (needle: Uint8Array): Uint32Array => {
  const table = new Uint32Array(needle.byteLength);
  let matched = 0;
  for (let index = 1; index < needle.byteLength;) {
    if (needle[index] === needle[matched]) table[index++] = ++matched;
    else if (matched > 0) matched = table[matched - 1]!;
    else table[index++] = 0;
  }
  return table;
};

const indexOfBytes = (
  source: Uint8Array,
  needle: Uint8Array,
  start: number,
  end = source.byteLength,
): number => {
  if (needle.byteLength === 0) return Math.min(start, end);
  const table = searchTable(needle);
  let matched = 0;
  for (let index = start; index < end; index++) {
    while (matched > 0 && source[index] !== needle[matched]) matched = table[matched - 1]!;
    if (source[index] !== needle[matched]) continue;
    matched += 1;
    if (matched === needle.byteLength) return index - needle.byteLength + 1;
  }
  return -1;
};

const headerSegments = (value: string): string[] | null => {
  const segments: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === ';') {
      segments.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quoted || escaped) return null;
  segments.push(value.slice(start).trim());
  return segments;
};

const headerParameterValue = (raw: string): string | null => {
  const value = raw.trim();
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"') || value.length < 2) return null;
  let decoded = '';
  for (let index = 1; index < value.length - 1; index++) {
    const character = value[index]!;
    if (character !== '\\') {
      decoded += character;
      continue;
    }
    index += 1;
    if (index >= value.length - 1) return null;
    decoded += value[index]!;
  }
  return decoded;
};

interface ParsedPartHeaders {
  readonly name: string;
  readonly filename: string | undefined;
  readonly contentType: string;
}

const decodeExtendedFilename = (value: string): string | null => {
  const match = /^utf-8'[^']*'(.*)$/iu.exec(value);
  if (match === null) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
};

const parsePartHeaders = (headerBytes: Uint8Array): ParsedPartHeaders | null => {
  const headers = new Map<string, string>();
  for (const line of new TextDecoder().decode(headerBytes).split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) return null;
    const name = line.slice(0, separator).trim().toLowerCase();
    if (headers.has(name)) return null;
    headers.set(name, line.slice(separator + 1).trim());
  }

  const disposition = headers.get('content-disposition');
  if (disposition === undefined) return null;
  const segments = headerSegments(disposition);
  if (segments === null || segments[0]?.toLowerCase() !== 'form-data') return null;
  const parameters = new Map<string, string>();
  for (const segment of segments.slice(1)) {
    const separator = segment.indexOf('=');
    if (separator <= 0) return null;
    const name = segment.slice(0, separator).trim().toLowerCase();
    const value = headerParameterValue(segment.slice(separator + 1));
    if (value === null || parameters.has(name)) return null;
    parameters.set(name, value);
  }
  const name = parameters.get('name');
  if (name === undefined) return null;
  const encodedFilename = parameters.get('filename*');
  const filename = parameters.get('filename')
    ?? (encodedFilename === undefined ? undefined : decodeExtendedFilename(encodedFilename));
  if (encodedFilename !== undefined && filename === null) return null;
  return {
    name,
    filename: filename ?? undefined,
    contentType: headers.get('content-type') ?? 'application/octet-stream',
  };
};

interface MultipartPart {
  readonly headers: ParsedPartHeaders;
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

type MultipartPreflightResult =
  | Exclude<MultipartFormDataResult, { readonly type: 'ok' }>
  | { readonly type: 'ok'; readonly parts: readonly MultipartPart[] };

const preflightMultipart = (
  bytes: Uint8Array,
  contentType: string,
  limits: MultipartParseLimits,
): MultipartPreflightResult => {
  for (const [name, value] of Object.entries(limits) as Array<[keyof MultipartParseLimits, number]>) {
    assertLimit(name, value);
  }

  const boundary = boundaryFromContentType(contentType);
  if (boundary === null) return { type: 'invalid' };
  const delimiter = new Uint8Array(boundary.byteLength + 2);
  delimiter[0] = DASH;
  delimiter[1] = DASH;
  delimiter.set(boundary, 2);
  const innerDelimiter = new Uint8Array(delimiter.byteLength + 2);
  innerDelimiter.set(CRLF);
  innerDelimiter.set(delimiter, 2);

  if (!startsWithBytes(bytes, delimiter, 0)) return { type: 'invalid' };
  let cursor = delimiter.byteLength;
  let parts = 0;
  let fields = 0;
  let files = 0;
  const parsedParts: MultipartPart[] = [];

  for (;;) {
    if (bytes[cursor] === DASH && bytes[cursor + 1] === DASH) {
      cursor += 2;
      if (cursor === bytes.byteLength) return { type: 'ok', parts: parsedParts };
      return startsWithBytes(bytes, CRLF, cursor) && cursor + CRLF.byteLength === bytes.byteLength
        ? { type: 'ok', parts: parsedParts }
        : { type: 'invalid' };
    }
    if (!startsWithBytes(bytes, CRLF, cursor)) return { type: 'invalid' };
    cursor += CRLF.byteLength;

    const headerSearchEnd = Math.min(bytes.byteLength, cursor + limits.headerBytes + HEADER_TERMINATOR.byteLength);
    const headerEnd = indexOfBytes(bytes, HEADER_TERMINATOR, cursor, headerSearchEnd);
    if (headerEnd === -1) {
      return indexOfBytes(bytes, HEADER_TERMINATOR, cursor) === -1
        ? { type: 'invalid' }
        : { type: 'limit', kind: 'header-bytes', max: limits.headerBytes };
    }

    parts += 1;
    if (parts > limits.parts) return { type: 'limit', kind: 'parts', max: limits.parts };
    const headers = parsePartHeaders(bytes.subarray(cursor, headerEnd));
    if (headers === null) return { type: 'invalid' };
    const file = headers.filename !== undefined;
    if (file) {
      files += 1;
      if (files > limits.files) return { type: 'limit', kind: 'files', max: limits.files };
    } else {
      fields += 1;
      if (fields > limits.fields) return { type: 'limit', kind: 'fields', max: limits.fields };
    }

    const bodyStart = headerEnd + HEADER_TERMINATOR.byteLength;
    let next = indexOfBytes(bytes, innerDelimiter, bodyStart);
    for (;;) {
      if (next === -1) return { type: 'invalid' };
      const suffix = next + innerDelimiter.byteLength;
      if (startsWithBytes(bytes, CRLF, suffix) || (bytes[suffix] === DASH && bytes[suffix + 1] === DASH)) break;
      next = indexOfBytes(bytes, innerDelimiter, next + CRLF.byteLength);
    }
    if (!file && next - bodyStart > limits.fieldBytes) {
      return { type: 'limit', kind: 'field-bytes', max: limits.fieldBytes };
    }
    parsedParts.push({ headers, bodyStart, bodyEnd: next });
    cursor = next + CRLF.byteLength + delimiter.byteLength;
  }
};

// Validate framing and every structural budget before constructing a File or
// decoding field text. Native Response.formData() builds all entries first, so
// it cannot reject a tiny-part amplification attack before paying its memory
// cost; the bounded descriptors above keep that decision ahead of allocation.
export const parseMultipartFormData = async (
  bytes: Uint8Array,
  contentType: string,
  limits: MultipartParseLimits = DEFAULT_MULTIPART_PARSE_LIMITS,
): Promise<MultipartFormDataResult> => {
  const preflight = preflightMultipart(bytes, contentType, limits);
  if (preflight.type !== 'ok') return preflight;
  try {
    const form = new FormData();
    for (const part of preflight.parts) {
      const body = bytes.subarray(part.bodyStart, part.bodyEnd);
      if (part.headers.filename === undefined) {
        form.append(part.headers.name, new TextDecoder().decode(body));
      } else {
        form.append(part.headers.name, new File(
          [body as BlobPart],
          part.headers.filename,
          { type: part.headers.contentType },
        ));
      }
    }
    return { type: 'ok', form };
  } catch {
    return { type: 'invalid' };
  }
};

export const multipartLimitMessage = (result: Extract<MultipartFormDataResult, { readonly type: 'limit' }>): string => {
  switch (result.kind) {
  case 'parts': return `Multipart request body supports at most ${result.max} parts.`;
  case 'fields': return `Multipart request body supports at most ${result.max} text fields.`;
  case 'files': return `Multipart request body supports at most ${result.max} file fields.`;
  case 'header-bytes': return `Each multipart part header must not exceed ${result.max} bytes.`;
  case 'field-bytes': return `Each multipart text field must not exceed ${result.max} bytes.`;
  }
};

export const singleNonEmptyMultipartTextField = (form: FormData, name: string): string | undefined => {
  const values = form.getAll(name);
  if (values.length !== 1) return undefined;
  const [value] = values;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};
