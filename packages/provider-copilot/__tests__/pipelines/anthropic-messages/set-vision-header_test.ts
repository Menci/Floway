import { test } from 'vitest';

import { setVisionHeader } from '../../../src/pipelines/anthropic-messages/set-vision-header.ts';
import { runStage, type StageRequest } from '../stage.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals } from '@floway-dev/test-utils';

const requestFor = (payload: AnthropicMessagesPayload): StageRequest<'anthropicMessages'> => ({
  payload,
  headers: new Headers(),
});

test('Anthropic Messages vision header set when an image is nested inside tool_result.content', async () => {
  const request = requestFor({
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

  const result = await runStage(setVisionHeader, 'anthropicMessages', request);

  assertEquals(result.headers.get('copilot-vision-request'), 'true');
});
