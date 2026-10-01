import { test } from 'vitest';

import { copilotAnthropicMessagesSetVisionHeader } from '../../../src/stages/anthropic-messages/set-vision-header.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { applyProviderStage, type AnthropicMessagesProbe, type ExecuteResult, eventResult } from '@floway-dev/test-utils';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: AnthropicMessagesPayload): AnthropicMessagesProbe => ({
  payload,
  headers: new Headers(),
  anthropicBeta: [],
  model: stubProviderModel({ endpoints: { anthropicMessages: {} } }),
});

test('Anthropic Messages vision header set when a top-level image block is present', async () => {
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

  await applyProviderStage(copilotAnthropicMessagesSetVisionHeader, ctx, okEvents);

  assertEquals(ctx.headers.get('copilot-vision-request'), 'true');
});

test('Anthropic Messages vision header set when an image is nested inside tool_result.content', async () => {
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

  await applyProviderStage(copilotAnthropicMessagesSetVisionHeader, ctx, okEvents);

  assertEquals(ctx.headers.get('copilot-vision-request'), 'true');
});

test('Anthropic Messages vision header absent when no image is present', async () => {
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

  await applyProviderStage(copilotAnthropicMessagesSetVisionHeader, ctx, okEvents);

  assertEquals(ctx.headers.has('copilot-vision-request'), false);
});
