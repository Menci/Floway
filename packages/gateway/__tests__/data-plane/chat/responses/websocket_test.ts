import type { ExecutionContext } from 'hono';
import { onTestFinished, test, vi } from 'vitest';

import { app } from '../../../../src/app.ts';
import { hashResponsesItem } from '../../../../src/data-plane/chat/responses/items/identity.ts';
import { responsesServe } from '../../../../src/data-plane/chat/responses/serve.ts';
import { KEEP_ALIVE_EVENT_TYPE } from '../../../../src/data-plane/chat/responses/websocket.ts';
import { DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS } from '../../../../src/data-plane/shared/sse.ts';
import { initDumpBroker, initDumpStore } from '../../../../src/dump/registry.ts';
import { installDumpStubs } from '../../../dump/test-fixtures.ts';
import { FakeTime } from '../../../test-time.ts';
import { copilotModels, flushAsyncWork, setupAppTest, sseResponse, sseResponsesResponse } from '../../../test-utils/app.ts';
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

const connectResponsesWebSocket = async (apiKey: string): Promise<TestWorkerWebSocket> => {
  const executionCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  } satisfies ExecutionContext;
  const response = await app.fetch(new Request('https://example.test/v1/responses', {
    method: 'GET',
    headers: {
      upgrade: 'websocket',
      'x-api-key': apiKey,
    },
  }), {}, executionCtx);
  assertEquals(response.status, 101);

  const runtime = activeRuntime();
  const pair = runtime.pairs.at(-1);
  assertExists(pair);
  return pair.client;
};

let currentRuntime: ReturnType<typeof installWorkerWebSocketRuntime> | undefined;

const activeRuntime = (): ReturnType<typeof installWorkerWebSocketRuntime> => {
  assertExists(currentRuntime);
  return currentRuntime;
};

const withWorkerWebSocketRuntime = async <T>(run: () => Promise<T>): Promise<T> => {
  const runtime = installWorkerWebSocketRuntime();
  currentRuntime = runtime;
  try {
    return await run();
  } finally {
    runtime.restore();
    currentRuntime = undefined;
  }
};

const withSuccessfulResponsesUpstream = async <T>(run: () => Promise<T>): Promise<T> =>
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
        return sseResponsesResponse({
          id: 'resp_ws_policy_refresh',
          object: 'response',
          model: 'gpt-direct-responses',
          status: 'completed',
          output: [],
          output_text: 'done',
          usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    run,
  );

const completeResponsesTurn = async (
  client: TestWorkerWebSocket,
  eventId: string,
): Promise<void> => {
  const received = waitForMessages(client, messages => messages.some(isTerminalResponseEvent));
  client.send(JSON.stringify({
    type: 'response.create',
    event_id: eventId,
    response: {
      model: 'gpt-direct-responses',
      input: eventId,
    },
  }));
  await received;
  await waitForMicrotasks();
};

test('Responses WebSocket forwards stream events, echoes event_id, and ends the turn on the terminal event', async () => {
  const { apiKey } = await setupAppTest();
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
        return sseResponsesResponse({
          id: 'resp_ws',
          object: 'response',
          model: 'gpt-direct-responses',
          status: 'completed',
          output: [],
          output_text: 'done',
          usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => await withWorkerWebSocketRuntime(async () => {
      const client = await connectResponsesWebSocket(apiKey.key);
      const raw = recordRawMessages(client);
      const received = waitForMessages(client, messages => messages.some(isTerminalResponseEvent));

      client.send(JSON.stringify({
        type: 'response.create',
        event_id: 'evt_1',
        response: {
          model: 'gpt-direct-responses',
          input: 'hello',
        },
      }));

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
    }),
  );
});

test('Responses WebSocket starts capturing on the next turn when dump retention is enabled after upgrade', async () => {
  const { apiKey, repo } = await setupAppTest();
  const dumps = installDumpStubs(initDumpStore, initDumpBroker);

  await withSuccessfulResponsesUpstream(
    async () => await withWorkerWebSocketRuntime(async () => {
      const client = await connectResponsesWebSocket(apiKey.key);
      await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });

      await completeResponsesTurn(client, 'capture-after-enable');
      await vi.waitFor(() => assertEquals(dumps.stored.length, 1));

      const stored = dumps.stored[0];
      assertExists(stored);
      assertEquals(stored.keyId, apiKey.id);
      assertEquals(stored.record.request.method, 'WS');
      assertEquals(stored.record.request.path, '/v1/responses');
      assertEquals(JSON.parse(new TextDecoder().decode(stored.record.request.body)), {
        type: 'response.create',
        event_id: 'capture-after-enable',
        response: {
          model: 'gpt-direct-responses',
          input: 'capture-after-enable',
        },
      });
      client.close();
    }),
  );
});

