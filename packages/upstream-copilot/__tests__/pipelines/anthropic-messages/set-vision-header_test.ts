import { test } from 'vitest';

import { setVisionHeader } from '../../../src/pipelines/anthropic-messages/set-vision-header.ts';
import { inspectStages, type StageFixture } from '../inspect.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals, stubUpstreamModel } from '@floway-dev/test-utils';

const invocation = (payload: AnthropicMessagesPayload): StageFixture<'anthropicMessages'> => ({
  payload,
  headers: new Headers(),
  anthropicBeta: [],
  model: stubUpstreamModel({ endpoints: { anthropicMessages: {} } }),
});

test('Anthropic Messages vision header set when an image is nested inside tool_result.content', async () => {
  const fixture = invocation({
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

  const ctx = await inspectStages('anthropicMessages', setVisionHeader, fixture);

  assertEquals(ctx.headers.get('copilot-vision-request'), 'true');
});
