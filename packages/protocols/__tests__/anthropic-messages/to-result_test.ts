import { test } from 'vitest';

import type { AnthropicMessagesStreamEventEx } from '../../src/anthropic-messages/index.ts';
import { collectAnthropicMessagesProtocolEventsToResult } from '../../src/anthropic-messages/to-result.ts';
import { eventFrame } from '../../src/common/index.ts';
import { assertRejects } from '@floway-dev/test-utils';

test('collectAnthropicMessagesProtocolEventsToResult rejects streams without message_stop', async () => {
  async function* events() {
    const payloads: AnthropicMessagesStreamEventEx[] = [
      {
        type: 'message_start',
        message: {
          container: null, diagnostics: null, stop_details: null,
          id: 'msg_truncated',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          stop_reason: null,
          stop_sequence: null,
          usage: { cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: null, input_tokens: 3, output_tokens: 0 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { citations: null, type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'partial' },
      },
      {
        type: 'content_block_stop',
        index: 0,
      },
      {
        type: 'message_delta',
        delta: { container: null, stop_details: null, stop_reason: 'end_turn', stop_sequence: null },
        usage: { input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, server_tool_use: null, output_tokens: 1 },
      },
    ];

    for (const event of payloads) yield eventFrame(event);
  }

  await assertRejects(async () => await collectAnthropicMessagesProtocolEventsToResult(events()), Error, 'Anthropic Messages stream ended without a message_stop event.');
});
