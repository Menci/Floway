import { expect, test } from 'vitest';

import { parseMultipartFormData, type MultipartParseLimits } from '../../../src/data-plane/shared/multipart.ts';
import { assertEquals } from '@floway-dev/test-utils';

const encodeForm = async (entries: ReadonlyArray<readonly [string, string | File]>) => {
  const form = new FormData();
  for (const [name, value] of entries) form.append(name, value);
  const request = new Request('https://multipart.invalid', { method: 'POST', body: form });
  return {
    bytes: new Uint8Array(await request.arrayBuffer()),
    contentType: request.headers.get('content-type')!,
  };
};

const limits = (overrides: Partial<MultipartParseLimits> = {}): MultipartParseLimits => ({
  parts: 8,
  fields: 8,
  files: 8,
  headerBytes: 1024,
  fieldBytes: 1024,
  ...overrides,
});

test('bounded multipart parser accepts exact cardinality and preserves repeated entries', async () => {
  const input = await encodeForm([['tag', 'a'], ['tag', 'b']]);
  const parsed = await parseMultipartFormData(input.bytes, input.contentType, limits({ parts: 2, fields: 2 }));

  if (parsed.type !== 'ok') throw new Error(`expected parsed form, got ${parsed.type}`);
  assertEquals(parsed.form.getAll('tag'), ['a', 'b']);
});

test.each([
  ['parts', { parts: 1 }, [['a', ''], ['b', '']] as const],
  ['fields', { fields: 1 }, [['a', ''], ['b', '']] as const],
  ['files', { files: 1 }, [
    ['a', new File(['a'], 'a.txt')],
    ['b', new File(['b'], 'b.txt')],
  ] as const],
] as const)('bounded multipart parser rejects the first %s beyond its configured limit', async (kind, override, entries) => {
  const input = await encodeForm(entries);
  const parsed = await parseMultipartFormData(input.bytes, input.contentType, limits(override));

  expect(parsed).toEqual({ type: 'limit', kind, max: 1 });
});

test('bounded multipart parser rejects oversized headers and text fields with tiny injected limits', async () => {
  const input = await encodeForm([['long-name', 'abc']]);

  expect(await parseMultipartFormData(input.bytes, input.contentType, limits({ headerBytes: 8 })))
    .toEqual({ type: 'limit', kind: 'header-bytes', max: 8 });
  expect(await parseMultipartFormData(input.bytes, input.contentType, limits({ fieldBytes: 2 })))
    .toEqual({ type: 'limit', kind: 'field-bytes', max: 2 });
});

test('bounded multipart parser ignores boundary-like file bytes that are not delimiter lines', async () => {
  const input = await encodeForm([['file', new File(['before\r\n--not-the-generated-boundary\r\nafter'], 'x.bin')]]);
  const parsed = await parseMultipartFormData(input.bytes, input.contentType, limits({ files: 1, parts: 1 }));

  if (parsed.type !== 'ok') throw new Error(`expected parsed form, got ${parsed.type}`);
  const file = parsed.form.get('file');
  expect(file).toBeInstanceOf(File);
});

test('bounded multipart parser reports malformed framing without materializing FormData', async () => {
  const parsed = await parseMultipartFormData(
    new TextEncoder().encode('--broken\r\nmissing headers and close'),
    'multipart/form-data; boundary=broken',
    limits(),
  );

  expect(parsed).toEqual({ type: 'invalid' });
});
