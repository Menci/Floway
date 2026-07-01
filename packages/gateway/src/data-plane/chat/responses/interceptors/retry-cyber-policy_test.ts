import { test } from 'vitest';

import { withCyberPolicyRetried } from './retry-cyber-policy.ts';
import type { ResponsesInvocation } from './types.ts';
import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import { createNonResponsesSourceStore } from '../items/store.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { eventResult, type ExecuteResult } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';
import type { CanonicalResponsesPayload } from '@floway-dev/translate/via-responses/responses-items';

const makePayload = (): CanonicalResponsesPayload => ({
  model: 'gpt-test',
  input: [{ type: 'message', role: 'user', content: 'hi' }],
  instructions: null,
  temperature: 1,
  top_p: null,
  max_output_tokens: 32,
  tools: null,
  tool_choice: 'auto',
  metadata: null,
  stream: true,
  store: false,
  parallel_tool_calls: true,
});

const makeInvocation = (payload: CanonicalResponsesPayload): ResponsesInvocation => ({
  payload,
  candidate: stubModelCandidate({ enabledFlags: new Set(['retry-cyber-policy']) }),
  targetApi: 'responses',
  headers: new Headers(),
  action: 'generate',
});

const stubCtx = (overrides: { abortSignal?: AbortSignal } = {}): ChatGatewayCtx => ({
  apiKeyId: 'test-key',
  upstreamIds: null,
  wantsStream: true,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  backgroundScheduler: () => {},
  requestStartedAt: 0,
  store: createNonResponsesSourceStore('test-key'),
  ...overrides,
});

type PromiseState<T> = { type: 'pending' } | { type: 'fulfilled'; value: T } | { type: 'rejected'; error: unknown };

const promiseStateAfterMicrotasks = async <T>(promise: Promise<T>): Promise<PromiseState<T>> => {
  let state: PromiseState<T> = { type: 'pending' };
  promise.then(
    value => {
      state = { type: 'fulfilled', value };
    },
    error => {
      state = { type: 'rejected', error };
    },
  );

  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    if (state.type !== 'pending') return state;
  }

  return state;
};

const completedResponse = (): ResponsesResult => ({
  id: 'resp_ok',
  object: 'response',
  model: 'gpt-test',
  status: 'completed',
  output_text: 'ok',
  output: [],
  error: null,
  incomplete_details: null,
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
});

const inProgressResponse = (id: string): ResponsesResult => ({
  id,
  object: 'response',
  model: 'gpt-test',
  status: 'in_progress',
  output_text: '',
  output: [],
  error: null,
  incomplete_details: null,
});

const failedResponse = (id: string, message: string): ResponsesResult => ({
  id,
  object: 'response',
  model: 'gpt-test',
  status: 'failed',
  output_text: '',
  output: [],
  error: {
    message,
    type: 'invalid_request_error',
    code: 'cyber_policy',
  },
  incomplete_details: null,
});

const completedEvent = (sequence_number = 1): ResponsesStreamEvent => ({
  type: 'response.completed',
  sequence_number,
  response: completedResponse(),
});

const cyberPolicyEvent = (id: string, sequence_number = 1): ResponsesStreamEvent => ({
  type: 'response.failed',
  sequence_number,
  response: failedResponse(id, 'This request was flagged for cyber policy.'),
});

const deltaEvent = (delta: string, sequence_number = 1): ResponsesStreamEvent => ({
  type: 'response.output_text.delta',
  sequence_number,
  item_id: 'msg_0',
  output_index: 0,
  content_index: 0,
  delta,
});

const protocolResult = (events: readonly ResponsesStreamEvent[], modelIdentity = testTelemetryModelIdentity, performance?: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>['performance']): ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> =>
  eventResult(
    (async function* () {
      for (const event of events) yield eventFrame(event);
    })(),
    modelIdentity,
    { performance },
  );

const collectFrames = async (events: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>): Promise<ProtocolFrame<ResponsesStreamEvent>[]> => {
  const frames: ProtocolFrame<ResponsesStreamEvent>[] = [];
  for await (const frame of events) frames.push(frame);
  return frames;
};

const modelIdentityFor = (modelKey: string) => ({
  ...testTelemetryModelIdentity,
  modelKey,
});

const performanceFor = (modelKey: string) => ({
  keyId: 'key_test',
  model: 'gpt-test',
  upstream: 'test-upstream',
  modelKey,
  stream: true,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
});

const upstreamCyberPolicyError = (message: string): ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> => ({
  type: 'api-error',
  source: 'upstream',
  status: 400,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: new TextEncoder().encode(
    JSON.stringify({
      error: {
        message,
        type: 'invalid_request_error',
        code: 'cyber_policy',
      },
    }),
  ),
});

const upstreamServerError = (message: string): ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> => ({
  type: 'api-error',
  source: 'upstream',
  status: 500,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: new TextEncoder().encode(
    JSON.stringify({
      error: {
        message,
        type: 'server_error',
        code: 'upstream_failed',
      },
    }),
  ),
});

