import { test } from 'vitest';

import { copilotAnthropicContentHasImage } from '../../../src/stages/anthropic-messages/set-vision-header.ts';
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

  const content = payload.messages[0]?.content;
  if (content === undefined) throw new Error('expected message content');
  assertEquals(copilotAnthropicContentHasImage(content), true);
});
