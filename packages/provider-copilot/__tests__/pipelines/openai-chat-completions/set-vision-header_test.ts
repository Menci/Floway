import { test } from 'vitest';

import { setVisionHeader } from '../../../src/pipelines/openai-chat-completions/set-vision-header.ts';
import { runStage, type StageRequest } from '../stage.ts';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import { assertEquals } from '@floway-dev/test-utils';

const requestFor = (payload: OpenAIChatCompletionsPayloadEx): StageRequest<'openaiChatCompletions'> => ({
  payload,
  headers: new Headers(),
});

test('OpenAI Chat Completions vision header set when an image_url content part is present', async () => {
  const request = requestFor({
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

  const result = await runStage(setVisionHeader, 'openaiChatCompletions', request);

  assertEquals(result.headers.get('copilot-vision-request'), 'true');
});
