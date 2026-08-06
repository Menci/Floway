export interface MultipartParseLimits {
  readonly parts: number;
  readonly fields: number;
  readonly files: number;
  readonly headerBytes: number;
  readonly fieldBytes: number;
  readonly fieldTotalBytes: number;
}

// Image edits are the widest multipart schema: 16 images plus one mask. A
// 64-part structural ceiling leaves 47 text fields, comfortably beyond the
// endpoint's declared scalar surface, while preventing tiny-part amplification.
// The 256 KiB field budget also covers the documented 32,000-character prompt
// at four UTF-8 bytes per code point; the 1 MiB aggregate prevents many valid
// fields from becoming a second large decoded representation together.
// https://github.com/openai/openai-openapi/blob/a3276900e58b8b2a92e0cb087cd2e6e005f58458/openapi.yaml#L44745-L44820
export const DEFAULT_MULTIPART_PARSE_LIMITS: MultipartParseLimits = {
  parts: 64,
  fields: 47,
  files: 17,
  headerBytes: 16 * 1024,
  fieldBytes: 256 * 1024,
  fieldTotalBytes: 1024 * 1024,
};

export type MultipartLimitKind =
  | 'parts'
  | 'fields'
  | 'files'
  | 'header-bytes'
  | 'field-bytes'
  | 'field-total-bytes';

type MultipartFailure =
  | { readonly type: 'invalid' }
  | { readonly type: 'limit'; readonly kind: MultipartLimitKind; readonly max: number };

export interface MultipartFileEntryValue {
  readonly name: string;
  readonly type: string;
  readonly bytes: Uint8Array;
}

export interface MultipartEntry {
  readonly name: string;
  readonly value: string | MultipartFileEntryValue;
}

export type MultipartEntriesResult =
  | { readonly type: 'ok'; readonly entries: readonly MultipartEntry[] }
  | MultipartFailure;

export type MultipartFormDataResult =
  | { readonly type: 'ok'; readonly form: FormData }
  | MultipartFailure;

const LF = 0x0A;
const CR = 0x0D;
const DASH = 0x2D;

