import { test } from 'vitest';

import { openAIChatCompletionsStages } from '../../../src/stages/openai-chat-completions/index.ts';
import { inspectRequestStage } from '../../pipeline-fixture.ts';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import { assertEquals } from '@floway-dev/test-utils';

test('OpenAI Chat Completions vision header set when an image_url content part is present', async () => {
  const payload: OpenAIChatCompletionsPayloadEx = {
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
  };

  assertEquals((await inspectRequestStage(openAIChatCompletionsStages, 'set-vision-header', payload)).headers.get('copilot-vision-request'), 'true');
});
