import { expect, test } from 'vitest';

import { eventFrame } from '../../src/common/index.ts';
import { decodeGeminiGenerateContentStream, parseGeminiGenerateContentStream } from '../../src/gemini-generate-content/stream.ts';
import { sseByteStream, sseFrame } from '../common/test-utils.ts';
import { assertEquals } from '@floway-dev/test-utils';

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

test('parseGeminiGenerateContentStream yields a pretty-printed bare error body as one error event', async () => {
  const chunk = { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Hel' }] } }] };
  const error = { error: { code: 500, message: 'Internal error encountered.', status: 'INTERNAL' } };
  const body = new Response(`data: ${JSON.stringify(chunk)}\n\n${JSON.stringify(error, null, 2)}\n`).body!;

  assertEquals(await collect(parseGeminiGenerateContentStream(body)), [eventFrame(chunk), eventFrame(error)]);
});

test.each([
  { field: 'content', content: null, cause: null },
  { field: 'content.parts', content: { role: 'model', parts: 42 }, cause: 42 },
])('Gemini rejects malformed candidate $field before emitting a typed event', async ({ field, content, cause }) => {
  const event = { candidates: [{ index: 0, finishReason: 'STOP', content }] };
  const body = sseByteStream(sseFrame(JSON.stringify(event)));
  expect(await collect(decodeGeminiGenerateContentStream(body))).toMatchObject([
    {
      ok: false,
      error: { kind: 'protocol', event, cause: { cause, message: expect.stringContaining(`candidates[0].${field}`) } },
    },
  ]);
});

test('Gemini preserves a finish-only candidate with an open finish reason', async () => {
  const event = { candidates: [{ index: 0, finishReason: 'VENDOR_FINISH' }] };
  const body = sseByteStream(sseFrame(JSON.stringify(event)));
  expect(await collect(decodeGeminiGenerateContentStream(body))).toEqual([{ ok: true, value: event }]);
});
