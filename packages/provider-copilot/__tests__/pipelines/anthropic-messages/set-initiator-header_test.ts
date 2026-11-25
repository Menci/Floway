import { test } from 'vitest';

import { setInitiatorHeader } from '../../../src/pipelines/anthropic-messages/set-initiator-header.ts';
import { inspectStages, type StageFixture } from '../inspect.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals, stubProviderModel } from '@floway-dev/test-utils';

const invocation = (payload: AnthropicMessagesPayload): StageFixture<'anthropicMessages'> => ({
  payload,
  headers: new Headers(),
  anthropicBeta: [],
  model: stubProviderModel({ endpoints: { anthropicMessages: {} } }),
});

test('Anthropic Messages initiator is user when the last user turn mixes text and tool_result', async () => {
  const fixture = invocation({
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

  const ctx = await inspectStages('anthropicMessages', setInitiatorHeader('anthropicMessages'), fixture);

  assertEquals(ctx.headers.get('x-initiator'), 'user');
});

test('Anthropic Messages initiator is agent when the last user turn is entirely tool_result blocks', async () => {
  const fixture = invocation({
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

  const ctx = await inspectStages('anthropicMessages', setInitiatorHeader('anthropicMessages'), fixture);

  assertEquals(ctx.headers.get('x-initiator'), 'agent');
});
