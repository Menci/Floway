import { expect, test } from 'vitest';

import { decodeOpenAIImagesEditsStream, decodeOpenAIImagesGenerationsStream } from '../../src/openai-images/index.ts';
import { sseByteStream, sseFrame } from '../common/test-utils.ts';

test('OpenAI Images Generations decodes partial and completed image events', async () => {
  const partial = { type: 'image_generation.partial_image', partial_image_index: 0, b64_json: 'AQI=' };
  const completed = { type: 'image_generation.completed', b64_json: 'AQID' };
  const body = sseByteStream(sseFrame(JSON.stringify(partial)), sseFrame(JSON.stringify(completed)));
  expect(await Array.fromAsync(decodeOpenAIImagesGenerationsStream(body))).toEqual([
    { ok: true, value: { data: partial } },
    { ok: true, value: { data: completed } },
  ]);
});

test('OpenAI Images Edits preserves a named upstream SSE error as a protocol failure', async () => {
  const error = { error: { message: 'image service unavailable', type: 'server_error', request_id: 'req_1' } };
  const body = sseByteStream(sseFrame(JSON.stringify(error), 'error'));
  expect(await Array.fromAsync(decodeOpenAIImagesEditsStream(body))).toMatchObject([
    { ok: false, error: { kind: 'protocol', event: error, eventName: 'error', cause: { message: expect.stringContaining('image service unavailable') } } },
  ]);
});

test('OpenAI Images Generations rejects a present non-string type', async () => {
  const event = { type: 42, b64_json: 'AQI=' };
  const body = sseByteStream(sseFrame(JSON.stringify(event), 'image_generation.partial_image'));
  expect(await Array.fromAsync(decodeOpenAIImagesGenerationsStream(body))).toMatchObject([
    { ok: false, error: { kind: 'protocol', event, eventName: 'image_generation.partial_image', cause: { cause: 42 } } },
  ]);
});

test('OpenAI Images Edits accepts unnamed events and preserves open event names', async () => {
  const named = { b64_json: 'AQID' };
  const typed = { type: 'future.image.event', vendor: true };
  const unnamed = { vendor: true };
  const body = sseByteStream(sseFrame(JSON.stringify(named), 'image_edit.completed'), sseFrame(JSON.stringify(typed)), sseFrame(JSON.stringify(unnamed)));
  expect(await Array.fromAsync(decodeOpenAIImagesEditsStream(body))).toEqual([
    { ok: true, value: { data: named, eventName: 'image_edit.completed' } },
    { ok: true, value: { data: typed } },
    { ok: true, value: { data: unnamed } },
  ]);
});
