import { test } from 'vitest';

import { withInlineImagesCompressed } from './compress-images.ts';
import type { ResponsesBoundaryCtx } from './types.ts';
import { type ImageProcessor, initImageProcessor } from '@floway-dev/platform';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {})(), testTelemetryModelIdentity));

const fixedProcessor: ImageProcessor = {
  compressToWebp: () => Promise.resolve(new Uint8Array([1, 2, 3])),
};

const invocation = (payload: ResponsesPayload): ResponsesBoundaryCtx => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { responses: {} } }),
  action: 'generate',
});

const firstImageUrl = (payload: ResponsesPayload): string => {
  const input = payload.input as Array<{ type: string; content?: Array<{ type: string; image_url?: string }> }>;
  const message = input.find(item => item.type === 'message');
  const image = message?.content?.find(part => part.type === 'input_image');
  return image?.image_url ?? '';
};

test('rewrites a base64 input_image data URL to a WebP data URL', async () => {
  initImageProcessor(fixedProcessor);

  const ctx = invocation({
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'look' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' },
        ],
      },
    ],
  });

  await withInlineImagesCompressed(ctx, stubRequest, okEvents);

  assertEquals(firstImageUrl(ctx.payload), 'data:image/webp;base64,AQID');
});

test('leaves remote https image references untouched', async () => {
  initImageProcessor(fixedProcessor);

  const ctx = invocation({
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: 'https://example.com/cat.png', detail: 'auto' }],
      },
    ],
  });

  await withInlineImagesCompressed(ctx, stubRequest, okEvents);

  assertEquals(firstImageUrl(ctx.payload), 'https://example.com/cat.png');
});

test('compresses base64 images inside function_call_output tool outputs', async () => {
  initImageProcessor(fixedProcessor);

  const ctx = invocation({
    model: 'gpt-test',
    input: [
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [
          { type: 'input_text', text: 'screenshot' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' },
        ],
      },
    ],
  });

  await withInlineImagesCompressed(ctx, stubRequest, okEvents);

  const output = (ctx.payload.input as Array<{ type: string; output?: Array<{ type: string; image_url?: string }> }>)[0].output;
  assertEquals(output?.find(part => part.type === 'input_image')?.image_url, 'data:image/webp;base64,AQID');
});

test('compresses each unique inline image only once when the same data URL appears multiple times', async () => {
  let calls = 0;
  initImageProcessor({
    compressToWebp: () => {
      calls += 1;
      return Promise.resolve(new Uint8Array([1, 2, 3]));
    },
  });

  const ctx = invocation({
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' },
        ],
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,BBBB', detail: 'auto' }],
      },
    ],
  });

  await withInlineImagesCompressed(ctx, stubRequest, okEvents);

  // Two unique data URLs across four targets → exactly two compress calls.
  assertEquals(calls, 2);
});
