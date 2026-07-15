import { describe, expect, test, vi } from 'vitest';

import { wrapGeminiAffinityEgress } from './egress.ts';
import type { AffinityCodec } from '../../shared/affinity/codec.ts';
import type { AffinityTarget } from '../../shared/affinity/types.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiStreamEvent } from '@floway-dev/protocols/gemini';

const affinity: AffinityTarget = {
  upstreamId: 'up-a',
  modelId: 'model-a',
  rulesPresent: false,
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

  test('waits for an immediate natural signature on the same function-call element', async () => {
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

    expect(output[0]).not.toMatchObject({ event: { candidates: [{ content: { parts: [{ thoughtSignature: expect.anything() }] } }] } });
    expect(output[1]).toMatchObject({
      event: { candidates: [{ content: { parts: [{ thoughtSignature: 'wrapped:natural' }] }, finishReason: 'STOP' }] },
    });
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
