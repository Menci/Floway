import { test } from 'vitest';

import { withInitiatorHeaderSet } from '../../../src/interceptors/anthropic-messages/set-initiator-header.ts';
import type { AnthropicMessagesBoundaryCtx } from '../../../src/interceptors/anthropic-messages/types.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: AnthropicMessagesPayload): AnthropicMessagesBoundaryCtx => ({
  payload,
  headers: new Headers(),
  anthropicBeta: [],
  model: stubProviderModel({ endpoints: { messages: {} } }),
});

test('Anthropic Messages initiator is user when the last message is a plain user turn', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hello' }],
  });

  await withInitiatorHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('x-initiator'), 'user');
});

test('Anthropic Messages initiator is user when the last user turn mixes text and tool_result', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't_1', content: [{ type: 'text', text: 'result' }] },
          { type: 'text', text: 'follow-up question' },
        ],
      },
    ],
  });

  await withInitiatorHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('x-initiator'), 'user');
});

test('Anthropic Messages initiator is agent when the last user turn is entirely tool_result blocks', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't_1', content: [{ type: 'text', text: 'result' }] },
        ],
      },
    ],
  });

  await withInitiatorHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('x-initiator'), 'agent');
});

test('Anthropic Messages initiator is agent when the final message is from the assistant', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi back' },
    ],
  });

  await withInitiatorHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('x-initiator'), 'agent');
});
