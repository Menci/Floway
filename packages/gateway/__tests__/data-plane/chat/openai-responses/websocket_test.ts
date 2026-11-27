import type { ExecutionContext } from 'hono';
import { expect, onTestFinished, test, vi } from 'vitest';

import { app } from '../../../../src/app.ts';
import { hashOpenAIResponsesItem } from '../../../../src/data-plane/chat/openai-responses/items/identity.ts';
import { INTERRUPT_UPSTREAM_ABORT_WARNING_MS, KEEP_ALIVE_EVENT_TYPE } from '../../../../src/data-plane/chat/openai-responses/websocket.ts';
import * as servicesModule from '../../../../src/data-plane/pipeline/services.ts';
import { DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS } from '../../../../src/data-plane/shared/sse.ts';
import { initDumpBroker, initDumpStore } from '../../../../src/dump/registry.ts';
import { initBackgroundSchedulerResolver } from '../../../../src/runtime/background.ts';
import { installDumpStubs } from '../../../dump/test-fixtures.ts';
import { saveUpstreamForTest } from '../../../repo/upstreams.ts';
import { FakeTime } from '../../../test-time.ts';
import { buildChatGPTUpstreamRecord, chatgptModels, copilotModels, setupAppTest, sseResponse, sseOpenAIResponsesResponse, warmModelsForTest } from '../../../test-utils/app.ts';
import { trackBackground } from '../../../test-utils/background-tracker.ts';
import { installWorkerWebSocketRuntime, type TestWorkerWebSocket } from '../../../test-utils/worker-websocket.ts';
import { assert, assertEquals, assertExists, assertStringIncludes, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const waitForMessages = async (
  socket: TestWorkerWebSocket,
  done: (messages: readonly Record<string, unknown>[]) => boolean,
  timeoutMs = 1_000,
): Promise<readonly Record<string, unknown>[]> => {
  const messages: Record<string, unknown>[] = [];
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      reject(new Error(`Timed out waiting for WebSocket messages; received ${JSON.stringify(messages)}`));
    }, timeoutMs);
    const onMessage = (event: Event): void => {
      const data = (event as MessageEvent<string>).data;
      messages.push(JSON.parse(data) as Record<string, unknown>);
      if (!done(messages)) return;
      clearTimeout(timeout);
      socket.removeEventListener('message', onMessage);
      resolve(messages);
    };
    socket.addEventListener('message', onMessage);
  });
};

const recordRawMessages = (socket: TestWorkerWebSocket) => {
  const messages: string[] = [];
  const onMessage = (event: Event): void => {
    messages.push((event as MessageEvent<string>).data);
  };
  socket.addEventListener('message', onMessage);
  return {
    messages,
    stop: () => socket.removeEventListener('message', onMessage),
  };
};

const waitForMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const isTerminalResponseEvent = (message: Record<string, unknown>): boolean =>
  message.type === 'response.completed' || message.type === 'response.failed' || message.type === 'response.incomplete';

const terminalResponseId = (messages: readonly Record<string, unknown>[]): string => {
  const terminal = messages.find(isTerminalResponseEvent) as { response?: { id?: unknown } } | undefined;
  assertExists(terminal);
  const response = terminal.response;
  assertExists(response);
  const id = response.id;
  if (typeof id !== 'string') throw new Error(`expected the terminal response id to be a string, got ${typeof id}`);
  return id;
};

// An upgrade registers one lifetime promise while its execution context is active.
const connectOpenAIResponsesWebSocketCapturingSessionLifetime = async (
  apiKey: string,
  upgradeHeaders: Record<string, string> = {},
): Promise<{ client: TestWorkerWebSocket; sessionLifetime: Promise<unknown> }> => {
  await warmModelsForTest();
  const runtime = activeRuntime();
  const registered: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (promise: Promise<unknown>) => {
      registered.push(promise);
      runtime.sessions.push(promise);
    },
    passThroughOnException: () => {},
    props: {},
  } satisfies ExecutionContext;
  const response = await app.fetch(new Request('https://example.test/v1/responses', {
    method: 'GET',
    headers: {
      upgrade: 'websocket',
      'x-api-key': apiKey,
      ...upgradeHeaders,
    },
  }), {}, executionCtx);
  assertEquals(response.status, 101);

  const pair = runtime.pairs.at(-1);
  assertExists(pair);
  assertEquals(registered.length, 1, 'expected the upgrade to register exactly one background task');
  const sessionLifetime = registered[0];
  assertExists(sessionLifetime);
  return { client: pair.client, sessionLifetime };
};

const connectOpenAIResponsesWebSocket = async (apiKey: string, upgradeHeaders?: Record<string, string>): Promise<TestWorkerWebSocket> =>
  (await connectOpenAIResponsesWebSocketCapturingSessionLifetime(apiKey, upgradeHeaders)).client;

type WebSocketRuntimeFixture = ReturnType<typeof installWorkerWebSocketRuntime> & { sessions: Promise<unknown>[] };

let currentRuntime: WebSocketRuntimeFixture | undefined;

const activeRuntime = (): WebSocketRuntimeFixture => {
  assertExists(currentRuntime);
  return currentRuntime;
};

const withWorkerWebSocketRuntime = async <T>(run: () => Promise<T>): Promise<T> => {
  const runtime: WebSocketRuntimeFixture = { ...installWorkerWebSocketRuntime(), sessions: [] };
  currentRuntime = runtime;
  initBackgroundSchedulerResolver(c => c.req.header('upgrade')?.toLowerCase() === 'websocket'
    ? promise => c.executionCtx.waitUntil(promise)
    : trackBackground);
  try {
    return await run();
  } finally {
    try {
      for (const { client } of runtime.pairs) {
        if (client.readyState === WebSocket.OPEN) client.close();
      }
      await Promise.all(runtime.sessions);
    } finally {
      initBackgroundSchedulerResolver(_c => trackBackground);
      runtime.restore();
      currentRuntime = undefined;
    }
  }
};

const withSuccessfulOpenAIResponsesUpstream = async <T>(run: () => Promise<T>): Promise<T> =>
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-direct-responses', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        return sseOpenAIResponsesResponse({
          id: 'resp_ws_policy_refresh',
          object: 'response',
          model: 'gpt-direct-responses',
          status: 'completed',
          output: [],
          usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    run,
  );

