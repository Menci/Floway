import type { ExecutionContext } from 'hono';
import { test, vi } from 'vitest';

import { hashResponsesItemBinding, hashResponsesItemContent, isResponsesItemId, isResponsesResponseId } from './items/format.ts';
import { responsesServe } from './serve.ts';
import { app } from '../../../app.ts';
import { initDumpBroker, initDumpStore } from '../../../dump/registry.ts';
import { installDumpStubs } from '../../../dump/test-fixtures.ts';
import { copilotModels, flushAsyncWork, setupAppTest, sseResponsesResponse } from '../../../test-helpers.ts';
import { FakeTime } from '../../../test-time.ts';
import { AffinityCodec } from '../shared/affinity/index.ts';
import { DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS } from '../shared/stream/sse.ts';
import { assert, assertEquals, assertExists, assertStringIncludes, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

type WorkerResponseInit = ResponseInit & { readonly webSocket?: WebSocket };

class TestWorkerWebSocket extends EventTarget {
  peer?: TestWorkerWebSocket;
  readyState: number = WebSocket.OPEN;

  accept(): void {}

  send(data: string): void {
    this.peer?.dispatchEvent(new MessageEvent('message', { data }));
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    if (this.peer) {
      this.peer.readyState = WebSocket.CLOSED;
      this.peer.dispatchEvent(new Event('close'));
    }
  }
}

const installWorkerWebSocketRuntime = (): {
  readonly pairs: Array<{ readonly client: TestWorkerWebSocket; readonly server: TestWorkerWebSocket }>;
  restore(): void;
} => {
  const globals = globalThis as typeof globalThis & {
    WebSocketPair?: unknown;
    Response: typeof Response;
  };
  const originalWebSocketPair = globals.WebSocketPair;
  const OriginalResponse = globals.Response;
  const pairs: Array<{ readonly client: TestWorkerWebSocket; readonly server: TestWorkerWebSocket }> = [];

  globals.WebSocketPair = class {
    constructor() {
      const client = new TestWorkerWebSocket();
      const server = new TestWorkerWebSocket();
      client.peer = server;
      server.peer = client;
      pairs.push({ client, server });
      return { 0: client, 1: server };
    }
  };

  globals.Response = class extends OriginalResponse {
    constructor(body?: BodyInit | null, init?: WorkerResponseInit) {
      if (init?.status === 101) {
        const { webSocket, status: _status, ...rest } = init;
        super(null, { ...rest, status: 200 });
        Object.defineProperty(this, 'status', { value: 101 });
        Object.defineProperty(this, 'webSocket', { value: webSocket });
        return;
      }
      super(body, init);
    }
  };

  return {
    pairs,
    restore: () => {
      globals.WebSocketPair = originalWebSocketPair;
      globals.Response = OriginalResponse;
    },
  };
};

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

const responseDoneId = (messages: readonly Record<string, unknown>[]): string => {
  const done = messages.find(message => message.type === 'response.done') as { response?: { id?: unknown } } | undefined;
  assertExists(done);
  const response = done.response;
  assertExists(response);
  const id = response.id;
  if (typeof id !== 'string') throw new Error(`expected response.done id to be a string, got ${typeof id}`);
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
  const received = waitForMessages(client, messages => messages.some(message => message.type === 'response.done'));
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

test('Responses WebSocket forwards stream events, echoes event_id, and sends response.done', async () => {
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
      const received = waitForMessages(client, messages => messages.some(message => message.type === 'response.done'));

      client.send(JSON.stringify({
        type: 'response.create',
        event_id: 'evt_1',
        response: {
          model: 'gpt-direct-responses',
          input: 'hello',
        },
      }));

      const messages = await received;
      assert(messages.every(message => message.event_id === 'evt_1'));
      const completed = messages.find(message => message.type === 'response.completed') as { response?: { id?: unknown } } | undefined;
      assertExists(completed);
      const flowayResponseId = (completed.response as { id?: unknown } | undefined)?.id;
      assertEquals(typeof flowayResponseId, 'string');
      assert(isResponsesResponseId(flowayResponseId as string), 'expected Floway-minted resp_ id, not the upstream blob');
      assertEquals(messages.at(-1), {
        type: 'response.done',
        event_id: 'evt_1',
        response: {
          id: flowayResponseId,
          usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
        },
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
        status_code: 401,
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
              content: [{ type: 'output_text', text: 'done' }],
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
        const error = messages.find(message => message.type === 'error') as { status_code?: unknown; error?: { message?: unknown } } | undefined;
        assertExists(error);
        assertEquals(error.status_code, 500);
        assertEquals(error.error?.message, 'simulated item persistence failure');
        assert(!messages.some(message => message.type === 'response.completed'));
        assert(!messages.some(message => message.type === 'response.done'));
      }),
    );
  } finally {
    persistence.mockRestore();
  }
});

