import { test } from 'vitest';

import { withInlineImagesCompressed } from './compress-images.ts';
import type { ResponsesBoundaryCtx } from './types.ts';
import { type ImageProcessor, initImageProcessor } from '@floway-dev/platform';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalResponsesPayload, ResponsesInputContent, ResponsesInputItem, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {})(), testTelemetryModelIdentity));

const fixedProcessor: ImageProcessor = {
  compressToWebp: () => Promise.resolve(new Uint8Array([1, 2, 3])),
};

const invocation = (payload: CanonicalResponsesPayload): ResponsesBoundaryCtx => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { responses: {} } }),
  action: 'generate',
});

const contentContainers = {
  message: (content: ResponsesInputContent[]): ResponsesInputItem => ({ type: 'message', role: 'user', content }),
  function_output: (output: ResponsesInputContent[]): ResponsesInputItem => ({ type: 'function_call_output', call_id: 'call_function', output }),
  custom_output: (output: ResponsesInputContent[]): ResponsesInputItem => ({ type: 'custom_tool_call_output', call_id: 'call_custom', output }),
};

const imageUrlOf = (item: ResponsesInputItem): string | null | undefined => {
  const content = item.type === 'message'
    ? item.content
    : item.type === 'function_call_output' || item.type === 'custom_tool_call_output' ? item.output : undefined;
  return Array.isArray(content) ? content.find(part => part.type === 'input_image')?.image_url : undefined;
};

test.each(Object.entries(contentContainers))('compresses inline images in %s', async (_name, wrap) => {
  initImageProcessor(fixedProcessor);
  const ctx = invocation({
    model: 'gpt-test',
    input: [wrap([
      { type: 'input_text', text: 'look' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' },
    ])],
  });

  await withInlineImagesCompressed(ctx, stubRequest, okEvents);

  assertEquals(imageUrlOf(ctx.payload.input[0]), 'data:image/webp;base64,AQID');
});

test.each(Object.entries(contentContainers))('leaves remote images in %s untouched', async (_name, wrap) => {
  initImageProcessor(fixedProcessor);
  const ctx = invocation({
    model: 'gpt-test',
    input: [wrap([{ type: 'input_image', image_url: 'https://example.com/cat.png', detail: 'auto' }])],
  });

  await withInlineImagesCompressed(ctx, stubRequest, okEvents);

  assertEquals(imageUrlOf(ctx.payload.input[0]), 'https://example.com/cat.png');
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
        type: 'custom_tool_call_output',
        call_id: 'call_custom',
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

  // Two unique data URLs across five targets → exactly two compress calls.
  assertEquals(calls, 2);
});

test('reuses its compressed image when the same attempt payload is retried', async () => {
  let calls = 0;
  initImageProcessor({
    compressToWebp: () => {
      calls += 1;
      return Promise.resolve(new Uint8Array([1, 2, 3]));
    },
  });

  const ctx = invocation({
    model: 'gpt-test',
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' }],
    }],
  });

  await withInlineImagesCompressed(ctx, stubRequest, okEvents);
  await withInlineImagesCompressed(ctx, stubRequest, okEvents);

  assertEquals(calls, 1);
  assertEquals(imageUrlOf(ctx.payload.input[0]), 'data:image/webp;base64,AQID');

  const item = ctx.payload.input[0];
  if (item.type !== 'message' || !Array.isArray(item.content) || item.content[0]?.type !== 'input_image') throw new Error('expected image content');
  item.content[0].image_url = 'data:image/png;base64,BBBB';
  await withInlineImagesCompressed(ctx, stubRequest, okEvents);

  assertEquals(calls, 2);
});
