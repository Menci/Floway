import { test } from 'vitest';

import { eventFrame } from '../../src/common/index.ts';
import { parseGeminiGenerateContentStream } from '../../src/gemini-generate-content/stream.ts';
import { sseFrame, sseFrameBody } from '../common/test-utils.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

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

test('parseGeminiGenerateContentStream surfaces malformed JSON with the upstream payload as context', async () => {
  await assertRejects(
    async () => await collect(parseGeminiGenerateContentStream(sseFrameBody(sseFrame('{not json')))),
    undefined,
    'Malformed upstream Gemini generateContent SSE JSON: {not json',
  );
});
