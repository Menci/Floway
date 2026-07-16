import { describe, expect, test, vi } from 'vitest';

import { wrapGeminiAffinityEgress } from './egress.ts';
import type { AffinityCodec, AffinityTarget } from '../../shared/affinity/index.ts';
import { eventFrame, type ProtocolFrame, USAGE_BILLING } from '@floway-dev/protocols/common';
import type { GeminiCandidate, GeminiStreamEvent } from '@floway-dev/protocols/gemini';

const affinity: AffinityTarget = {
  upstreamId: 'up-a',
  modelId: 'model-a',
};

type AffinityEgressCodec = Pick<AffinityCodec, 'wrap'>;

const frames = async function* (values: ProtocolFrame<GeminiStreamEvent>[]) {
  yield* values;
};

const withCandidateExtra = (candidate: GeminiCandidate, key: string, value: unknown): GeminiCandidate =>
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

describe('Gemini affinity egress', () => {
  test('buffers one event and wraps a natural signature on its content-bearing part', async () => {
    const codec = new DelayedCodec();
    const output = wrapGeminiAffinityEgress(frames([eventFrame({
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
    const output: ProtocolFrame<GeminiStreamEvent>[] = [];
    for await (const frame of wrapGeminiAffinityEgress(frames([eventFrame({
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
    const output: ProtocolFrame<GeminiStreamEvent>[] = [];
    for await (const frame of wrapGeminiAffinityEgress(frames([
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
    { text: '', thoughtSignature: 'natural' },
    { thought: true, thoughtSignature: 'natural' },
  ])('treats an empty signature trailer as metadata rather than visible content', async trailer => {
    const output: ProtocolFrame<GeminiStreamEvent>[] = [];
    for await (const frame of wrapGeminiAffinityEgress(frames([
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'visible' }] } }] }),
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [trailer] }, finishReason: 'STOP' }] }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output[0]).toMatchObject({
      event: { candidates: [{ content: { parts: [{ text: 'visible', thoughtSignature: 'wrapped:natural' }] }, finishReason: 'STOP' }] },
    });
    expect(output).toHaveLength(1);
  });

  test('moves an immediate continuation signature onto the buffered function-call event', async () => {
    const output: ProtocolFrame<GeminiStreamEvent>[] = [];
    for await (const frame of wrapGeminiAffinityEgress(frames([
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ functionCall: { id: 'call', name: 'tool', args: { a: 1 } } }] } }] }),
      eventFrame({
        candidates: [{
          index: 0,
          content: { role: 'model', parts: [{ functionCall: { id: 'call', name: 'tool', args: { b: 2 } }, thoughtSignature: 'natural' }] },
          finishReason: 'STOP',
        }],
      }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output[0]).toMatchObject({
      event: { candidates: [{ content: { parts: [{ thoughtSignature: 'wrapped:natural' }] } }] },
    });
    expect(output[1]).not.toMatchObject({ event: { candidates: [{ content: { parts: [{ thoughtSignature: expect.anything() }] } }] } });
  });

  test('slides one-event lookahead until a later natural signature closes the same element', async () => {
    const output: ProtocolFrame<GeminiStreamEvent>[] = [];
    for await (const frame of wrapGeminiAffinityEgress(frames([
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

  test('slides one-event lookahead to finish before synthesizing without a natural signature', async () => {
    const output: ProtocolFrame<GeminiStreamEvent>[] = [];
    for await (const frame of wrapGeminiAffinityEgress(frames([
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'a' }] } }] }),
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'b' }] } }] }),
      eventFrame({
        candidates: [{
          index: 0,
          content: { role: 'model', parts: [{ text: 'c' }] },
          finishReason: 'STOP',
        }],
      }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output[0]).not.toMatchObject({ event: { candidates: [{ content: { parts: [{ thoughtSignature: expect.anything() }] } }] } });
    expect(output[1]).not.toMatchObject({ event: { candidates: [{ content: { parts: [{ thoughtSignature: expect.anything() }] } }] } });
    expect(output[2]).toMatchObject({
      event: { candidates: [{ content: { parts: [{ text: 'c', thoughtSignature: 'wrapped:synthetic' }] }, finishReason: 'STOP' }] },
    });
  });

  test.each([
    [
      { text: 'a', thoughtSignature: 'old' },
      { text: 'b', thoughtSignature: 'latest' },
    ],
    [
      { functionCall: { id: 'call', name: 'tool', args: { a: 1 } }, thoughtSignature: 'old' },
      { functionCall: { id: 'call', name: 'tool', args: { b: 2 } }, thoughtSignature: 'latest' },
    ],
    [
      { text: 'a', thoughtSignature: 'old' },
      { thoughtSignature: 'latest' },
    ],
  ])('keeps one latest signature for repeated snapshots in the same event', async (first, second) => {
    const parts = [first, second];
    const output: ProtocolFrame<GeminiStreamEvent>[] = [];
    for await (const frame of wrapGeminiAffinityEgress(frames([eventFrame({
      candidates: [{ index: 0, content: { role: 'model', parts }, finishReason: 'STOP' }],
    })]), { codec: immediateCodec, affinity })) output.push(frame);

    const signatures = JSON.stringify(output).match(/wrapped:(?:old|latest)/g);
    expect(signatures).toEqual(['wrapped:latest']);
  });

  test('normalizes signatures independently for every logical element in one event', async () => {
    const output: ProtocolFrame<GeminiStreamEvent>[] = [];
    for await (const frame of wrapGeminiAffinityEgress(frames([eventFrame({
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
    expect(event?.candidates?.[0].content.parts).toEqual([
      { text: 'answer', thoughtSignature: 'wrapped:synthetic' },
      { functionCall: { id: 'call', name: 'tool', args: { a: 1 } }, thoughtSignature: 'wrapped:function-latest' },
      { functionCall: { id: 'call', name: 'tool', args: { b: 2 } } },
      { text: 'explanation', thought: true, thoughtSignature: 'wrapped:text-latest' },
      { text: 'continued', thought: true },
    ]);
  });

  test('places the latest signature on the first Part of a repeated function-call element', async () => {
    const output: ProtocolFrame<GeminiStreamEvent>[] = [];
    for await (const frame of wrapGeminiAffinityEgress(frames([eventFrame({
      candidates: [{
        index: 0,
        content: {
          role: 'model', parts: [
            { functionCall: { id: 'call', name: 'tool', args: { a: 1 } }, thoughtSignature: 'old' },
            { functionCall: { id: 'call', name: 'tool', args: { b: 2 } }, thoughtSignature: 'latest' },
          ],
        },
        finishReason: 'STOP',
      }],
    })]), { codec: immediateCodec, affinity })) output.push(frame);

    const event = output[0].type === 'event' && !('error' in output[0].event) ? output[0].event : undefined;
    const parts = event?.candidates?.[0].content.parts;
    expect(parts?.[0]).toMatchObject({ thoughtSignature: 'wrapped:latest' });
    expect(parts?.[1]).not.toHaveProperty('thoughtSignature');
  });

  test('moves the latest replacement from a signature-only lookahead', async () => {
    const output: ProtocolFrame<GeminiStreamEvent>[] = [];
    for await (const frame of wrapGeminiAffinityEgress(frames([
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'visible' }] } }] }),
      eventFrame({
        candidates: [{
          index: 0,
          content: { role: 'model', parts: [{ thoughtSignature: 'old' }, { thoughtSignature: 'latest' }] },
          finishReason: 'STOP',
        }],
      }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output[0]).toMatchObject({
      event: { candidates: [{ content: { parts: [{ thoughtSignature: 'wrapped:latest' }] }, finishReason: 'STOP' }] },
    });
    expect(JSON.stringify(output).match(/wrapped:(?:old|latest)/g)).toEqual(['wrapped:latest']);
  });

  test.each([
    { text: 'answer' },
    { functionCall: { id: 'call', name: 'tool', args: {} } },
  ])('moves a leading signature-only event forward onto the first content Part', async contentPart => {
    const output: ProtocolFrame<GeminiStreamEvent>[] = [];
    for await (const frame of wrapGeminiAffinityEgress(frames([
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ thoughtSignature: 'natural' }] } }] }),
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [contentPart] }, finishReason: 'STOP' }] }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      event: { candidates: [{ content: { parts: [{ thoughtSignature: 'wrapped:natural' }] }, finishReason: 'STOP' }] },
    });
  });

  test('moves event metadata forward when suppressing a leading signature event', async () => {
    const output: ProtocolFrame<GeminiStreamEvent>[] = [];
    for await (const frame of wrapGeminiAffinityEgress(frames([
      eventFrame({
        candidates: [withCandidateExtra(
          { index: 0, content: { role: 'model', parts: [{ thoughtSignature: 'natural' }] } },
          'vendor_text',
          'early-',
        )],
        modelVersion: 'model-v1',
      }),
      eventFrame({
        candidates: [withCandidateExtra(
          { index: 0, content: { role: 'model', parts: [{ text: 'answer' }] }, finishReason: 'STOP' },
          'vendor_text',
          'late',
        )],
        responseId: 'response-1',
      }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      event: {
        modelVersion: 'model-v1',
        responseId: 'response-1',
        candidates: [{
          vendor_text: 'early-late',
          content: { parts: [{ text: 'answer', thoughtSignature: 'wrapped:natural' }] },
        }],
      },
    });
  });

  test('merges candidate extension metadata backward from a suppressed trailer', async () => {
    const output: ProtocolFrame<GeminiStreamEvent>[] = [];
    for await (const frame of wrapGeminiAffinityEgress(frames([
      eventFrame({
        candidates: [withCandidateExtra(
          { index: 0, content: { role: 'model', parts: [{ text: 'answer' }] } },
          'vendor_text',
          'early-',
        )],
      }),
      eventFrame({
        candidates: [withCandidateExtra(
          { index: 0, content: { role: 'model', parts: [{ thoughtSignature: 'natural' }] }, finishReason: 'STOP' },
          'vendor_text',
          'late',
        )],
      }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ event: { candidates: [{ vendor_text: 'early-late' }] } });
  });

  test('keeps a leading signature with the different element that follows it', async () => {
    const output: ProtocolFrame<GeminiStreamEvent>[] = [];
    for await (const frame of wrapGeminiAffinityEgress(frames([
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'answer' }] } }] }),
      eventFrame({
        candidates: [{
          index: 0,
          content: {
            role: 'model', parts: [
              { thoughtSignature: 'natural' },
              { functionCall: { id: 'call', name: 'tool', args: {} } },
            ],
          },
          finishReason: 'STOP',
        }],
      }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output[0]).toMatchObject({
      event: { candidates: [{ content: { parts: [{ text: 'answer', thoughtSignature: 'wrapped:synthetic' }] } }] },
    });
    expect(output[1]).toMatchObject({
      event: { candidates: [{ content: { parts: [{ functionCall: { id: 'call' }, thoughtSignature: 'wrapped:natural' }] } }] },
    });
  });

  test('preserves a native empty candidate as an element boundary', async () => {
    const empty = withCandidateExtra(
      { index: 0, content: { role: 'model', parts: [] } },
      'vendor_empty',
      true,
    );
    const output: ProtocolFrame<GeminiStreamEvent>[] = [];
    for await (const frame of wrapGeminiAffinityEgress(frames([
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'first' }] } }] }),
      eventFrame({ candidates: [empty] }),
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'second' }] }, finishReason: 'STOP' }] }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output).toHaveLength(3);
    expect(output[0]).toMatchObject({ event: { candidates: [{ content: { parts: [{ thoughtSignature: 'wrapped:synthetic' }] } }] } });
    expect(output[1]).toMatchObject({ event: { candidates: [{ vendor_empty: true, content: { parts: [] } }] } });
    expect(output[2]).not.toMatchObject({ event: { candidates: [{ content: { parts: [{ thoughtSignature: expect.anything() }] } }] } });
  });

  test('preserves native empty Parts when adding a standalone fallback carrier', async () => {
    const output: ProtocolFrame<GeminiStreamEvent>[] = [];
    for await (const frame of wrapGeminiAffinityEgress(frames([eventFrame({
      candidates: [{
        index: 0,
        content: { role: 'model', parts: [{ text: '' }, { thought: true }] },
        finishReason: 'STOP',
      }],
    })]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output[0]).toMatchObject({
      event: {
        candidates: [{
          content: {
            parts: [
              { text: '' },
              { thought: true },
              { thoughtSignature: 'wrapped:synthetic' },
            ],
          },
        }],
      },
    });
  });

  test('keeps a natural signature-only finishing candidate as its anchor', async () => {
    const output: ProtocolFrame<GeminiStreamEvent>[] = [];
    for await (const frame of wrapGeminiAffinityEgress(frames([eventFrame({
      candidates: [{
        index: 0,
        content: { role: 'model', parts: [{ thoughtSignature: 'old' }, { thoughtSignature: 'latest' }] },
        finishReason: 'STOP',
      }],
    })]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output).toEqual([eventFrame({
      candidates: [{
        index: 0,
        content: { role: 'model', parts: [{ thoughtSignature: 'wrapped:latest' }] },
        finishReason: 'STOP',
      }],
    })]);
  });

  test('preserves the role when folding a signature-only terminal candidate', async () => {
    const output: ProtocolFrame<GeminiStreamEvent>[] = [];
    for await (const frame of wrapGeminiAffinityEgress(frames([
      eventFrame({ candidates: [{ index: 0, content: { parts: [{ text: 'visible' }] } }] }),
      eventFrame({
        candidates: [{
          index: 0,
          content: { role: 'model', parts: [{ thoughtSignature: 'natural' }] },
          finishReason: 'STOP',
        }],
      }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output[0]).toEqual(eventFrame({
      candidates: [{
        index: 0,
        content: { role: 'model', parts: [{ text: 'visible', thoughtSignature: 'wrapped:natural' }] },
        finishReason: 'STOP',
      }],
    }));
  });

  test('treats an absent candidate as a boundary before an interleaved candidate', async () => {
    const output: ProtocolFrame<GeminiStreamEvent>[] = [];
    for await (const frame of wrapGeminiAffinityEgress(frames([
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'a' }] } }] }),
      eventFrame({ candidates: [{ index: 1, content: { role: 'model', parts: [{ text: 'b' }] } }] }),
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'c', thoughtSignature: 'natural' }] }, finishReason: 'STOP' }] }),
      eventFrame({ candidates: [{ index: 1, content: { role: 'model', parts: [{ text: 'd' }] }, finishReason: 'STOP' }] }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output[0]).toMatchObject({ event: { candidates: [{ index: 0, content: { parts: [{ thoughtSignature: 'wrapped:synthetic' }] } }] } });
    expect(output[1]).toMatchObject({ event: { candidates: [{ index: 1, content: { parts: [{ thoughtSignature: 'wrapped:synthetic' }] } }] } });
    expect(output[2]).toMatchObject({ event: { candidates: [{ index: 0, content: { parts: [{ thoughtSignature: 'wrapped:natural' }] } }] } });
  });

  test('does not merge adjacent complete same-name function calls without IDs', async () => {
    const output: ProtocolFrame<GeminiStreamEvent>[] = [];
    for await (const frame of wrapGeminiAffinityEgress(frames([
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ functionCall: { name: 'tool', args: { a: 1 } } }] } }] }),
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ functionCall: { name: 'tool', args: { b: 2 } }, thoughtSignature: 'natural' }] }, finishReason: 'STOP' }] }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output[0]).toMatchObject({ event: { candidates: [{ content: { parts: [{ thoughtSignature: 'wrapped:synthetic' }] } }] } });
    expect(output[1]).toMatchObject({ event: { candidates: [{ content: { parts: [{ thoughtSignature: 'wrapped:natural' }] } }] } });
  });

  test('does not merge a same-name function call when only the earlier call has an ID', async () => {
    const output: ProtocolFrame<GeminiStreamEvent>[] = [];
    for await (const frame of wrapGeminiAffinityEgress(frames([
      eventFrame({
        candidates: [{
          index: 0,
          content: { role: 'model', parts: [{ functionCall: { id: 'first', name: 'tool', args: { a: 1 } } }] },
        }],
      }),
      eventFrame({
        candidates: [{
          index: 0,
          content: { role: 'model', parts: [{ functionCall: { name: 'tool', args: { b: 2 } }, thoughtSignature: 'natural' }] },
          finishReason: 'STOP',
        }],
      }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output[0]).toMatchObject({ event: { candidates: [{ content: { parts: [{ thoughtSignature: 'wrapped:synthetic' }] } }] } });
    expect(output[1]).toMatchObject({ event: { candidates: [{ content: { parts: [{ thoughtSignature: 'wrapped:natural' }] } }] } });
  });

  test('synthesizes on the buffered first element when the lookahead starts a different element', async () => {
    const output: ProtocolFrame<GeminiStreamEvent>[] = [];
    for await (const frame of wrapGeminiAffinityEgress(frames([
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'answer' }] } }] }),
      eventFrame({
        candidates: [{
          index: 0,
          content: { role: 'model', parts: [{ functionCall: { name: 'tool', args: {} } }] },
          finishReason: 'STOP',
        }],
      }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output[0]).toMatchObject({
      event: { candidates: [{ content: { parts: [{ text: 'answer', thoughtSignature: 'wrapped:synthetic' }] } }] },
    });
    expect(output[1]).not.toMatchObject({ event: { candidates: [{ content: { parts: [{ thoughtSignature: expect.anything() }] } }] } });
  });

  test('preserves usage billing metadata through the event clone', async () => {
    const billing = { cacheWriteTokenCount: 3, serviceTier: 'priority' };
    const output: ProtocolFrame<GeminiStreamEvent>[] = [];
    for await (const frame of wrapGeminiAffinityEgress(frames([eventFrame({
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'answer' }] }, finishReason: 'STOP' }],
      usageMetadata: { totalTokenCount: 4, [USAGE_BILLING]: billing },
    })]), { codec: immediateCodec, affinity })) output.push(frame);

    const event = output[0].type === 'event' && !('error' in output[0].event) ? output[0].event : undefined;
    expect(event?.usageMetadata?.[USAGE_BILLING]).toEqual(billing);
    expect(event?.usageMetadata?.[USAGE_BILLING]).not.toBe(billing);
  });

  test('flushes pending visible content before propagating an iterator failure', async () => {
    const source = async function* (): AsyncGenerator<ProtocolFrame<GeminiStreamEvent>> {
      yield eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'visible' }] } }] });
      throw new Error('upstream failed');
    };
    const iterator = wrapGeminiAffinityEgress(source(), { codec: immediateCodec, affinity })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { event: { candidates: [{ content: { parts: [{ text: 'visible' }] } }] } },
    });
    await expect(iterator.next()).rejects.toThrow('upstream failed');
  });
});
