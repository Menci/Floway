/**
 * Protobuf Encoding Helpers
 *
 * Low-level utilities for encoding protobuf wire format:
 * - Varint encoding (wire type 0)
 * - Length-delimited encoding (wire type 2)
 * - Fixed-width encoding (wire types 1, 5)
 * - google.protobuf.Value encoding for dynamic JSON-like data
 *
 * Workers-clean: pure Uint8Array + DataView, no Buffer.
 */

// Shared TextEncoder — reused across all string encodes on the outgoing path
// (tool defs, MCP schemas, ExecMcpResult bodies). TextEncoder has no internal
// buffered state that survives a call, so reuse is safe.
export const TEXT_ENCODER = /*@__PURE__*/ new TextEncoder();

// --- Basic Varint and Field Encoding ---

/**
 * Encode a varint (variable-length integer) for protobuf.
 * Supports both number and bigint for large values (e.g. append_seqno).
 */
export function encodeVarint(value: number | bigint): Uint8Array {
  // A 64-bit varint fits in at most 10 bytes; write into a fixed buffer and
  // return an owned slice so the caller can hold onto it independently.
  const scratch = new Uint8Array(10);
  let len = 0;
  let v = BigInt(value);
  if (v < 0n) {
    // Negative ints encode as two's-complement 64-bit varints (10 bytes). We
    // never emit negatives on the Cursor wire, but keep this defensive so a
    // stray negative doesn't loop forever.
    v = v + (1n << 64n);
  }
  while (v > 127n) {
    scratch[len++] = Number(v & 0x7fn) | 0x80;
    v >>= 7n;
  }
  scratch[len++] = Number(v);
  return scratch.slice(0, len);
}

/**
 * Encode a field tag `(field_number << 3) | wire_type` as a varint. Field
 * numbers ≥ 16 need a multi-byte tag, so this must never be truncated to a
 * single byte.
 */
export function encodeFieldTag(fieldNumber: number, wireType: number): Uint8Array {
  return encodeVarint((fieldNumber << 3) | wireType);
}

/**
 * Encode a string field in protobuf format.
 * Field format: (field_number << 3) | wire_type; string wire type = 2.
 */
export function encodeStringField(fieldNumber: number, value: string): Uint8Array {
  if (!value) return new Uint8Array(0);

  const tag = encodeFieldTag(fieldNumber, 2);
  const encoded = TEXT_ENCODER.encode(value);
  const length = encodeVarint(encoded.length);

  const result = new Uint8Array(tag.length + length.length + encoded.length);
  result.set(tag, 0);
  result.set(length, tag.length);
  result.set(encoded, tag.length + length.length);

  return result;
}

/**
 * Encode a uint32 field (varint, wire type 0). Omitted when zero — Cursor's
 * proto uses default-zero semantics, so a zero field tag is round-trip
 * equivalent and keeps frames minimal.
 */
export function encodeUint32Field(fieldNumber: number, value: number): Uint8Array {
  if (value === 0) return new Uint8Array(0);
  return concatBytes(encodeFieldTag(fieldNumber, 0), encodeVarint(value));
}

/**
 * Encode an int32 field (varint, wire type 0). Omitted when zero.
 */
export function encodeInt32Field(fieldNumber: number, value: number): Uint8Array {
  if (value === 0) return new Uint8Array(0);
  return concatBytes(encodeFieldTag(fieldNumber, 0), encodeVarint(value));
}

/**
 * Encode an int64 field (varint, wire type 0). Always emitted — a zero
 * seqno is meaningful on the Cursor wire.
 */
export function encodeInt64Field(fieldNumber: number, value: bigint): Uint8Array {
  return concatBytes(encodeFieldTag(fieldNumber, 0), encodeVarint(value));
}

/**
 * Encode a nested message field (length-delimited, wire type 2).
 */
export function encodeMessageField(fieldNumber: number, data: Uint8Array): Uint8Array {
  return concatBytes(encodeFieldTag(fieldNumber, 2), encodeVarint(data.length), data);
}

/**
 * Encode a bool field (varint, wire type 0).
 */
export function encodeBoolField(fieldNumber: number, value: boolean): Uint8Array {
  return concatBytes(encodeFieldTag(fieldNumber, 0), new Uint8Array([value ? 1 : 0]));
}

/**
 * Encode a double field (64-bit, wire type 1, little-endian).
 */
export function encodeDoubleField(fieldNumber: number, value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return concatBytes(encodeFieldTag(fieldNumber, 1), bytes);
}

/**
 * Concatenate multiple Uint8Arrays into one fresh ArrayBuffer-backed array.
 */
export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// --- google.protobuf.Value Encoding ---

/**
 * Encode a JavaScript value as google.protobuf.Value.
 *
 * oneof:
 *   field 1: null_value (enum NullValue = 0)
 *   field 2: number_value (double)
 *   field 3: string_value (string)
 *   field 4: bool_value (bool)
 *   field 5: struct_value (Struct)
 *   field 6: list_value (ListValue)
 */
export function encodeProtobufValue(value: unknown): Uint8Array {
  if (value === null || value === undefined) {
    // NullValue enum = 0. Emit the field explicitly (tag + 0) rather than via
    // encodeUint32Field, which omits zero values — an omitted oneof field
    // decodes as "no value" under a presence-keyed parser. Cursor's proto3
    // decoder reads either form as NULL_VALUE.
    return new Uint8Array([(1 << 3) | 0, 0]);
  }

  if (typeof value === 'number') {
    return encodeDoubleField(2, value);
  }

  if (typeof value === 'string') {
    return encodeStringField(3, value);
  }

  if (typeof value === 'boolean') {
    return encodeBoolField(4, value);
  }

  if (Array.isArray(value)) {
    const listBytes: Uint8Array[] = [];
    for (const item of value) {
      const itemValue = encodeProtobufValue(item);
      listBytes.push(encodeMessageField(1, itemValue));
    }
    const listValue = concatBytes(...listBytes);
    return encodeMessageField(6, listValue);
  }

  if (typeof value === 'object') {
    const structBytes: Uint8Array[] = [];
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const keyBytes = encodeStringField(1, key);
      const valBytes = encodeMessageField(2, encodeProtobufValue(val));
      const mapEntry = concatBytes(keyBytes, valBytes);
      structBytes.push(encodeMessageField(1, mapEntry));
    }
    const structValue = concatBytes(...structBytes);
    return encodeMessageField(5, structValue);
  }

  return encodeStringField(3, String(value));
}

// --- Hex helpers (Workers-clean replacement for Buffer.from(...).toString('hex')) ---

const HEX_DIGITS = '0123456789abcdef';

/** Encode a Uint8Array as a lowercase hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += HEX_DIGITS[(b >>> 4) & 0xf]! + HEX_DIGITS[b & 0xf]!;
  }
  return out;
}

/** Decode a lowercase/uppercase hex string into a Uint8Array. */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const len = clean.length;
  if (len % 2 !== 0) {
    throw new TypeError(`hexToBytes: odd-length hex string (${len})`);
  }
  const out = new Uint8Array(len / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = hexDigitValue(clean.charCodeAt(i * 2));
    const lo = hexDigitValue(clean.charCodeAt(i * 2 + 1));
    if (hi < 0 || lo < 0) {
      throw new TypeError(`hexToBytes: invalid hex digit at index ${i * 2}`);
    }
    out[i] = (hi << 4) | lo;
  }
  return out;
}

function hexDigitValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  return -1;
}
