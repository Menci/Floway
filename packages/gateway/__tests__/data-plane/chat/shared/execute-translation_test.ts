import { describe, expect, test } from 'vitest';

import { executeTranslation } from '../../../../src/data-plane/chat/shared/execute-translation.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { toInternalDebugError, type ExecuteResult } from '@floway-dev/provider';
import { testTelemetryModelIdentity } from '@floway-dev/test-utils';
import type { TranslateTrip } from '@floway-dev/translate';

// Fake event types — no real protocol types needed.
type SrcPayload = { model: string; stream?: boolean };
type SrcEvent = { kind: 'src'; value: string };
type TgtEvent = { kind: 'tgt'; value: string };

const translate = async (payload: SrcPayload): Promise<TranslateTrip<string, SrcEvent, TgtEvent>> => ({
  type: 'trip',
  error: () => undefined,
  target: `translated(${payload.model})`,
  async *events(frames) {
    for await (const frame of frames) {
      if (frame.type === 'done') {
        yield doneFrame();
      } else {
        yield eventFrame({ kind: 'src', value: frame.event.value });
      }
    }
  },
});

const makeTgtFrames = async function* (values: string[]): AsyncGenerator<ProtocolFrame<TgtEvent>> {
  for (const v of values) yield eventFrame({ kind: 'tgt', value: v });
  yield doneFrame();
};

const collectFrames = async (iterable: AsyncIterable<ProtocolFrame<SrcEvent>>): Promise<ProtocolFrame<SrcEvent>[]> => {
  const out: ProtocolFrame<SrcEvent>[] = [];
  for await (const frame of iterable) out.push(frame);
  return out;
};

describe('executeTranslation', () => {
  test('asks the upstream for a stream whatever the caller requested', async () => {
    const innerAttempt = async (_translated: string): Promise<ExecuteResult<ProtocolFrame<TgtEvent>>> => ({
      type: 'events',
      events: makeTgtFrames([]),
      modelIdentity: testTelemetryModelIdentity,
    });

    // A client that asked for a single body still reaches a trip, whose only
    // output is a stream. The caller's preference is a rendering decision made
    // from the returned events, so it never reaches the source protocol.
    const source = { model: 'm', stream: false };
    let seen: unknown;
    await executeTranslation(source, async (payload: typeof source) => {
      seen = payload;
      return await translate(payload);
    }, innerAttempt);

    expect(seen).toEqual({ model: 'm', stream: true });
    // The caller's own payload is not mutated.
    expect(source).toEqual({ model: 'm', stream: false });
  });

  test('events inner — outer wraps with trip.events', async () => {
    const innerAttempt = async (_translated: string): Promise<ExecuteResult<ProtocolFrame<TgtEvent>>> => ({
      type: 'events',
      events: makeTgtFrames(['a', 'b']),
      modelIdentity: testTelemetryModelIdentity,
    });

    const result = await executeTranslation({ model: 'payload' }, translate, innerAttempt);

    expect(result.type).toBe('events');
    if (result.type !== 'events') throw new Error('unreachable');

    const frames = await collectFrames(result.events);
    expect(frames).toEqual([
      { type: 'event', event: { kind: 'src', value: 'a' } },
      { type: 'event', event: { kind: 'src', value: 'b' } },
      { type: 'done' },
    ]);
    expect(result.modelIdentity).toBe(testTelemetryModelIdentity);
  });

  test('result inner — outer returns the result unchanged', async () => {
    const inner: ExecuteResult<ProtocolFrame<TgtEvent>> = {
      type: 'api-error',
      source: 'upstream',
      status: 404,
      headers: new Headers(),
      body: new Uint8Array(),
    };
    const innerAttempt = async (_translated: string): Promise<ExecuteResult<ProtocolFrame<TgtEvent>>> => inner;

    const result = await executeTranslation({ model: 'payload' }, translate, innerAttempt);

    expect(result).toBe(inner);
  });

  test('failure inner — outer returns the failure unchanged', async () => {
    const inner: ExecuteResult<ProtocolFrame<TgtEvent>> = {
      type: 'internal-error',
      status: 500,
      error: toInternalDebugError(new Error('boom')),
    };
    const innerAttempt = async (_translated: string): Promise<ExecuteResult<ProtocolFrame<TgtEvent>>> => inner;

    const result = await executeTranslation({ model: 'payload' }, translate, innerAttempt);

    expect(result).toBe(inner);
  });

  test('upstream api-error with trip.error — outer returns the restated envelope', async () => {
    const inner: ExecuteResult<ProtocolFrame<TgtEvent>> = {
      type: 'api-error',
      source: 'upstream',
      status: 400,
      headers: new Headers({ 'x-upstream-request-id': 'abc' }),
      body: new TextEncoder().encode('raw upstream'),
    };
    const translateWithRewrite = async (payload: SrcPayload): Promise<TranslateTrip<string, SrcEvent, TgtEvent>> => ({
      ...(await translate(payload)),
      error: () => ({ status: 400, headers: new Headers({ 'content-type': 'application/json' }), body: { error: { message: 'rewritten' } } }),
    });

    const result = await executeTranslation({ model: 'payload' }, translateWithRewrite, async () => inner);
    expect(result.type).toBe('api-error');
    if (result.type !== 'api-error') throw new Error('unreachable');
    expect(JSON.parse(new TextDecoder().decode(result.body))).toEqual({ error: { message: 'rewritten' } });
    expect(result.headers.get('content-type')).toBe('application/json');
    expect(result.headers.get('x-upstream-request-id')).toBeNull();
    // Fields not touched by the rewriter (source, performance, upstream) survive.
    expect(result.source).toBe('upstream');
  });

  test('upstream api-error with trip.error returning undefined — outer passes the envelope through', async () => {
    const inner: ExecuteResult<ProtocolFrame<TgtEvent>> = {
      type: 'api-error',
      source: 'upstream',
      status: 502,
      headers: new Headers(),
      body: new TextEncoder().encode('bad gateway'),
    };
    const translateWithRewrite = async (payload: SrcPayload): Promise<TranslateTrip<string, SrcEvent, TgtEvent>> => ({ ...(await translate(payload)), error: () => undefined });

    const result = await executeTranslation({ model: 'payload' }, translateWithRewrite, async () => inner);
    expect(result).toBe(inner);
  });

  test('gateway-sourced api-error — trip.error is NOT invoked', async () => {
    const inner: ExecuteResult<ProtocolFrame<TgtEvent>> = {
      type: 'api-error',
      source: 'gateway',
      status: 400,
      headers: new Headers(),
      body: new TextEncoder().encode('synthesized'),
    };
    let called = false;
    const translateWithRewrite = async (payload: SrcPayload): Promise<TranslateTrip<string, SrcEvent, TgtEvent>> => ({
      ...(await translate(payload)),
      error: () => {
        called = true;
        return { status: 999, headers: new Headers(), body: { error: { message: 'unused' } } };
      },
    });

    const result = await executeTranslation({ model: 'payload' }, translateWithRewrite, async () => inner);
    expect(called).toBe(false);
    expect(result).toBe(inner);
  });
});

