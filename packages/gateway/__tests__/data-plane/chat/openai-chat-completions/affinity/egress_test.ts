import { expect, test } from 'vitest';

import { wrapOpenAIChatCompletionsAffinityEgress } from '../../../../../src/data-plane/chat/openai-chat-completions/affinity/egress.ts';
import type { AffinityIdentity } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsAssistantDeltaEx, OpenAIChatCompletionsReasoningPreference, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

const affinity: AffinityIdentity = { upstreamId: 'up', modelId: 'm', opaqueBlobCompatibilityIdentity: { upstreamId: 'up', key: 'm' } };
const opaque: OpenAIChatCompletionsReasoningPreference = { textFieldName: 'reasoning', reasoningEncapsulationFormat: 'copilot-reasoning_opaque' };
const details: OpenAIChatCompletionsReasoningPreference = { textFieldName: 'reasoning', reasoningEncapsulationFormat: 'openrouter-reasoning_details' };
const chunk = (delta: OpenAIChatCompletionsAssistantDeltaEx, finish_reason: 'stop' | null = null, index = 0): ProtocolFrame<OpenAIChatCompletionsStreamEvent> => eventFrame({ id: 'chat', object: 'chat.completion.chunk', model: 'm', created: 0, choices: [{ index, delta, finish_reason }] });
const frames = async function* (values: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[]) { yield* values; };
const collect = async <T>(values: AsyncIterable<T>): Promise<T[]> => { const output: T[] = []; for await (const value of values) output.push(value); return output; };
const codec = { wrap: async (value: string | undefined) => `wrapped:${value ?? 'synthetic'}` };

test('wraps every complete opaque carrier as it arrives without keeping a payload snapshot', async () => {
  const input = [chunk({ reasoning_opaque: 'first', content: 'A' }), chunk({ reasoning_opaque: 'second', content: 'B' }, 'stop'), doneFrame()];
  const original = structuredClone(input);
  expect(await collect(wrapOpenAIChatCompletionsAffinityEgress(frames(input), { codec, affinity, preference: opaque }))).toEqual([
    chunk({ reasoning_opaque: 'wrapped:first', content: 'A' }), chunk({ reasoning_opaque: 'wrapped:second', content: 'B' }, 'stop'), doneFrame(),
  ]);
  expect(input).toEqual(original);
});

test('summary and encrypted details may arrive in separate events', async () => {
  const summary = { type: 'reasoning.summary', summary: 'thinking', index: 0 };
  expect(await collect(wrapOpenAIChatCompletionsAffinityEgress(frames([
    chunk({ reasoning_details: [summary] }), chunk({ reasoning_details: [{ type: 'reasoning.encrypted', data: 'one' }, { type: 'reasoning.encrypted', data: 'two' }] }, 'stop'), doneFrame(),
  ]), { codec, affinity, preference: details }))).toEqual([
    chunk({ reasoning_details: [summary] }), chunk({ reasoning_details: [{ type: 'reasoning.encrypted', data: 'wrapped:one' }, { type: 'reasoning.encrypted', data: 'wrapped:two' }] }, 'stop'), doneFrame(),
  ]);
});

test('adds only the preferred synthetic carrier once before an uncarried choice finishes', async () => {
  expect(await collect(wrapOpenAIChatCompletionsAffinityEgress(frames([chunk({ content: 'answer' }, 'stop'), doneFrame()]), { codec, affinity, preference: details }))).toEqual([
    chunk({ content: 'answer' }), chunk({ reasoning_details: [{ type: 'reasoning.encrypted', data: 'wrapped:synthetic', format: 'unknown', index: 1 }] }), chunk({}, 'stop'), doneFrame(),
  ]);
});

test('EOF supplies missing carriers independently without duplicating an existing choice carrier', async () => {
  const output = await collect(wrapOpenAIChatCompletionsAffinityEgress(frames([chunk({ reasoning_opaque: 'present' }), chunk({ content: 'other' }, null, 1), doneFrame()]), { codec, affinity, preference: opaque }));
  expect(output).toEqual([chunk({ reasoning_opaque: 'wrapped:present' }), chunk({ content: 'other' }, null, 1), chunk({ reasoning_opaque: 'wrapped:synthetic' }, null, 1), doneFrame()]);
});

test('preserves nonselected carriers, choice extras and chunk extras exactly once', async () => {
  const frame = chunk({ reasoning_opaque: 'nonselected', content: 'answer' }, 'stop');
  if (frame.type !== 'event') throw new Error('Expected event');
  Object.assign(frame.event, { vendor: 'chunk' });
  Object.assign(frame.event.choices[0], { logprobs: { content: [], refusal: null }, vendor: 'choice' });
  const output = await collect(wrapOpenAIChatCompletionsAffinityEgress(frames([frame, doneFrame()]), { codec, affinity, preference: details }));
  expect(output[0]).toMatchObject({ event: { vendor: 'chunk', choices: [{ vendor: 'choice', delta: { reasoning_opaque: 'nonselected', content: 'answer' } }] } });
  expect(JSON.stringify(output.slice(1))).not.toContain('vendor');
  expect(JSON.stringify(output.slice(1))).not.toContain('logprobs');
});

test('upstream errors suppress synthetic completion carriers', async () => {
  const error = eventFrame({ error: { type: 'upstream', message: 'failed' } } as unknown as OpenAIChatCompletionsStreamEvent);
  expect(await collect(wrapOpenAIChatCompletionsAffinityEgress(frames([chunk({ content: 'partial' }), error, doneFrame()]), { codec, affinity, preference: details }))).toEqual([chunk({ content: 'partial' }), error, doneFrame()]);
});
