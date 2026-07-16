import { describe, expect, test, vi } from 'vitest';

import { wrapGeminiAffinityEgress } from './egress.ts';
import type { AffinityCodec } from '../../shared/affinity/index.ts';
import type { AffinityTarget } from '../../shared/affinity/index.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiStreamEvent } from '@floway-dev/protocols/gemini';

const affinity: AffinityTarget = {
  upstreamId: 'up-a',
  modelId: 'model-a',
};

type AffinityEgressCodec = Pick<AffinityCodec, 'wrap'>;

const frames = async function* (values: ProtocolFrame<GeminiStreamEvent>[]) {
  yield* values;
};

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
    }));
    expect(output[1]).toEqual(eventFrame({ candidates: [], usageMetadata: { totalTokenCount: 2 } }));
  });

  test('moves an immediate continuation signature onto the buffered function-call event', async () => {
    const output: ProtocolFrame<GeminiStreamEvent>[] = [];
    for await (const frame of wrapGeminiAffinityEgress(frames([
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ functionCall: { id: 'call', name: 'tool', args: { a: 1 } } }] } }] }),
      eventFrame({
        candidates: [{
          index: 0,
          content: { role: 'model', parts: [{ functionCall: { name: 'tool', args: { b: 2 } }, thoughtSignature: 'natural' }] },
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
});
