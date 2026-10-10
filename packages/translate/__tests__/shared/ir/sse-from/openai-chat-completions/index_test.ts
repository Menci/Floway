import { describe, expect, it } from 'vitest';

import { createIAT } from '../../../../../src/shared/ir/iat.ts';
import type { IRRoundTripReader } from '../../../../../src/shared/ir/round-trip/stream.ts';
import { irFromOpenAIChatCompletions } from '../../../../../src/shared/ir/sse-from/openai-chat-completions/index.ts';
import { IATReference } from '../../../../../src/shared/ir/thin-types.ts';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

const chunk = (choices: unknown[]): ReturnType<typeof eventFrame<OpenAIChatCompletionsStreamEvent>> => eventFrame({
  id: 'source',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'model',
  choices,
} as OpenAIChatCompletionsStreamEvent);

const entryFor = (iat: ReturnType<typeof createIAT>, nativePath: readonly (string | number)[]) =>
  [...iat.entries.values()].find(entry => JSON.stringify(entry.nativePath) === JSON.stringify(nativePath));

describe('OpenAI Chat Completions round-trip capture', () => {
  it('captures the reassembled message with exact IR source ranges before choice_end', async () => {
    const iat = createIAT();
    const order: string[] = [];
    let turn: any;
    const roundTrip: IRRoundTripReader<'openaiChatCompletions'> = {
      iat,
      onAssistantTurn: (_choice, nativeTurn) => { order.push('turn'); turn = nativeTurn; },
    };
    const frames = [
      chunk([{ index: 0, delta: { content: 'north ' } }]),
      chunk([{ index: 0, delta: { reasoning_text: 'work' } }]),
      chunk([{ index: 0, delta: { content: 'south', vendor_specific: { opaque: 'literal' } } }]),
      chunk([{ index: 0, delta: { function_call: { name: 'legacy', arguments: '{"legacy":1}' } } }]),
      chunk([{ index: 0, delta: { tool_calls: [{ index: 2, function: { arguments: '{"q":' } }] } }]),
      chunk([{ index: 0, delta: { tool_calls: [{ index: 2, id: 'call', type: 'function', function: { name: 'lookup', arguments: '1}' } }] }, finish_reason: 'tool_calls' }]),
      doneFrame(),
    ];
    for await (const frame of irFromOpenAIChatCompletions((async function* () { yield* frames; })(), { roundTrip })) {
      for (const record of frame.records) {
        if (record.type === 'choice_end') order.push('choice_end');
      }
    }

    expect(order).toEqual(['turn', 'choice_end']);
    expect(turn.content).toBeInstanceOf(IATReference);
    expect(turn.reasoning_text).toBeInstanceOf(IATReference);
    expect(turn.function_call.arguments).toBeInstanceOf(IATReference);
    expect(turn.tool_calls[0].function.arguments).toBeInstanceOf(IATReference);
    expect(turn.vendor_specific).toEqual({ opaque: 'literal' });
    expect(entryFor(iat, ['choices', 0, 'message', 'content'])).toMatchObject({
      view: 'north south',
      original: 'north south',
      sources: [
        { path: ['choices', 0, 'items', 0, 'content', 0, 'text'], sourceStart: 0, sourceEndExclusive: 6, viewStart: 0 },
        { path: ['choices', 0, 'items', 2, 'content', 0, 'text'], sourceStart: 0, sourceEndExclusive: 5, viewStart: 6 },
      ],
    });
    expect(entryFor(iat, ['choices', 0, 'message', 'reasoning_text'])).toMatchObject({
      view: 'work',
      sources: [{ path: ['choices', 0, 'items', 1, 'summary', 0], sourceStart: 0, sourceEndExclusive: 4, viewStart: 0 }],
    });
    expect(entryFor(iat, ['choices', 0, 'message', 'function_call', 'arguments'])).toMatchObject({
      view: '{"legacy":1}',
      sources: [{ path: ['choices', 0, 'items', 3, 'arguments'], sourceStart: 0, sourceEndExclusive: 12, viewStart: 0 }],
    });
    expect(entryFor(iat, ['choices', 0, 'message', 'tool_calls', 0, 'function', 'arguments'])).toMatchObject({
      view: '{"q":1}',
      sources: [
        { path: ['choices', 0, 'items', 4, 'arguments'], sourceStart: 0, sourceEndExclusive: 5, viewStart: 0 },
        { path: ['choices', 0, 'items', 4, 'arguments'], sourceStart: 5, sourceEndExclusive: 7, viewStart: 5 },
      ],
    });
  });

  it('namespaces identical native field paths by choice', async () => {
    const iat = createIAT();
    const turns = new Map<number, any>();
    const roundTrip: IRRoundTripReader<'openaiChatCompletions'> = {
      iat,
      onAssistantTurn: (choice, turn) => { turns.set(choice, turn); },
    };
    const frames = [chunk([
      { index: 0, delta: { content: 'first' }, finish_reason: 'stop' },
      { index: 1, delta: { content: 'second' }, finish_reason: 'stop' },
    ]), doneFrame()];
    for await (const _frame of irFromOpenAIChatCompletions((async function* () { yield* frames; })(), { roundTrip })) {}

    expect(turns.get(0).content).toBeInstanceOf(IATReference);
    expect(turns.get(1).content).toBeInstanceOf(IATReference);
    expect(entryFor(iat, ['choices', 0, 'message', 'content'])?.original).toBe('first');
    expect(entryFor(iat, ['choices', 1, 'message', 'content'])?.original).toBe('second');
  });
});
