import { expect, test } from 'vitest';

import { routeOpenAIChatCompletionsViaOpenAIResponses } from '../../src/index.ts';
import { errorPayloadFromWire, irErrorPayloadFromBody } from '../../src/shared/api-error.ts';
import { createTestSidecarCodec } from '../round-trip/sidecar-codec.ts';

const createTrip = async () => {
  const trip = await routeOpenAIChatCompletionsViaOpenAIResponses({
    model: 'm', stream: true, messages: [{ role: 'user', content: 'hello' }],
  }, { sidecarCodec: createTestSidecarCodec() });
  if (trip.type !== 'trip') throw new Error(trip.message);
  return trip;
};

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

test('error metadata collisions reserve original suffix keys across every namespace', () => {
  const body = new TextEncoder().encode(JSON.stringify({
    error: {
      message: 'failed', trace: 'inner loose',
      provider_specific_fields: { trace: 'inner container' },
    },
    trace: 'outer loose', trace_1: 'original suffix',
    provider_specific_fields: { trace: 'outer container' },
  }));
  expect(irErrorPayloadFromBody(body)).toEqual({
    message: 'failed',
    provider_specific_fields: {
      trace: 'inner container', trace_1: 'original suffix',
      trace_2: 'inner loose', trace_3: 'outer container', trace_4: 'outer loose',
    },
  });
});

test('equal values at one metadata key coalesce across namespaces without consuming explicit suffix keys', () => {
  const body = new TextEncoder().encode(JSON.stringify({
    error: {
      message: 'failed', trace: { region: 'us', attempts: [1, false, null] },
      provider_specific_fields: { trace: 'preferred' },
    },
    trace: { attempts: [1, false, null], region: 'us' },
    trace_1: { region: 'us', attempts: [1, false, null] },
    provider_specific_fields: { trace: { region: 'us', attempts: [1, false, null] } },
  }));
  expect(irErrorPayloadFromBody(body)).toEqual({
    message: 'failed',
    provider_specific_fields: {
      trace: 'preferred', trace_1: { region: 'us', attempts: [1, false, null] },
      trace_2: { region: 'us', attempts: [1, false, null] },
    },
  });
});

test('preserves structured error fields when a wire error omits message', () => {
  expect(errorPayloadFromWire({
    error: { type: 'rate_limit_error', code: 'rate_limit', param: 'model', status: 'RESOURCE_EXHAUSTED', trace: 't1' },
  })).toEqual({
    message: '',
    type: 'rate_limit_error',
    code: 'rate_limit',
    param: 'model',
    provider_specific_fields: { status: 'RESOURCE_EXHAUSTED', trace: 't1' },
  });
});
