import { test } from 'vitest';

import { withInlineImagesCompressed } from './compress-images.ts';
import type { ChatCompletionsBoundaryCtx } from './types.ts';
import { type ImageProcessor, initImageProcessor } from '@floway-dev/platform';
import type { ChatCompletionsStreamEvent, ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assert, assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> {})(), testTelemetryModelIdentity));

const fixedProcessor: ImageProcessor = {
  compressToWebp: () => Promise.resolve(new Uint8Array([1, 2, 3])),
};

const invocation = (payload: ChatCompletionsPayload): ChatCompletionsBoundaryCtx => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { chatCompletions: {} } }),
});

const imageUrl = (payload: ChatCompletionsPayload): string => {
  const part = (payload.messages[0].content as Array<{ type: string; image_url?: { url: string } }>).find(p => p.type === 'image_url');
  return part?.image_url?.url ?? '';
};

test('rewrites a base64 image_url data URL to a WebP data URL', async () => {
  initImageProcessor(fixedProcessor);

  const textPart = { type: 'text' as const, text: 'look' };
  const imagePart = { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,AAAA', detail: 'high' as const } };
  const untouchedMessage = { role: 'user' as const, content: [{ type: 'image_url' as const, image_url: { url: 'https://example.com/cat.png' } }] };
  const payload: ChatCompletionsPayload = {
    model: 'gpt-test',
    messages: [
      {
        role: 'user',
        content: [textPart, imagePart],
      },
      untouchedMessage,
    ],
  };
  const ctx = invocation(payload);

  await withInlineImagesCompressed(ctx, stubRequest, okEvents);

  assertEquals(imageUrl(ctx.payload), 'data:image/webp;base64,AQID');
  assertEquals(imageUrl(payload), 'data:image/png;base64,AAAA');
  assert(ctx.payload !== payload);
  assert(ctx.payload.messages !== payload.messages);
  assert(ctx.payload.messages[0] !== payload.messages[0]);
  assert(ctx.payload.messages[1] === untouchedMessage);
  const rewritten = ctx.payload.messages[0].content;
  if (!Array.isArray(rewritten)) throw new Error('expected rewritten multipart content');
  assert(rewritten !== payload.messages[0].content);
  assert(rewritten[0] === textPart);
  assert(rewritten[1] !== imagePart);
  if (rewritten[1]?.type !== 'image_url') throw new Error('expected rewritten image part');
  assert(rewritten[1].image_url !== imagePart.image_url);
  assertEquals(rewritten[1].image_url.detail, 'high');
});

test('leaves remote https image references untouched', async () => {
  initImageProcessor(fixedProcessor);

  const payload: ChatCompletionsPayload = {
    model: 'gpt-test',
    messages: [
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://example.com/cat.png' } }],
      },
    ],
  };
  const ctx = invocation(payload);

  await withInlineImagesCompressed(ctx, stubRequest, okEvents);

  assertEquals(imageUrl(ctx.payload), 'https://example.com/cat.png');
  assert(ctx.payload === payload);
});

test('compresses each unique inline image only once when the same data URL repeats', async () => {
  let calls = 0;
  initImageProcessor({
    compressToWebp: () => {
      calls += 1;
      return Promise.resolve(new Uint8Array([1, 2, 3]));
    },
  });

  const ctx = invocation({
    model: 'gpt-test',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ],
  });

  await withInlineImagesCompressed(ctx, stubRequest, okEvents);

  assertEquals(calls, 2);
});
