import { expect, test, vi } from 'vitest';

import { wrapGeminiGenerateContentAffinityEgress } from '../../../../../src/data-plane/chat/gemini-generate-content/affinity/egress.ts';
import type { AffinityCodec, AffinityIdentity } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

const affinity: AffinityIdentity = { upstreamId: 'up-a', modelId: 'model-a', opaqueBlobCompatibilityIdentity: { upstreamId: 'up-a', key: 'model-a' } };
const wrap = vi.fn(async (value: string | undefined) => `wrapped:${value ?? 'synthetic'}`);
const codec = { wrap } as unknown as AffinityCodec;
const collect = async (values: ProtocolFrame<GeminiGenerateContentStreamEvent>[]) => {
  const output = [];
  for await (const frame of wrapGeminiGenerateContentAffinityEgress((async function* () { yield* values; })(), { codec, affinity })) output.push(frame);
  return output;
};

test('wraps each existing signature in place while preserving Parts, SSE order, metadata, and source values', async () => {
  const values = [
    eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'live' }] } }] }),
    eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ thoughtSignature: 'one' }, { text: 'later', thoughtSignature: 'two' }] }, finishReason: 'STOP' }], responseId: 'response' }),
    doneFrame(),
  ];
  const before = structuredClone(values);
  const output = await collect(values);
  expect(output).toEqual([values[0], eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ thoughtSignature: 'wrapped:one' }, { text: 'later', thoughtSignature: 'wrapped:two' }] }, finishReason: 'STOP' }], responseId: 'response' }), values[2]]);
  expect(output[0]).toBe(values[0]);
  expect(values).toEqual(before);
});

test('visible content is yielded before the next upstream frame is requested', async () => {
  let reads = 0;
  const output = wrapGeminiGenerateContentAffinityEgress((async function* () {
    reads++;
    yield eventFrame({ candidates: [{ content: { parts: [{ text: 'live' }] } }] });
    reads++;
    yield eventFrame({ candidates: [{ finishReason: 'STOP' }] });
  })(), { codec, affinity });
  const first = await output.next();
  expect(first.value).toEqual(eventFrame({ candidates: [{ content: { parts: [{ text: 'live' }] } }] }));
  expect(reads).toBe(1);
  await output.return(undefined);
});

test('adds one standalone synthetic carrier at each missing candidate finish, including omitted content and default index', async () => {
  const output = await collect([
    eventFrame({ candidates: [{ content: { role: 'model', parts: [{ text: 'zero' }] } }, { index: 1, content: { parts: [{ functionCall: { name: 'f', args: {} } }] } }] }),
    eventFrame({ candidates: [{ finishReason: 'STOP' }, { index: 1, finishReason: 'STOP' }] }),
    eventFrame({ candidates: [{ index: 0, finishReason: 'STOP' }] }),
  ]);
  expect(output[1]).toEqual(eventFrame({
    candidates: [
      { finishReason: 'STOP', content: { role: 'model', parts: [{ thoughtSignature: 'wrapped:synthetic' }] } },
      { index: 1, finishReason: 'STOP', content: { role: 'model', parts: [{ thoughtSignature: 'wrapped:synthetic' }] } },
    ],
  }));
  expect(output[2]).toEqual(eventFrame({ candidates: [{ index: 0, finishReason: 'STOP' }] }));
});

test('a natural standalone carrier satisfies affinity without being attached to text or tools', async () => {
  const output = await collect([
    eventFrame({ candidates: [{ index: 0, content: { parts: [{ functionCall: { id: 'c', name: 'f', args: {} } }] } }] }),
    eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ thoughtSignature: 'carrier' }] }, finishReason: 'STOP' }] }),
  ]);
  expect(output).toEqual([
    eventFrame({ candidates: [{ index: 0, content: { parts: [{ functionCall: { id: 'c', name: 'f', args: {} } }] } }] }),
    eventFrame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ thoughtSignature: 'wrapped:carrier' }] }, finishReason: 'STOP' }] }),
  ]);
});

test('errors and unsuccessful stream ends do not create affinity carriers', async () => {
  const values = [eventFrame({ candidates: [{ content: { parts: [{ text: 'partial' }] } }] }), eventFrame<GeminiGenerateContentStreamEvent>({ error: { code: 500, status: 'INTERNAL', message: 'failed' } })];
  expect(await collect(values)).toEqual(values);
  const output = wrapGeminiGenerateContentAffinityEgress((async function* () { yield values[0]; throw new Error('upstream failed'); })(), { codec, affinity });
  expect((await output.next()).value).toBe(values[0]);
  await expect(output.next()).rejects.toThrow('upstream failed');
});
