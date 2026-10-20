import { expect, test } from 'vitest';

import type { IRRecord } from '../../../../src/ir/stream.ts';
import type { OpenAIChatCompletionsInputAssistantTurn } from '../../../../src/protocols/openai-chat-completions/as-target/assistant-turn.ts';
import { irFromOpenAIChatCompletions } from '../../../../src/protocols/openai-chat-completions/as-target/sse-from.ts';
import { appendContent, collectContentViews, createContentState, createReferenceBuilder } from '../../../../src/round-trip/reference/reference-builder.ts';
import { finalizeAssistantTurnReferences } from '../../../../src/round-trip/reference/reference-selection.ts';
import { restoreAssistantTurn } from '../../../../src/round-trip/reference/restore.ts';
import type { RoundTripReader } from '../../../../src/round-trip/stream.ts';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

const chunk = (choices: OpenAIChatCompletionsStreamEvent['choices']) => eventFrame<OpenAIChatCompletionsStreamEvent>({
  id: 'chatcmpl', object: 'chat.completion.chunk', created: 1, model: 'model', choices,
});

const drain = async (frames: ReturnType<typeof chunk>[]): Promise<Map<number, OpenAIChatCompletionsInputAssistantTurn>> => {
  const turns = new Map<number, OpenAIChatCompletionsInputAssistantTurn>();
  const roundTrip: RoundTripReader<'openaiChatCompletions'> = {
    builder: createReferenceBuilder(),
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

const traceTools = async (frames: ReturnType<typeof chunk>[], options: { prefix?: string; customToolNames?: ReadonlySet<string> } = {}) => {
  const builder = createReferenceBuilder();
  const content = createContentState(builder, 'text');
  let text = options.prefix ?? '';
  appendContent(builder, content, text);
  let captured: Parameters<RoundTripReader<'openaiChatCompletions'>['onAssistantTurn']> | undefined;
  const appends: Extract<IRRecord, { type: 'write'; kind: 'append' }>[] = [];
  const roundTrip: RoundTripReader<'openaiChatCompletions'> = {
    builder,
    onAssistantTurn: (...args) => { captured = args; },
  };
  for await (const record of irFromOpenAIChatCompletions((async function* () { yield* frames; yield doneFrame(); })(), { roundTrip, customToolNames: options.customToolNames })) {
    if (record.type !== 'write' || record.kind !== 'append') continue;
    const field = record.path.at(-1);
    if (field !== 'arguments' && field !== 'input') continue;
    appends.push(record);
    appendContent(builder, content, record.value, record.referencePieceIds);
    text += record.value;
  }
  if (captured === undefined) throw new Error('Native Chat turn was not collected');
  const [, turn, fieldState] = captured;
  const finalized = await finalizeAssistantTurnReferences(turn, fieldState, builder, collectContentViews(text, content));
  const hydrated = await restoreAssistantTurn('openaiChatCompletions', [text], finalized.targetTurn, finalized.referencedContentHashes);
  expect(hydrated).toEqual({ ok: true, turn });
  return { turn, fieldState, appends, finalized };
};

test('keeps merged pre-name arguments in one IR append with every original atom ID', async () => {
  const result = await traceTools([
    chunk([{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call', type: 'function', function: { arguments: '{"x":' } }] }, finish_reason: null }]),
    chunk([{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: null }]),
    chunk([{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'lookup' } }] }, finish_reason: 'tool_calls' }]),
  ], { prefix: 'p:' });

  expect(result.appends.map(record => ({ text: record.value, referencePieceIds: record.referencePieceIds }))).toEqual([{ text: '{"x":1}', referencePieceIds: [0, 1] }]);
  expect(result.fieldState).toMatchObject({ tool_calls: [{ function: { arguments: expect.any(Object) } }] });
  expect(result.finalized.targetTurn).toMatchObject({ tool_calls: [{ function: { arguments: '{"x":1}' } }] });
  expect(result.finalized).not.toHaveProperty('referencedContentHashes');
});

test('tracks native custom input and legacy function arguments in their own input fields', async () => {
  const custom = await traceTools([
    chunk([{ index: 0, delta: { tool_calls: [{ index: 0, id: 'custom', type: 'custom', custom: { name: 'freeform', input: 'ab' } }] }, finish_reason: null }]),
    chunk([{ index: 0, delta: { tool_calls: [{ index: 0, custom: { input: 'cd' } }] }, finish_reason: 'tool_calls' }]),
  ]);
  expect(custom.finalized.targetTurn).toMatchObject({ tool_calls: [{ type: 'custom', custom: { input: 'abcd' } }] });
  expect(custom.finalized).not.toHaveProperty('referencedContentHashes');

  const legacy = await traceTools([
    chunk([{ index: 0, delta: { function_call: { name: 'legacy', arguments: '{"x":1}' } }, finish_reason: 'function_call' }]),
  ]);
  expect(legacy.finalized.targetTurn).toMatchObject({ function_call: { arguments: '{"x":1}' } });
  expect(legacy.finalized).not.toHaveProperty('referencedContentHashes');
  expect(legacy.fieldState).not.toHaveProperty('tool_calls');
});

test('sorts native tool state with sparse wire indices without rebuilding field nodes', async () => {
  const result = await traceTools([
    chunk([{
      index: 0, delta: {
        tool_calls: [
          { index: 3, id: 'b', type: 'function', function: { name: 'second', arguments: '{"b":2}' } },
          { index: 1, id: 'a', type: 'function', function: { name: 'first', arguments: '{"a":1}' } },
        ],
      }, finish_reason: 'tool_calls',
    }]),
  ]);
  expect(result.finalized.targetTurn).toMatchObject({
    tool_calls: [
      { id: 'a', function: { arguments: '{"a":1}' } },
      { id: 'b', function: { arguments: '{"b":2}' } },
    ],
  });
  expect(result.finalized).not.toHaveProperty('referencedContentHashes');
});

test('keeps a transformed wrapped tool field literal', async () => {
  const result = await traceTools([
    chunk([{ index: 0, delta: { tool_calls: [{ index: 0, id: 'wrapped', type: 'function', function: { name: 'wrapped', arguments: '{"input":"hello"}' } }] }, finish_reason: 'tool_calls' }]),
  ], { customToolNames: new Set(['wrapped']) });
  expect(result.appends.map(record => ({ text: record.value, referencePieceIds: record.referencePieceIds }))).toEqual([{ text: 'hello', referencePieceIds: undefined }]);
  expect(result.finalized.targetTurn).toEqual(result.turn);
  expect(result.finalized).not.toHaveProperty('referencedContentHashes');
});
