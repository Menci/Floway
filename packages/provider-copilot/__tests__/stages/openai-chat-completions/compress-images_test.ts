import { test } from 'vitest';

import { openAIChatCompletionsStages } from '../../../src/stages/openai-chat-completions/index.ts';
import { inspectRequestStage } from '../../pipeline-fixture.ts';
import { type ImageProcessor, initImageProcessor } from '@floway-dev/platform';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import { assert, assertEquals } from '@floway-dev/test-utils';

const fixedProcessor: ImageProcessor = {
  compressToWebp: () => Promise.resolve(new Uint8Array([1, 2, 3])),
};

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
  const rewrittenPayload = (await inspectRequestStage(openAIChatCompletionsStages, 'compress-images', payload)).payload;

  assertEquals(imageUrl(rewrittenPayload), 'data:image/webp;base64,AQID');
  assertEquals(imageUrl(payload), 'data:image/png;base64,AAAA');
  assert(rewrittenPayload !== payload);
  assert(rewrittenPayload.messages !== payload.messages);
  assert(rewrittenPayload.messages[0] !== payload.messages[0]);
  assert(rewrittenPayload.messages[1] === untouchedMessage);
  const rewritten = rewrittenPayload.messages[0].content;
  if (!Array.isArray(rewritten)) throw new Error('expected rewritten multipart content');
  assert(rewritten !== payload.messages[0].content);
  assert(rewritten[0] === textPart);
  assert(rewritten[1] !== imagePart);
  if (rewritten[1]?.type !== 'image_url') throw new Error('expected rewritten image part');
  assert(rewritten[1].image_url !== imagePart.image_url);
  assertEquals(rewritten[1].image_url.detail, 'high');
});
