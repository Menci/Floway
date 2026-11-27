import { test } from 'vitest';

import { setVisionHeader } from '../../../src/pipelines/openai-chat-completions/set-vision-header.ts';
import { inspectStages, type StageFixture } from '../inspect.ts';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import { assertEquals, stubUpstreamModel } from '@floway-dev/test-utils';

const invocation = (payload: OpenAIChatCompletionsPayloadEx): StageFixture<'openaiChatCompletions'> => ({
  payload,
  headers: new Headers(),
  model: stubUpstreamModel({ endpoints: { openaiChatCompletions: {} } }),
});

test('OpenAI Chat Completions vision header set when an image_url content part is present', async () => {
  const fixture = invocation({
    model: 'gpt-test',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ],
  });

  const ctx = await inspectStages('openaiChatCompletions', setVisionHeader, fixture);

  assertEquals(ctx.headers.get('copilot-vision-request'), 'true');
});
