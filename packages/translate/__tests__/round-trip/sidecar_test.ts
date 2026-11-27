import { expect, test } from 'vitest';

import { createTestSidecarCodec } from './sidecar-codec.ts';
import { ROUND_TRIP_SIDECAR_VERSION, decodeRoundTripSidecar, encodeRoundTripSidecar, type RoundTripSidecar } from '../../src/round-trip/sidecar.ts';

const envelope: RoundTripSidecar<'openaiChatCompletions'> = {
  v: ROUND_TRIP_SIDECAR_VERSION,
  source: 'openaiResponses', target: 'openaiChatCompletions',
  targetTurn: { role: 'assistant', content: 'answer' },
  sourceTurnDigest: new Uint8Array(8),
};

test('restores current v3 and legacy v1/v2 round-trip payloads recognized by the injected decoder', async () => {
  const codec = createTestSidecarCodec();
  const encoded = await encodeRoundTripSidecar(codec, envelope);
  expect(await decodeRoundTripSidecar(codec, 'openaiResponses', encoded)).toEqual(envelope);
  expect(await decodeRoundTripSidecar(codec, 'anthropicMessages', encoded)).toBeUndefined();

  for (const version of [1, 2] as const) {
    const legacy: RoundTripSidecar<'openaiChatCompletions'> = { ...envelope, v: version };
    const encodedLegacy = await encodeRoundTripSidecar(codec, legacy);
    expect(await decodeRoundTripSidecar(codec, 'openaiResponses', encodedLegacy)).toEqual(legacy);
  }
});

test('rejects a payload whose top-level wire version this build does not know', async () => {
  const codec = createTestSidecarCodec();
  // One wire version covers every subsystem; an unknown value must fail here
  // rather than reach a turn-digest mapping that happens to accept it.
  const future = await codec.encode({ ...envelope, v: 4 });
  await expect(decodeRoundTripSidecar(codec, 'openaiResponses', future)).rejects.toThrow(TypeError);
});