test('Responses WebSocket stops capturing on the next turn when dump retention is disabled after upgrade', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const dumps = installDumpStubs(initDumpStore, initDumpBroker);

  await withSuccessfulResponsesUpstream(
    async () => await withWorkerWebSocketRuntime(async () => {
      const client = await connectResponsesWebSocket(apiKey.key);
      await completeResponsesTurn(client, 'captured-before-disable');
      await vi.waitFor(() => assertEquals(dumps.stored.length, 1));

      await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: null });
      await completeResponsesTurn(client, 'not-captured-after-disable');

      assertEquals(dumps.stored.length, 1);
      client.close();
    }),
  );
});

test('Responses WebSocket dump responseBytes equals the UTF-8 payload bytes sent downstream', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const dumps = installDumpStubs(initDumpStore, initDumpBroker);

  await withSuccessfulResponsesUpstream(
    async () => await withWorkerWebSocketRuntime(async () => {
      const client = await connectResponsesWebSocket(apiKey.key);
      const recorded = recordRawMessages(client);
      try {
        await completeResponsesTurn(client, '响应-byte-count');
        await vi.waitFor(() => assertEquals(dumps.stored.length, 1));

        const expectedBytes = recorded.messages.reduce(
          (total, message) => total + new TextEncoder().encode(message).byteLength,
          0,
        );
        const utf16CodeUnits = recorded.messages.reduce((total, message) => total + message.length, 0);
        assert(expectedBytes > utf16CodeUnits, 'non-ASCII event_id must be counted as UTF-8 bytes');
        assertEquals(dumps.stored[0]?.record.meta.responseBytes, expectedBytes);
      } finally {
        recorded.stop();
        client.close();
      }
    }),
  );
});

