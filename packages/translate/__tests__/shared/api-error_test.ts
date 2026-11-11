import { expect, test, vi } from 'vitest';

import { routeOpenAIChatCompletionsViaOpenAIResponses } from '../../src/index.ts';
import { createTestSidecarCodec } from '../round-trip/sidecar-codec.ts';

const createTrip = async () => {
  const trip = await routeOpenAIChatCompletionsViaOpenAIResponses({
    model: 'm', stream: true, messages: [{ role: 'user', content: 'hello' }],
  }, { sidecarCodec: createTestSidecarCodec() });
  if (trip.type !== 'trip') throw new Error(trip.message);
  return trip;
};

test('error restatement retains nullable fields, unused aliases and outer metadata', async () => {
  const trip = await createTrip();
  const result = trip.error(400, new Headers({ 'retry-after': '5' }), new TextEncoder().encode(JSON.stringify({
    error: { message: 'bad field', code: null, param: null, status: 'INVALID_ARGUMENT' }, request_id: 'req_1',
  })));
  expect(result?.body).toEqual({
    error: {
      message: 'bad field', type: 'server_error', code: null, param: null,
      provider_specific_fields: { status: 'INVALID_ARGUMENT', request_id: 'req_1' },
    },
  });
  expect(result?.status).toBe(400);
  expect(result?.headers.get('retry-after')).toBe('5');
});

test('unrecognized encoding and nonobject JSON leave the upstream body untouched', async () => {
  const trip = await createTrip();
  const invalid = new Uint8Array([
    ...new TextEncoder().encode('{"error":{"message":"'), 255, ...new TextEncoder().encode('"}}'),
  ]);
  expect(trip.error(500, new Headers(), invalid)).toBeUndefined();
  for (const body of ['null', '[]', '502 Bad Gateway']) {
    expect(trip.error(500, new Headers(), new TextEncoder().encode(body))).toBeUndefined();
  }
});

test('an internal error from JSON parsing propagates with its original cause', async () => {
  const trip = await createTrip();
  const failure = new Error('internal parser failure', { cause: new Error('underlying failure') });
  const json = JSON as typeof JSON & { rawJSON: (text: string) => unknown };
  const spy = vi.spyOn(json, 'rawJSON').mockImplementation(() => { throw failure; });
  try {
    expect(() => trip.error(500, new Headers(), new TextEncoder().encode('{"error":{"message":"bad","retry_after":1.0}}'))).toThrow(failure);
  } finally {
    spy.mockRestore();
  }
});
