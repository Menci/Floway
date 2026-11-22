import { test } from 'vitest';

import { stripCopilotCacheControlExtensions } from '../../../src/stages/anthropic-messages/strip-cache-control-extensions.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals } from '@floway-dev/test-utils';

test('strips scope and ttl from system, tools, and message content blocks while keeping the marker', async () => {
  const payload: AnthropicMessagesPayload = {
    model: 'claude-test',
    max_tokens: 10,
    system: [
      { type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'system' } as { type: 'ephemeral' } },
    ],
    tools: [
      { name: 't', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral', ttl: '1h' } as { type: 'ephemeral' } },
    ],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'q', cache_control: { type: 'ephemeral', scope: 'session' } as { type: 'ephemeral' } },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'u1', name: 't', input: {}, cache_control: { type: 'ephemeral', ttl: '5m' } as { type: 'ephemeral' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'u1', content: 'ok', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'session' } as { type: 'ephemeral' } },
        ],
      },
    ],
  };
  const rewritten = stripCopilotCacheControlExtensions(payload);

  assertEquals(rewritten.system, [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]);
  assertEquals(rewritten.tools, [{ name: 't', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }]);
  assertEquals(rewritten.messages[0].content, [{ type: 'text', text: 'q', cache_control: { type: 'ephemeral' } }]);
  assertEquals(rewritten.messages[1].content, [{ type: 'tool_use', id: 'u1', name: 't', input: {}, cache_control: { type: 'ephemeral' } }]);
  assertEquals(rewritten.messages[2].content, [{ type: 'tool_result', tool_use_id: 'u1', content: 'ok', cache_control: { type: 'ephemeral' } }]);
});