test('Responses WebSocket rejects the next turn after its API key is rotated', async () => {
  const { apiKey, repo } = await setupAppTest();

  await withSuccessfulResponsesUpstream(
    async () => await withWorkerWebSocketRuntime(async () => {
      const client = await connectResponsesWebSocket(apiKey.key);
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

test('Responses WebSocket reports a failed turn when an output item cannot be persisted', async () => {
  const { apiKey, repo } = await setupAppTest();
  const persistence = vi.spyOn(repo.responsesItems, 'insertMany').mockRejectedValue(new Error('simulated item persistence failure'));
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
          return sseResponsesResponse({
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
            output_text: 'done',
            usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
          });
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => await withWorkerWebSocketRuntime(async () => {
        const client = await connectResponsesWebSocket(apiKey.key);
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
        assertEquals(error.error?.message, 'simulated item persistence failure');
        assert(!messages.some(message => message.type === 'response.output_item.done'));
        assert(!messages.some(isTerminalResponseEvent));
      }),
    );
  } finally {
    persistence.mockRestore();
  }
});

test('Responses WebSocket keep-alive waits for the first event and takes a slot in the stream sequence', async () => {
  const { apiKey } = await setupAppTest();
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
      const client = await connectResponsesWebSocket(apiKey.key);
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
          output_text: 'done',
        };
        const inProgress = { ...response, status: 'in_progress', output: [], output_text: '' };
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
});

test('Responses WebSocket returns OpenAI-style error envelopes for unsupported client events', async () => {
  const { apiKey } = await setupAppTest();
  await withWorkerWebSocketRuntime(async () => {
    const client = await connectResponsesWebSocket(apiKey.key);
    const received = waitForMessages(client, messages => messages.length === 1);

    client.send(JSON.stringify({ type: 'session.update', event_id: 'evt_bad' }));

    assertEquals(await received, [{
      type: 'error',
      event_id: 'evt_bad',
      status: 400,
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request_error',
        message: "Unsupported WebSocket event type 'session.update'.",
      },
    }]);
  });
});

test('Responses WebSocket returns invalid_request_error for malformed client messages', async () => {
  const { apiKey } = await setupAppTest();
  await withWorkerWebSocketRuntime(async () => {
    const client = await connectResponsesWebSocket(apiKey.key);
    const invalidJson = waitForMessages(client, messages => messages.length === 1);

    client.send('{bad json');

    const [invalidJsonMessage] = await invalidJson;
    assertExists(invalidJsonMessage);
    assertEquals(invalidJsonMessage.type, 'error');
    assertEquals(invalidJsonMessage.status, 400);
    assertEquals((invalidJsonMessage.error as { type?: unknown; code?: unknown }).type, 'invalid_request_error');
    assertEquals((invalidJsonMessage.error as { type?: unknown; code?: unknown }).code, 'invalid_request_error');
    assertStringIncludes((invalidJsonMessage.error as { message: string }).message, 'valid JSON');

    const invalidShape = waitForMessages(client, messages => messages.length === 1);
    client.send(JSON.stringify({ event_id: 'evt_shape', response: {} }));

    assertEquals(await invalidShape, [{
      type: 'error',
      event_id: 'evt_shape',
      status: 400,
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request_error',
        message: 'WebSocket message must be a JSON object with a string type.',
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
      message: "Missing required parameter: 'model'.",
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
      message: 'Responses input must be a string or an array.',
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
        message: 'Untyped Responses input items require a valid role and content.',
        param: 'input[0]',
      },
    }]);
  });
});

test('Responses WebSocket forwards HTTP failures with status, error.code, and event_id', async () => {
  const { apiKey } = await setupAppTest();
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') return jsonResponse(copilotModels([]));
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => await withWorkerWebSocketRuntime(async () => {
      const client = await connectResponsesWebSocket(apiKey.key);
      const received = waitForMessages(client, messages => messages.length === 1);

      client.send(JSON.stringify({
        type: 'response.create',
        event_id: 'evt_missing',
        response: {
          model: 'missing-model',
          input: 'hello',
        },
      }));

      assertEquals(await received, [{
        type: 'error',
        event_id: 'evt_missing',
        status: 404,
        error: {
          type: 'invalid_request_error',
          code: 'invalid_request_error',
          message: 'Model missing-model is not available on any configured upstream.',
        },
      }]);
    }),
  );
});

test('Responses WebSocket dump responseBytes counts an error envelope sent downstream', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const dumps = installDumpStubs(initDumpStore, initDumpBroker);

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') return jsonResponse(copilotModels([]));
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => await withWorkerWebSocketRuntime(async () => {
      const client = await connectResponsesWebSocket(apiKey.key);
      const recorded = recordRawMessages(client);
      try {
        const received = waitForMessages(client, messages => messages.length === 1);
        client.send(JSON.stringify({
          type: 'response.create',
          event_id: '错误-byte-count',
          response: {
            model: 'missing-model',
            input: 'hello',
          },
        }));

        assertEquals((await received)[0]?.status, 404);
        await vi.waitFor(() => assertEquals(dumps.stored.length, 1));
        const expectedBytes = recorded.messages.reduce(
          (total, message) => total + new TextEncoder().encode(message).byteLength,
          0,
        );
        assertEquals(dumps.stored[0]?.record.meta.responseBytes, expectedBytes);
      } finally {
        recorded.stop();
        client.close();
      }
    }),
  );
});

