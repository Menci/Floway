import { test } from 'vitest';

import { setInitiatorHeader } from '../../../src/pipelines/anthropic-messages/set-initiator-header.ts';
import { runStage, type StageRequest } from '../stage.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals } from '@floway-dev/test-utils';

const requestFor = (payload: AnthropicMessagesPayload): StageRequest<'anthropicMessages'> => ({
  payload,
  headers: new Headers(),
});

test('Anthropic Messages initiator is user when the last user turn mixes text and tool_result', async () => {
  const request = requestFor({
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

  const result = await runStage(setInitiatorHeader, 'anthropicMessages', request);

  assertEquals(result.headers.get('x-initiator'), 'user');
});

test('Anthropic Messages initiator is agent when the last user turn is entirely tool_result blocks', async () => {
  const request = requestFor({
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

  const result = await runStage(setInitiatorHeader, 'anthropicMessages', request);

  assertEquals(result.headers.get('x-initiator'), 'agent');
});
