import { test } from 'vitest';

import { compressImages } from '../../../src/pipelines/openai-chat-completions/compress-images.ts';
import { runStage, type StageRequest } from '../stage.ts';
import { type ImageProcessor, initImageProcessor } from '@floway-dev/platform';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import { assert, assertEquals, stubProviderModel } from '@floway-dev/test-utils';

const fixedProcessor: ImageProcessor = {
  compressToWebp: () => Promise.resolve(new Uint8Array([1, 2, 3])),
};

const requestFor = (payload: OpenAIChatCompletionsPayloadEx): StageRequest<'openaiChatCompletions'> => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { openaiChatCompletions: {} } }),
});

const imageUrl = (payload: OpenAIChatCompletionsPayloadEx): string => {
  const part = (payload.messages[0].content as Array<{ type: string; image_url?: { url: string } }>).find(p => p.type === 'image_url');
  return part?.image_url?.url ?? '';
};

test('rewrites a base64 image_url data URL to a WebP data URL', async () => {
  initImageProcessor(fixedProcessor);

  const textPart = { type: 'text' as const, text: 'look' };
  const imagePart = { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,AAAA', detail: 'high' as const } };
  const untouchedMessage = { role: 'user' as const, content: [{ type: 'image_url' as const, image_url: { url: 'https://example.com/cat.png' } }] };
  const payload: OpenAIChatCompletionsPayloadEx = {
    model: 'gpt-test',
    messages: [
      {
        role: 'user',
        content: [textPart, imagePart],
      },
      untouchedMessage,
    ],
  };
  const request = requestFor(payload);

  const result = await runStage(compressImages, 'openaiChatCompletions', request);

  assertEquals(imageUrl(result.payload), 'data:image/webp;base64,AQID');
  assertEquals(imageUrl(payload), 'data:image/png;base64,AAAA');
  assert(result.payload !== payload);
  assert(result.payload.messages !== payload.messages);
  assert(result.payload.messages[0] !== payload.messages[0]);
  assert(result.payload.messages[1] === untouchedMessage);
  const rewritten = result.payload.messages[0].content;
  if (!Array.isArray(rewritten)) throw new Error('expected rewritten multipart content');
  assert(rewritten !== payload.messages[0].content);
  assert(rewritten[0] === textPart);
  assert(rewritten[1] !== imagePart);
  if (rewritten[1]?.type !== 'image_url') throw new Error('expected rewritten image part');
  assert(rewritten[1].image_url !== imagePart.image_url);
  assertEquals(rewritten[1].image_url.detail, 'high');
});