test('Responses WebSocket store:false keeps session snapshots without durable repo writes', async () => {
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
        return sseResponsesResponse({
          id: `resp_ws_store_false_${turn}`,
          object: 'response',
          model: 'gpt-direct-responses',
          status: 'completed',
          output_text: `answer ${turn}`,
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
      const client = await connectResponsesWebSocket(apiKey.key);
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
      assertEquals(await repo.responsesSnapshots.lookup(apiKey.id, firstResponseId, 0), null);
      const firstOutput = firstMessages.find(message =>
        message.type === 'response.output_item.done'
        && (message as { item?: { type?: unknown } }).item?.type === 'message') as { item?: { id?: string } } | undefined;
      assertExists(firstOutput?.item?.id);
      assert(firstOutput.item.id !== 'assistant_ws_store_false_1', 'expected Copilot to replace the raw message id');
      assertEquals(await repo.responsesItems.lookupMany(apiKey.id, [firstOutput.item.id], 0), []);
      assertEquals(
        await repo.responsesItems.lookupManyByItemHash(apiKey.id, [await hashResponsesItem({ type: 'message', role: 'user', content: 'first question' })], 0),
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
      assertEquals(await repo.responsesSnapshots.lookup(apiKey.id, secondResponseId, 0), null);

      const secondBody = upstreamBodies[1] as { previous_response_id?: unknown; input: Array<{ type: string; role?: string; content?: unknown }> };
      assertEquals(secondBody.previous_response_id, undefined);
      assertEquals(secondBody.input.map(item => [item.type, item.role, item.content]), [
        ['message', 'user', 'first question'],
        ['message', 'assistant', [{ type: 'output_text', text: 'answer 1', annotations: [] }]],
        ['message', 'user', 'follow-up'],
      ]);

      const sessionB = await connectResponsesWebSocket(apiKey.key);
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
          message: `Previous response with id '${firstResponseId}' not found.`,
          type: 'invalid_request_error',
          param: 'previous_response_id',
          code: 'previous_response_not_found',
        },
      }]);
    }),
  );
});

test('Responses WebSocket evicts a failed continuation target so the next attempt reports previous_response_not_found', async () => {
  const { apiKey } = await setupAppTest();
  let responseCalls = 0;

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
          return jsonResponse({
            error: { message: 'simulated upstream rejection', type: 'invalid_request_error', code: 'bad_request' },
          }, 400);
        }
        return sseResponsesResponse({
          id: `resp_ws_evict_${responseCalls}`,
          object: 'response',
          model: 'gpt-direct-responses',
          status: 'completed',
          output_text: 'answer',
          output: [{
            id: `assistant_ws_evict_${responseCalls}`,
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
      const client = await connectResponsesWebSocket(apiKey.key);
      const firstTerminal = waitForMessages(client, messages => messages.some(isTerminalResponseEvent));
      client.send(JSON.stringify({
        type: 'response.create',
        response: { model: 'gpt-direct-responses', input: 'first question', store: false },
      }));
      const firstResponseId = terminalResponseId(await firstTerminal);

      const rejected = waitForMessages(client, messages => messages.some(message => message.type === 'error'));
      client.send(JSON.stringify({
        type: 'response.create',
        event_id: 'evt_rejected',
        response: {
          model: 'gpt-direct-responses',
          previous_response_id: firstResponseId,
          input: 'follow-up the upstream rejects',
          store: false,
        },
      }));
      assertEquals(await rejected, [{
        type: 'error',
        event_id: 'evt_rejected',
        status: 400,
        error: {
          message: 'simulated upstream rejection',
          type: 'invalid_request_error',
          code: 'bad_request',
        },
      }]);

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
          message: `Previous response with id '${firstResponseId}' not found.`,
          type: 'invalid_request_error',
          param: 'previous_response_id',
          code: 'previous_response_not_found',
        },
      }]);
      assertEquals(responseCalls, 2);
    }),
  );
});

