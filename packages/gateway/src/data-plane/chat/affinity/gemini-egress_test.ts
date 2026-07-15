import { describe, expect, test } from 'vitest';

import type { AffinityEgressCodec } from './affinity-egress.ts';
import { wrapGeminiAffinityEgress } from './gemini-egress.ts';
import type { AffinityTarget } from './types.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiStreamEvent } from '@floway-dev/protocols/gemini';

const affinity: AffinityTarget = {
  mode: 'prefer',
  upstreamId: 'up-a',
  upstreamRevision: 'rev-a',
  modelId: 'model-a',
  rulesPresent: false,
};

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
  test('emits visible part data before wrapping a thoughtSignature from the same part', async () => {
    const codec = new DelayedCodec();
    const input: GeminiStreamEvent = {
      candidates: [{
        index: 0,
        content: { role: 'model', parts: [{ text: 'visible', thoughtSignature: 'opaque' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { totalTokenCount: 2 },
    };
    const output = wrapGeminiAffinityEgress(frames([eventFrame(input)]), { codec, affinity })[Symbol.asyncIterator]();

    expect((await output.next()).value).toEqual(eventFrame({
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'visible' }] } }],
    }));
    expect(codec.calls).toHaveLength(0);

    const carrierPending = output.next();
    await Promise.resolve();
    expect(codec.calls.map(call => call.value)).toEqual(['opaque']);
    codec.calls[0].resolve('wrapped-opaque');
    expect((await carrierPending).value).toEqual(eventFrame({
      candidates: [{
        index: 0,
        content: { role: 'model', parts: [{ thoughtSignature: 'wrapped-opaque' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { totalTokenCount: 2 },
    }));
  });

  test('synthesizes a signature-only part for each finishing candidate without one', async () => {
    const output: ProtocolFrame<GeminiStreamEvent>[] = [];
    for await (const frame of wrapGeminiAffinityEgress(frames([eventFrame({
      candidates: [
        { index: 0, content: { role: 'model', parts: [{ text: 'a' }] }, finishReason: 'STOP' },
        { index: 1, content: { role: 'model', parts: [{ functionCall: { name: 'tool', args: {} } }] }, finishReason: 'MAX_TOKENS' },
      ],
    })]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output[0]).toMatchObject({
      event: {
        candidates: [
          { index: 0, content: { parts: [{ text: 'a' }] } },
          { index: 1, content: { parts: [{ functionCall: { name: 'tool' } }] } },
        ],
      },
    });
    expect(output[1]).toMatchObject({
      event: {
        candidates: [
          { index: 0, content: { parts: [{ thoughtSignature: 'wrapped:synthetic' }] }, finishReason: 'STOP' },
          { index: 1, content: { parts: [{ thoughtSignature: 'wrapped:synthetic' }] }, finishReason: 'MAX_TOKENS' },
        ],
      },
    });
  });
});
