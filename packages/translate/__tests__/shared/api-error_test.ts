import { expect, test, vi } from 'vitest';

import { routeOpenAIChatCompletionsViaOpenAIResponses } from '../../src/index.ts';
import { errorPayloadFromWire, irErrorPayloadFromBody } from '../../src/shared/api-error.ts';
import { createTestSidecarCodec } from '../round-trip/sidecar-codec.ts';

const createTrip = async () => {
  const trip = await routeOpenAIChatCompletionsViaOpenAIResponses({
    model: 'm', stream: true, messages: [{ role: 'user', content: 'hello' }],
  }, { model: 'm', sidecarCodec: createTestSidecarCodec() });
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
      message: 'bad field', code: null, param: null,
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
  for (const body of ['null', '[]', '502 Bad Gateway', 'some upstream prose: exceeds the context window of this model']) {
    expect(trip.error(500, new Headers(), new TextEncoder().encode(body))).toBeUndefined();
  }
});

test('an internal error from JSON parsing propagates with its original cause', async () => {
  const trip = await createTrip();
  const failure = new Error('internal parser failure', { cause: new Error('underlying failure') });
  const json = JSON as typeof JSON & { rawJSON: (text: string) => unknown };
  const spy = vi.spyOn(json, 'rawJSON').mockImplementation(() => { throw failure; });
  try {
    let caught: unknown;
    try {
      trip.error(500, new Headers(), new TextEncoder().encode('{"error":{"message":"bad","retry_after":1.0}}'));
    } catch (error) {
      caught = error;
    }
    expect(spy).toHaveBeenCalledOnce();
    expect(caught).toBe(failure);
    expect(failure.cause).toBeInstanceOf(Error);
    expect((caught as Error).cause).toBe(failure.cause);
  } finally {
    spy.mockRestore();
  }
});

test('consumes msg only when it supplies the canonical message', () => {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  expect(irErrorPayloadFromBody(encode({ error: { message: 'primary', msg: 'secondary' } }))).toEqual({
    message: 'primary', provider_specific_fields: { msg: 'secondary' },
  });
  expect(irErrorPayloadFromBody(encode({ error: { msg: 'alias', trace_id: 'trace' } }))).toEqual({
    message: 'alias', provider_specific_fields: { trace_id: 'trace' },
  });
  expect(errorPayloadFromWire({ msg: 'alias', trace_id: 'trace' })).toEqual({ message: 'alias', trace_id: 'trace' });
});

test('canonical wire errors retain object identity', () => {
  const error = { message: 'failed', type: 'upstream_type', code: 'upstream_code', param: null, request_id: 'req_1' };
  expect(errorPayloadFromWire(error)).toBe(error);
  expect(errorPayloadFromWire({ error })).toBe(error);
  expect(errorPayloadFromWire({ type: 'error', sequence_number: 1, error })).toBe(error);
  const nativeCategory = { ...error, type: 'error' };
  expect(errorPayloadFromWire(nativeCategory)).toBe(nativeCategory);
});

test('envelope transport fields stay outside the error metadata', () => {
  const body = new TextEncoder().encode(JSON.stringify({
    type: 'error', sequence_number: 9, request_id: 'req_1', error: { message: 'failed', code: null },
  }));
  expect(irErrorPayloadFromBody(body)).toEqual({
    message: 'failed', code: null, provider_specific_fields: { request_id: 'req_1' },
  });
});