test('OpenAI Responses WebSocket forwards stream events, echoes event_id, and ends the turn on the terminal event', async () => {
  const { apiKey, repo, copilotUpstream } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const dumps = installDumpStubs(initDumpStore, initDumpBroker);
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-direct-responses', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        return sseOpenAIResponsesResponse({
          id: 'resp_ws',
          object: 'response',
          model: 'gpt-direct-responses',
          status: 'completed',
          output: [{
            id: 'msg_ws', type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: 'answer', annotations: [] }],
          }],
          usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => await withWorkerWebSocketRuntime(async () => {
      const { client, sessionLifetime } = await connectOpenAIResponsesWebSocketCapturingSessionLifetime(apiKey.key);
      const raw = recordRawMessages(client);
      const received = waitForMessages(client, messages => messages.some(isTerminalResponseEvent));

      const requestText = JSON.stringify({
        type: 'response.create',
        event_id: 'evt_1',
        response: {
          model: 'gpt-direct-responses',
          input: 'hello',
        },
      }, null, 2);
      client.send(requestText);

      const messages = await received;
      raw.stop();
      assert(raw.messages.every(message => !message.includes('[DONE]')), 'expected the WebSocket transport to carry no SSE sentinel');
      assert(messages.every(message => message.event_id === 'evt_1'));
      const completed = messages.at(-1) as { type?: unknown; response?: { id?: unknown } } | undefined;
      assertExists(completed);
      const responseId = completed.response?.id;
      assertEquals(typeof responseId, 'string');
      assert(responseId !== 'resp_ws', 'expected the source boundary to replace the upstream response id');
      assertEquals(completed.type, 'response.completed');
      // The egress stage completes the response resource before the terminal
      // event reaches the socket, so the usage breakdowns are present on it.
      assertEquals((completed.response as { usage?: unknown }).usage, {
        input_tokens: 3,
        output_tokens: 5,
        total_tokens: 8,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      });
      client.close();
      await sessionLifetime;
      assertEquals(dumps.stored.length, 1);
      const captured = dumps.stored[0]?.record;
      assertExists(captured);
      assertEquals(new TextDecoder().decode(captured.request.body), requestText);
      expect(captured.meta).toMatchObject({
        method: 'WS', status: 200, model: 'gpt-direct-responses', upstream: { id: copilotUpstream.id },
        inputTokens: 3, outputTokens: 5, ttftMs: expect.any(Number),
      });
    }),
  );
});

test('OpenAI Responses WebSocket rejects the next turn after its API key is rotated', async () => {
  const { apiKey, repo } = await setupAppTest();

  await withSuccessfulOpenAIResponsesUpstream(
    async () => await withWorkerWebSocketRuntime(async () => {
      const client = await connectOpenAIResponsesWebSocket(apiKey.key);
      await repo.apiKeys.save({ ...apiKey, key: 'rotated-api-key' });
      const received = waitForMessages(client, messages => messages.length === 1);

      client.send(JSON.stringify({
        type: 'response.create',
        event_id: 'after-key-rotation',
        response: {
          model: 'gpt-direct-responses',
          input: 'must not reach the upstream',
        },
      }));

      assertEquals(await received, [{
        type: 'error',
        status: 401,
        error: {
          type: 'authentication_error',
          code: 'invalid_api_key',
          message: 'Invalid API key.',
        },
      }]);
      client.close();
    }),
  );
});

test('OpenAI Responses WebSocket reports a failed turn when an output item cannot be persisted', async () => {
  const { apiKey, repo } = await setupAppTest();
  const nested = new TypeError('nested persistence'); nested.stack = 'TypeError: nested persistence\n  at database';
  const failure = new Error('simulated item persistence failure', { cause: nested }); failure.stack = 'Error: simulated item persistence failure\n  at persistence';
  const persistence = vi.spyOn(repo.openaiResponsesItems, 'insertMany').mockRejectedValue(failure);
  try {
    await withMockedFetch(
      async request => {
        const url = new URL(request.url);
        if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
        if (url.pathname === '/copilot_internal/v2/token') {
          return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
        }
        if (url.pathname === '/models') {
          return jsonResponse(copilotModels([{ id: 'gpt-direct-responses', supported_endpoints: ['/responses'] }]));
        }
        if (url.pathname === '/responses') {
          return sseOpenAIResponsesResponse({
            id: 'resp_ws_persist_failure',
            object: 'response',
            model: 'gpt-direct-responses',
            status: 'completed',
            output: [{
              type: 'message',
              id: 'msg_upstream',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'done', annotations: [] }],
            }],
            usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
          });
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => await withWorkerWebSocketRuntime(async () => {
        const client = await connectOpenAIResponsesWebSocket(apiKey.key);
        const received = waitForMessages(client, messages => messages.some(message => message.type === 'error'));

        client.send(JSON.stringify({
          type: 'response.create',
          event_id: 'evt_persist_failure',
          response: {
            model: 'gpt-direct-responses',
            input: 'hello',
          },
        }));

        const messages = await received;
        const error = messages.find(message => message.type === 'error') as { status?: unknown; error?: { message?: unknown } } | undefined;
        assertExists(error);
        assertEquals(error.status, 500);
        assertEquals(error.error, { type: 'internal_error', code: 'internal_error', message: 'simulated item persistence failure', provider_specific_fields: { name: 'Error', stack: failure.stack, cause: { name: 'TypeError', message: 'nested persistence', stack: nested.stack } } });
        assertEquals((error as Record<string, unknown>).event_id, 'evt_persist_failure');
        assert(!messages.some(message => message.type === 'response.output_item.done'));
        assert(!messages.some(isTerminalResponseEvent));
      }),
    );
  } finally {
    persistence.mockRestore();
  }
});