test('Responses WebSocket keepalive during an in-flight request does not drop the pending upstream frame', async () => {
  const { apiKey } = await setupAppTest();
  const time = new FakeTime();
  const encoder = new TextEncoder();
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
  const hasMessageType = (messages: readonly Record<string, unknown>[], type: string): boolean =>
    messages.some(message => message.type === type);

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
          for (let i = 0; i < 4 && !hasMessageType(messages, 'ping'); i++) {
            await waitForMicrotasks();
            await time.tickAsync(DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS);
          }

          assert(hasMessageType(messages, 'ping'), 'expected a ping while the upstream response stream is idle');
          const completed = waitForMessages(client, received => received.some(message => message.type === 'response.done'));

          const response = {
            id: 'resp_ws_keepalive',
            object: 'response',
            model: 'gpt-direct-responses',
            status: 'completed',
            output: [],
            output_text: 'done',
          };
          const inProgress = { ...response, status: 'in_progress', output: [], output_text: '' };
          enqueueSseEvent('response.created', { type: 'response.created', response: inProgress, sequence_number: 0 });
          enqueueSseEvent('response.in_progress', { type: 'response.in_progress', response: inProgress, sequence_number: 1 });
          enqueueSseEvent('response.completed', { type: 'response.completed', response, sequence_number: 2 });
          upstreamController.enqueue(encoder.encode('data: [DONE]\n\n'));
          upstreamController.close();

          await completed;

          const types = messages.map(message => message.type);
          assert(types.indexOf('ping') < types.indexOf('response.created'), 'expected the delayed upstream frame after the ping');
          assert(types.includes('response.completed'), 'expected the terminal upstream frame after the ping');
          assertEquals(types.at(-1), 'response.done');
        } finally {
          client.removeEventListener('message', onMessage);
        }
      }),
    );
  } finally {
    time.restore();
  }
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
      status_code: 400,
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
    assertEquals(invalidJsonMessage.status_code, 400);
    assertEquals((invalidJsonMessage.error as { type?: unknown; code?: unknown }).type, 'invalid_request_error');
    assertEquals((invalidJsonMessage.error as { type?: unknown; code?: unknown }).code, 'invalid_request_error');
    assertStringIncludes((invalidJsonMessage.error as { message: string }).message, 'valid JSON');

    const invalidShape = waitForMessages(client, messages => messages.length === 1);
    client.send(JSON.stringify({ event_id: 'evt_shape', response: {} }));

    assertEquals(await invalidShape, [{
      type: 'error',
      event_id: 'evt_shape',
      status_code: 400,
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request_error',
        message: 'WebSocket message must be a JSON object with a string type.',
      },
    }]);

    const invalidResponse = waitForMessages(client, messages => messages.length === 1);
    client.send(JSON.stringify({ type: 'response.create', event_id: 'evt_response', response: {} }));

    assertEquals(await invalidResponse, [{
      type: 'error',
      event_id: 'evt_response',
      status_code: 400,
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request_error',
        message: 'response.create requires response.model to be a non-empty string.',
      },
    }]);

    const invalidItem = waitForMessages(client, messages => messages.length === 1);
    client.send(JSON.stringify({
      type: 'response.create',
      event_id: 'evt_item',
      response: { model: 'test-model', input: [null] },
    }));

    assertEquals(await invalidItem, [{
      type: 'error',
      event_id: 'evt_item',
      status_code: 400,
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request_error',
        message: 'Untyped Responses input items require a valid role and content.',
        param: 'input[0]',
      },
    }]);
  });
});