const assertLimit = (name: keyof MultipartParseLimits, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Multipart parse limit ${name} must be a non-negative safe integer`);
  }
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

const boundaryFromContentType = (contentType: string): Uint8Array | null => {
  const segments = headerSegments(contentType);
  if (segments === null || segments[0]?.toLowerCase() !== 'multipart/form-data') return null;
  let raw: string | undefined;
  for (const segment of segments.slice(1)) {
    const separator = segment.indexOf('=');
    if (separator <= 0) return null;
    const name = segment.slice(0, separator).trim().toLowerCase();
    if (name !== 'boundary') continue;
    if (raw !== undefined) return null;
    const value = headerParameterValue(segment.slice(separator + 1));
    if (value === null) return null;
    raw = value;
  }
  // RFC 2046 §5.1.1 caps boundary values at 70 characters.
  // https://www.rfc-editor.org/rfc/rfc2046#section-5.1.1
  if (raw === undefined || raw.length === 0 || raw.length > 70 || !/^[\x20-\x7E]+$/u.test(raw)) return null;
  return new TextEncoder().encode(raw);
};

interface ParsedPartHeaders {
  readonly name: string;
  readonly filename: string | undefined;
  readonly contentType: string;
}

const parsePartHeaders = (headerBytes: Uint8Array): ParsedPartHeaders | null => {
  const headers = new Map<string, string>();
  for (const line of new TextDecoder().decode(headerBytes).split(/\r?\n/u)) {
    const separator = line.indexOf(':');
    if (separator <= 0) return null;
    const name = line.slice(0, separator).trim().toLowerCase();
    if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/u.test(name)) return null;
    // Node retains the last duplicate while workerd comma-combines indexed
    // headers. Neither behavior is portable for Content-Disposition, so reject
    // ambiguous part metadata at the common gateway boundary.
    // https://github.com/nodejs/undici/blob/01a912e49a50c48009ed2639d2a457a6ec26752a/lib/web/fetch/formdata-parser.js#L220-L331
    // https://github.com/capnproto/capnproto/blob/e9fa5c7dc98192fc0dc0098ec770db68f997a938/c%2B%2B/src/kj/compat/http.c%2B%2B#L742-L767
    if (headers.has(name)) return null;
    headers.set(name, line.slice(separator + 1).trim());
  }

  const disposition = headers.get('content-disposition');
  if (disposition === undefined) return null;
  // Node decodes legacy Content-Transfer-Encoding while workerd ignores it.
  // Reject it at the shared boundary so the same bytes cannot become different
  // uploads depending on the deployment runtime.
  // https://github.com/nodejs/undici/blob/01a912e49a50c48009ed2639d2a457a6ec26752a/lib/web/fetch/formdata-parser.js#L372-L390
  // https://github.com/cloudflare/workerd/blob/80c80a712532b012cbeaef4d08ff6ab15407e960/src/workerd/api/form-data.c%2B%2B#L213-L230
  if (headers.has('content-transfer-encoding')) return null;
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
  // Undici treats quoted `filename*` as a file name while workerd ignores the
  // unknown parameter and produces a scalar field. Reject the runtime-dependent
  // shape at the common boundary rather than changing its type by deployment.
  // https://github.com/nodejs/undici/blob/01a912e49a50c48009ed2639d2a457a6ec26752a/lib/web/fetch/formdata-parser.js#L297-L322
  // https://github.com/cloudflare/workerd/blob/80c80a712532b012cbeaef4d08ff6ab15407e960/src/workerd/api/form-data.c%2B%2B#L213-L230
  if (parameters.has('filename*')) return null;
  return {
    name,
    filename: parameters.get('filename'),
    contentType: headers.get('content-type') ?? 'application/octet-stream',
  };
};

interface HeaderTerminator {
  readonly headersEnd: number;
  readonly bodyStart: number;
}

const findHeaderTerminator = (
  source: Uint8Array,
  start: number,
  maxHeaderBytes: number,
): HeaderTerminator | 'limit' | null => {
  const boundedEnd = Math.min(source.byteLength, start + maxHeaderBytes + 4);
  let sawFirstNewline = false;
  let firstNewlineStart = -1;
  for (let index = start; index < source.byteLength; index++) {
    if (index >= boundedEnd) return 'limit';
    if (source[index] !== LF) continue;
    const newlineStart = index > start && source[index - 1] === CR ? index - 1 : index;
    if (sawFirstNewline) {
      return { headersEnd: firstNewlineStart, bodyStart: index + 1 };
    }
    sawFirstNewline = true;
    firstNewlineStart = newlineStart;
    if (index + 1 < source.byteLength && source[index + 1] !== LF && source[index + 1] !== CR) {
      sawFirstNewline = false;
      firstNewlineStart = -1;
    }
  }
  return null;
};

interface MultipartPart {
  readonly headers: ParsedPartHeaders;
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

type MultipartPreflightResult =
  | MultipartFailure
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
  const innerDelimiter = new Uint8Array(delimiter.byteLength + 1);
  // workerd accepts an omitted CR while Undici requires CRLF. Recognize both
  // wire forms so moving a deployment between the two targets does not narrow
  // a request the Cloudflare target previously accepted.
  // https://github.com/cloudflare/workerd/blob/80c80a712532b012cbeaef4d08ff6ab15407e960/src/workerd/api/form-data.c%2B%2B#L150-L184
  innerDelimiter[0] = LF;
  innerDelimiter.set(delimiter, 1);

  const firstDelimiter = startsWithBytes(bytes, delimiter, 0)
    ? 0
    : (() => {
        const prefixed = indexOfBytes(bytes, innerDelimiter, 0);
        return prefixed === -1 ? -1 : prefixed + 1;
      })();
  if (firstDelimiter === -1) return { type: 'invalid' };
  let cursor = firstDelimiter + delimiter.byteLength;
  let parts = 0;
  let fields = 0;
  let files = 0;
  let fieldBytes = 0;
  const parsedParts: MultipartPart[] = [];

  for (;;) {
    if (bytes[cursor] === DASH && bytes[cursor + 1] === DASH) {
      cursor += 2;
      if (cursor === bytes.byteLength) return { type: 'ok', parts: parsedParts };
      // RFC 2046 permits an arbitrary epilogue after the closing boundary's
      // line ending. Preserve the runtime parser behavior while still
      // rejecting bytes glued directly to the closing `--` marker.
      // https://www.rfc-editor.org/rfc/rfc2046#section-5.1.1
      if (bytes[cursor] === LF) return { type: 'ok', parts: parsedParts };
      if (bytes[cursor] === CR && bytes[cursor + 1] === LF) return { type: 'ok', parts: parsedParts };
      return { type: 'invalid' };
    }
    if (bytes[cursor] === LF) cursor += 1;
    else if (bytes[cursor] === CR && bytes[cursor + 1] === LF) cursor += 2;
    else return { type: 'invalid' };

    const headerTerminator = findHeaderTerminator(bytes, cursor, limits.headerBytes);
    if (headerTerminator === null) return { type: 'invalid' };
    if (headerTerminator === 'limit') return { type: 'limit', kind: 'header-bytes', max: limits.headerBytes };
    const { headersEnd: headerEnd, bodyStart } = headerTerminator;

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

    const next = indexOfBytes(bytes, innerDelimiter, bodyStart);
    if (next === -1) return { type: 'invalid' };
    const suffix = next + innerDelimiter.byteLength;
    if (!(bytes[suffix] === LF
      || (bytes[suffix] === CR && bytes[suffix + 1] === LF)
      || (bytes[suffix] === DASH && bytes[suffix + 1] === DASH))) {
      return { type: 'invalid' };
    }
    const bodyEnd = next > bodyStart && bytes[next - 1] === CR ? next - 1 : next;
    if (!file && bodyEnd - bodyStart > limits.fieldBytes) {
      return { type: 'limit', kind: 'field-bytes', max: limits.fieldBytes };
    }
    if (!file) {
      fieldBytes += bodyEnd - bodyStart;
      if (fieldBytes > limits.fieldTotalBytes) {
        return { type: 'limit', kind: 'field-total-bytes', max: limits.fieldTotalBytes };
      }
    }
    parsedParts.push({ headers, bodyStart, bodyEnd });
    cursor = suffix;
  }
};

// Validate framing and every structural budget before decoding field text.
// File entries remain exact views over the immutable request buffer so callers
// that can stream them do not need a second whole-file representation.
export const parseMultipartEntries = (
  bytes: Uint8Array,
  contentType: string,
  limits: MultipartParseLimits = DEFAULT_MULTIPART_PARSE_LIMITS,
): MultipartEntriesResult => {
  const preflight = preflightMultipart(bytes, contentType, limits);
  if (preflight.type !== 'ok') return preflight;
  try {
    const entries = preflight.parts.map((part): MultipartEntry => {
      const body = bytes.subarray(part.bodyStart, part.bodyEnd);
      if (part.headers.filename === undefined) {
        return { name: part.headers.name, value: new TextDecoder().decode(body) };
      }
      return {
        name: part.headers.name,
        value: { name: part.headers.filename, type: part.headers.contentType, bytes: body },
      };
    });
    return { type: 'ok', entries };
  } catch {
    return { type: 'invalid' };
  }
};

// Audio still exposes FormData to its provider contract. Materialize only after
// the same bounded parse; image edits consume parseMultipartEntries directly.
export const parseMultipartFormData = async (
  bytes: Uint8Array,
  contentType: string,
  limits: MultipartParseLimits = DEFAULT_MULTIPART_PARSE_LIMITS,
): Promise<MultipartFormDataResult> => {
  const parsed = parseMultipartEntries(bytes, contentType, limits);
  if (parsed.type !== 'ok') return parsed;
  try {
    const form = new FormData();
    for (const entry of parsed.entries) {
      if (typeof entry.value === 'string') form.append(entry.name, entry.value);
      else form.append(entry.name, new File(
        [entry.value.bytes as BlobPart],
        entry.value.name,
        { type: entry.value.type },
      ));
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
  case 'field-total-bytes': return `Multipart text fields must not exceed ${result.max} bytes in total.`;
  }
};

export const singleNonEmptyMultipartTextField = (form: FormData, name: string): string | undefined => {
  const values = form.getAll(name);
  if (values.length !== 1) return undefined;
  const [value] = values;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

export const singleNonEmptyMultipartTextEntry = (entries: readonly MultipartEntry[], name: string): string | undefined => {
  const values = entries.filter(entry => entry.name === name).map(entry => entry.value);
  if (values.length !== 1) return undefined;
  const [value] = values;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};
