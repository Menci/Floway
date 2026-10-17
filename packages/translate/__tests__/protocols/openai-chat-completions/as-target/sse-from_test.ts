import { expect, test } from 'vitest';

import type { OpenAIChatCompletionsInputAssistantTurn } from '../../../../src/protocols/openai-chat-completions/as-target/assistant-turn.ts';
import { irFromOpenAIChatCompletions } from '../../../../src/protocols/openai-chat-completions/as-target/sse-from.ts';
import type { RoundTripReader } from '../../../../src/round-trip/stream.ts';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

const chunk = (choices: OpenAIChatCompletionsStreamEvent['choices']) => eventFrame<OpenAIChatCompletionsStreamEvent>({
  id: 'chatcmpl', object: 'chat.completion.chunk', created: 1, model: 'model', choices,
});

const drain = async (frames: ReturnType<typeof chunk>[]): Promise<Map<number, OpenAIChatCompletionsInputAssistantTurn>> => {
  const turns = new Map<number, OpenAIChatCompletionsInputAssistantTurn>();
  const roundTrip: RoundTripReader<'openaiChatCompletions'> = {
    onAssistantTurn: (choice, turn) => { turns.set(choice, turn); },
  };
  for await (const _record of irFromOpenAIChatCompletions((async function* () { yield* frames; yield doneFrame(); })(), { maxChoices: 2, roundTrip })) {}
  return turns;
};

test('finalizes each Chat choice independently while another choice has partial audio', async () => {
  const turns = await drain([
    chunk([
      { index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' },
      { index: 1, delta: { role: 'assistant', audio: { id: 'audio', data: 'YQ==' } }, finish_reason: null },
    ]),
    chunk([{ index: 1, delta: { audio: { transcript: 'a', expires_at: 10 } }, finish_reason: 'stop' }]),
  ]);

  expect(turns.get(0)).toMatchObject({ role: 'assistant', content: 'done' });
  expect(turns.get(1)).toMatchObject({ role: 'assistant', audio: { id: 'audio' } });
});

test('rejects incomplete audio when its own Chat choice finalizes', async () => {
  await expect(drain([
    chunk([{ index: 0, delta: { role: 'assistant', audio: { id: 'audio', data: 'YQ==' } }, finish_reason: 'stop' }]),
  ])).rejects.toThrow('audio ended without its complete metadata');
});

test('collects a native assistant turn for a finish-only Chat choice with omitted delta', async () => {
  const choice = { index: 0, delta: {}, finish_reason: 'stop' as const };
  Reflect.deleteProperty(choice, 'delta');
  expect(choice).not.toHaveProperty('delta');

  const turns = await drain([chunk([choice])]);

  expect([...turns]).toEqual([[0, { role: 'assistant', content: null, refusal: null }]]);
});

test('collects every native Chat choice when a sibling omits delta', async () => {
  const emptyChoice = { index: 0, delta: {}, finish_reason: 'stop' as const };
  Reflect.deleteProperty(emptyChoice, 'delta');
  expect(emptyChoice).not.toHaveProperty('delta');
  const delta = { role: 'assistant' as const, content: 'Hello', reasoning_content: 'Think', provider_specific_fields: { trace: 'native' } };

  const turns = await drain([
    chunk([emptyChoice, { index: 1, delta, finish_reason: null }]),
    chunk([{ index: 1, delta: { content: ' world' }, finish_reason: 'stop' }]),
  ]);

  expect([...turns]).toEqual([
    [0, { role: 'assistant', content: null, refusal: null }],
    [1, { role: 'assistant', content: 'Hello world', refusal: null, reasoning_content: 'Think', provider_specific_fields: { trace: 'native' } }],
  ]);
});
