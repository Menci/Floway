import { describe, expect, test } from 'vitest';

import { decodeVarint, parseProtoFields } from './decoding.ts';
import { encodeDoubleField, encodeFieldTag, encodeInt32Field, encodeMessageField, encodeStringField } from './encoding.ts';
import { decodeStreamCppResponse, encodeStreamCppRequest } from './stream-cpp.ts';

describe('encodeFieldTag (varint tags — regression for fields >= 16)', () => {
  test('single-byte tag for field <= 15', () => {
    expect(Array.from(encodeFieldTag(1, 2))).toEqual([(1 << 3) | 2]);
    expect(Array.from(encodeFieldTag(15, 0))).toEqual([(15 << 3) | 0]); // 120
  });
  test('multi-byte varint tag for field >= 16', () => {
    // field 16, wire 2 → tag 130 → varint [0x82, 0x01]
    expect(Array.from(encodeFieldTag(16, 2))).toEqual([0x82, 0x01]);
    // field 21, wire 1 (double) → tag 169 → varint [0xa9, 0x01]
    expect(Array.from(encodeFieldTag(21, 1))).toEqual([0xa9, 0x01]);
  });
  test('field encoders emit correctly-tagged fields for field >= 16', () => {
    // A string at field 20 must round-trip through the generic parser.
    const bytes = encodeStringField(20, 'hi');
    const fields = parseProtoFields(bytes);
    expect(fields).toHaveLength(1);
    expect(fields[0].fieldNumber).toBe(20);
    expect(fields[0].wireType).toBe(2);
    // A double at field 24 must not corrupt the following field.
    const combined = new Uint8Array([...encodeDoubleField(24, 3), ...encodeInt32Field(8, 42)]);
    const parsed = parseProtoFields(combined);
    expect(parsed.map(f => f.fieldNumber)).toEqual([24, 8]);
    expect(parsed[1].value).toBe(42);
  });
});

describe('encodeStreamCppRequest', () => {
  test('encodes current_file + model_name + timestamps without misaligning fields', () => {
    const bytes = encodeStreamCppRequest({
      relativePath: 'a.py', contents: 'x = ', cursorLine: 0, cursorColumn: 4, languageId: 'python', modelName: 'fast',
    });
    const top = parseProtoFields(bytes);
    const byNum = new Map(top.map(f => [f.fieldNumber, f]));
    // current_file=1 (msg), model_name=3 (string), file_diff_histories=7 (msg),
    // cpp_intent_info=16 (msg), client_time=21/time=23/24/tz=25 (double), lsp=26, supports_cpt=27/28.
    expect(byNum.has(1)).toBe(true);
    expect(byNum.get(3)!.wireType).toBe(2);
    expect(new TextDecoder().decode(byNum.get(3)!.value as Uint8Array)).toBe('fast');
    expect(byNum.has(16)).toBe(true); // survived past the >=16 boundary
    expect(byNum.get(21)!.wireType).toBe(1); // double
    // current_file nested: path=1, contents=2, cursor_position=3
    const cf = parseProtoFields(byNum.get(1)!.value as Uint8Array);
    const cfByNum = new Map(cf.map(f => [f.fieldNumber, f]));
    expect(new TextDecoder().decode(cfByNum.get(2)!.value as Uint8Array)).toBe('x = ');
    const pos = parseProtoFields(cfByNum.get(3)!.value as Uint8Array);
    expect(pos.find(f => f.fieldNumber === 2)!.value).toBe(4); // column
  });
});

// Build a StreamCppResponse frame body from field parts.
const respFrame = (parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

describe('decodeStreamCppResponse', () => {
  test('reads streamed text (field 1)', () => {
    expect(decodeStreamCppResponse(encodeStringField(1, 'return ')).text).toBe('return ');
  });
  test('reads range_to_replace (field 11) as a LineRange with exclusive end', () => {
    // LineRange { start_line=1, end_line=3 } → replace 1-indexed lines [1, 3)
    const range = respFrame([encodeInt32Field(1, 1), encodeInt32Field(2, 3)]);
    const decoded = decodeStreamCppResponse(encodeMessageField(11, range));
    expect(decoded.rangeToReplace).toEqual({ startLineNumber: 1, endLine: 3 });
  });
  test('reads done_stream (field 4)', () => {
    const bytes = respFrame([encodeFieldTag(4, 0), new Uint8Array([1])]);
    expect(decodeStreamCppResponse(bytes).doneStream).toBe(true);
  });
});

// Sanity: decodeVarint is used by the parser we rely on.
test('decodeVarint reads a 2-byte varint', () => {
  expect(decodeVarint(new Uint8Array([0x82, 0x01]), 0)).toEqual({ value: 130, bytesRead: 2 });
});