test('Responses WebSocket renders an invalid bound affinity carrier as a 400 input error', async () => {
  const { apiKey } = await setupAppTest();
  const original = { type: 'program_output' as const, id: 'first', call_id: 'call_1', result: 'first', status: 'completed' as const };
  const carrier = await new AffinityCodec(apiKey.serverSecret).wrap(undefined, {
    upstreamId: 'copilot',
    modelId: 'gpt-direct-responses',
    syntheticItem: true,
    boundItem: {
      type: original.type,
      upstreamItemId: 'first_upstream',
      contentHash: await hashResponsesItemBinding(original),
    },
  }, 'responses.reasoning.encrypted_content');

  await withSuccessfulResponsesUpstream(async () => await withWorkerWebSocketRuntime(async () => {
    const client = await connectResponsesWebSocket(apiKey.key);
    const received = waitForMessages(client, messages => messages.some(message => message.type === 'error'));
    client.send(JSON.stringify({
      type: 'response.create',
      event_id: 'evt_affinity',
      response: {
        model: 'gpt-direct-responses',
        input: [
          { type: 'reasoning', id: 'rs_prefix', summary: [], encrypted_content: carrier },
          { type: 'program_output', id: 'second', call_id: 'call_2', result: 'second', status: 'completed' },
        ],
      },
    }));

    assertEquals(await received, [{
      type: 'error',
      event_id: 'evt_affinity',
      status_code: 400,
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request_error',
        message: 'Affinity carrier does not match the Responses input item at index 1.',
        param: 'input[1]',
      },
    }]);
  }));
});