// A turn that fails by streaming a `response.failed` terminal answers the
// client with an event instead of an error envelope, so it leaves the handler
// through a different exit than the rejected turn above — and the spec's
// eviction rule applies to it just the same.
test('Responses WebSocket evicts a continuation that failed through a streamed terminal event', async () => {
  const { apiKey } = await setupAppTest();
  let responseCalls = 0;

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
            output_text: '',
            error: { code: 'server_error', message: 'the upstream gave up mid-turn' },
            incomplete_details: null,
          };
          return sseResponse([
            { event: 'response.created', data: { type: 'response.created', response: { ...failing, status: 'in_progress', error: null }, sequence_number: 0 } },
            { event: 'response.failed', data: { type: 'response.failed', response: failing, sequence_number: 1 } },
            { data: '[DONE]' },
          ]);
        }
        return sseResponsesResponse({
          id: `resp_ws_evict_streamed_${responseCalls}`,
          object: 'response',
          model: 'gpt-direct-responses',
          status: 'completed',
          output_text: 'answer',
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
      const client = await connectResponsesWebSocket(apiKey.key);
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
          message: `Previous response with id '${firstResponseId}' not found.`,
          type: 'invalid_request_error',
          param: 'previous_response_id',
          code: 'previous_response_not_found',
        },
      }]);
      assertEquals(responseCalls, 2);
    }),
  );
});

test('Responses WebSocket store:true durable snapshots can chain through local session cache', async () => {
  const { apiKey, repo } = await setupAppTest();
  let turn = 0;
  let firstResponseId: string | undefined;
  let secondResponseId: string | undefined;

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
        turn += 1;
        return sseResponsesResponse({
          id: `resp_ws_durable_${turn}`,
          object: 'response',
          model: 'gpt-direct-responses',
          status: 'completed',
          output_text: `answer ${turn}`,
          output: [{
            id: `assistant_ws_durable_${turn}`,
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
      const client = await connectResponsesWebSocket(apiKey.key);
      const firstTerminal = waitForMessages(client, messages => messages.some(isTerminalResponseEvent));
      client.send(JSON.stringify({ type: 'response.create', response: { model: 'gpt-direct-responses', input: 'first' } }));
      const firstMessages = await firstTerminal;
      const firstCompleted = firstMessages.find(message => message.type === 'response.completed') as { response?: { id?: string } } | undefined;
      firstResponseId = firstCompleted?.response?.id;
      assertExists(firstResponseId);

      const secondTerminal = waitForMessages(client, messages => messages.some(isTerminalResponseEvent));
      client.send(JSON.stringify({ type: 'response.create', response: { model: 'gpt-direct-responses', previous_response_id: firstResponseId, input: 'second' } }));
      const secondMessages = await secondTerminal;
      const secondCompleted = secondMessages.find(message => message.type === 'response.completed') as { response?: { id?: string } } | undefined;
      secondResponseId = secondCompleted?.response?.id;
      assertExists(secondResponseId);
    }),
  );

  const firstSnapshot = await repo.responsesSnapshots.lookup(apiKey.id, firstResponseId!, 0);
  const secondSnapshot = await repo.responsesSnapshots.lookup(apiKey.id, secondResponseId!, 0);
  assertExists(firstSnapshot);
  assertExists(secondSnapshot);
  assertEquals(secondSnapshot.itemIds.length > firstSnapshot.itemIds.length, true);
});

test('Responses WebSocket makes a done reasoning item reusable from a fresh connection before terminal', async () => {
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
            output_text: '',
            error: null,
            incomplete_details: null,
          };
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              enqueue(controller, 'response.created', { type: 'response.created', response, sequence_number: 0 });
              enqueue(controller, 'response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: originalReasoning, sequence_number: 1 });
              enqueue(controller, 'response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: originalReasoning, sequence_number: 2 });
            },
          }), { headers: { 'content-type': 'text/event-stream' } });
        }
        resolveSecondBody(body);
        return sseResponsesResponse({
          id: 'resp_second',
          object: 'response',
          model: 'gpt-direct-responses',
          status: 'completed',
          output: [],
          output_text: 'ok',
          error: null,
          incomplete_details: null,
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => await withWorkerWebSocketRuntime(async () => {
      try {
        firstClient = await connectResponsesWebSocket(apiKey.key);
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

        secondClient = await connectResponsesWebSocket(apiKey.key);
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
        await waitForMicrotasks();
      }
    }),
  );
});

