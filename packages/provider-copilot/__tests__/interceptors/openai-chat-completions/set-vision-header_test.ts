import { test } from 'vitest';

import { withVisionHeaderSet } from '../../../src/interceptors/openai-chat-completions/set-vision-header.ts';
import type { OpenAIChatCompletionsBoundaryCtx } from '../../../src/interceptors/openai-chat-completions/types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: OpenAIChatCompletionsPayload): OpenAIChatCompletionsBoundaryCtx => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { openaiChatCompletions: {} } }),
});

test('OpenAI Chat Completions vision header set when an image_url content part is present', async () => {
  const ctx = invocation({
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

  await withVisionHeaderSet(ctx, okEvents);

  assertEquals(ctx.headers.get('copilot-vision-request'), 'true');
});

test('OpenAI Chat Completions vision header absent when content is pure text', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    messages: [
      { role: 'user', content: 'plain string content' },
      { role: 'user', content: [{ type: 'text', text: 'array text only' }] },
    ],
  });

  await withVisionHeaderSet(ctx, okEvents);

  assertEquals(ctx.headers.has('copilot-vision-request'), false);
});
