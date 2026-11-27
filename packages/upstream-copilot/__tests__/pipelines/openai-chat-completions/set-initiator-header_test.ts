import { test } from 'vitest';

import { setInitiatorHeader } from '../../../src/pipelines/openai-chat-completions/set-initiator-header.ts';
import { inspectStages, type StageFixture } from '../inspect.ts';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import { assertEquals, stubUpstreamModel } from '@floway-dev/test-utils';

const invocation = (payload: OpenAIChatCompletionsPayloadEx): StageFixture<'openaiChatCompletions'> => ({
  payload,
  headers: new Headers(),
  model: stubUpstreamModel({ endpoints: { openaiChatCompletions: {} } }),
});

test('OpenAI Chat Completions initiator is agent when the last message is a tool result', async () => {
  const fixture = invocation({
    model: 'gpt-test',
    messages: [
      { role: 'user', content: 'do the thing' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'do_thing', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'done' },
    ],
  });

  const ctx = await inspectStages('openaiChatCompletions', setInitiatorHeader, fixture);

  assertEquals(ctx.headers.get('x-initiator'), 'agent');
});

test('OpenAI Chat Completions initiator follows the final user role for a lifted-image-shaped message', async () => {
  const fixture = invocation({
    model: 'gpt-test',
    messages: [
      { role: 'tool', tool_call_id: 'call_1', content: 'done' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Image output from tool call call_1:' },
          { type: 'image_url', image_url: { url: 'https://example.com/user.png' } },
        ],
      },
    ],
  });

  const ctx = await inspectStages('openaiChatCompletions', setInitiatorHeader, fixture);

  assertEquals(ctx.headers.get('x-initiator'), 'user');
});
