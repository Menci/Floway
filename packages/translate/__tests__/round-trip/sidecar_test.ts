import { expect, test } from 'vitest';

import { createTestSidecarCodec } from './sidecar-codec.ts';
import { ROUND_TRIP_SIDECAR_VERSION, decodeRoundTripSidecar, encodeRoundTripSidecar, type RoundTripSidecar } from '../../src/round-trip/sidecar.ts';

const envelope: RoundTripSidecar<'openaiChatCompletions'> = {
  v: ROUND_TRIP_SIDECAR_VERSION,
  source: 'openaiResponses', target: 'openaiChatCompletions',
  targetTurn: { role: 'assistant', content: 'answer' },
  sourceTurnDigest: new Uint8Array(8),
};

test('restores current v2 and legacy v1 round-trip payloads recognized by the injected decoder', async () => {
  const codec = createTestSidecarCodec();
  const encoded = await encodeRoundTripSidecar(codec, envelope);
  expect(await decodeRoundTripSidecar(codec, 'openaiResponses', encoded)).toEqual(envelope);
  expect(await decodeRoundTripSidecar(codec, 'anthropicMessages', encoded)).toBeUndefined();

  const legacyV1: RoundTripSidecar<'openaiChatCompletions'> = { ...envelope, v: 1 };
  const encodedV1 = await encodeRoundTripSidecar(codec, legacyV1);
  expect(await decodeRoundTripSidecar(codec, 'openaiResponses', encodedV1)).toEqual(legacyV1);
});

test('rejects a payload whose top-level wire version this build does not know', async () => {
  const codec = createTestSidecarCodec();
  // One wire version covers every subsystem; an unknown value must fail here
  // rather than reach a turn-digest mapping that happens to accept it.
  const future = await codec.encode({ ...envelope, v: 3 });
  await expect(decodeRoundTripSidecar(codec, 'openaiResponses', future)).rejects.toThrow(TypeError);
});
