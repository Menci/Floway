import { test } from 'vitest';

import { withVisionHeaderSet } from '../../../src/interceptors/openai-chat-completions/set-vision-header.ts';
import type { OpenAIChatCompletionsBoundaryCtx } from '../../../src/interceptors/openai-chat-completions/types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import { assertEquals, stubUpstreamModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';
import type { ExecuteResult } from '@floway-dev/upstream';
import { eventResult } from '@floway-dev/upstream';

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: OpenAIChatCompletionsPayloadEx): OpenAIChatCompletionsBoundaryCtx => ({
  payload,
  headers: new Headers(),
  model: stubUpstreamModel({ endpoints: { openaiChatCompletions: {} } }),
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

  await withVisionHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('copilot-vision-request'), 'true');
});
