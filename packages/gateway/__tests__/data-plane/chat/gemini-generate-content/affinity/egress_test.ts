import { describe, expect, test, vi } from 'vitest';

import { wrapGeminiGenerateContentAffinityEgress } from '../../../../../src/data-plane/chat/gemini-generate-content/affinity/egress.ts';
import type { AffinityCodec, AffinityIdentity } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

const affinity: AffinityIdentity = {
  upstreamId: 'up-a',
  modelId: 'model-a',
  opaqueBlobCompatibilityIdentity: { upstreamId: 'up-a', key: 'model-a' },
};
const frames = async function* (values: ProtocolFrame<GeminiGenerateContentStreamEvent>[]) { yield* values; };
const codec: Pick<AffinityCodec, 'wrap'> = { wrap: async value => `wrapped:${value}` };

const collect = async (values: ProtocolFrame<GeminiGenerateContentStreamEvent>[]) => {
  const output = [];
  for await (const frame of wrapGeminiGenerateContentAffinityEgress(frames(values), { codec, affinity })) output.push(frame);
  return output;
};

describe('Gemini generateContent affinity egress', () => {
  test('wraps a trailing signature-only Part in its original event', async () => {
    const visible = eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'answer' }] } }], modelVersion: 'model-v1' });
    const trailer = eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ thoughtSignature: 'sidecar' }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 2 } });
    const original = structuredClone(trailer);
    expect(await collect([visible, trailer, doneFrame()])).toEqual([
      visible,
      eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ thoughtSignature: 'wrapped:sidecar' }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 2 } }),
      doneFrame(),
    ]);
    expect(trailer).toEqual(original);
  });

  test('wraps each existing signature without collapsing Parts or candidates', async () => {
    const event = {
      candidates: [
        { index: 0, content: { role: 'model', parts: [{ text: 'a', thoughtSignature: 'first' }, { thoughtSignature: 'second' }, { functionCall: { id: 'call', name: 'tool', args: { x: 1 } }, thoughtSignature: 'tool' }] }, finishReason: 'STOP' },
        { index: 1, content: { parts: [{ text: '', thought: true, thoughtSignature: 'other' }] }, finishReason: 'MAX_TOKENS' },
      ],
      responseId: 'response-1',
    };
    expect(await collect([eventFrame(event)])).toEqual([eventFrame({
      ...event,
      candidates: [
        { ...event.candidates[0], content: { role: 'model', parts: [{ text: 'a', thoughtSignature: 'wrapped:first' }, { thoughtSignature: 'wrapped:second' }, { functionCall: { id: 'call', name: 'tool', args: { x: 1 } }, thoughtSignature: 'wrapped:tool' }] } },
        { ...event.candidates[1], content: { parts: [{ text: '', thought: true, thoughtSignature: 'wrapped:other' }] } },
      ],
    })]);
  });

  test.each([
    {},
    { candidates: [] },
    { candidates: [{ finishReason: 'STOP' }] },
    { candidates: [{ content: { role: 'model' }, finishReason: 'STOP' }] },
    { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'answer' }, { thought: true }, { thoughtSignature: '' }] }, finishReason: 'STOP' }] },
  ])('forwards unsigned output without adding or defaulting fields: %j', async event => {
    const wrap = vi.fn(codec.wrap);
    const input = eventFrame(event);
    const iterator = wrapGeminiGenerateContentAffinityEgress(frames([input]), { codec: { wrap }, affinity });
    const output = [];
    for await (const frame of iterator) output.push(frame);
    expect(output).toEqual([input]);
    expect(output[0]).toBe(input);
    expect(wrap).not.toHaveBeenCalled();
  });

  test('emits visible content without reading ahead and propagates the original iterator failure', async () => {
    const error = new Error('upstream failed');
    const visible = eventFrame({ candidates: [{ content: { parts: [{ text: 'visible' }] } }] });
    let reads = 0;
    const source = async function* () {
      reads++;
      yield visible;
      reads++;
      throw error;
    };
    const iterator = wrapGeminiGenerateContentAffinityEgress(source(), { codec, affinity });
    expect((await iterator.next()).value).toBe(visible);
    expect(reads).toBe(1);
    await expect(iterator.next()).rejects.toBe(error);
  });

  test('forwards an error frame without wrapping or consuming later frames', async () => {
    const failure = eventFrame({ error: { code: 500, message: 'failed', status: 'INTERNAL' } });
    const later = eventFrame({ candidates: [{ content: { parts: [{ thoughtSignature: 'later' }] } }] });
    let reads = 0;
    const source = async function* () {
      reads++;
      yield failure;
      reads++;
      yield later;
    };
    const output = [];
    for await (const frame of wrapGeminiGenerateContentAffinityEgress(source(), { codec, affinity })) output.push(frame);
    expect(output).toEqual([failure]);
    expect(reads).toBe(1);
  });
});