// Exercises the session-level item cache directly: createResponsesWsSession
// builds a per-session MemoryStatefulResponsesBacking that mirrors every
// durable write. Wiping the D1-backed repo between turns proves the second
// message resolves the prior snapshot purely from in-RAM session cache.
// A fresh WS session after the repo wipe MUST NOT see it (the cache is
// per-session, not per-api-key).
test('Responses WebSocket session-level store: second message resolves prior items via session cache', async () => {
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
        return sseResponsesResponse({
          id: `resp_session_${turn}`,
          object: 'response',
          model: 'gpt-direct-responses',
          status: 'completed',
          output_text: `turn ${turn}`,
          output: [{
            id: `assistant_session_${turn}`,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: `turn ${turn}`, annotations: [] }],
          }],
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => await withWorkerWebSocketRuntime(async () => {
      const sessionA = await connectResponsesWebSocket(apiKey.key);
      const firstTerminal = waitForMessages(sessionA, messages => messages.some(isTerminalResponseEvent));
      sessionA.send(JSON.stringify({
        type: 'response.create',
        response: { model: 'gpt-direct-responses', input: 'turn one input' },
      }));
      const firstMessages = await firstTerminal;
      const firstCompleted = firstMessages.find(message => message.type === 'response.completed') as { response?: { id?: string } } | undefined;
      const firstResponseId = firstCompleted?.response?.id;
      assertExists(firstResponseId);

      // The first turn wrote to both the durable repo and the session-local
      // cache. Wipe the repo to prove the next lookup comes from the cache
      // alone.
      assertExists(await repo.responsesSnapshots.lookup(apiKey.id, firstResponseId, 0));
      await repo.responsesSnapshots.deleteAll();
      await repo.responsesItems.deleteAll();
      assertEquals(await repo.responsesSnapshots.lookup(apiKey.id, firstResponseId, 0), null);

      const secondTerminal = waitForMessages(sessionA, messages => messages.some(isTerminalResponseEvent));
      sessionA.send(JSON.stringify({
        type: 'response.create',
        response: {
          model: 'gpt-direct-responses',
          previous_response_id: firstResponseId,
          input: 'turn two input',
        },
      }));
      await secondTerminal;

      const secondBody = upstreamBodies[1] as { previous_response_id?: unknown; input: Array<{ type: string; role?: string; content?: unknown }> };
      assertEquals(secondBody.previous_response_id, undefined);
      // The snapshot resolved via the session cache contains turn 1's staged
      // user input and the prior assistant message; the new user input is
      // appended verbatim.
      assertEquals(secondBody.input.map(item => [item.type, item.role, item.content]), [
        ['message', 'user', 'turn one input'],
        ['message', 'assistant', [{ type: 'output_text', text: 'turn 1', annotations: [] }]],
        ['message', 'user', 'turn two input'],
      ]);

      const restored = await repo.responsesSnapshots.lookup(apiKey.id, firstResponseId, 0);
      assertExists(restored);
      assertEquals((await repo.responsesItems.lookupMany(apiKey.id, restored.itemIds, 0)).length, restored.itemIds.length);
      await repo.responsesSnapshots.deleteAll();
      await repo.responsesItems.deleteAll();

      // A fresh WS session for the same api key has its own empty cache; with
      // the repo wiped, the snapshot is unreachable.
      const sessionB = await connectResponsesWebSocket(apiKey.key);
      const missingError = waitForMessages(sessionB, messages => messages.length === 1);
      sessionB.send(JSON.stringify({
        type: 'response.create',
        event_id: 'evt_b',
        response: {
          model: 'gpt-direct-responses',
          previous_response_id: 'resp_session_1',
          input: 'cross-session attempt',
        },
      }));

      assertEquals(await missingError, [{
        type: 'error',
        event_id: 'evt_b',
        status: 400,
        error: {
          message: "Previous response with id 'resp_session_1' not found.",
          type: 'invalid_request_error',
          param: 'previous_response_id',
          code: 'previous_response_not_found',
        },
      }]);
    }),
  );
});

