import { test } from 'vitest';

import { withInlineImagesCompressed } from './compress-images.ts';
import { initImageProcessor } from '../../../../../image/index.ts';
import type { ImageProcessor } from '../../../../../image/types.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import { stubProvider, stubUpstreamModel, testTelemetryModelIdentity } from '../../../../../test-helpers.ts';
import type { ChatCompletionsInvocation, RequestContext } from '../../../../llm/interceptors.ts';
import { eventResult, type ExecuteResult } from '../../../../llm/shared/errors/result.ts';
import type { ChatCompletionsStreamEvent, ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

const stubRequest: RequestContext = {
  requestStartedAt: 0,
  statefulResponsesContext: { privatePayload: new Map(), newSyntheticIds: new Set() },  runtimeLocation: 'test',
  clientStream: false,
};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> {})(), testTelemetryModelIdentity));

const fixedProcessor: ImageProcessor = {
  compressToWebp: () => Promise.resolve(new Uint8Array([1, 2, 3])),
};

const invocation = (payload: ChatCompletionsPayload): ChatCompletionsInvocation => ({
  sourceApi: 'chat-completions',
  targetApi: 'chat-completions',
  model: payload.model,
  upstream: 'test-upstream',
  payload,
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel(),
  enabledFlags: new Set<string>(),
  headers: {},
});

const imageUrl = (payload: ChatCompletionsPayload): string => {
  const part = (payload.messages[0].content as Array<{ type: string; image_url?: { url: string } }>).find(p => p.type === 'image_url');
  return part?.image_url?.url ?? '';
};

test('rewrites a base64 image_url data URL to a WebP data URL', async () => {
  initImageProcessor(fixedProcessor);

  const ctx = invocation({
    model: 'gpt-test',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ],
  });

  await withInlineImagesCompressed(ctx, stubRequest, okEvents);

  assertEquals(imageUrl(ctx.payload), 'data:image/webp;base64,AQID');
});

test('leaves remote https image references untouched', async () => {
  initImageProcessor(fixedProcessor);

  const ctx = invocation({
    model: 'gpt-test',
    messages: [
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://example.com/cat.png' } }],
      },
    ],
  });

  await withInlineImagesCompressed(ctx, stubRequest, okEvents);

  assertEquals(imageUrl(ctx.payload), 'https://example.com/cat.png');
});