// The pre-translation capture hook sees the ORIGINAL target-protocol frames
// (events path) and the verbatim upstream api-error envelope (api-error path),
// before `trip.events` / `trip.error` restate them. `capture === undefined`
// (api key opts out of dumps) skips all capture work.
describe('executeTranslation upstream capture', () => {
  test('events path — capture receives each original target frame, in order, before translation', async () => {
    const innerAttempt = async (_translated: string): Promise<ExecuteResult<ProtocolFrame<TgtEvent>>> => ({
      type: 'events',
      events: makeTgtFrames(['a', 'b']),
      modelIdentity: testTelemetryModelIdentity,
    });
    const captured: ProtocolFrame<unknown>[] = [];
    const capture = {
      upstreamFrame: (frame: ProtocolFrame<unknown>) => captured.push(frame),
      upstreamApiError: () => { throw new Error('should not be called on events path'); },
    };

    const result = await executeTranslation({ model: 'payload' }, translate, innerAttempt, capture);
    expect(result.type).toBe('events');
    if (result.type !== 'events') throw new Error('unreachable');
    // Drain the translated stream so the tee pulls the inner frames.
    await collectFrames(result.events);

    // Capture saw the original target frames (incl. done) in order.
    expect(captured).toEqual([
      { type: 'event', event: { kind: 'tgt', value: 'a' } },
      { type: 'event', event: { kind: 'tgt', value: 'b' } },
      { type: 'done' },
    ]);
  });

  test('events path — downstream still receives the translated frames when capture is set', async () => {
    const innerAttempt = async (_translated: string): Promise<ExecuteResult<ProtocolFrame<TgtEvent>>> => ({
      type: 'events',
      events: makeTgtFrames(['a']),
      modelIdentity: testTelemetryModelIdentity,
    });
    const capture = { upstreamFrame: () => {}, upstreamApiError: () => {} };

    const result = await executeTranslation({ model: 'payload' }, translate, innerAttempt, capture);
    if (result.type !== 'events') throw new Error('unreachable');
    const frames = await collectFrames(result.events);
    expect(frames).toEqual([
      { type: 'event', event: { kind: 'src', value: 'a' } },
      { type: 'done' },
    ]);
  });

  test('api-error path — capture receives the verbatim upstream envelope before any rewrite', async () => {
    const inner: ExecuteResult<ProtocolFrame<TgtEvent>> = {
      type: 'api-error',
      source: 'upstream',
      status: 413,
      headers: new Headers({ 'x-upstream': 'yes' }),
      body: new TextEncoder().encode('raw upstream body'),
    };
    const captured: { status: number; headers: Headers; body: Uint8Array }[] = [];
    const capture = {
      upstreamFrame: () => { throw new Error('should not be called on api-error path'); },
      upstreamApiError: (error: { status: number; headers: Headers; body: Uint8Array }) => captured.push(error),
    };
    const translateWithRewrite = async (payload: SrcPayload): Promise<TranslateTrip<string, SrcEvent, TgtEvent>> => ({
      ...(await translate(payload)),
      error: () => ({ status: 400, headers: new Headers(), body: { error: { message: 'rewritten' } } }),
    });

    const result = await executeTranslation({ model: 'payload' }, translateWithRewrite, async () => inner, capture);
    expect(result.type).toBe('api-error');
    if (result.type !== 'api-error') throw new Error('unreachable');
    // Capture saw the ORIGINAL envelope, not the rewrite.
    expect(captured).toHaveLength(1);
    expect(captured[0].status).toBe(413);
    expect(captured[0].headers.get('x-upstream')).toBe('yes');
    expect(new TextDecoder().decode(captured[0].body)).toBe('raw upstream body');
    // Downstream got the rewrite.
    expect(JSON.parse(new TextDecoder().decode(result.body))).toEqual({ error: { message: 'rewritten' } });
  });

  test('api-error path — capture fires even when trip.error is undefined (no restatement)', async () => {
    const inner: ExecuteResult<ProtocolFrame<TgtEvent>> = {
      type: 'api-error',
      source: 'upstream',
      status: 502,
      headers: new Headers(),
      body: new TextEncoder().encode('bad gateway'),
    };
    const captured: { status: number }[] = [];
    const capture = {
      upstreamFrame: () => {},
      upstreamApiError: (error: { status: number; headers: Headers; body: Uint8Array }) => captured.push({ status: error.status }),
    };

    await executeTranslation({ model: 'payload' }, translate, async () => inner, capture);
    expect(captured).toEqual([{ status: 502 }]);
  });

  test('internal-error path — capture is NOT invoked', async () => {
    const inner: ExecuteResult<ProtocolFrame<TgtEvent>> = {
      type: 'internal-error',
      status: 500,
      error: toInternalDebugError(new Error('boom')),
    };
    let called = false;
    const capture = {
      upstreamFrame: () => { called = true; },
      upstreamApiError: () => { called = true; },
    };

    const result = await executeTranslation({ model: 'payload' }, translate, async () => inner, capture);
    expect(called).toBe(false);
    expect(result).toBe(inner);
  });

  test('gateway-sourced api-error — capture is NOT invoked', async () => {
    const inner: ExecuteResult<ProtocolFrame<TgtEvent>> = {
      type: 'api-error',
      source: 'gateway',
      status: 400,
      headers: new Headers(),
      body: new TextEncoder().encode('synthesized'),
    };
    let called = false;
    const capture = {
      upstreamFrame: () => { called = true; },
      upstreamApiError: () => { called = true; },
    };

    await executeTranslation({ model: 'payload' }, translate, async () => inner, capture);
    expect(called).toBe(false);
  });

  test('capture undefined — no tee, downstream still works', async () => {
    const innerAttempt = async (_translated: string): Promise<ExecuteResult<ProtocolFrame<TgtEvent>>> => ({
      type: 'events',
      events: makeTgtFrames(['a']),
      modelIdentity: testTelemetryModelIdentity,
    });

    const result = await executeTranslation({ model: 'payload' }, translate, innerAttempt, undefined);
    if (result.type !== 'events') throw new Error('unreachable');
    const frames = await collectFrames(result.events);
    expect(frames).toEqual([
      { type: 'event', event: { kind: 'src', value: 'a' } },
      { type: 'done' },
    ]);
  });
});

test('returns a raw translation input error before calling the inner attempt', async () => {
  const failure = { type: 'input-error' as const, message: 'unsupported content', param: 'messages[0]', code: 'unsupported_content' };
  let called = false;
  const result = await executeTranslation({ model: 'payload' }, async () => failure, async () => {
    called = true;
    return { type: 'events', events: makeTgtFrames([]), modelIdentity: testTelemetryModelIdentity };
  });
  expect(result).toBe(failure);
  expect(called).toBe(false);
});
