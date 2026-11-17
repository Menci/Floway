import { test } from 'vitest';

import { doneFrame, eventFrame } from '../../src/common/index.ts';
import { parseGeminiGenerateContentStream } from '../../src/gemini-generate-content/stream.ts';
import { sseFrame, sseFrameBody } from '../common/test-utils.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

test('parseGeminiGenerateContentStream yields each JSON chunk and closes on EOF', async () => {
  const first = { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Hello' }] } }] };
  const terminal = { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: ' world' }] }, finishReason: 'STOP' as const }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 } };

  const frames = await collect(parseGeminiGenerateContentStream(sseFrameBody(
    sseFrame(JSON.stringify(first)),
    sseFrame(JSON.stringify(terminal)),
  )));

  // Gemini closes the stream at natural EOF; there is no `[DONE]` sentinel to
  // translate and the parser must not invent a done frame the upstream never sent.
  assertEquals(frames, [eventFrame(first), eventFrame(terminal)]);
});

test('parseGeminiGenerateContentStream skips empty data frames and honours an explicit terminator', async () => {
  const chunk = { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'hi' }] } }] };

  const frames = await collect(parseGeminiGenerateContentStream(sseFrameBody(
    sseFrame(''),
    sseFrame(JSON.stringify(chunk)),
    sseFrame('[DONE]'),
  )));

  assertEquals(frames, [eventFrame(chunk), doneFrame()]);
});

test('parseGeminiGenerateContentStream surfaces malformed JSON with the upstream payload as context', async () => {
  await assertRejects(
    async () => await collect(parseGeminiGenerateContentStream(sseFrameBody(sseFrame('{not json')))),
    undefined,
    'Malformed upstream Gemini generateContent SSE JSON: {not json',
  );
});