test('OpenAI Responses WebSocket keep-alive waits for the first event and takes a slot in the stream sequence', async () => {
  const { apiKey, repo } = await setupAppTest();
  const backgroundErrors = vi.spyOn(console, 'error');
  onTestFinished(() => backgroundErrors.mockRestore());
  // Captured before the clock is faked: the turn's frames cross real event-loop
  // turns (upstream body reads, item persistence), which a faked `setTimeout`
  // cannot yield to.
  const realSetTimeout = globalThis.setTimeout;
  const time = new FakeTime();
  // Registered as a test hook rather than run from a `finally`: the
  // `upstreamReadStarted` await below is unbounded, so a turn that never
  // reaches the upstream body suspends the body forever, and a `finally` that
  // never runs would leave the fake clock installed for every later test in
  // the file.
  onTestFinished(() => time.restore());
  const encoder = new TextEncoder();
  const reasoning = {
    type: 'reasoning' as const,
    id: 'rs_keepalive',
    summary: [],
    encrypted_content: 'opaque',
  };
  let upstreamController!: ReadableStreamDefaultController<Uint8Array>;
  let resolveUpstreamReadStarted!: () => void;
  const upstreamReadStarted = new Promise<void>(resolve => {
    resolveUpstreamReadStarted = resolve;
  });
  let upstreamReadStartedResolved = false;

  const resolveReadStartedOnce = (): void => {
    if (upstreamReadStartedResolved) return;
    upstreamReadStartedResolved = true;
    resolveUpstreamReadStarted();
  };
  const enqueueSseEvent = (event: string, data: unknown): void => {
    upstreamController.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };
  // Every wait below is bounded by a turn count, not by a clock: a frame that
  // never comes fails an assertion instead of suspending the test body, which
  // under a fake clock would hang until the runner's timeout and leave the
  // fake clock installed for every test after it.
  const drainFramesUntil = async (settled: () => boolean): Promise<boolean> => {
    for (let i = 0; i < 200 && !settled(); i++) {
      await new Promise<void>(resolve => { realSetTimeout(resolve, 0); });
      await time.tickAsync(0);
    }
    return settled();
  };
  const tickKeepAliveIntervals = async (count: number): Promise<void> => {
    for (let i = 0; i < count; i++) {
      await waitForMicrotasks();
      await time.tickAsync(DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS);
    }
  };

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-direct-responses', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            upstreamController = controller;
            request.signal.addEventListener('abort', () => controller.error(request.signal.reason), { once: true });
          },
          pull() {
            resolveReadStartedOnce();
          },
        }), {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => await withWorkerWebSocketRuntime(async () => {
      const client = await connectOpenAIResponsesWebSocket(apiKey.key);
      const messages: Record<string, unknown>[] = [];
      const onMessage = (event: Event): void => {
        messages.push(JSON.parse((event as MessageEvent<string>).data) as Record<string, unknown>);
      };
      client.addEventListener('message', onMessage);

      try {
        client.send(JSON.stringify({
          type: 'response.create',
          event_id: 'evt_keepalive',
          response: {
            model: 'gpt-direct-responses',
            input: 'hello',
          },
        }));

        await upstreamReadStarted;

        await tickKeepAliveIntervals(4);
        assertEquals(messages, [], 'expected no keep-alive before the turn sent its first event');

        const response = {
          id: 'resp_ws_keepalive',
          object: 'response',
          model: 'gpt-direct-responses',
          status: 'completed',
          output: [reasoning],
          usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
        };
        const inProgress = { ...response, status: 'in_progress', output: [] };
        enqueueSseEvent('response.created', { type: 'response.created', response: inProgress, sequence_number: 0 });
        assert(
          await drainFramesUntil(() => messages.length >= 1),
          `expected the turn to open, got ${JSON.stringify(messages)}`,
        );
        assertEquals(
          messages.map(message => message.type),
          ['response.created'],
          'expected the turn to open before any keep-alive',
        );

        await tickKeepAliveIntervals(1);

        enqueueSseEvent('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: reasoning, sequence_number: 1 });
        enqueueSseEvent('response.completed', { type: 'response.completed', response, sequence_number: 2 });
        upstreamController.enqueue(encoder.encode('data: [DONE]\n\n'));
        upstreamController.close();
        assert(
          await drainFramesUntil(() => messages.some(isTerminalResponseEvent)),
          `expected the turn to reach its terminal event, got ${JSON.stringify(messages)}`,
        );

        assertEquals(
          messages.map(message => [message.type, message.sequence_number]),
          [
            ['response.created', 0],
            [KEEP_ALIVE_EVENT_TYPE, 1],
            ['response.output_item.done', 2],
            ['response.completed', 3],
          ],
          'expected the keep-alive to take a slot and shift every later event past it',
        );
      } finally {
        client.removeEventListener('message', onMessage);
      }
    }),
  );
  const samples = (await repo.performance.listAll()).filter(row => row.keyId === apiKey.id && row.model === 'gpt-direct-responses');
  expect(samples).toMatchObject([{ requests: 1, ttftSamplesOk: 1, tpotSamples: 1 }]);
  expect(samples[0]?.tpotUsSum).toBeGreaterThanOrEqual(0);
  expect(backgroundErrors).not.toHaveBeenCalled();
});

