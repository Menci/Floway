import { expect, test } from 'vitest';

import { jsonRequestBody } from '../src/json-request.ts';

const readChunks = async (body: ReturnType<typeof jsonRequestBody>): Promise<Uint8Array[]> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body.open()) chunks.push(chunk);
  return chunks;
};

test.each([
  { plain: 'text', escaped: '\b\f\n\r\t"\\', unicode: '中文😀', lone: '\ud800' },
  { array: [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -0] },
  { exponent: 1e21, negativeExponent: -1e21, largeInteger: 1e20 },
  { omitted: undefined, retained: true, order: { second: 2, first: 1 } },
])('matches JSON.stringify bytes for JSON request values', async value => {
  const expected = JSON.stringify(value);
  const body = jsonRequestBody(value);

  expect(body.contentLength).toBe(new TextEncoder().encode(expected).byteLength);
  expect(await new Response(body.open()).text()).toBe(expected);
  expect(await new Response(body.open()).text()).toBe(expected);
});

test('streams a multi-image document without coalescing the complete payload', async () => {
  const image = 'A'.repeat(1024 * 1024);
  const value = { input: Array.from({ length: 4 }, (_, index) => ({ index, image })) };
  const body = jsonRequestBody(value);

  const chunks = await readChunks(body);
  const decoder = new TextDecoder();
  const output = chunks.map(chunk => decoder.decode(chunk, { stream: true })).join('') + decoder.decode();

  expect(output).toBe(JSON.stringify(value));
  expect(Math.max(...chunks.map(chunk => chunk.byteLength))).toBeLessThan(body.contentLength / 2);
});

test('rejects circular request values before dispatch', () => {
  const value: { self?: unknown } = {};
  value.self = value;

  expect(() => jsonRequestBody(value)).toThrow('Converting circular structure to JSON');
});
