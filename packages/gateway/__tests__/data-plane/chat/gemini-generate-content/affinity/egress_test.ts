import { describe, expect, test } from 'vitest';

import { wrapGeminiGenerateContentAffinityEgress } from '../../../../../src/data-plane/chat/gemini-generate-content/affinity/egress.ts';
import type { AffinityCodec, AffinityIdentity } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentCandidate, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

const affinity: AffinityIdentity = {
  upstreamId: 'up-a',
  modelId: 'model-a',
  opaqueBlobCompatibilityIdentity: { upstreamId: 'up-a', key: 'model-a' },
};

type AffinityEgressCodec = Pick<AffinityCodec, 'wrap'>;

const frames = async function* (values: ProtocolFrame<GeminiGenerateContentStreamEvent>[]) {
  yield* values;
};

const withCandidateExtra = (candidate: GeminiGenerateContentCandidate, key: string, value: unknown): GeminiGenerateContentCandidate =>
  Object.assign(candidate, { [key]: value });

const immediateCodec: AffinityEgressCodec = {
  wrap: async value => `wrapped:${value ?? 'synthetic'}`,
};

describe('Gemini generateContent affinity egress', () => {
  test('attaches synthetic affinity to the first content-bearing part of every candidate', async () => {
    const output: ProtocolFrame<GeminiGenerateContentStreamEvent>[] = [];
    for await (const frame of wrapGeminiGenerateContentAffinityEgress(frames([eventFrame({
      candidates: [
        { index: 0, content: { role: 'model', parts: [{ text: 'a' }] }, finishReason: 'STOP' },
        { index: 1, content: { role: 'model', parts: [{ functionCall: { name: 'tool', args: {} } }] }, finishReason: 'MAX_TOKENS' },
      ],
    })]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output).toEqual([eventFrame({
      candidates: [
        { index: 0, content: { role: 'model', parts: [{ text: 'a', thoughtSignature: 'wrapped:synthetic' }] }, finishReason: 'STOP' },
        {
          index: 1,
          content: { role: 'model', parts: [{ functionCall: { name: 'tool', args: {} }, thoughtSignature: 'wrapped:synthetic' }] },
          finishReason: 'MAX_TOKENS',
        },
      ],
    })]);
  });

  test('moves an immediate signature-only trailer onto the buffered content event', async () => {
    const output: ProtocolFrame<GeminiGenerateContentStreamEvent>[] = [];
    for await (const frame of wrapGeminiGenerateContentAffinityEgress(frames([
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'visible' }] } }] }),
      eventFrame({
        candidates: [{ index: 0, content: { role: 'model', parts: [{ thoughtSignature: 'natural' }] }, finishReason: 'STOP' }],
        usageMetadata: { totalTokenCount: 2 },
      }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output[0]).toEqual(eventFrame({
      candidates: [{
        index: 0,
        content: { role: 'model', parts: [{ text: 'visible', thoughtSignature: 'wrapped:natural' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { totalTokenCount: 2 },
    }));
    expect(output).toHaveLength(1);
  });

  test('slides one-event lookahead until a later natural signature closes the same element', async () => {
    const output: ProtocolFrame<GeminiGenerateContentStreamEvent>[] = [];
    for await (const frame of wrapGeminiGenerateContentAffinityEgress(frames([
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'a' }] } }] }),
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'b' }] } }] }),
      eventFrame({
        candidates: [{
          index: 0,
          content: { role: 'model', parts: [{ text: 'c', thoughtSignature: 'natural' }] },
          finishReason: 'STOP',
        }],
      }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output[0]).not.toMatchObject({ event: { candidates: [{ content: { parts: [{ thoughtSignature: expect.anything() }] } }] } });
    expect(output[1]).toMatchObject({
      event: { candidates: [{ content: { parts: [{ text: 'b', thoughtSignature: 'wrapped:natural' }] } }] },
    });
    expect(output[2]).not.toMatchObject({ event: { candidates: [{ content: { parts: [{ thoughtSignature: expect.anything() }] } }] } });
  });

  test('normalizes signatures independently for every logical element in one event', async () => {
    const output: ProtocolFrame<GeminiGenerateContentStreamEvent>[] = [];
    for await (const frame of wrapGeminiGenerateContentAffinityEgress(frames([eventFrame({
      candidates: [{
        index: 0,
        content: {
          role: 'model',
          parts: [
            { text: 'answer' },
            { functionCall: { id: 'call', name: 'tool', args: { a: 1 } }, thoughtSignature: 'function-old' },
            { functionCall: { id: 'call', name: 'tool', args: { b: 2 } }, thoughtSignature: 'function-latest' },
            { text: 'explanation', thought: true, thoughtSignature: 'text-old' },
            { text: 'continued', thought: true, thoughtSignature: 'text-latest' },
          ],
        },
        finishReason: 'STOP',
      }],
    })]), { codec: immediateCodec, affinity })) output.push(frame);

    const event = output[0].type === 'event' && !('error' in output[0].event) ? output[0].event : undefined;
    expect(event?.candidates?.[0].content?.parts).toEqual([
      { text: 'answer', thoughtSignature: 'wrapped:synthetic' },
      { functionCall: { id: 'call', name: 'tool', args: { a: 1 } }, thoughtSignature: 'wrapped:function-latest' },
      { functionCall: { id: 'call', name: 'tool', args: { b: 2 } } },
      { text: 'explanation', thought: true, thoughtSignature: 'wrapped:text-latest' },
      { text: 'continued', thought: true },
    ]);
  });

  test('moves a leading signature-only event forward onto the first content Part', async () => {
    const output: ProtocolFrame<GeminiGenerateContentStreamEvent>[] = [];
    for await (const frame of wrapGeminiGenerateContentAffinityEgress(frames([
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ thoughtSignature: 'natural' }] } }] }),
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ functionCall: { id: 'call', name: 'tool', args: {} } }] }, finishReason: 'STOP' }] }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      event: { candidates: [{ content: { parts: [{ thoughtSignature: 'wrapped:natural' }] }, finishReason: 'STOP' }] },
    });
  });

  test('preserves a native empty candidate as an element boundary', async () => {
    const empty = withCandidateExtra(
      { index: 0, content: { role: 'model', parts: [] } },
      'vendor_empty',
      true,
    );
    const output: ProtocolFrame<GeminiGenerateContentStreamEvent>[] = [];
    for await (const frame of wrapGeminiGenerateContentAffinityEgress(frames([
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'first' }] } }] }),
      eventFrame({ candidates: [empty] }),
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'second' }] }, finishReason: 'STOP' }] }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output).toHaveLength(3);
    expect(output[0]).toMatchObject({ event: { candidates: [{ content: { parts: [{ thoughtSignature: 'wrapped:synthetic' }] } }] } });
    expect(output[1]).toMatchObject({ event: { candidates: [{ vendor_empty: true, content: { parts: [] } }] } });
    expect(output[2]).not.toMatchObject({ event: { candidates: [{ content: { parts: [{ thoughtSignature: expect.anything() }] } }] } });
  });

  test('does not merge adjacent complete same-name function calls without IDs', async () => {
    const output: ProtocolFrame<GeminiGenerateContentStreamEvent>[] = [];
    for await (const frame of wrapGeminiGenerateContentAffinityEgress(frames([
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ functionCall: { name: 'tool', args: { a: 1 } } }] } }] }),
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ functionCall: { name: 'tool', args: { b: 2 } }, thoughtSignature: 'natural' }] }, finishReason: 'STOP' }] }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output[0]).toMatchObject({ event: { candidates: [{ content: { parts: [{ thoughtSignature: 'wrapped:synthetic' }] } }] } });
    expect(output[1]).toMatchObject({ event: { candidates: [{ content: { parts: [{ thoughtSignature: 'wrapped:natural' }] } }] } });
  });

  test('flushes pending visible content before propagating an iterator failure', async () => {
    const source = async function* (): AsyncGenerator<ProtocolFrame<GeminiGenerateContentStreamEvent>> {
      yield eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'visible' }] } }] });
      throw new Error('upstream failed');
    };
    const iterator = wrapGeminiGenerateContentAffinityEgress(source(), { codec: immediateCodec, affinity })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { event: { candidates: [{ content: { parts: [{ text: 'visible' }] } }] } },
    });
    await expect(iterator.next()).rejects.toThrow('upstream failed');
  });

  // The property the whole shape of this transducer rests on: a frame it is handed belongs to
  // the layer that produced it. The events used to be deep-cloned on the way in precisely
  // because the rules then wrote into them; nothing writes now, so a frozen source has to
  // survive the pass unchanged — and the relocations are exercised here rather than asserted
  // about, because a rewrite that reached for `delete` or an index assignment throws in strict
  // mode instead of quietly corrupting the caller's event.
  test('rewrites a deeply frozen source without writing into it', async () => {
    const freeze = <T>(value: T): T => {
      if (value === null || typeof value !== 'object') return value;
      for (const entry of Object.values(value as Record<string, unknown>)) freeze(entry);
      return Object.freeze(value);
    };
    const frozen = (event: GeminiGenerateContentStreamEvent): ProtocolFrame<GeminiGenerateContentStreamEvent> => eventFrame(freeze(event));
    const source: ProtocolFrame<GeminiGenerateContentStreamEvent>[] = [
      // A signature-only leader, relocated forward onto the next event's content.
      frozen({
        candidates: [{ index: 0, content: { role: 'model', parts: [{ thoughtSignature: 'lead' }] } }],
      }),
      // Content that continues into the third event, whose signature is pulled back onto it.
      frozen({
        candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'hello' }] } }],
        usageMetadata: { totalTokenCount: 1 },
      }),
      frozen({
        candidates: [{
          index: 0,
          content: { role: 'model', parts: [{ text: ' world', thoughtSignature: 'tail' }] },
          finishReason: 'STOP',
        }],
      }),
    ];
    const before = JSON.stringify(source);

    const output: ProtocolFrame<GeminiGenerateContentStreamEvent>[] = [];
    for await (const frame of wrapGeminiGenerateContentAffinityEgress(frames(source), { codec: immediateCodec, affinity })) {
      output.push(frame);
    }

    // The source is what it was, and the pass still did its work.
    expect(JSON.stringify(source)).toBe(before);
    const signatures = output.flatMap(frame =>
      (frame.type === 'event' && 'candidates' in frame.event ? frame.event.candidates ?? [] : [])
        .flatMap(candidate => candidate.content?.parts?.flatMap(part => part.thoughtSignature ?? []) ?? []));
    expect(signatures.some(signature => signature.startsWith('wrapped:'))).toBe(true);
  });
});
