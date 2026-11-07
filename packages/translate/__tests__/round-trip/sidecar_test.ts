import { expect, test } from 'vitest';

import { createTestSidecarCodec } from './sidecar-codec.ts';
import { decodeRoundTripSidecar, encodeRoundTripSidecar, type RoundTripSidecar } from '../../src/round-trip/sidecar.ts';
import { rawJSON } from '../../src/shared/json/raw-json.ts';
import { assertEquals } from '@floway-dev/test-utils';

const envelope: RoundTripSidecar<'openaiChatCompletions'> = {
  v: 1,
  source: 'openaiResponses', target: 'openaiChatCompletions',
  targetTurn: { role: 'assistant', content: 'answer' },
  sourceTurnDigest: new Uint8Array(8),
};

test('restores a round-trip payload recognized by the injected decoder', async () => {
  const codec = createTestSidecarCodec();
  const encoded = await encodeRoundTripSidecar(codec, envelope);
  expect(await decodeRoundTripSidecar(codec, encoded)).toEqual(envelope);
});

test('rejects a payload whose top-level wire version this build does not know', async () => {
  const codec = createTestSidecarCodec();
  // One wire version covers every subsystem; an unknown value must fail here
  // rather than reach a turn-digest mapping that happens to accept it.
  const future = await codec.encode({ ...envelope, v: 2 });
  await expect(decodeRoundTripSidecar(codec, future)).rejects.toThrow('sidecar version is unsupported');
});

test('does not claim an opaque value unrecognized by the injected decoder', async () => {
  expect(await decodeRoundTripSidecar(createTestSidecarCodec(), 'native opaque value')).toBeUndefined();
});

test('rejects a malformed payload recognized by the injected decoder', async () => {
  const codec = createTestSidecarCodec();
  const malformed = await codec.encode({ v: 1, source: 'openaiResponses', target: 'openaiChatCompletions' });
  await expect(decodeRoundTripSidecar(codec, malformed)).rejects.toThrow('assistant turn is invalid');
  const nonObject = await codec.encode(null);
  await expect(decodeRoundTripSidecar(codec, nonObject)).rejects.toThrow('sidecar envelope is invalid');
});

test('validates an envelope regardless of which protocol it names', async () => {
  const codec = createTestSidecarCodec();
  // Decoding states the envelope's format, not whether it belongs to the trip
  // reading it: an envelope naming another source is still well formed.
  const otherSource = await codec.encode({ v: 1, source: 'anthropicMessages', target: 'openaiChatCompletions', targetTurn: { role: 'assistant', content: [] }, sourceTurnDigest: new Uint8Array(8) });
  assertEquals((await decodeRoundTripSidecar(codec, otherSource))?.source, 'anthropicMessages');
  // A target that is not a protocol at all is malformed, whoever asks.
  const badTarget = await codec.encode({ v: 1, source: 'anthropicMessages', target: 'invalid' });
  await expect(decodeRoundTripSidecar(codec, badTarget)).rejects.toThrow('sidecar target is invalid');
});

test('the opaque fixture codec isolates scopes and changed handles', async () => {
  const first = createTestSidecarCodec('same-scope');
  const encoded = await first.encode(envelope);
  expect(await createTestSidecarCodec('same-scope').decode(encoded)).toEqual(envelope);
  expect(await createTestSidecarCodec('other-scope').decode(encoded)).toBeUndefined();
  expect(await first.decode(`changed-${encoded}`)).toBeUndefined();
});

test('the opaque fixture codec rejects undefined and directly returns other payloads', async () => {
  const codec = createTestSidecarCodec();
  // @ts-expect-error The injected encoder excludes undefined payloads.
  await expect(codec.encode(undefined)).rejects.toThrow('Sidecar payload must not be undefined');
  for (const payload of [null, false, 0, '']) expect(await codec.decode(await codec.encode(payload))).toBe(payload);
});

test('the opaque fixture codec independently snapshots JSON values, raw numbers, and replay bytes', async () => {
  const codec = createTestSidecarCodec();
  const payload: RoundTripSidecar<'openaiChatCompletions'> = {
    ...envelope,
    targetTurn: { role: 'assistant', content: 'original', provider_specific_fields: { amount: rawJSON.rawJSON('1e400') } },
    sourceTurnDigest: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
  };
  const encoded = await encodeRoundTripSidecar(codec, payload);
  payload.targetTurn.content = 'edited input';
  payload.sourceTurnDigest[0] = 9;
  const decoded = await decodeRoundTripSidecar(codec, encoded);
  if (decoded?.target !== 'openaiChatCompletions') throw new Error('Expected Chat history');
  expect(decoded.targetTurn.content).toBe('original');
  expect(decoded.sourceTurnDigest[0]).toBe(1);
  expect(JSON.stringify(decoded.targetTurn.provider_specific_fields)).toBe('{"amount":1e400}');
  decoded.targetTurn.content = 'edited output';
  decoded.sourceTurnDigest[0] = 10;
  const second = await decodeRoundTripSidecar(codec, encoded);
  if (second?.target !== 'openaiChatCompletions') throw new Error('Expected Chat history');
  expect(second.targetTurn.content).toBe('original');
  expect(second.sourceTurnDigest[0]).toBe(1);
});