test('Responses WebSocket forwards HTTP failures with status_code, error.code, and event_id', async () => {
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
        status_code: 404,
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

        assertEquals((await received)[0]?.status_code, 404);
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
            content: [{ type: 'output_text', text: `answer ${turn}` }],
          }],
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => await withWorkerWebSocketRuntime(async () => {
      const client = await connectResponsesWebSocket(apiKey.key);
      const firstDone = waitForMessages(client, messages => messages.some(message => message.type === 'response.done'));
      client.send(JSON.stringify({
        type: 'response.create',
        response: {
          model: 'gpt-direct-responses',
          input: 'first question',
          store: false,
        },
      }));
      const firstMessages = await firstDone;
      const firstResponseId = responseDoneId(firstMessages);

      assert(isResponsesResponseId(firstResponseId), 'expected a Floway response id');
      assertEquals(await repo.responsesSnapshots.lookup(apiKey.id, firstResponseId), null);
      const firstOutput = firstMessages.find(message => message.type === 'response.output_item.done') as { item?: { id?: string } } | undefined;
      assertExists(firstOutput?.item?.id);
      assert(isResponsesItemId(firstOutput.item.id), 'expected a Floway output item id');
      assertEquals(await repo.responsesItems.lookupMany(apiKey.id, [firstOutput.item.id]), []);
      assertEquals(
        await repo.responsesItems.lookupManyByContentHash(apiKey.id, [await hashResponsesItemContent({ type: 'message', role: 'user', content: 'first question' })]),
        [],
      );

      const followupDone = waitForMessages(client, messages => messages.some(message => message.type === 'response.done'));
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
      const secondMessages = await followupDone;
      const secondResponseId = responseDoneId(secondMessages);
      assertEquals(await repo.responsesSnapshots.lookup(apiKey.id, secondResponseId), null);

      const secondBody = upstreamBodies[1] as { previous_response_id?: unknown; input: Array<{ type: string; role?: string; content?: unknown }> };
      assertEquals(secondBody.previous_response_id, undefined);
      assertEquals(secondBody.input.map(item => [item.type, item.role, item.content]), [
        ['message', 'user', 'first question'],
        ['message', 'assistant', [{ type: 'output_text', text: 'answer 1' }]],
        ['message', 'user', 'follow-up'],
      ]);

      const sessionB = await connectResponsesWebSocket(apiKey.key);
      const missingDone = waitForMessages(sessionB, messages => messages.length === 1);
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

      assertEquals(await missingDone, [{
        type: 'error',
        event_id: 'evt_cross_session',
        status_code: 400,
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
            content: [{ type: 'output_text', text: `answer ${turn}` }],
          }],
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => await withWorkerWebSocketRuntime(async () => {
      const client = await connectResponsesWebSocket(apiKey.key);
      const firstDone = waitForMessages(client, messages => messages.some(message => message.type === 'response.done'));
      client.send(JSON.stringify({ type: 'response.create', response: { model: 'gpt-direct-responses', input: 'first' } }));
      const firstMessages = await firstDone;
      const firstCompleted = firstMessages.find(message => message.type === 'response.completed') as { response?: { id?: string } } | undefined;
      firstResponseId = firstCompleted?.response?.id;
      assertExists(firstResponseId);

      const secondDone = waitForMessages(client, messages => messages.some(message => message.type === 'response.done'));
      client.send(JSON.stringify({ type: 'response.create', response: { model: 'gpt-direct-responses', previous_response_id: firstResponseId, input: 'second' } }));
      const secondMessages = await secondDone;
      const secondCompleted = secondMessages.find(message => message.type === 'response.completed') as { response?: { id?: string } } | undefined;
      secondResponseId = secondCompleted?.response?.id;
      assertExists(secondResponseId);
    }),
  );

  const firstSnapshot = await repo.responsesSnapshots.lookup(apiKey.id, firstResponseId!);
  const secondSnapshot = await repo.responsesSnapshots.lookup(apiKey.id, secondResponseId!);
  assertExists(firstSnapshot);
  assertExists(secondSnapshot);
  assertEquals(secondSnapshot.itemIds.length > firstSnapshot.itemIds.length, true);
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
            content: [{ type: 'output_text', text: `turn ${turn}` }],
          }],
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => await withWorkerWebSocketRuntime(async () => {
      const sessionA = await connectResponsesWebSocket(apiKey.key);
      const firstDone = waitForMessages(sessionA, messages => messages.some(message => message.type === 'response.done'));
      sessionA.send(JSON.stringify({
        type: 'response.create',
        response: { model: 'gpt-direct-responses', input: 'turn one input' },
      }));
      const firstMessages = await firstDone;
      const firstCompleted = firstMessages.find(message => message.type === 'response.completed') as { response?: { id?: string } } | undefined;
      const firstResponseId = firstCompleted?.response?.id;
      assertExists(firstResponseId);

      // The first turn wrote to both the durable repo and the session-local
      // cache. Wipe the repo to prove the next lookup comes from the cache
      // alone.
      assertExists(await repo.responsesSnapshots.lookup(apiKey.id, firstResponseId));
      await repo.responsesSnapshots.deleteAll();
      await repo.responsesItems.deleteAll();
      assertEquals(await repo.responsesSnapshots.lookup(apiKey.id, firstResponseId), null);

      const secondDone = waitForMessages(sessionA, messages => messages.some(message => message.type === 'response.done'));
      sessionA.send(JSON.stringify({
        type: 'response.create',
        response: {
          model: 'gpt-direct-responses',
          previous_response_id: firstResponseId,
          input: 'turn two input',
        },
      }));
      await secondDone;

      const secondBody = upstreamBodies[1] as { previous_response_id?: unknown; input: Array<{ type: string; role?: string; content?: unknown }> };
      assertEquals(secondBody.previous_response_id, undefined);
      // The snapshot resolved via the session cache contains turn 1's staged
      // user input and the prior assistant message; the new user input is
      // appended verbatim.
      assertEquals(secondBody.input.map(item => [item.type, item.role, item.content]), [
        ['message', 'user', 'turn one input'],
        ['message', 'assistant', [{ type: 'output_text', text: 'turn 1' }]],
        ['message', 'user', 'turn two input'],
      ]);

      const restored = await repo.responsesSnapshots.lookup(apiKey.id, firstResponseId);
      assertExists(restored);
      assertEquals((await repo.responsesItems.lookupMany(apiKey.id, restored.itemIds)).length, restored.itemIds.length);
      await repo.responsesSnapshots.deleteAll();
      await repo.responsesItems.deleteAll();

      // A fresh WS session for the same api key has its own empty cache; with
      // the repo wiped, the snapshot is unreachable.
      const sessionB = await connectResponsesWebSocket(apiKey.key);
      const missingDone = waitForMessages(sessionB, messages => messages.length === 1);
      sessionB.send(JSON.stringify({
        type: 'response.create',
        event_id: 'evt_b',
        response: {
          model: 'gpt-direct-responses',
          previous_response_id: 'resp_session_1',
          input: 'cross-session attempt',
        },
      }));

      assertEquals(await missingDone, [{
        type: 'error',
        event_id: 'evt_b',
        status_code: 400,
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
// bug, translation error, provider-layer JS exception that bypassed
// tryCatchChatServeFailure) through an
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
        assertEquals(errorMessage.status_code, 500);
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
