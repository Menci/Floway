import { expect, test } from 'vitest';

import { createTestSidecarCodec } from './sidecar-codec.ts';
import { decodeRoundTripSidecar, type RoundTripSidecar } from '../../src/round-trip/sidecar.ts';
import { rawJSON } from '../../src/shared/json/raw-json.ts';

const envelope: RoundTripSidecar<'openaiChatCompletions'> = {
  source: 'openaiResponses', target: 'openaiChatCompletions',
  assistantTurn: { role: 'assistant', content: 'answer' },
  replayCheck: { version: 1, digest: new Uint8Array(8) },
};

test('restores a round-trip payload recognized by the injected decoder', async () => {
  const codec = createTestSidecarCodec();
  const encoded = await codec.encode(envelope);
  expect(await decodeRoundTripSidecar(codec, 'openaiResponses', encoded)).toEqual(envelope);
  expect(await decodeRoundTripSidecar(codec, 'anthropicMessages', encoded)).toBeUndefined();
});

test('does not claim an opaque value unrecognized by the injected decoder', async () => {
  expect(await decodeRoundTripSidecar(createTestSidecarCodec(), 'openaiResponses', 'native opaque value')).toBeUndefined();
});

test('rejects a malformed payload recognized by the injected decoder', async () => {
  const codec = createTestSidecarCodec();
  const malformed = await codec.encode({ source: 'openaiResponses', target: 'openaiChatCompletions' });
  await expect(decodeRoundTripSidecar(codec, 'openaiResponses', malformed)).rejects.toThrow('assistant turn is invalid');
  const nonObject = await codec.encode(null);
  await expect(decodeRoundTripSidecar(codec, 'openaiResponses', nonObject)).rejects.toThrow('sidecar envelope is invalid');
});

test('does not validate a payload belonging to another source protocol', async () => {
  const codec = createTestSidecarCodec();
  const otherSource = await codec.encode({ source: 'anthropicMessages', target: 'invalid' });
  expect(await decodeRoundTripSidecar(codec, 'openaiResponses', otherSource)).toBeUndefined();
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
    assistantTurn: { role: 'assistant', content: 'original', provider_specific_fields: { amount: rawJSON.rawJSON('1e400') } },
    replayCheck: { version: 1, digest: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) },
  };
  const encoded = await codec.encode(payload);
  payload.assistantTurn.content = 'edited input';
  payload.replayCheck.digest[0] = 9;
  const decoded = await decodeRoundTripSidecar(codec, 'openaiResponses', encoded);
  if (decoded?.target !== 'openaiChatCompletions') throw new Error('Expected Chat history');
  expect(decoded.assistantTurn.content).toBe('original');
  expect(decoded.replayCheck.digest[0]).toBe(1);
  expect(JSON.stringify(decoded.assistantTurn.provider_specific_fields)).toBe('{"amount":1e400}');
  decoded.assistantTurn.content = 'edited output';
  decoded.replayCheck.digest[0] = 10;
  const second = await decodeRoundTripSidecar(codec, 'openaiResponses', encoded);
  if (second?.target !== 'openaiChatCompletions') throw new Error('Expected Chat history');
  expect(second.assistantTurn.content).toBe('original');
  expect(second.replayCheck.digest[0]).toBe(1);
});
