import { test } from 'vitest';

import { withVisionHeaderSet } from './set-vision-header.ts';
import type { MessagesBoundaryCtx } from './types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: MessagesPayload): MessagesBoundaryCtx => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { messages: {} } }),
});

test('Messages vision header set when a top-level image block is present', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      },
    ],
  });

  await withVisionHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('copilot-vision-request'), 'true');
});

test('Messages vision header set when an image is nested inside tool_result.content', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_image',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            ],
          },
        ],
      },
    ],
  });

  await withVisionHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('copilot-vision-request'), 'true');
});

test('Messages vision header absent when no image is present', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_text',
            content: [{ type: 'text', text: 'plain result' }],
          },
        ],
      },
    ],
  });

  await withVisionHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.has('copilot-vision-request'), false);
});
