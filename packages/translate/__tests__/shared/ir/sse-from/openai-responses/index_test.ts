import { describe, expect, it } from 'vitest';

import { createIAT } from '../../../../../src/shared/ir/iat.ts';
import type { IRRoundTripReader } from '../../../../../src/shared/ir/round-trip/stream.ts';
import { irFromOpenAIResponses } from '../../../../../src/shared/ir/sse-from/openai-responses/index.ts';
import { IATReference } from '../../../../../src/shared/ir/thin-types.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

const entryFor = (iat: ReturnType<typeof createIAT>, nativePath: readonly (string | number)[]) =>
  [...iat.entries.values()].find(entry => JSON.stringify(entry.nativePath) === JSON.stringify(nativePath));

describe('OpenAI Responses round-trip capture', () => {
  it('captures supported output fields, preserves opaque items, and retains a null image result', async () => {
    const iat = createIAT();
    const order: string[] = [];
    let turn: any;
    const roundTrip: IRRoundTripReader<'openaiResponses'> = {
      iat,
      onAssistantTurn: (_choice, nativeTurn) => { order.push('turn'); turn = nativeTurn; },
    };
    const response = {
      id: 'source',
      object: 'response',
      model: 'model',
      created_at: 1,
      status: 'completed',
      error: null,
      incomplete_details: null,
      usage: null,
      output: [
        {
          type: 'message',
          id: 'message',
          role: 'assistant',
          status: 'completed',
          phase: 'final',
          internal_chat_message_metadata_passthrough: { keep: true },
          content: [
            { type: 'output_text', text: 'answer', annotations: [{ type: 'url_citation', url: 'https://example.test', title: 'source', start_index: 0, end_index: 6 }], logprobs: [{ token: 'answer' }] },
            { type: 'refusal', refusal: 'blocked' },
          ],
        },
        {
          type: 'reasoning',
          id: 'reasoning',
          status: 'completed',
          summary: [{ type: 'summary_text', text: 'thought' }],
          content: [{ type: 'reasoning_text', text: 'detail' }],
          encrypted_content: 'sealed',
          provider_opaque: { keep: true },
        },
        {
          type: 'function_call',
          id: 'function',
          call_id: 'call',
          name: 'lookup',
          arguments: '{"query":"x"}',
          status: 'completed',
          provider_opaque: 'tool metadata',
        },
        { type: 'image_generation_call', id: 'image', status: 'failed', result: null, output_format: 'png' },
      ],
    } as OpenAIResponsesResultEx;
    const frames = [eventFrame({ type: 'response.completed', response } as OpenAIResponsesStreamEventEx)];
    for await (const frame of irFromOpenAIResponses((async function* () { yield* frames; })(), { roundTrip })) {
      for (const record of frame.records) if (record.type === 'choice_end') order.push('choice_end');
    }

    expect(order).toEqual(['turn', 'choice_end']);
    expect(turn[0].content[0].text).toBeInstanceOf(IATReference);
    expect(turn[0].content[1].refusal).toBeInstanceOf(IATReference);
    expect(turn[0].internal_chat_message_metadata_passthrough).toEqual({ keep: true });
    expect(turn[0].content[0]).not.toHaveProperty('annotations');
    expect(turn[0].content[0]).not.toHaveProperty('logprobs');
    expect(turn[1].summary[0].text).toBeInstanceOf(IATReference);
    expect(turn[1].content[0].text).toBeInstanceOf(IATReference);
    expect(turn[1].encrypted_content).toBe('sealed');
    expect(turn[1].provider_opaque).toEqual({ keep: true });
    expect(turn[2].arguments).toBeInstanceOf(IATReference);
    expect(turn[2].provider_opaque).toBe('tool metadata');
    expect(turn[3]).toMatchObject({ type: 'image_generation_call', result: null, output_format: 'png' });
    expect(entryFor(iat, [0, 'content', 0, 'text'])).toMatchObject({
      view: 'answer',
      sources: [{ path: ['choices', 0, 'items', 0, 'content', 0, 'text'], sourceStart: 0, sourceEndExclusive: 6, viewStart: 0 }],
    });
    expect(entryFor(iat, [0, 'content', 1, 'refusal'])).toMatchObject({
      view: 'blocked',
      sources: [{ path: ['choices', 0, 'items', 0, 'content', 1, 'refusal'], sourceStart: 0, sourceEndExclusive: 7, viewStart: 0 }],
    });
    expect(entryFor(iat, [1, 'summary', 0, 'text'])).toMatchObject({
      view: 'thought',
      sources: [{ path: ['choices', 0, 'items', 1, 'summary', 0], sourceStart: 0, sourceEndExclusive: 7, viewStart: 0 }],
    });
    expect(entryFor(iat, [1, 'content', 0, 'text'])).toMatchObject({
      view: 'detail',
      sources: [{ path: ['choices', 0, 'items', 1, 'content', 0], sourceStart: 0, sourceEndExclusive: 6, viewStart: 0 }],
    });
    expect(entryFor(iat, [2, 'arguments'])).toMatchObject({
      view: '{"query":"x"}',
      sources: [{ path: ['choices', 0, 'items', 2, 'arguments'], sourceStart: 0, sourceEndExclusive: 13, viewStart: 0 }],
    });
    expect(entryFor(iat, [3, 'result'])).toBeUndefined();
  });
});