test('withCyberPolicyRetried retries fatal upstream cyber policy errors before returning success', async () => {
  const payload = makePayload();
  let attempts = 0;

  const result = await withCyberPolicyRetried(makeInvocation(payload), stubCtx(), () => {
    attempts += 1;

    if (attempts < 6) {
      return Promise.resolve(upstreamCyberPolicyError(`blocked ${attempts}`));
    }

    return Promise.resolve(protocolResult([completedEvent()]));
  });

  assertEquals(attempts, 6);
  assertEquals(result.type, 'events');
});

test('withCyberPolicyRetried retries first Responses protocol cyber policy failures before returning success', async () => {
  const payload = makePayload();
  let attempts = 0;

  const result = await withCyberPolicyRetried(makeInvocation(payload), stubCtx(), () => {
    attempts += 1;

    if (attempts < 3) {
      return Promise.resolve(protocolResult([cyberPolicyEvent(`resp_blocked_${attempts}`)]));
    }

    return Promise.resolve(protocolResult([completedEvent()]));
  });

  assertEquals(attempts, 1);
  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('expected events result');

  const frames = await collectFrames(result.events);
  assertEquals(attempts, 3);
  assertEquals(frames, [eventFrame(completedEvent())]);
});

test('withCyberPolicyRetried buffers converted fallback prologue frames before retrying terminal cyber policy failures', async () => {
  const payload = makePayload();
  let attempts = 0;

  const result = await withCyberPolicyRetried(makeInvocation(payload), stubCtx(), () => {
    attempts += 1;

    if (attempts === 1) {
      return Promise.resolve(
        protocolResult([
          {
            type: 'response.created',
            sequence_number: 0,
            response: inProgressResponse('resp_blocked'),
          },
          {
            type: 'response.in_progress',
            sequence_number: 1,
            response: inProgressResponse('resp_blocked'),
          },
          cyberPolicyEvent('resp_blocked', 2),
        ]),
      );
    }

    return Promise.resolve(protocolResult([completedEvent()]));
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('expected events result');

  const frames = await collectFrames(result.events);
  assertEquals(attempts, 2);
  assertEquals(frames, [eventFrame(completedEvent())]);
});

test('withCyberPolicyRetried attributes streaming retries to the final provider call', async () => {
  const payload = makePayload();
  let attempts = 0;

  const result = await withCyberPolicyRetried(makeInvocation(payload), stubCtx(), () => {
    attempts += 1;

    if (attempts === 1) {
      return Promise.resolve(protocolResult([cyberPolicyEvent('resp_blocked_first_model_key')], modelIdentityFor('first-model-key'), performanceFor('first-model-key')));
    }

    return Promise.resolve(protocolResult([completedEvent()], modelIdentityFor('final-model-key'), performanceFor('final-model-key')));
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('expected events result');
  assertEquals(result.modelIdentity.modelKey, 'first-model-key');

  const frames = await collectFrames(result.events);

  assertEquals(frames.length, 1);
  assertEquals(result.modelIdentity.modelKey, 'final-model-key');
  assertEquals(result.performance?.modelKey, 'final-model-key');
});

test('withCyberPolicyRetried returns successful streams without draining them', async () => {
  const payload = makePayload();
  let release!: () => void;
  let markStreamDrained!: () => void;
  const untilRelease = new Promise<void>(resolve => (release = resolve));
  const streamDrained = new Promise<'drained'>(resolve => {
    markStreamDrained = () => resolve('drained');
  });

  const resultPromise = withCyberPolicyRetried(makeInvocation(payload), stubCtx(), () =>
    Promise.resolve(
      eventResult(
        (async function* () {
          yield eventFrame(deltaEvent('ok'));

          markStreamDrained();
          await untilRelease;
          yield eventFrame(completedEvent(2));
        })(),
        testTelemetryModelIdentity,
      ),
    ));

  const firstAction = await Promise.race([resultPromise.then(() => 'returned' as const), streamDrained]);
  release();

  assertEquals(firstAction, 'returned');
  const result = await resultPromise;
  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('expected events result');

  const frames = await collectFrames(result.events);
  assertEquals(frames.length, 2);
});

test('withCyberPolicyRetried returns streaming results before the first upstream frame arrives', async () => {
  const payload = makePayload();
  let releaseFirstFrame!: () => void;
  const firstFrameReady = new Promise<void>(resolve => {
    releaseFirstFrame = resolve;
  });

  const resultPromise = withCyberPolicyRetried(makeInvocation(payload), stubCtx(), () =>
    Promise.resolve(
      eventResult(
        (async function* () {
          await firstFrameReady;
          yield eventFrame(completedEvent());
        })(),
        testTelemetryModelIdentity,
      ),
    ));

  const state = await promiseStateAfterMicrotasks(resultPromise);
  releaseFirstFrame();
  const result = await resultPromise;

  assertEquals(state.type, 'fulfilled');
  assertEquals(result.type, 'events');
});

test('withCyberPolicyRetried does not start another streaming retry after downstream abort', async () => {
  const payload = makePayload();
  const downstreamAbortController = new AbortController();
  let attempts = 0;
  const cyberPolicyFrame = eventFrame(cyberPolicyEvent('resp_blocked_after_abort'));

  const result = await withCyberPolicyRetried(
    makeInvocation(payload),
    stubCtx({ abortSignal: downstreamAbortController.signal }),
    () => {
      attempts += 1;
      return Promise.resolve(
        eventResult(
          (async function* () {
            downstreamAbortController.abort();
            yield cyberPolicyFrame;
          })(),
          testTelemetryModelIdentity,
        ),
      );
    },
  );

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('expected events result');

  const frames = await collectFrames(result.events);

  assertEquals(attempts, 1);
  assertEquals(frames, [cyberPolicyFrame]);
});

const drainFrames = async (events: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>): Promise<unknown> => {
  try {
    for await (const _frame of events) {
    }
    return undefined;
  } catch (error) {
    return error;
  }
};

test('withCyberPolicyRetried throws the final HTTP cyber policy failure body after a streaming policy failure', async () => {
  const payload = makePayload();
  let attempts = 0;

  const result = await withCyberPolicyRetried(makeInvocation(payload), stubCtx(), () => {
    attempts += 1;

    if (attempts === 1) {
      return Promise.resolve(protocolResult([cyberPolicyEvent('resp_stream_policy_failure')]));
    }

    return Promise.resolve(upstreamCyberPolicyError(`blocked ${attempts}`));
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('expected events result');

  const error = await drainFrames(result.events);

  assertEquals(attempts, 11);
  if (!(error instanceof Error)) throw new Error('expected events iteration to throw');
  if (!error.message.includes('HTTP 400')) throw new Error(`expected status in message, got: ${error.message}`);
  if (!error.message.includes('blocked 11')) throw new Error(`expected raw upstream body in message, got: ${error.message}`);
  if (!error.message.includes('cyber_policy')) throw new Error(`expected upstream code preserved in body, got: ${error.message}`);
});

test('withCyberPolicyRetried throws a later HTTP upstream failure after a streaming policy failure', async () => {
  const payload = makePayload();
  let attempts = 0;

  const result = await withCyberPolicyRetried(makeInvocation(payload), stubCtx(), () => {
    attempts += 1;

    if (attempts === 1) {
      return Promise.resolve(protocolResult([cyberPolicyEvent('resp_stream_policy_failure')]));
    }

    return Promise.resolve(upstreamServerError('upstream failed after retry'));
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('expected events result');

  const error = await drainFrames(result.events);

  assertEquals(attempts, 2);
  if (!(error instanceof Error)) throw new Error('expected events iteration to throw');
  if (!error.message.includes('HTTP 500')) throw new Error(`expected status in message, got: ${error.message}`);
  if (!error.message.includes('upstream failed after retry')) throw new Error(`expected raw upstream body in message, got: ${error.message}`);
});

test('withCyberPolicyRetried throws a later internal failure with the original error as cause', async () => {
  const payload = makePayload();
  let attempts = 0;
  const internalError = {
    type: 'internal_error' as const,
    name: 'Error',
    message: 'retry setup failed',
    stack: 'Error: retry setup failed\n    at test',
    cause: { message: 'nested' },
    target_api: 'responses' as const,
  };

  const result = await withCyberPolicyRetried(makeInvocation(payload), stubCtx(), () => {
    attempts += 1;

    if (attempts === 1) {
      return Promise.resolve(protocolResult([cyberPolicyEvent('resp_stream_policy_failure')]));
    }

    return Promise.resolve({
      type: 'internal-error' as const,
      status: 502,
      error: internalError,
    });
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('expected events result');

  const error = await drainFrames(result.events);

  assertEquals(attempts, 2);
  if (!(error instanceof Error)) throw new Error('expected events iteration to throw');
  if (!error.message.includes('retry setup failed')) throw new Error(`expected internal error message, got: ${error.message}`);
  assertEquals(error.cause, internalError);
});

test('withCyberPolicyRetried returns the final cyber policy failure after exhausting retries', async () => {
  const payload = makePayload();
  let attempts = 0;

  const result = await withCyberPolicyRetried(makeInvocation(payload), stubCtx(), () => {
    attempts += 1;
    return Promise.resolve(upstreamCyberPolicyError(`blocked ${attempts}`));
  });

  assertEquals(attempts, 11);
  assertEquals(result.type, 'api-error');
  if (result.type !== 'api-error') {
    throw new Error('expected upstream-error result');
  }
  assertEquals(JSON.parse(new TextDecoder().decode(result.body)).error.message, 'blocked 11');
});