test('OpenAI Responses WebSocket interrupts an active turn and continues from its completed items', async () => {
  const { apiKey } = await setupAppTest();
  const encoder = new TextEncoder();
  const upstreamBodies: Record<string, unknown>[] = [];
  let resolveUpstreamAborted!: () => void;
  const upstreamAborted = new Promise<void>(resolve => { resolveUpstreamAborted = resolve; });
  const settleUpstreamAbort = Promise.withResolvers<void>();
  let delayAbort = false;
  onTestFinished(() => settleUpstreamAbort.resolve());
  let resolveFollowUp!: () => void;
  const releaseFollowUp = new Promise<void>(resolve => { resolveFollowUp = resolve; });
  const kept = {
    id: 'msg_kept',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'finished', annotations: [] }],
  };

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-direct-responses', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        upstreamBodies.push(JSON.parse(await request.clone().text()) as Record<string, unknown>);
        if (upstreamBodies.length > 1) {
          const completed = {
            id: 'resp_follow_up',
            object: 'response',
            model: 'gpt-direct-responses',
            status: 'completed',
            output: [],
            error: null,
            incomplete_details: null,
            usage: { input_tokens: 7, output_tokens: 1, total_tokens: 8 },
          };
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(`event: response.created\ndata: ${JSON.stringify({
                type: 'response.created', response: { ...completed, status: 'in_progress' }, sequence_number: 0,
              })}\n\n`));
              void releaseFollowUp.then(() => {
                if (request.signal.aborted) return;
                controller.enqueue(encoder.encode(`event: response.completed\ndata: ${JSON.stringify({
                  type: 'response.completed', response: completed, sequence_number: 1,
                })}\n\n`));
                controller.close();
              });
              request.signal.addEventListener('abort', () => controller.error(request.signal.reason), { once: true });
            },
          }), { headers: { 'content-type': 'text/event-stream' } });
        }
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            const events = [
              {
                type: 'response.created',
                response: {
                  id: 'resp_upstream_active',
                  object: 'response',
                  model: 'gpt-direct-responses',
                  status: 'in_progress',
                  output: [],
                  error: null,
                  incomplete_details: null,
                },
              },
              { type: 'response.output_item.added', output_index: 0, item: kept },
              { type: 'response.output_item.done', output_index: 0, item: kept },
              { type: 'response.output_item.added', output_index: 1, item: { id: 'rs_partial', type: 'reasoning', summary: [] } },
            ];
            events.forEach((event, sequence_number) => {
              controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`));
            });
            request.signal.addEventListener('abort', () => {
              resolveUpstreamAborted();
              if (delayAbort) void settleUpstreamAbort.promise.then(() => controller.error(request.signal.reason));
              else controller.error(request.signal.reason);
            }, { once: true });
          },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => await withWorkerWebSocketRuntime(async () => {
      const client = await connectOpenAIResponsesWebSocket(apiKey.key);
      const started = waitForMessages(client, messages => messages.length === 6);
      client.send(JSON.stringify({
        type: 'response.create',
        event_id: 'evt_create',
        response: { model: 'gpt-direct-responses', input: 'start', store: false },
      }));
      const initial = await started;
      assertEquals(initial.map(message => message.type), [
        'response.created',
        'response.output_item.added',
        'response.output_item.done',
        'response.output_item.added',
        'response.output_item.done',
        'response.output_item.added',
      ]);
      const responseId = (initial[0].response as { id: string }).id;
      const keptClientItem = initial[4].item;
      const partialClientItemId = ((initial[5].item as { id: string }).id);

      const invalidMode = waitForMessages(client, messages => messages.length === 1);
      client.send(JSON.stringify({ type: 'response.interrupt', response_id: responseId, mode: 'keep_partial_items' }));
      assertEquals((await invalidMode)[0].status, 400);

      const wrongResponse = waitForMessages(client, messages => messages.length === 1);
      client.send(JSON.stringify({ type: 'response.interrupt', response_id: 'resp_wrong', mode: 'discard_partial_items' }));
      assertEquals(((await wrongResponse)[0].error as { code: string }).code, 'response_not_found');

      const time = new FakeTime(Date.now());
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const rawInterrupt = recordRawMessages(client);
      onTestFinished(() => time.restore());
      let interruptEvents: readonly Record<string, unknown>[];
      try {
        delayAbort = true;
        const acknowledged = waitForMessages(client, messages => messages.some(message => message.type === 'response.interrupt.accepted'));
        client.send(JSON.stringify({
          type: 'response.interrupt',
          event_id: 'evt_interrupt',
          response_id: responseId,
          mode: 'discard_partial_items',
        }));
        const accepted = await acknowledged;
        await upstreamAborted;

        await time.tickAsync(INTERRUPT_UPSTREAM_ABORT_WARNING_MS - 1);
        assertEquals(warn.mock.calls, []);
        await time.tickAsync(1);
        assertEquals(warn.mock.calls, [[
          'Floway: Responses WebSocket interrupt is still waiting for the upstream stream to stop after abort',
          { responseId, model: 'gpt-direct-responses', waitedMs: INTERRUPT_UPSTREAM_ABORT_WARNING_MS },
        ]]);
        assertEquals(rawInterrupt.messages.map(message => JSON.parse(message)), accepted);

        const interrupted = waitForMessages(client, messages => messages.some(isTerminalResponseEvent));
        settleUpstreamAbort.resolve();
        interruptEvents = [...accepted, ...await interrupted];
      } finally {
        rawInterrupt.stop();
        settleUpstreamAbort.resolve();
        warn.mockRestore();
        time.restore();
      }
      assertEquals(interruptEvents.map(message => [message.type, message.sequence_number]), [
        ['response.interrupt.accepted', 6],
        ['response.output_item.interrupted', 7],
        ['response.incomplete', 8],
      ]);
      assertEquals(interruptEvents[0].event_id, 'evt_interrupt');
      assertEquals(interruptEvents[1].item_id, partialClientItemId);
      assertEquals(interruptEvents[1].event_id, 'evt_create');
      const incomplete = interruptEvents[2].response as { id: string; status: string; output: unknown[]; incomplete_details: unknown };
      assertEquals(incomplete.id, responseId);
      assertEquals(incomplete.status, 'incomplete');
      assertEquals(incomplete.output.some(item => (item as { id?: unknown }).id === (keptClientItem as { id: string }).id), true);
      assertEquals(incomplete.incomplete_details, { reason: 'interrupted' });
      const followUp = waitForMessages(client, messages => messages.some(isTerminalResponseEvent));
      const followUpStarted = waitForMessages(client, messages => messages.some(message => message.type === 'response.created'));
      client.send(JSON.stringify({
        type: 'response.create',
        response: {
          model: 'gpt-direct-responses',
          previous_response_id: responseId,
          input: 'change direction',
          store: false,
        },
      }));
      await followUpStarted;
      client.send(JSON.stringify({ type: 'response.interrupt', response_id: responseId, mode: 'discard_partial_items' }));
      await waitForMicrotasks();
      resolveFollowUp();
      const followUpEvents = await followUp;
      assert(!followUpEvents.some(message => message.type === 'error'), JSON.stringify(followUpEvents));
      assertEquals(followUpEvents.at(-1)?.type, 'response.completed');
      assertEquals(upstreamBodies.length, 2);
      assertStringIncludes(JSON.stringify(upstreamBodies[1].input), 'finished');
    }),
  );
});

test('OpenAI Responses WebSocket returns invalid_request_error for malformed client messages', async () => {
  const { apiKey } = await setupAppTest();
  await withSuccessfulOpenAIResponsesUpstream(async () => await withWorkerWebSocketRuntime(async () => {
    const client = await connectOpenAIResponsesWebSocket(apiKey.key);
    const invalidJson = waitForMessages(client, messages => messages.length === 1);

    client.send('{bad json');

    const [invalidJsonMessage] = await invalidJson;
    assertExists(invalidJsonMessage);
    assertEquals(invalidJsonMessage.type, 'error');
    assertEquals(invalidJsonMessage.status, 400);
    assertEquals((invalidJsonMessage.error as { type?: unknown; code?: unknown }).type, 'invalid_request_error');
    assertEquals((invalidJsonMessage.error as { type?: unknown; code?: unknown }).code, 'invalid_request_error');

    const invalidShape = waitForMessages(client, messages => messages.length === 1);
    client.send(JSON.stringify({ event_id: 'evt_shape', response: {} }));

    assertEquals(await invalidShape, [{
      type: 'error',
      event_id: 'evt_shape',
      status: 400,
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request_error',
        message: expect.any(String),
      },
    }]);

    // The whole-frame comparisons around these two already pin the error
    // frame's own keys, so they assert the error body alone.
    const invalidResponse = waitForMessages(client, messages => messages.length === 1);
    client.send(JSON.stringify({ type: 'response.create', event_id: 'evt_response', response: {} }));

    const [invalidResponseMessage] = await invalidResponse;
    assertExists(invalidResponseMessage);
    assertEquals(invalidResponseMessage.type, 'error');
    assertEquals(invalidResponseMessage.event_id, 'evt_response');
    assertEquals(invalidResponseMessage.error, {
      type: 'invalid_request_error',
      code: 'missing_required_parameter',
      message: expect.any(String),
      param: 'model',
    });

    const invalidInput = waitForMessages(client, messages => messages.length === 1);
    client.send(JSON.stringify({ type: 'response.create', event_id: 'evt_input', response: { model: 'test-model' } }));

    const [invalidInputMessage] = await invalidInput;
    assertExists(invalidInputMessage);
    assertEquals(invalidInputMessage.type, 'error');
    assertEquals(invalidInputMessage.event_id, 'evt_input');
    assertEquals(invalidInputMessage.error, {
      type: 'invalid_request_error',
      code: 'invalid_request_error',
      message: expect.any(String),
      param: 'input',
    });

    const invalidItem = waitForMessages(client, messages => messages.length === 1);
    client.send(JSON.stringify({
      type: 'response.create',
      event_id: 'evt_item',
      response: { model: 'test-model', input: [null] },
    }));

    assertEquals(await invalidItem, [{
      type: 'error',
      event_id: 'evt_item',
      status: 400,
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request_error',
        message: expect.any(String),
        param: 'input[0]',
      },
    }]);
  }));
});

test('OpenAI Responses WebSocket store:false keeps session snapshots without durable repo writes', async () => {
  const { apiKey, repo } = await setupAppTest();
  const upstreamBodies: unknown[] = [];

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-direct-responses', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        upstreamBodies.push(JSON.parse(await request.text()));
        const turn = upstreamBodies.length;
        return sseOpenAIResponsesResponse({
          id: `resp_ws_store_false_${turn}`,
          object: 'response',
          model: 'gpt-direct-responses',
          status: 'completed',
          output: [{
            id: `assistant_ws_store_false_${turn}`,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: `answer ${turn}`, annotations: [] }],
          }],
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => await withWorkerWebSocketRuntime(async () => {
      const client = await connectOpenAIResponsesWebSocket(apiKey.key);
      const firstTerminal = waitForMessages(client, messages => messages.some(isTerminalResponseEvent));
      client.send(JSON.stringify({
        type: 'response.create',
        response: {
          model: 'gpt-direct-responses',
          input: 'first question',
          store: false,
        },
      }));
      const firstMessages = await firstTerminal;
      const firstResponseId = terminalResponseId(firstMessages);

      assert(firstResponseId !== 'resp_ws_store_false_1', 'expected the source boundary to replace the upstream response id');
      assertEquals(await repo.openaiResponsesSnapshots.lookup(apiKey.id, firstResponseId, 0), null);
      const firstOutput = firstMessages.find(message =>
        message.type === 'response.output_item.done'
        && (message as { item?: { type?: unknown } }).item?.type === 'message') as { item?: { id?: string } } | undefined;
      assertExists(firstOutput?.item?.id);
      assert(firstOutput.item.id !== 'assistant_ws_store_false_1', 'expected Copilot to replace the raw message id');
      assertEquals(await repo.openaiResponsesItems.lookupMany(apiKey.id, [firstOutput.item.id], 0), []);
      assertEquals(
        await repo.openaiResponsesItems.lookupManyByItemHash(apiKey.id, [await hashOpenAIResponsesItem({ type: 'message', role: 'user', content: 'first question' })], 0),
        [],
      );

      const followupTerminal = waitForMessages(client, messages => messages.some(isTerminalResponseEvent));
      client.send(JSON.stringify({
        type: 'response.create',
        event_id: 'evt_followup',
        response: {
          model: 'gpt-direct-responses',
          previous_response_id: firstResponseId,
          input: 'follow-up',
          store: false,
        },
      }));
      const secondMessages = await followupTerminal;
      const secondResponseId = terminalResponseId(secondMessages);
      assertEquals(await repo.openaiResponsesSnapshots.lookup(apiKey.id, secondResponseId, 0), null);

      const secondBody = upstreamBodies[1] as { previous_response_id?: unknown; input: Array<{ type: string; role?: string; content?: unknown }> };
      assertEquals(secondBody.previous_response_id, undefined);
      assertEquals(secondBody.input.map(item => [item.type, item.role, item.content]), [
        ['message', 'user', 'first question'],
        ['message', 'assistant', [{ type: 'output_text', text: 'answer 1', annotations: [] }]],
        ['message', 'user', 'follow-up'],
      ]);

      const sessionB = await connectOpenAIResponsesWebSocket(apiKey.key);
      const missingError = waitForMessages(sessionB, messages => messages.length === 1);
      sessionB.send(JSON.stringify({
        type: 'response.create',
        event_id: 'evt_cross_session',
        response: {
          model: 'gpt-direct-responses',
          previous_response_id: firstResponseId,
          input: 'cross-session attempt',
          store: false,
        },
      }));

      assertEquals(await missingError, [{
        type: 'error',
        event_id: 'evt_cross_session',
        status: 400,
        error: {
          message: expect.any(String),
          type: 'invalid_request_error',
          param: 'previous_response_id',
          code: 'previous_response_not_found',
        },
      }]);
    }),
  );
});

test('OpenAI Responses WebSocket answers a Codex generate:false prewarm locally and continues from it', async () => {
  const { apiKey } = await setupAppTest();
  const upstreamBodies: Record<string, unknown>[] = [];

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-direct-responses', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        upstreamBodies.push(JSON.parse(await request.text()) as Record<string, unknown>);
        return sseOpenAIResponsesResponse({
          id: 'resp_ws_after_prewarm',
          object: 'response',
          model: 'gpt-direct-responses',
          status: 'completed',
          output: [{
            id: 'assistant_ws_after_prewarm',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'answer', annotations: [] }],
          }],
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => await withWorkerWebSocketRuntime(async () => {
      const client = await connectOpenAIResponsesWebSocket(apiKey.key);
      const prewarmTerminal = waitForMessages(client, messages => messages.some(isTerminalResponseEvent));
      client.send(JSON.stringify({
        type: 'response.create',
        response: {
          model: 'gpt-direct-responses',
          input: [{ type: 'message', role: 'developer', content: 'Base instructions' }],
          store: false,
          generate: false,
        },
      }));
      const prewarmMessages = await prewarmTerminal;
      const prewarmResponseId = terminalResponseId(prewarmMessages);
      const prewarmCompleted = prewarmMessages.find(isTerminalResponseEvent) as { type?: unknown; response?: { status?: unknown; output?: Array<{ type: string }> } };
      assertEquals(prewarmCompleted.type, 'response.completed');
      assertEquals(prewarmCompleted.response?.status, 'completed');
      // Nothing was generated; the only item is the affinity carrier every
      // routed turn states.
      assertEquals(prewarmCompleted.response?.output?.map(item => item.type), ['reasoning']);
      assertEquals(upstreamBodies.length, 0);

      const turnTerminal = waitForMessages(client, messages => messages.some(isTerminalResponseEvent));
      client.send(JSON.stringify({
        type: 'response.create',
        response: {
          model: 'gpt-direct-responses',
          previous_response_id: prewarmResponseId,
          input: 'first question',
          store: false,
        },
      }));
      await turnTerminal;

      assertEquals(upstreamBodies.length, 1);
      const body = upstreamBodies[0] as { generate?: unknown; previous_response_id?: unknown; input: Array<{ type: string; role?: string; content?: unknown }> };
      assertEquals(Object.hasOwn(body, 'generate'), false);
      assertEquals(body.previous_response_id, undefined);
      assertEquals(body.input.map(item => [item.type, item.role, item.content]), [
        ['message', 'developer', 'Base instructions'],
        ['message', 'user', 'first question'],
      ]);
    }),
  );
});

test.each([
  { status: 400, retryAfter: undefined },
  { status: 429, retryAfter: '104' },
  { status: 503, retryAfter: 'Fri, 18 Nov 2033 09:18:34 GMT' },
])('OpenAI Responses WebSocket preserves the retry hint on an upstream $status', async ({ status, retryAfter }) => {
  const { apiKey } = await setupAppTest();
  const error = status === 429
    ? { type: 'rate_limit_error', code: 'turn_rate_limit_exceeded', message: 'Codex is at capacity, please try again later' }
    : { type: 'upstream_error', code: 'rejected', message: 'simulated upstream rejection' };

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-direct-responses', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        return new Response(JSON.stringify({ error }), {
          status,
          headers: {
            'content-type': 'Application/Problem+JSON; charset=utf-8',
            'set-cookie': 'upstream-only=1',
            ...(retryAfter === undefined ? {} : { 'Retry-After': retryAfter }),
          },
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => await withWorkerWebSocketRuntime(async () => {
      const client = await connectOpenAIResponsesWebSocket(apiKey.key);
      const rejected = waitForMessages(client, messages => messages.some(message => message.type === 'error'));
      client.send(JSON.stringify({
        type: 'response.create',
        event_id: 'evt_rejected',
        response: { model: 'gpt-direct-responses', input: 'question', store: false },
      }));
      assertEquals(await rejected, [{
        type: 'error',
        event_id: 'evt_rejected',
        status,
        error,
        ...(retryAfter === undefined ? {} : { headers: { 'retry-after': retryAfter } }),
      }]);

      client.close();
    }),
  );
});

test('OpenAI Responses WebSocket evicts a continuation that failed through a streamed terminal event', async () => {
  const { apiKey } = await setupAppTest();
  let responseCalls = 0;
  const upstreamError = { type: 'error', sequence_number: 1, code: null, param: 'tools', message: 'the upstream gave up mid-turn', vendor: { retryable: false } };

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-direct-responses', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        responseCalls += 1;
        if (responseCalls === 2) {
          const failing = {
            id: 'resp_ws_evict_streamed_2',
            object: 'response',
            model: 'gpt-direct-responses',
            status: 'failed',
            output: [],
            error: { code: 'server_error', message: 'the upstream gave up mid-turn' },
            incomplete_details: null,
          };
          return sseResponse([
            { event: 'response.created', data: { type: 'response.created', response: { ...failing, status: 'in_progress', error: null }, sequence_number: 0 } },
            { event: 'error', data: upstreamError },
            { event: 'response.failed', data: { type: 'response.failed', response: failing, sequence_number: 2 } },
            { data: '[DONE]' },
          ]);
        }
        return sseOpenAIResponsesResponse({
          id: `resp_ws_evict_streamed_${responseCalls}`,
          object: 'response',
          model: 'gpt-direct-responses',
          status: 'completed',
          output: [{
            id: `assistant_ws_evict_streamed_${responseCalls}`,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'answer' }],
          }],
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => await withWorkerWebSocketRuntime(async () => {
      const client = await connectOpenAIResponsesWebSocket(apiKey.key);
      const firstTerminal = waitForMessages(client, messages => messages.some(isTerminalResponseEvent));
      client.send(JSON.stringify({
        type: 'response.create',
        response: { model: 'gpt-direct-responses', input: 'first question', store: false },
      }));
      const firstResponseId = terminalResponseId(await firstTerminal);

      const failedTurn = waitForMessages(client, messages => messages.some(isTerminalResponseEvent));
      client.send(JSON.stringify({
        type: 'response.create',
        event_id: 'evt_streamed_failure',
        response: {
          model: 'gpt-direct-responses',
          previous_response_id: firstResponseId,
          input: 'follow-up the upstream abandons',
          store: false,
        },
      }));
      const failedMessages = await failedTurn;
      assertEquals(failedMessages.map(message => message.type), ['response.created', 'error', 'response.in_progress', 'response.failed']);
      assertEquals(failedMessages[1], { ...upstreamError, event_id: 'evt_streamed_failure' });
      assertEquals(failedMessages.map(message => message.sequence_number), [0, 1, 2, 3]);
      assert(failedMessages.every(message => message.event_id === 'evt_streamed_failure'));
      assertEquals(failedMessages.at(-1)?.type, 'response.failed');

      const evicted = waitForMessages(client, messages => messages.some(message => message.type === 'error'));
      client.send(JSON.stringify({
        type: 'response.create',
        event_id: 'evt_evicted',
        response: {
          model: 'gpt-direct-responses',
          previous_response_id: firstResponseId,
          input: 'retry from the same id',
          store: false,
        },
      }));

      assertEquals(await evicted, [{
        type: 'error',
        event_id: 'evt_evicted',
        status: 400,
        error: {
          message: expect.any(String),
          type: 'invalid_request_error',
          param: 'previous_response_id',
          code: 'previous_response_not_found',
        },
      }]);
      assertEquals(responseCalls, 2);
    }),
  );
});

test.each([
  { error: { type: 'error', code: null, param: null, message: 'native failure', vendor: { detail: 'flat' } }, announced: false },
  { error: { type: 'error', error: { code: 'vendor_failure', param: 'tools', message: 'native failure', vendor: { detail: 'nested' } }, trace: 'native-trace' }, announced: true },
])('OpenAI Responses WebSocket preserves a standalone upstream error and accepts the next turn %j', async ({ error, announced }) => {
  const { apiKey, repo } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const dumps = installDumpStubs(initDumpStore, initDumpBroker);
  let responseCalls = 0;
  const nativeError = { ...error, sequence_number: announced ? 1 : 0 };
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-direct-responses', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        responseCalls += 1;
        if (responseCalls === 1) return sseResponse([
          ...(announced ? [{ event: 'response.created', data: { type: 'response.created', sequence_number: 0, response: { id: 'resp_error', object: 'response', model: 'gpt-direct-responses', status: 'in_progress', output: [], error: null, incomplete_details: null } } }] : []),
          { event: 'error', data: nativeError },
          { data: '[DONE]' },
        ]);
        return sseOpenAIResponsesResponse({ id: 'resp_after_error', object: 'response', model: 'gpt-direct-responses', status: 'completed', output: [] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => await withWorkerWebSocketRuntime(async () => {
      const client = await connectOpenAIResponsesWebSocket(apiKey.key);
      const raw = recordRawMessages(client);
      try {
        const received = waitForMessages(client, messages => messages.some(message => message.type === 'error'));
        client.send(JSON.stringify({ type: 'response.create', event_id: 'evt_standalone', response: { model: 'gpt-direct-responses', input: 'hello' } }));
        const messages = await received;
        assertEquals(messages.map(message => message.type), announced ? ['response.created', 'error'] : ['error']);
        assertEquals(messages.at(-1), { ...nativeError, event_id: 'evt_standalone' });
        await vi.waitFor(() => assertEquals(dumps.stored.length, 1));
        assertEquals(raw.messages.map(message => JSON.parse(message)), messages);
        assertEquals(dumps.stored[0]?.record.meta.responseBytes, raw.messages.reduce((total, message) => total + new TextEncoder().encode(message).byteLength, 0));
        const nextTurn = waitForMessages(client, messages => messages.some(isTerminalResponseEvent));
        if (announced) {
          const created = messages[0] as { response: { id: string } };
          client.send(JSON.stringify({ type: 'response.interrupt', event_id: 'evt_late_interrupt', response_id: created.response.id, mode: 'discard_partial_items' }));
        }
        client.send(JSON.stringify({ type: 'response.create', event_id: 'evt_after_error', response: { model: 'gpt-direct-responses', input: 'next turn' } }));
        assert((await nextTurn).every(message => message.event_id === 'evt_after_error'));
        assertEquals(responseCalls, 2);
      } finally {
        raw.stop();
        client.close();
      }
    }),
  );
});

test('OpenAI Responses WebSocket makes a done reasoning item reusable from a fresh connection before terminal', async () => {
  const { apiKey } = await setupAppTest();
  const encoder = new TextEncoder();
  const originalReasoning = {
    type: 'reasoning' as const,
    id: 'rs_original',
    summary: [],
    encrypted_content: 'opaque',
  };
  let responseCalls = 0;
  let resolveSecondBody!: (body: { store?: unknown; input?: unknown }) => void;
  const secondBody = new Promise<{ store?: unknown; input?: unknown }>(resolve => { resolveSecondBody = resolve; });
  let firstClient: TestWorkerWebSocket | undefined;
  let secondClient: TestWorkerWebSocket | undefined;

  const enqueue = (controller: ReadableStreamDefaultController<Uint8Array>, event: string, data: unknown): void =>
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-direct-responses', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        const body = JSON.parse(await request.text()) as { store?: unknown; input?: unknown };
        responseCalls += 1;
        if (responseCalls === 1) {
          const response = {
            id: 'resp_first',
            object: 'response',
            model: 'gpt-direct-responses',
            status: 'in_progress',
            output: [],
            error: null,
            incomplete_details: null,
          };
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              enqueue(controller, 'response.created', { type: 'response.created', response, sequence_number: 0 });
              enqueue(controller, 'response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: originalReasoning, sequence_number: 1 });
              enqueue(controller, 'response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: originalReasoning, sequence_number: 2 });
              request.signal.addEventListener('abort', () => controller.error(request.signal.reason), { once: true });
            },
          }), { headers: { 'content-type': 'text/event-stream' } });
        }
        resolveSecondBody(body);
        return sseOpenAIResponsesResponse({
          id: 'resp_second',
          object: 'response',
          model: 'gpt-direct-responses',
          status: 'completed',
          output: [],
          error: null,
          incomplete_details: null,
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => await withWorkerWebSocketRuntime(async () => {
      try {
        firstClient = await connectOpenAIResponsesWebSocket(apiKey.key);
        const firstItemDone = waitForMessages(firstClient, messages =>
          messages.some(message => message.type === 'response.output_item.done'));
        firstClient.send(JSON.stringify({
          type: 'response.create',
          response: { model: 'gpt-direct-responses', store: true, input: 'first' },
        }));
        const messages = await firstItemDone;
        const done = messages.find(message => message.type === 'response.output_item.done') as { item?: typeof originalReasoning } | undefined;
        assertExists(done?.item);
        assert(done.item.id !== originalReasoning.id, 'expected Copilot to replace the carried reasoning id');
        assert(done.item.encrypted_content !== originalReasoning.encrypted_content);
        firstClient.close();

        secondClient = await connectOpenAIResponsesWebSocket(apiKey.key);
        secondClient.send(JSON.stringify({
          type: 'response.create',
          response: {
            model: 'gpt-direct-responses',
            store: true,
            input: [done.item, { type: 'message', role: 'user', content: 'continue' }],
          },
        }));
        const replay = await secondBody;
        assert(Array.isArray(replay.input));
        assertEquals(replay.input[0], originalReasoning);
        assertEquals(replay.store, false);
      } finally {
        firstClient?.close();
        secondClient?.close();
      }
    }),
  );
});

// A turn schedules its dump and usage writes from its terminal `finally`, so
// nothing of its own sits in the session's pending set while it streams. The
// session lifetime therefore has to hold the in-flight message chain itself:
// a client that closes mid-turn otherwise finds that set empty at the exact
// moment the close resolves `sessionClosed`, and the lifetime would resolve —
// freeing Cloudflare to evict the isolate — before the interrupted turn had
// recorded anything.
test('OpenAI Responses WebSocket holds the session lifetime open until a turn the client interrupted has recorded its dump', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const dumps = installDumpStubs(initDumpStore, initDumpBroker);
  const encoder = new TextEncoder();
  let resolveUpstreamReadStarted!: () => void;
  const upstreamReadStarted = new Promise<void>(resolve => {
    resolveUpstreamReadStarted = resolve;
  });

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-direct-responses', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`event: response.created\ndata: ${JSON.stringify({
              type: 'response.created',
              response: {
                id: 'resp_ws_lifetime',
                object: 'response',
                model: 'gpt-direct-responses',
                status: 'in_progress',
                output: [],
              },
              sequence_number: 0,
            })}\n\n`));
            // The turn never reaches a terminal event. The client's close
            // reaches this body through the request signal, which is how a
            // real streaming upstream is torn down mid-flight.
            request.signal.addEventListener('abort', () => {
              controller.error(request.signal.reason);
            }, { once: true });
          },
          pull() {
            resolveUpstreamReadStarted();
          },
        }), {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => await withWorkerWebSocketRuntime(async () => {
      const { client, sessionLifetime } = await connectOpenAIResponsesWebSocketCapturingSessionLifetime(apiKey.key);
      client.send(JSON.stringify({
        type: 'response.create',
        event_id: 'evt_ws_lifetime',
        response: {
          model: 'gpt-direct-responses',
          input: 'hello',
        },
      }));

      await waitForMessages(client, messages => messages.length >= 1);
      await upstreamReadStarted;
      client.close();

      await sessionLifetime;
      // Sampled at the instant the runtime would be free to drop the isolate,
      // deliberately without flushing background work first: the interrupted
      // turn's dump has to be stored by then, not merely scheduled.
      assertEquals(dumps.stored.length, 1);
    }),
  );
});

test('OpenAI Responses WebSocket returns the provider panic without recording an ordinary performance sample', async () => {
  const { apiKey, repo } = await setupAppTest();
  const buildServices = servicesModule.createGatewayServices;
  const failure = new Error('simulated Copilot authorization panic');
  delete failure.stack;
  const credentials = vi.fn(async () => { throw failure; });
  const createServices = vi.spyOn(servicesModule, 'createGatewayServices').mockImplementation(options => {
    const services = buildServices(options);
    return { ...services, copilot: { ...services.copilot, credentials } };
  });

  try {
    await withMockedFetch(
      async request => {
        const url = new URL(request.url);
        if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
        if (url.pathname === '/copilot_internal/v2/token') {
          return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
        }
        if (url.pathname === '/models') {
          return jsonResponse(copilotModels([{ id: 'gpt-direct-responses', supported_endpoints: ['/responses'] }]));
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => await withWorkerWebSocketRuntime(async () => {
        const { client, sessionLifetime } = await connectOpenAIResponsesWebSocketCapturingSessionLifetime(apiKey.key);
        const received = waitForMessages(client, messages => messages.length === 1);
        client.send(JSON.stringify({
          type: 'response.create',
          event_id: 'evt_throw',
          response: { model: 'gpt-direct-responses', input: 'hello' },
        }));

        assertEquals(await received, [{
          type: 'error',
          status: 500,
          event_id: 'evt_throw',
          error: {
            type: 'internal_error', code: 'internal_error', message: failure.message, provider_specific_fields: { name: 'Error' },
          },
        }]);
        client.close();
        await sessionLifetime;
      }),
    );

    assertEquals(credentials.mock.calls.length, 1);
    const samples = (await repo.performance.listAll()).filter(row => row.keyId === apiKey.id && row.model === 'gpt-direct-responses');
    assertEquals(samples, []);
  } finally {
    createServices.mockRestore();
  }
});

test('OpenAI Responses WebSocket dispatches each Codex turn with the metadata blob that turn carried', async () => {
  const { apiKey, repo } = await setupAppTest();
  const backgroundErrors = vi.spyOn(console, 'error');
  onTestFinished(() => backgroundErrors.mockRestore());
  await saveUpstreamForTest(repo.upstreams, buildChatGPTUpstreamRecord({
    flagOverrides: { 'openai-responses-compact-decrypt': false },
  }));
  const upstreamBodies: Record<string, unknown>[] = [];

  // The handshake carries the connection's first turn, exactly as the Codex
  // client sends it. Every later turn arrives on the frame body alone, so a
  // dispatch that re-reads these headers announces turn 1 forever.
  const handshakeTurnMetadata = {
    session_id: 'codex-session',
    thread_id: 'codex-thread',
    window_id: 'codex-thread:0',
    turn_id: 'handshake-turn',
    request_kind: 'turn',
    turn_started_at_unix_ms: 1700000000000,
  };

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') return jsonResponse(copilotModels([]));
      if (url.pathname === '/backend-api/codex/models') return jsonResponse(chatgptModels([{ slug: 'gpt-5.4' }]));
      if (url.pathname === '/backend-api/codex/responses') {
        upstreamBodies.push(JSON.parse(await request.text()) as Record<string, unknown>);
        const turn = upstreamBodies.length;
        return sseOpenAIResponsesResponse({
          id: `resp_codex_ws_${turn}`,
          object: 'response',
          model: 'gpt-5.4',
          status: 'completed',
          output: [{
            id: `assistant_codex_ws_${turn}`,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: `answer ${turn}`, annotations: [] }],
          }],
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => await withWorkerWebSocketRuntime(async () => {
      const socket = await connectOpenAIResponsesWebSocket(apiKey.key, {
        'session-id': 'codex-session',
        'thread-id': 'codex-thread',
        'x-codex-window-id': 'codex-thread:0',
        'x-codex-turn-metadata': JSON.stringify(handshakeTurnMetadata),
      });

      const firstTerminal = waitForMessages(socket, messages => messages.some(isTerminalResponseEvent));
      socket.send(JSON.stringify({
        type: 'response.create',
        response: {
          model: 'gpt-5.4',
          input: 'turn one input',
          client_metadata: {
            session_id: 'codex-session',
            thread_id: 'codex-thread',
            'x-codex-window-id': 'codex-thread:0',
            turn_id: 'turn-1',
            'x-codex-turn-metadata': JSON.stringify(handshakeTurnMetadata),
          },
        },
      }));
      await firstTerminal;

      const secondTerminal = waitForMessages(socket, messages => messages.some(isTerminalResponseEvent));
      socket.send(JSON.stringify({
        type: 'response.create',
        response: {
          model: 'gpt-5.4',
          input: [
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'turn two input' }] },
            { type: 'compaction_trigger' },
          ],
          client_metadata: {
            session_id: 'codex-session',
            thread_id: 'codex-thread',
            // Codex advances the window on auto-compaction and the advanced
            // value never reaches the handshake.
            'x-codex-window-id': 'codex-thread:1',
            turn_id: 'turn-2',
            'x-codex-turn-metadata': JSON.stringify({
              session_id: 'codex-session',
              thread_id: 'codex-thread',
              window_id: 'codex-thread:1',
              turn_id: 'turn-2',
              request_kind: 'compaction',
              compaction: { trigger: 'auto', reason: 'context_limit', implementation: 'responses_compaction_v2', phase: 'standalone_turn', strategy: 'memento' },
              turn_started_at_unix_ms: 1700000000002,
            }),
          },
        },
      }));
      await secondTerminal;

      assertEquals(upstreamBodies.length, 2);
      const turnMetadataOf = (body: Record<string, unknown>): Record<string, unknown> =>
        JSON.parse((body.client_metadata as Record<string, string>)['x-codex-turn-metadata']) as Record<string, unknown>;

      const first = turnMetadataOf(upstreamBodies[0]);
      assertEquals(first.request_kind, 'turn');
      assertEquals(first.window_id, 'codex-thread:0');
      assertEquals(first.turn_started_at_unix_ms, 1700000000000);

      const second = turnMetadataOf(upstreamBodies[1]);
      assertEquals(second.request_kind, 'compaction');
      assertEquals(second.window_id, 'codex-thread:1');
      assertEquals(second.turn_id, 'turn-2');
      assertEquals(second.turn_started_at_unix_ms, 1700000000002);
      assertEquals((upstreamBodies[1].client_metadata as Record<string, string>)['x-codex-window-id'], 'codex-thread:1');
    }),
  );
  expect(backgroundErrors).not.toHaveBeenCalled();
});