test('Responses WebSocket aborts the in-flight Responses request when the client closes', async () => {
  const { apiKey } = await setupAppTest();
  let resolveResponsesStarted: (() => void) | undefined;
  const responsesStarted = new Promise<void>(resolve => {
    resolveResponsesStarted = resolve;
  });
  let resolveUpstreamAborted: (() => void) | undefined;
  const upstreamAborted = new Promise<void>(resolve => {
    resolveUpstreamAborted = resolve;
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
        resolveResponsesStarted?.();
        return await new Promise<Response>(resolve => {
          request.signal.addEventListener('abort', () => {
            resolveUpstreamAborted?.();
            resolve(sseResponsesResponse({
              id: 'resp_ws_abort',
              object: 'response',
              model: 'gpt-direct-responses',
              status: 'completed',
              output: [],
              output_text: '',
            }));
          }, { once: true });
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => await withWorkerWebSocketRuntime(async () => {
      const client = await connectResponsesWebSocket(apiKey.key);
      client.send(JSON.stringify({
        type: 'response.create',
        response: {
          model: 'gpt-direct-responses',
          input: 'hello',
        },
      }));

      await responsesStarted;
      client.close();
      await upstreamAborted;
    }),
  );
});

// The four chat HTTP transports render a mid-attempt throw (interceptor
// bug, translation error, provider-layer JS exception not represented as a ChatServeFailure) through an
// `internalErrorResult(..., ctx.attempt.telemetry)` envelope,
// which internally reaches `recordFailedRequest` and lands an error row
// attributed to the throwing candidate. The WS transport's outer catch
// must do the same: alongside its sendError / dump.failed / dump.finalize,
// it calls `recordFailedRequest(ctx, ctx.attempt.telemetry)` so
// the failure shows up in performance_summary.
test('Responses WebSocket outer catch records a failed perf sample attributed to the throwing candidate', async () => {
  const { apiKey, repo } = await setupAppTest();

  // Mirror what responsesServe.generate would have stamped before failing
  // — telemetry set for the throwing candidate — then throw.
  const generateSpy = vi.spyOn(responsesServe, 'generate').mockImplementation(async ({ ctx }) => {
    ctx.attempt.telemetry = {
      keyId: apiKey.id,
      model: 'gpt-direct-responses',
      upstream: 'up_throwing',
      operation: 'chat',
      runtimeLocation: 'TEST',
    };
    throw new Error('simulated mid-attempt provider throw');
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
        const client = await connectResponsesWebSocket(apiKey.key);
        const received = waitForMessages(client, messages => messages.length === 1);
        client.send(JSON.stringify({
          type: 'response.create',
          event_id: 'evt_throw',
          response: { model: 'gpt-direct-responses', input: 'hello' },
        }));

        const [errorMessage] = await received;
        assertExists(errorMessage);
        assertEquals(errorMessage.type, 'error');
        assertEquals(errorMessage.status, 500);
        assertEquals(errorMessage.event_id, 'evt_throw');
      }),
    );

    await flushAsyncWork();

    // Filter to the throwing upstream: earlier WS tests in the same file
    // schedule background recordFailedRequest calls through the session
    // scheduler, and the shared `getRepo()` global resolves them against
    // whichever repo `setupAppTest` last installed — so cross-test rows can
    // land here. Only the row from the mocked generate is load-bearing for
    // this fix.
    const perfRows = (await repo.performance.listAll()).filter(row => row.upstream === 'up_throwing');
    assertEquals(perfRows.length, 1);
    assertEquals(perfRows[0]?.upstream, 'up_throwing');
    assertEquals(perfRows[0]?.model, 'gpt-direct-responses');
    assertEquals(perfRows[0]?.operation, 'chat');
    assertEquals(perfRows[0]?.errorsNoOutput, 1);
    assertEquals(perfRows[0]?.requests, 1);
  } finally {
    generateSpy.mockRestore();
  }
});
