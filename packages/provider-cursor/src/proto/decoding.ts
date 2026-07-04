/**
 * Protobuf Decoding Helpers
 *
 * Low-level utilities for decoding protobuf wire format: varint decoding,
 * field parsing, and google.protobuf.Value decoding. Pure Uint8Array +
 * DataView — no Buffer.
 */

// Shared TextDecoder — reused across every string decode on the incoming path
// (text_delta frames, tool call ids/args, KV blob keys, etc.). TextDecoder has
// no cross-call state for defaults ({ fatal: false, ignoreBOM: false }), so
// reuse is safe.
export const TEXT_DECODER = /*@__PURE__*/ new TextDecoder();

// Shared fatal-mode decoder for the KV blob "is this UTF-8 text?" probe path.
// Separate from TEXT_DECODER because the fatal option changes decode behavior.
export const TEXT_DECODER_FATAL = /*@__PURE__*/ new TextDecoder('utf-8', { fatal: true });

export interface ParsedField {
  fieldNumber: number;
  wireType: number;
  value: Uint8Array | number | bigint;
}

export function decodeVarint(data: Uint8Array, offset: number): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;

  while (offset + bytesRead < data.length) {
    const byte = data[offset + bytesRead];
    if (byte === undefined) break;
    value |= (byte & 0x7f) << shift;
    bytesRead++;

    if ((byte & 0x80) === 0) {
      break;
    }
    shift += 7;
  }

  return { value, bytesRead };
}

export function parseProtoFields(data: Uint8Array): ParsedField[] {
  const fields: ParsedField[] = [];
  let offset = 0;

  while (offset < data.length) {
    const tagInfo = decodeVarint(data, offset);
    offset += tagInfo.bytesRead;

    const fieldNumber = tagInfo.value >> 3;
    const wireType = tagInfo.value & 0x7;

    if (wireType === 2) {
      const lengthInfo = decodeVarint(data, offset);
      offset += lengthInfo.bytesRead;
      // subarray, not slice: parseProtoFields is called on owned frame
      // payloads that outlive the fields we hand back, and no caller mutates
      // the input in place — the copy was pure overhead.
      const value = data.subarray(offset, offset + lengthInfo.value);
      offset += lengthInfo.value;
      fields.push({ fieldNumber, wireType, value });
    } else if (wireType === 0) {
      const valueInfo = decodeVarint(data, offset);
      offset += valueInfo.bytesRead;
      fields.push({ fieldNumber, wireType, value: valueInfo.value });
    } else if (wireType === 1) {
      const value = data.subarray(offset, offset + 8);
      offset += 8;
      fields.push({ fieldNumber, wireType, value });
    } else if (wireType === 5) {
      const value = data.subarray(offset, offset + 4);
      offset += 4;
      fields.push({ fieldNumber, wireType, value });
    } else {
      break;
    }
  }

  return fields;
}

export function parseProtobufValue(data: Uint8Array): unknown {
  const fields = parseProtoFields(data);

  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 0) {
      return null;
    }
    if (field.fieldNumber === 2 && field.wireType === 1 && field.value instanceof Uint8Array) {
      const view = new DataView(field.value.buffer, field.value.byteOffset, 8);
      return view.getFloat64(0, true);
    }
    if (field.fieldNumber === 3 && field.wireType === 2 && field.value instanceof Uint8Array) {
      return TEXT_DECODER.decode(field.value);
    }
    if (field.fieldNumber === 4 && field.wireType === 0) {
      return field.value === 1;
    }
    if (field.fieldNumber === 5 && field.wireType === 2 && field.value instanceof Uint8Array) {
      return parseProtobufStruct(field.value);
    }
    if (field.fieldNumber === 6 && field.wireType === 2 && field.value instanceof Uint8Array) {
      return parseProtobufListValue(field.value);
    }
  }

  return undefined;
}

export function parseProtobufStruct(data: Uint8Array): Record<string, unknown> {
  const fields = parseProtoFields(data);
  const result: Record<string, unknown> = {};

  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
      const entryFields = parseProtoFields(field.value);
      let key = '';
      let value: unknown = undefined;

      for (const ef of entryFields) {
        if (ef.fieldNumber === 1 && ef.wireType === 2 && ef.value instanceof Uint8Array) {
          key = TEXT_DECODER.decode(ef.value);
        }
        if (ef.fieldNumber === 2 && ef.wireType === 2 && ef.value instanceof Uint8Array) {
          value = parseProtobufValue(ef.value);
        }
      }

      if (key) {
        result[key] = value;
      }
    }
  }

  return result;
}

export function parseProtobufListValue(data: Uint8Array): unknown[] {
  const fields = parseProtoFields(data);
  const result: unknown[] = [];

  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
      result.push(parseProtobufValue(field.value));
    }
  }

  return result;
}
