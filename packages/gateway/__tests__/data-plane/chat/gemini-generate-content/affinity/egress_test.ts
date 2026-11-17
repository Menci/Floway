import { describe, expect, test, vi } from 'vitest';

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

class DelayedCodec implements AffinityEgressCodec {
  readonly calls: Array<{ value: string | undefined; resolve: (value: string) => void }> = [];

  wrap(value: string | undefined): Promise<string> {
    return new Promise(resolve => this.calls.push({ value, resolve }));
  }
}

const immediateCodec: AffinityEgressCodec = {
  wrap: async value => `wrapped:${value ?? 'synthetic'}`,
};

describe('Gemini generateContent affinity egress', () => {
  test('buffers one event and wraps a natural signature on its content-bearing part', async () => {
    const codec = new DelayedCodec();
    const output = wrapGeminiGenerateContentAffinityEgress(frames([eventFrame({
      candidates: [{
        index: 0,
        content: { role: 'model', parts: [{ text: 'visible', thoughtSignature: 'opaque' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { totalTokenCount: 2 },
    })]), { codec, affinity })[Symbol.asyncIterator]();

    const pending = output.next();
    await vi.waitFor(() => expect(codec.calls.map(call => call.value)).toEqual(['opaque']));
    codec.calls[0].resolve('wrapped-opaque');
    expect((await pending).value).toEqual(eventFrame({
      candidates: [{
        index: 0,
        content: { role: 'model', parts: [{ text: 'visible', thoughtSignature: 'wrapped-opaque' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { totalTokenCount: 2 },
    }));
  });

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

  test.each([
    { thought: true, thoughtSignature: 'natural' },
  ])('treats an empty signature trailer as metadata rather than visible content', async trailer => {
    const output: ProtocolFrame<GeminiGenerateContentStreamEvent>[] = [];
    for await (const frame of wrapGeminiGenerateContentAffinityEgress(frames([
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'visible' }] } }] }),
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [trailer] }, finishReason: 'STOP' }] }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output[0]).toMatchObject({
      event: { candidates: [{ content: { parts: [{ text: 'visible', thoughtSignature: 'wrapped:natural' }] }, finishReason: 'STOP' }] },
    });
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

  test.each([
    [
      { text: 'a', thoughtSignature: 'old' },
      { text: 'b', thoughtSignature: 'latest' },
    ],
    [
      { text: 'a', thoughtSignature: 'old' },
      { thoughtSignature: 'latest' },
    ],
  ])('keeps one latest signature for repeated snapshots in the same event', async (first, second) => {
    const parts = [first, second];
    const output: ProtocolFrame<GeminiGenerateContentStreamEvent>[] = [];
    for await (const frame of wrapGeminiGenerateContentAffinityEgress(frames([eventFrame({
      candidates: [{ index: 0, content: { role: 'model', parts }, finishReason: 'STOP' }],
    })]), { codec: immediateCodec, affinity })) output.push(frame);

    const signatures = JSON.stringify(output).match(/wrapped:(?:old|latest)/g);
    expect(signatures).toEqual(['wrapped:latest']);
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

  test.each([
    { functionCall: { id: 'call', name: 'tool', args: {} } },
  ])('moves a leading signature-only event forward onto the first content Part', async contentPart => {
    const output: ProtocolFrame<GeminiGenerateContentStreamEvent>[] = [];
    for await (const frame of wrapGeminiGenerateContentAffinityEgress(frames([
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ thoughtSignature: 'natural' }] } }] }),
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [contentPart] }, finishReason: 'STOP' }] }),
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
});
