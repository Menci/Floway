import { test } from 'vitest';

import { copilotOpenAIChatCompletionsSetInitiatorHeader } from '../../../src/stages/openai-chat-completions/set-initiator-header.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import { applyProviderStage, type OpenAIChatCompletionsProbe, type ExecuteResult, eventResult } from '@floway-dev/test-utils';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: OpenAIChatCompletionsPayload): OpenAIChatCompletionsProbe => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { openaiChatCompletions: {} } }),
});

test('OpenAI Chat Completions initiator is user when the last message is from the user', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
  });

  await applyProviderStage(copilotOpenAIChatCompletionsSetInitiatorHeader, ctx, okEvents);

  assertEquals(ctx.headers.get('x-initiator'), 'user');
});

test('OpenAI Chat Completions initiator is agent when the last message is an assistant replay', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'previous answer' },
    ],
  });

  await applyProviderStage(copilotOpenAIChatCompletionsSetInitiatorHeader, ctx, okEvents);

  assertEquals(ctx.headers.get('x-initiator'), 'agent');
});

test('OpenAI Chat Completions initiator is agent when the last message is a tool result', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    messages: [
      { role: 'user', content: 'do the thing' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'do_thing', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'done' },
    ],
  });

  await applyProviderStage(copilotOpenAIChatCompletionsSetInitiatorHeader, ctx, okEvents);

  assertEquals(ctx.headers.get('x-initiator'), 'agent');
});

test('OpenAI Chat Completions initiator follows the final user role for a lifted-image-shaped message', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    messages: [
      { role: 'tool', tool_call_id: 'call_1', content: 'done' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Image output from tool call call_1:' },
          { type: 'image_url', image_url: { url: 'https://example.com/user.png' } },
        ],
      },
    ],
  });

  await applyProviderStage(copilotOpenAIChatCompletionsSetInitiatorHeader, ctx, okEvents);

  assertEquals(ctx.headers.get('x-initiator'), 'user');
});
