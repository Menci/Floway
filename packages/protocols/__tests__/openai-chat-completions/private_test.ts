import { expect, test } from 'vitest';

import { accumulateOpenAIChatCompletionsPrivate, finalizeOpenAIChatCompletionsPrivate, OpenAIChatCompletionsAssistantMessagePrivate, type OpenAIChatCompletionsAssistantMessageSidecar, type OpenAIChatCompletionsPrivateDraft, type OpenAIChatCompletionsStreamEvent } from '../../src/openai-chat-completions/index.ts';
import { reassembleOpenAIChatCompletionsEvents } from '../../src/openai-chat-completions/reassemble.ts';

const sidecar: OpenAIChatCompletionsAssistantMessageSidecar = { upstreamProtocol: 'openaiChatCompletions', extraFields: { metadata: 'kept' } };

test('private text is incremental and sidecar is one terminal full value', () => {
  const state: OpenAIChatCompletionsPrivateDraft = {};
  accumulateOpenAIChatCompletionsPrivate(state, { reasoningText: '' });
  accumulateOpenAIChatCompletionsPrivate(state, { reasoningText: 'A' });
  accumulateOpenAIChatCompletionsPrivate(state, { sidecar });
  expect(finalizeOpenAIChatCompletionsPrivate(state)).toEqual({ reasoningText: 'A', sidecar });
  expect(() => accumulateOpenAIChatCompletionsPrivate(state, { sidecar })).toThrow('more than one sidecar');
  expect(() => accumulateOpenAIChatCompletionsPrivate(state, { reasoningText: 'late' })).toThrow('after the final sidecar');
  expect(() => finalizeOpenAIChatCompletionsPrivate({ reasoningText: '' })).toThrow('without its final sidecar');
  expect(finalizeOpenAIChatCompletionsPrivate({})).toBeUndefined();
});

test('reassembly carries private state through visible text and the terminal sidecar', async () => {
  const events = async function* (): AsyncGenerator<OpenAIChatCompletionsStreamEvent> {
    yield { id: 'private', object: 'chat.completion.chunk', model: 'm', created: 0, choices: [{ index: 0, delta: { [OpenAIChatCompletionsAssistantMessagePrivate]: { reasoningText: 'A' } }, finish_reason: null }] };
    yield { id: 'private', object: 'chat.completion.chunk', model: 'm', created: 0, choices: [{ index: 0, delta: { content: 'visible' }, finish_reason: 'stop' }] };
    yield { id: 'private', object: 'chat.completion.chunk', model: 'm', created: 0, choices: [{ index: 0, delta: { [OpenAIChatCompletionsAssistantMessagePrivate]: { sidecar } }, finish_reason: null }] };
  };
  const result = await reassembleOpenAIChatCompletionsEvents(events());
  expect(result.choices[0].message.content).toBe('visible');
  expect(result.choices[0].message[OpenAIChatCompletionsAssistantMessagePrivate]).toEqual({ reasoningText: 'A', sidecar });
});
