import { expect, test } from 'vitest';

import { createTestSidecarCodec } from './sidecar-codec.ts';
import { decodeRoundTripSidecar, encodeRoundTripSidecar, type RoundTripSidecar } from '../../src/round-trip/sidecar.ts';

const envelope: RoundTripSidecar<'openaiChatCompletions'> = {
  v: 1,
  source: 'openaiResponses', target: 'openaiChatCompletions',
  targetTurn: { role: 'assistant', content: 'answer' },
  sourceTurnDigest: new Uint8Array(8),
};

test('restores a round-trip payload recognized by the injected decoder', async () => {
  const codec = createTestSidecarCodec();
  const encoded = await encodeRoundTripSidecar(codec, envelope);
  expect(await decodeRoundTripSidecar(codec, 'openaiResponses', encoded)).toEqual(envelope);
  expect(await decodeRoundTripSidecar(codec, 'anthropicMessages', encoded)).toBeUndefined();
});

test('rejects a payload whose top-level wire version this build does not know', async () => {
  const codec = createTestSidecarCodec();
  // One wire version covers every subsystem; an unknown value must fail here
  // rather than reach a turn-digest mapping that happens to accept it.
  const future = await codec.encode({ ...envelope, v: 2 });
  await expect(decodeRoundTripSidecar(codec, 'openaiResponses', future)).rejects.toThrow('sidecar version is unsupported');
});

test('rejects a malformed payload recognized by the injected decoder', async () => {
  const codec = createTestSidecarCodec();
  const malformed = await codec.encode({ v: 1, source: 'openaiResponses', target: 'openaiChatCompletions' });
  await expect(decodeRoundTripSidecar(codec, 'openaiResponses', malformed)).rejects.toThrow('assistant turn is invalid');
  const nonObject = await codec.encode(null);
  await expect(decodeRoundTripSidecar(codec, 'openaiResponses', nonObject)).rejects.toThrow('sidecar envelope is invalid');
});
