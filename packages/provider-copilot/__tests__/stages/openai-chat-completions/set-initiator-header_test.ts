import { test } from 'vitest';

import { openAIChatCompletionsStages } from '../../../src/stages/openai-chat-completions/index.ts';
import { inspectRequestStage } from '../../pipeline-fixture.ts';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import { assertEquals } from '@floway-dev/test-utils';

test('OpenAI Chat Completions initiator is agent when the last message is a tool result', async () => {
  const payload: OpenAIChatCompletionsPayloadEx = {
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
  };

  assertEquals((await inspectRequestStage(openAIChatCompletionsStages, 'set-initiator-header', payload)).headers.get('x-initiator'), 'agent');
});

test('OpenAI Chat Completions initiator follows the final user role for a lifted-image-shaped message', async () => {
  const payload: OpenAIChatCompletionsPayloadEx = {
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
  };

  assertEquals((await inspectRequestStage(openAIChatCompletionsStages, 'set-initiator-header', payload)).headers.get('x-initiator'), 'user');
});
