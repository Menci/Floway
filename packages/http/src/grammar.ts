// Shared HTTP/1.1 grammar primitives (RFC 9110 / RFC 9112).

import { HttpProtocolError } from './errors.ts';

// RFC 9110 §5.6.2: token = 1*tchar; tchar = "!" / "#" / "$" / "%" / "&" /
// "'" / "*" / "+" / "-" / "." / "^" / "_" / "`" / "|" / "~" / DIGIT / ALPHA
export const TCHAR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// Module-scope so we never allocate a fresh decoder per request/response.
export const ASCII_DECODER = new TextDecoder();

// RFC 9110 §5.5 includes obs-text (%x80-FF) in field values and requires
// recipients to treat it as opaque data. Decode one byte to one code point;
// UTF-8 decoding would replace standalone obs-text and corrupt the field.
export const decodeHttp1Head = (bytes: Uint8Array): string => {
  let decoded = '';
  const chunkSize = 8192;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    decoded += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return decoded;
};

// RFC 9110 §5.6.3: OWS = *( SP / HTAB ). Strip from both ends of a
// field-value. Wrapped in a helper rather than exporting the bare
// `/g`-flag regex because a module-scope `/g` regex carries `lastIndex`
// and would become a footgun if anyone later switched to `.test`/`.exec`.
export const trimFieldValueOws = (value: string): string => value.replace(/^[\t ]+|[\t ]+$/g, '');

// RFC 9112 §4: status-line = HTTP-version SP status-code SP reason-phrase.
// The version group is non-capturing — no caller reads it — so capture
// indices are status=m[1], reason=m[2]. reason-phrase permits HTAB, SP,
// VCHAR, and obs-text; the empty alternative follows RFC 7230 erratum 4087.
export const STATUS_LINE = /^HTTP\/(?:1\.[01]) (\d{3}) ([\t\x20-\x7e\x80-\xff]*)$/;

// RFC 9110 §5.5: field-content = field-vchar / SP / HTAB / obs-fold;
// field-vchar = VCHAR / obs-text. The legal byte set inside a value is
// HTAB (0x09), SP (0x20), VCHAR (0x21-0x7E), and obs-text (0x80-0xFF).
// Anything else — NUL and the rest of the C0 control set (0x01-0x08,
// 0x0B-0x1F; CR/LF call out the smuggling shape directly) plus DEL
// (0x7F) — violates the grammar. Each caller passes a builder so the
// error message stays caller-shaped while the byte set lives in one
// place.
export const validateFieldValueBytes = (
  value: string,
  makeError: (hex: string) => HttpProtocolError,
): void => {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) {
      throw makeError(c.toString(16).padStart(2, '0'));
    }
  }
};

// RFC 9112 §3.2 request-target. We don't validate the full URI grammar
// — callers above us own that — but a CR/LF/SP/NUL/CTL/DEL byte would
// split the request line and smuggle a forged head past the header
// validators. The legal byte set is therefore VCHAR + obs-text
// (≥ 0x21, excluding DEL). Empty path is rejected up front; the field
// is mandatory.
export const validateRequestTargetBytes = (
  path: string,
  makeEmptyError: () => HttpProtocolError,
  makeByteError: (hex: string) => HttpProtocolError,
): void => {
  if (path.length === 0) {
    throw makeEmptyError();
  }
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    if (c < 0x21 || c === 0x7f) {
      throw makeByteError(c.toString(16).padStart(2, '0'));
    }
  }
};
