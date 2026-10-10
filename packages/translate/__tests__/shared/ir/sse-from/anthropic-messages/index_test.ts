import { describe, expect, it } from 'vitest';

import { createIAT } from '../../../../../src/shared/ir/iat.ts';
import type { IRJSONObject } from '../../../../../src/shared/ir/ir.ts';
import type { IRRoundTripReader } from '../../../../../src/shared/ir/round-trip/stream.ts';
import { irJSON } from '../../../../../src/shared/ir/shared/json.ts';
import { irFromAnthropicMessages } from '../../../../../src/shared/ir/sse-from/anthropic-messages/index.ts';
import { IATReference } from '../../../../../src/shared/ir/thin-types.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame } from '@floway-dev/protocols/common';

const entryFor = (iat: ReturnType<typeof createIAT>, nativePath: readonly (string | number)[]) =>
  [...iat.entries.values()].find(entry => JSON.stringify(entry.nativePath) === JSON.stringify(nativePath));

describe('Anthropic Messages round-trip capture', () => {
  it('captures source blocks, citations, thinking, and parsed tool JSON before choice_end', async () => {
    const iat = createIAT();
    const order: string[] = [];
    let turn: any;
    const roundTrip: IRRoundTripReader<'anthropicMessages'> = {
      iat,
      onAssistantTurn: (_choice, nativeTurn) => { order.push('turn'); turn = nativeTurn; },
    };
    const toolInput = '{"large":9007199254740993,"__proto__":{"safe":true}}';
    const sourceEvents = [
      { type: 'message_start', message: { id: 'source', type: 'message', role: 'assistant', model: 'model', content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'read ', citations: [{ type: 'web_search_result_location', url: 'https://example.test', title: 'source', encrypted_index: 'idx', cited_text: 'search quote' }], provider_opaque: { kept: true } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '😀' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: 'reason', signature: 'sealed', provider_opaque: 'thinking metadata' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call', name: 'lookup', input: {}, provider_opaque: 'tool metadata' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: toolInput } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null, container: null }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ];
    const frames = sourceEvents.map(value => eventFrame(value as AnthropicMessagesStreamEventEx));
    for await (const frame of irFromAnthropicMessages((async function* () { yield* frames; })(), { roundTrip })) {
      for (const record of frame.records) if (record.type === 'choice_end') order.push('choice_end');
    }

    expect(order).toEqual(['turn', 'choice_end']);
    expect(turn.role).toBe('assistant');
    expect(turn.content[0].text).toBeInstanceOf(IATReference);
    expect(turn.content[0].citations[0].cited_text).toBeInstanceOf(IATReference);
    expect(turn.content[1].thinking).toBeInstanceOf(IATReference);
    expect(turn.content[2].input).toBeInstanceOf(IATReference);
    expect(turn.content[0].provider_opaque).toEqual({ kept: true });
    expect(turn.content[1].signature).toBe('sealed');
    expect(turn.content[2].provider_opaque).toBe('tool metadata');
    expect(entryFor(iat, ['content', 0, 'text'])).toMatchObject({
      view: 'read 😀',
      sources: [{ path: ['choices', 0, 'items', 0, 'content', 0, 'text'], sourceStart: 0, sourceEndExclusive: 7, viewStart: 0 }],
    });
    expect(entryFor(iat, ['content', 0, 'citations', 0, 'cited_text'])).toMatchObject({
      view: 'search quote',
      sources: [{ path: ['choices', 0, 'items', 0, 'content', 0, 'annotations', 0, 'source_text', 'text'], sourceStart: 0, sourceEndExclusive: 12, viewStart: 0 }],
    });
    expect(entryFor(iat, ['content', 1, 'thinking'])).toMatchObject({
      view: 'reason',
      sources: [{ path: ['choices', 0, 'items', 1, 'summary', 0], sourceStart: 0, sourceEndExclusive: 6, viewStart: 0 }],
    });
    const input = entryFor(iat, ['content', 2, 'input'])?.original as IRJSONObject;
    expect(JSON.stringify(input)).toBe(toolInput);
    expect(Object.hasOwn(input, '__proto__')).toBe(true);
    expect(irJSON.isRawJSON((input as any).large)).toBe(true);
    expect(entryFor(iat, ['content', 2, 'input'])).toMatchObject({
      view: toolInput,
      sources: [{ path: ['choices', 0, 'items', 2, 'arguments'], sourceStart: 0, sourceEndExclusive: toolInput.length, viewStart: 0 }],
    });
  });
});
