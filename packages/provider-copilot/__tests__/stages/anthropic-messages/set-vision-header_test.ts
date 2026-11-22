import { test } from 'vitest';

import { anthropicMessagesStages } from '../../../src/stages/anthropic-messages/index.ts';
import { inspectRequestStage } from '../../pipeline-fixture.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals } from '@floway-dev/test-utils';

test('Anthropic Messages vision header set when an image is nested inside tool_result.content', async () => {
  const payload: AnthropicMessagesPayload = {
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
  };

  const { headers } = await inspectRequestStage(anthropicMessagesStages, 'set-vision-header', payload);
  assertEquals(headers.get('copilot-vision-request'), 'true');
});
