import type { ExecutionContext } from 'hono';
import { onTestFinished, test, vi } from 'vitest';

import { app } from '../../../../src/app.ts';
import { hashOpenAIResponsesItem } from '../../../../src/data-plane/chat/openai-responses/items/identity.ts';
import { openaiResponsesServe } from '../../../../src/data-plane/chat/openai-responses/serve.ts';
import { KEEP_ALIVE_EVENT_TYPE } from '../../../../src/data-plane/chat/openai-responses/websocket.ts';
import { DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS } from '../../../../src/data-plane/shared/sse.ts';
import { initDumpBroker, initDumpStore } from '../../../../src/dump/registry.ts';
import { initBackgroundSchedulerResolver } from '../../../../src/runtime/background.ts';
import { installDumpStubs } from '../../../dump/test-fixtures.ts';
import { FakeTime } from '../../../test-time.ts';
import { buildCodexUpstreamRecord, codexModels, copilotModels, flushAsyncWork, setupAppTest, sseResponse, sseOpenAIResponsesResponse } from '../../../test-utils/app.ts';
import { trackBackground } from '../../../test-utils/background-tracker.ts';
import { installWorkerWebSocketRuntime, type TestWorkerWebSocket } from '../../../test-utils/worker-websocket.ts';
import { OPENAI_RESPONSES_LITE_HEADER, OPENAI_RESPONSES_LITE_WS_METADATA_KEY } from '@floway-dev/protocols/openai-responses';
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

const connectOpenAIResponsesWebSocket = async (apiKey: string, upgradeHeaders: Record<string, string> = {}): Promise<TestWorkerWebSocket> => {
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
      ...upgradeHeaders,
    },
  }), {}, executionCtx);
  assertEquals(response.status, 101);

  const runtime = activeRuntime();
  const pair = runtime.pairs.at(-1);
  assertExists(pair);
  return pair.client;
};

// The upgrade registers exactly one runtime background task: the session
// lifetime promise, which resolves once the socket is closed and every
// session-scoped write has drained. Capturing it lets a test observe the
// instant the runtime would be free to evict the isolate — on Cloudflare
// that is the deadline every session-scoped write has to beat.
const connectOpenAIResponsesWebSocketCapturingSessionLifetime = async (
  apiKey: string,
): Promise<{ client: TestWorkerWebSocket; sessionLifetime: Promise<unknown> }> => {
  const registered: Promise<unknown>[] = [];
  initBackgroundSchedulerResolver(_c => promise => {
    registered.push(Promise.resolve(promise));
    trackBackground(promise);
  });
  try {
    const client = await connectOpenAIResponsesWebSocket(apiKey);
    assertEquals(registered.length, 1, 'expected the upgrade to register exactly one background task');
    const sessionLifetime = registered[0];
    assertExists(sessionLifetime);
    return { client, sessionLifetime };
  } finally {
    initBackgroundSchedulerResolver(_c => trackBackground);
  }
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
          output_text: 'done',
          usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    run,
  );

const completeOpenAIResponsesTurn = async (
  client: TestWorkerWebSocket,
  eventId: string,
  streamId?: string,
): Promise<void> => {
  const received = waitForMessages(client, messages => messages.some(isTerminalResponseEvent));
  client.send(JSON.stringify({
    type: 'response.create',
    event_id: eventId,
    stream_id: streamId,
    response: {
      model: 'gpt-direct-responses',
      input: eventId,
    },
  }));
  await received;
  await waitForMicrotasks();
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

const withCodexWebSocketUpstream = async (
  respond: (request: Request) => Promise<Response>,
  run: (setup: Awaited<ReturnType<typeof setupAppTest>>) => Promise<void>,
) => {
  const setup = await setupAppTest();
  await setup.repo.upstreams.save({ ...setup.copilotUpstream, enabled: false });
  await setup.repo.upstreams.save(buildCodexUpstreamRecord());
  await withMockedFetch(async request => {
    const { pathname } = new URL(request.url);
    if (pathname === '/backend-api/codex/models') return jsonResponse(codexModels([{ slug: 'gpt-6-astra' }]));
    if (pathname === '/backend-api/codex/responses') return await respond(request);
    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => await withWorkerWebSocketRuntime(async () => await run(setup)));
};

const emptyCodexResponse = () => sseOpenAIResponsesResponse({
  id: 'resp_upstream', object: 'response', model: 'gpt-6-astra', status: 'completed', output: [],
});

test('OpenAI Responses WebSocket names lanes without sending stream_id to HTTP and echoes all response and error envelopes', async () => {
  const bodies: Record<string, unknown>[] = [];
  await withCodexWebSocketUpstream(async request => {
    bodies.push(JSON.parse(await request.text()) as Record<string, unknown>);
    return emptyCodexResponse();
  }, async ({ apiKey }) => {
    const socket = await connectOpenAIResponsesWebSocket(apiKey.key);
    const streamId = 'Lane_1-a.'.padEnd(256, 'z');
    const completed = waitForMessages(socket, messages => messages.some(isTerminalResponseEvent));
    socket.send(JSON.stringify({ type: 'response.create', stream_id: streamId, event_id: 'named_create', response: { model: 'gpt-6-astra', input: 'hello' } }));
    const events = await completed;
    assert(events.every(event => event.stream_id === streamId && event.event_id === 'named_create'));
    assertEquals(bodies.length, 1);
    assertEquals(bodies[0].stream_id, undefined);

    const failed = waitForMessages(socket, messages => messages.some(event => event.type === 'error'));
    socket.send(JSON.stringify({ type: 'response.create', stream_id: streamId, event_id: 'named_error', model: 'gpt-6-astra', previous_response_id: 'missing_named_response', input: [] }));
    const error = (await failed).at(-1)!;
    assertEquals(error.stream_id, streamId);
    assertEquals(error.event_id, 'named_error');
    assertEquals((error.error as Record<string, unknown>).code, 'previous_response_not_found');
    socket.close();
  });
});

test('OpenAI Responses WebSocket runs different lanes concurrently and keeps each lane FIFO', async () => {
  const turns = ['a1', 'a2', 'b1', 'default'];
  const started = new Map(turns.map(turn => [turn, deferred()]));
  const release = new Map(turns.map(turn => [turn, deferred()]));
  const requests: string[] = [];
  await withCodexWebSocketUpstream(async request => {
    const body = JSON.parse(await request.text()) as { client_metadata: { lane_test_turn: string }; stream_id?: unknown };
    assertEquals(body.stream_id, undefined);
    const turn = body.client_metadata.lane_test_turn;
    requests.push(turn);
    started.get(turn)!.resolve();
    await release.get(turn)!.promise;
    return emptyCodexResponse();
  }, async ({ apiKey }) => {
    const socket = await connectOpenAIResponsesWebSocket(apiKey.key);
    try {
      const completed = waitForMessages(socket, messages => messages.filter(isTerminalResponseEvent).length === 4 || messages.some(event => event.type === 'error'))
        .then(events => {
          assertEquals(events.find(event => event.type === 'error'), undefined);
          return events;
        });
      for (const [turn, streamId] of [['a1', 'a'], ['a2', 'a'], ['b1', 'b'], ['default', undefined]]) {
        socket.send(JSON.stringify({ type: 'response.create', stream_id: streamId, event_id: turn, model: 'gpt-6-astra', input: [], client_metadata: { lane_test_turn: turn } }));
      }
      await Promise.race([Promise.all(['a1', 'b1', 'default'].map(turn => started.get(turn)!.promise)), completed]);
      assertEquals(new Set(requests), new Set(['a1', 'b1', 'default']));
      release.get('a1')!.resolve();
      await started.get('a2')!.promise;
      assertEquals(requests.indexOf('a1') < requests.indexOf('a2'), true);
      for (const gate of release.values()) gate.resolve();
      const events = await completed;
      for (const event of events) {
        const expected = event.event_id === 'default' ? undefined : (event.event_id as string)[0];
        assertEquals(event.stream_id, expected);
      }
    } finally {
      for (const gate of release.values()) gate.resolve();
      socket.close();
    }
  });
});

test('OpenAI Responses WebSocket queues the seventeenth active response including the default lane', async () => {
  const started = Array.from({ length: 17 }, deferred);
  const release = Array.from({ length: 17 }, deferred);
  const requests: number[] = [];
  await withCodexWebSocketUpstream(async request => {
    const body = JSON.parse(await request.text()) as { client_metadata: { lane_test_turn: string } };
    const turn = Number(body.client_metadata.lane_test_turn);
    requests.push(turn);
    started[turn].resolve();
    await release[turn].promise;
    return emptyCodexResponse();
  }, async ({ apiKey }) => {
    const socket = await connectOpenAIResponsesWebSocket(apiKey.key);
    try {
      const completed = waitForMessages(socket, messages => messages.filter(isTerminalResponseEvent).length === 17 || messages.some(event => event.type === 'error'))
        .then(events => { assertEquals(events.find(event => event.type === 'error'), undefined); return events; });
      for (let turn = 0; turn < 17; turn++) {
        socket.send(JSON.stringify({ type: 'response.create', stream_id: turn === 0 ? undefined : `lane_${turn}`, model: 'gpt-6-astra', input: [], client_metadata: { lane_test_turn: String(turn) } }));
      }
      await Promise.race([Promise.all(started.slice(0, 16).map(gate => gate.promise)), completed]);
      await flushAsyncWork();
      assertEquals(requests.length, 16);
      assertEquals(requests.includes(16), false);
      release[0].resolve();
      await Promise.race([started[16].promise, completed]);
      assertEquals(requests.length, 17);
      for (const gate of release) gate.resolve();
      await completed;
    } finally {
      for (const gate of release) gate.resolve();
      socket.close();
    }
  });
});

test('OpenAI Responses WebSocket validates stream names and retains all 32 named lanes for reuse', async () => {
  let requests = 0;
  await withCodexWebSocketUpstream(async () => { requests++; return emptyCodexResponse(); }, async ({ apiKey }) => {
    const socket = await connectOpenAIResponsesWebSocket(apiKey.key);
    const send = async (streamId: unknown, eventId: string) => {
      const received = waitForMessages(socket, messages => messages.some(event => isTerminalResponseEvent(event) || event.type === 'error'));
      socket.send(JSON.stringify({ type: 'response.create', stream_id: streamId, event_id: eventId, model: 'gpt-6-astra', input: [], generate: false, store: false }));
      return (await received).at(-1)!;
    };
    for (const invalid of ['', null, 1, true, {}, [], 'has space', 'slash/name', '中文', 'a'.repeat(257)]) {
      const error = await send(invalid, 'invalid_name');
      assertEquals(error.type, 'error');
      assertEquals(error.status, 400);
      assertEquals(error.event_id, 'invalid_name');
      assertEquals(error.stream_id, undefined);
      assertEquals((error.error as Record<string, unknown>).code, 'invalid_stream_id');
    }
    for (let lane = 0; lane < 32; lane++) {
      const event = await send(`lane_${lane}`, `warm_${lane}`);
      assertEquals(event.type, 'response.completed');
      assertEquals(event.stream_id, `lane_${lane}`);
    }
    const overflow = await send('lane_32', 'overflow');
    assertEquals(overflow.type, 'error');
    assertEquals(overflow.status, 400);
    assertEquals(overflow.stream_id, 'lane_32');
    assertEquals((overflow.error as Record<string, unknown>).code, 'websocket_stream_limit_reached');
    assertEquals((await send(undefined, 'default_after_limit')).stream_id, undefined);
    assertEquals((await send('lane_0', 'reuse_first')).type, 'response.completed');
    assertEquals((await send('lane_31', 'reuse_last')).type, 'response.completed');
    assertEquals(requests, 0, 'prewarming and stream validation must not invoke inference');
    socket.close();
  });
});

test('OpenAI Responses WebSocket preserves a parent after a failed cross-lane fork and evicts a failed same-lane continuation', async () => {
  const bodies: Record<string, unknown>[] = [];
  await withCodexWebSocketUpstream(async request => {
    const body = JSON.parse(await request.text()) as Record<string, unknown>;
    bodies.push(body);
    if ((body.client_metadata as Record<string, unknown>).fail === 'true') return jsonResponse({ error: { type: 'invalid_request_error', message: 'Rejected test turn.', code: 'test_rejected' } }, 400);
    return emptyCodexResponse();
  }, async ({ apiKey }) => {
    const socket = await connectOpenAIResponsesWebSocket(apiKey.key);
    const send = async (streamId: string, input: unknown, extra: Record<string, unknown> = {}) => {
      const received = waitForMessages(socket, messages => messages.some(event => isTerminalResponseEvent(event) || event.type === 'error'));
      socket.send(JSON.stringify({ type: 'response.create', stream_id: streamId, model: 'gpt-6-astra', input, store: false, ...extra }));
      const events = await received;
      assert(events.every(event => event.stream_id === streamId));
      return events;
    };
    const parentInput = { type: 'message', role: 'user', content: 'Shared parent.' };
    const parent = terminalResponseId(await send('source', [parentInput], { generate: false }));
    const fork = await send('fork', [], { previous_response_id: parent, client_metadata: { fail: 'true' } });
    assertEquals((fork.at(-1)!.error as Record<string, unknown>).code, 'test_rejected', JSON.stringify(fork));
    assertEquals(bodies.length, 1, 'the failed fork must have hydrated its parent and reached upstream');
    assertStringIncludes(JSON.stringify(bodies[0].input), 'Shared parent.');

    const continued = terminalResponseId(await send('source', [], { previous_response_id: parent }));
    assertEquals(bodies.length, 2);
    assertEquals(bodies[1].input, bodies[0].input);
    const oldParent = await send('fork', [], { previous_response_id: parent });
    assertEquals((oldParent.at(-1)!.error as Record<string, unknown>).code, 'previous_response_not_found');
    assertEquals(bodies.length, 2, 'advancing the source lane must evict its previous local snapshot');

    const failed = await send('source', [], { previous_response_id: continued, client_metadata: { fail: 'true' } });
    assertEquals((failed.at(-1)!.error as Record<string, unknown>).code, 'test_rejected');
    const evicted = await send('source', [], { previous_response_id: continued });
    assertEquals((evicted.at(-1)!.error as Record<string, unknown>).code, 'previous_response_not_found');
    assertEquals(bodies.length, 3);
    socket.close();
  });
});

test('OpenAI Responses WebSocket closing aborts every active lane and discards queued turns', async () => {
  const started = [deferred(), deferred()];
  const aborted = [deferred(), deferred()];
  let requests = 0;
  await withCodexWebSocketUpstream(async request => {
    const index = requests++;
    started[index].resolve();
    return await new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener('abort', () => {
        aborted[index].resolve();
        reject(request.signal.reason);
      }, { once: true });
    });
  }, async ({ apiKey }) => {
    const { client, sessionLifetime } = await connectOpenAIResponsesWebSocketCapturingSessionLifetime(apiKey.key);
    let fail!: (error: Error) => void;
    const failure = new Promise<never>((_resolve, reject) => { fail = reject; });
    const onMessage = (event: Event) => {
      const message = JSON.parse((event as MessageEvent<string>).data) as Record<string, unknown>;
      if (message.type === 'error') fail(new Error(JSON.stringify(message)));
    };
    client.addEventListener('message', onMessage);
    for (const streamId of ['a', 'b', 'a', 'b']) client.send(JSON.stringify({ type: 'response.create', stream_id: streamId, model: 'gpt-6-astra', input: [] }));
    try {
      await Promise.race([Promise.all(started.map(gate => gate.promise)), failure]);
      client.close();
      await Promise.all(aborted.map(gate => gate.promise));
      await sessionLifetime;
      assertEquals(requests, 2);
    } finally {
      client.removeEventListener('message', onMessage);
      client.close();
    }
  });
});

test('OpenAI Responses WebSocket keeps concurrent lane authentication policies isolated', async () => {
  const requests: string[] = [];
  await withCodexWebSocketUpstream(async request => {
    const body = JSON.parse(await request.text()) as { client_metadata: { lane_test_turn: string } };
    requests.push(body.client_metadata.lane_test_turn);
    return emptyCodexResponse();
  }, async ({ apiKey, repo }) => {
    const socket = await connectOpenAIResponsesWebSocket(apiKey.key);
    const user = await repo.users.getById(apiKey.userId);
    assertExists(user);
    const reads = [deferred(), deferred()];
    const release = deferred();
    let usersRead = 0;
    const keys = vi.spyOn(repo.apiKeys, 'findByRawKey')
      .mockResolvedValueOnce({ ...apiKey, upstreamIds: null })
      .mockResolvedValueOnce({ ...apiKey, upstreamIds: [] });
    const users = vi.spyOn(repo.users, 'getById').mockImplementation(async () => {
      reads[usersRead++].resolve();
      await release.promise;
      return user;
    });
    try {
      const finished = waitForMessages(socket, messages => messages.filter(event => isTerminalResponseEvent(event) || event.type === 'error').length === 2);
      for (const streamId of ['allowed', 'denied']) socket.send(JSON.stringify({ type: 'response.create', stream_id: streamId, model: 'gpt-6-astra', input: [], client_metadata: { lane_test_turn: streamId } }));
      await Promise.race([Promise.all(reads.map(read => read.promise)), finished]);
      release.resolve();
      const events = await finished;
      assertEquals(events.find(event => event.stream_id === 'allowed' && isTerminalResponseEvent(event))?.type, 'response.completed');
      assertEquals(events.find(event => event.stream_id === 'denied' && event.type === 'error')?.status, 404);
      assertEquals(requests, ['allowed']);
    } finally {
      release.resolve();
      keys.mockRestore();
      users.mockRestore();
      socket.close();
    }
  });
});

test('OpenAI Responses WebSocket preserves binary then text frame order in the same lane', async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const inputs: string[] = [];
  await withCodexWebSocketUpstream(async request => {
    const body = JSON.parse(await request.text()) as { input: unknown };
    inputs.push(JSON.stringify(body.input));
    if (inputs.length === 1) {
      firstStarted.resolve();
      await releaseFirst.promise;
    }
    return emptyCodexResponse();
  }, async ({ apiKey, repo }) => {
    await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
    const dumps = installDumpStubs(initDumpStore, initDumpBroker);
    const socket = await connectOpenAIResponsesWebSocket(apiKey.key);
    try {
      const finished = waitForMessages(socket, messages => messages.filter(isTerminalResponseEvent).length === 2 || messages.some(event => event.type === 'error'));
      const binary = new TextEncoder().encode('{\n "type": "response.create", "stream_id": "binary_lane", "model": "gpt-6-astra", "input": "第一轮 🌏"\n}');
      activeRuntime().pairs.at(-1)!.server.dispatchEvent(new MessageEvent('message', { data: binary }));
      socket.send(JSON.stringify({ type: 'response.create', stream_id: 'binary_lane', model: 'gpt-6-astra', input: 'second turn' }));
      await Promise.race([firstStarted.promise, finished]);
      assertEquals(inputs.length, 1);
      assertStringIncludes(inputs[0], '第一轮 🌏');
      releaseFirst.resolve();
      const events = await finished;
      assertEquals(events.find(event => event.type === 'error'), undefined);
      assertEquals(inputs.length, 2);
      assertStringIncludes(inputs[1], 'second turn');
      assert(events.every(event => event.stream_id === 'binary_lane'));
      await vi.waitFor(() => assertEquals(dumps.stored.length, 2));
      assertEquals(dumps.stored[0].record.request.body, binary);
    } finally {
      releaseFirst.resolve();
      socket.close();
    }
  });
});

test('Codex WebSocket preserves Astra Lite continuation and switches to standard per turn', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.save(buildCodexUpstreamRecord());
  const upstreamBodies: Record<string, unknown>[] = [];
  const upstreamLiteHeaders: Array<string | null> = [];
  const prefix = [
    { type: 'additional_tools', id: 'at_codex_thread', role: 'developer', tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' }, async: true }] },
    { type: 'message', id: 'msg_codex_instructions', role: 'developer', content: [{ type: 'input_text', text: 'Be concise.' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Look this up.' }] },
  ];
  const toolCall = { type: 'function_call', id: 'fc_async', call_id: 'call_async', name: 'lookup', arguments: '{}', status: 'completed' };
  const continuation = [
    { type: 'configuration_update', reasoning: { effort: 'xhigh' } },
    { type: 'function_call_output', call_id: 'call_async', output: 'Lookup complete.' },
  ];
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') return jsonResponse(copilotModels([]));
      if (url.pathname === '/backend-api/codex/models') {
        return jsonResponse({ models: codexModels([{ slug: 'gpt-6-astra' }, { slug: 'gpt-5.4' }]).models.map(model => ({ ...model, use_responses_lite: model.slug === 'gpt-6-astra' })) });
      }
      if (url.pathname === '/backend-api/codex/responses') {
        upstreamBodies.push(JSON.parse(await request.text()) as Record<string, unknown>);
        upstreamLiteHeaders.push(request.headers.get(OPENAI_RESPONSES_LITE_HEADER));
        const turn = upstreamBodies.length;
        return sseOpenAIResponsesResponse({
          id: `resp_lite_ws_${turn}`, object: 'response', model: turn < 3 ? 'gpt-6-astra' : 'gpt-5.4', status: 'completed',
          output: turn === 1 ? [toolCall] : [],
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => await withWorkerWebSocketRuntime(async () => {
      const socket = await connectOpenAIResponsesWebSocket(apiKey.key);
      const liteMetadata = { [OPENAI_RESPONSES_LITE_WS_METADATA_KEY]: 'true', thread_id: 'codex-thread' };
      const firstTerminal = waitForMessages(socket, messages => messages.some(isTerminalResponseEvent));
      socket.send(JSON.stringify({ type: 'response.create', model: 'gpt-6-astra', store: false, input: prefix, client_metadata: liteMetadata }));
      const firstId = terminalResponseId(await firstTerminal);

      const secondTerminal = waitForMessages(socket, messages => messages.some(isTerminalResponseEvent));
      socket.send(JSON.stringify({ type: 'response.create', model: 'gpt-6-astra', store: false, previous_response_id: firstId, input: continuation, client_metadata: liteMetadata }));
      await secondTerminal;

      const thirdTerminal = waitForMessages(socket, messages => messages.some(isTerminalResponseEvent));
      socket.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.4', store: false, instructions: 'Standard instructions.', tools: [], input: 'New standard turn.', client_metadata: { thread_id: 'codex-thread' } }));
      await thirdTerminal;

      assertEquals(upstreamLiteHeaders, ['true', 'true', null]);
      assertEquals(upstreamBodies[0].input, prefix);
      assertEquals(upstreamBodies[1].input, [...prefix, toolCall, ...continuation]);
      assertEquals(upstreamBodies[1].previous_response_id, undefined);
      assertEquals(upstreamBodies[2].instructions, 'Standard instructions.');
      assertEquals(upstreamBodies[2].tools, []);
      for (const body of upstreamBodies) {
        assertEquals((body.client_metadata as Record<string, unknown>)[OPENAI_RESPONSES_LITE_WS_METADATA_KEY], undefined);
      }

      const invalidMarker = waitForMessages(socket, messages => messages.some(message => message.type === 'error'));
      socket.send(JSON.stringify({ type: 'response.create', model: 'gpt-6-astra', input: [], client_metadata: { [OPENAI_RESPONSES_LITE_WS_METADATA_KEY]: 'invalid' } }));
      const error = (await invalidMarker).find(message => message.type === 'error');
      assertEquals(error?.status, 400);
      assertEquals((error?.error as Record<string, unknown>).code, 'invalid_value');
      assertEquals(upstreamBodies.length, 3);
      socket.close();
    }),
  );
});

test.each([undefined, 'prewarm_lane'].flatMap(streamId => [false, true].map(empty => ({ streamId, empty }))))('Codex Lite WebSocket prewarms without inference and continues its snapshot with empty=$empty stream_id=$streamId', async ({ empty, streamId }) => {
  const { apiKey, repo, copilotUpstream } = await setupAppTest();
  await repo.upstreams.save({ ...copilotUpstream, enabled: false });
  await repo.upstreams.save(buildCodexUpstreamRecord());
  const requests: Record<string, unknown>[] = [];
  const prefix = empty ? [] : [
    { type: 'additional_tools', id: 'at_prewarm', role: 'developer', tools: [] },
    { type: 'message', id: 'msg_prewarm', role: 'developer', content: 'Keep the warmed prefix.' },
  ];
  const followup = { type: 'message', role: 'user', content: 'Now answer.' };
  await withMockedFetch(async request => {
    const { pathname } = new URL(request.url);
    if (pathname === '/backend-api/codex/models') {
      return jsonResponse({ models: codexModels([{ slug: 'gpt-6-astra' }]).models.map(model => ({ ...model, use_responses_lite: true })) });
    }
    if (pathname !== '/backend-api/codex/responses') throw new Error(`Unhandled fetch ${request.url}`);
    assertEquals(request.headers.get(OPENAI_RESPONSES_LITE_HEADER), 'true');
    const body = JSON.parse(await request.text()) as Record<string, unknown>;
    requests.push(body);
    return sseOpenAIResponsesResponse({
      id: `resp_prewarm_${requests.length}`, object: 'response', model: 'gpt-6-astra', status: 'completed',
      output: [{ type: 'message', id: 'msg_answer', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Answer.', annotations: [] }] }],
    });
  }, async () => await withWorkerWebSocketRuntime(async () => {
    const socket = await connectOpenAIResponsesWebSocket(apiKey.key);
    const clientMetadata = { [OPENAI_RESPONSES_LITE_WS_METADATA_KEY]: 'true' };
    const warmed = waitForMessages(socket, messages => messages.some(isTerminalResponseEvent));
    socket.send(JSON.stringify({ type: 'response.create', stream_id: streamId, model: 'gpt-6-astra', input: prefix, generate: false, store: false, client_metadata: clientMetadata }));
    const warmEvents = await warmed;
    const warmId = terminalResponseId(warmEvents);
    assert(warmEvents.every(event => event.stream_id === streamId));
    assertEquals(requests.length, 0);
    assertEquals(warmEvents.filter(event => event.type === 'response.output_text.delta').length, 0);
    assertEquals(warmEvents.at(-1)?.type, 'response.completed');
    assertEquals((warmEvents.at(-1)?.response as Record<string, unknown>).output, []);
    await flushAsyncWork();
    assertEquals(await repo.usage.listAll(), []);
    assertEquals(await repo.performance.listAll(), []);
    assertEquals(await repo.openaiResponsesSnapshots.lookup(apiKey.id, warmId, 0), null);

    for (const generate of ['false', null, 0]) {
      const rejected = waitForMessages(socket, messages => messages.some(event => event.type === 'error'));
      socket.send(JSON.stringify({ type: 'response.create', model: 'gpt-6-astra', input: [], generate }));
      const error = (await rejected).find(event => event.type === 'error');
      assertEquals(error?.status, 400);
      assertEquals((error?.error as Record<string, unknown>).param, 'generate');
    }
    const missing = waitForMessages(socket, messages => messages.some(event => event.type === 'error'));
    socket.send(JSON.stringify({ type: 'response.create', model: 'gpt-6-astra', input: [], previous_response_id: 'resp_missing_prewarm', generate: false }));
    const missingError = (await missing).find(event => event.type === 'error');
    assertEquals(missingError?.status, 400);
    assertEquals((missingError?.error as Record<string, unknown>).code, 'previous_response_not_found');
    assertEquals(requests.length, 0);

    const answered = waitForMessages(socket, messages => messages.some(isTerminalResponseEvent));
    socket.send(JSON.stringify({ type: 'response.create', stream_id: streamId, model: 'gpt-6-astra', input: [followup], previous_response_id: warmId, generate: true, store: false, client_metadata: clientMetadata }));
    const answerEvents = await answered;
    assert(answerEvents.every(event => event.stream_id === streamId));
    assertEquals(answerEvents.at(-1)?.type, 'response.completed');
    assertEquals(requests.length, 1);
    assertEquals(requests[0].generate, undefined);
    assertEquals(requests[0].stream_id, undefined);
    assertEquals(requests[0].input, [...prefix, followup]);
    assertEquals(requests[0].previous_response_id, undefined);
    socket.close();
  }));
});

test('OpenAI Responses WebSocket forwards stream events, echoes event_id, and ends the turn on the terminal event', async () => {
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
        return sseOpenAIResponsesResponse({
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
      const client = await connectOpenAIResponsesWebSocket(apiKey.key);
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

test('OpenAI Responses WebSocket starts capturing on the next turn when dump retention is enabled after upgrade', async () => {
  const { apiKey, repo } = await setupAppTest();
  const dumps = installDumpStubs(initDumpStore, initDumpBroker);

  await withSuccessfulOpenAIResponsesUpstream(
    async () => await withWorkerWebSocketRuntime(async () => {
      const client = await connectOpenAIResponsesWebSocket(apiKey.key);
      await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });

      await completeOpenAIResponsesTurn(client, 'capture-after-enable');
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

test('OpenAI Responses WebSocket stops capturing on the next turn when dump retention is disabled after upgrade', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const dumps = installDumpStubs(initDumpStore, initDumpBroker);

  await withSuccessfulOpenAIResponsesUpstream(
    async () => await withWorkerWebSocketRuntime(async () => {
      const client = await connectOpenAIResponsesWebSocket(apiKey.key);
      await completeOpenAIResponsesTurn(client, 'captured-before-disable');
      await vi.waitFor(() => assertEquals(dumps.stored.length, 1));

      await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: null });
      await completeOpenAIResponsesTurn(client, 'not-captured-after-disable');

      assertEquals(dumps.stored.length, 1);
      client.close();
    }),
  );
});

test('OpenAI Responses WebSocket dump responseBytes equals the UTF-8 payload bytes sent downstream', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const dumps = installDumpStubs(initDumpStore, initDumpBroker);

  await withSuccessfulOpenAIResponsesUpstream(
    async () => await withWorkerWebSocketRuntime(async () => {
      const client = await connectOpenAIResponsesWebSocket(apiKey.key);
      const recorded = recordRawMessages(client);
      try {
        await completeOpenAIResponsesTurn(client, '响应-byte-count', 'bytes_lane');
        await vi.waitFor(() => assertEquals(dumps.stored.length, 1));

        const expectedBytes = recorded.messages.reduce(
          (total, message) => total + new TextEncoder().encode(message).byteLength,
          0,
        );
        const utf16CodeUnits = recorded.messages.reduce((total, message) => total + message.length, 0);
        assert(expectedBytes > utf16CodeUnits, 'non-ASCII event_id must be counted as UTF-8 bytes');
        assert(recorded.messages.every(message => (JSON.parse(message) as Record<string, unknown>).stream_id === 'bytes_lane'));
        assertEquals(dumps.stored[0]?.record.meta.responseBytes, expectedBytes);
      } finally {
        recorded.stop();
        client.close();
      }
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
  const persistence = vi.spyOn(repo.openaiResponsesItems, 'insertMany').mockRejectedValue(new Error('simulated item persistence failure'));
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
            output_text: 'done',
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
        assertEquals(error.error?.message, 'simulated item persistence failure');
        assert(!messages.some(message => message.type === 'response.output_item.done'));
        assert(!messages.some(isTerminalResponseEvent));
      }),
    );
  } finally {
    persistence.mockRestore();
  }
});

test('OpenAI Responses WebSocket keep-alive waits for the first event and takes a slot in the stream sequence', async () => {
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

test('OpenAI Responses WebSocket returns OpenAI-style error envelopes for unsupported client events', async () => {
  const { apiKey } = await setupAppTest();
  await withWorkerWebSocketRuntime(async () => {
    const client = await connectOpenAIResponsesWebSocket(apiKey.key);
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

test('OpenAI Responses WebSocket returns invalid_request_error for malformed client messages', async () => {
  const { apiKey } = await setupAppTest();
  await withWorkerWebSocketRuntime(async () => {
    const client = await connectOpenAIResponsesWebSocket(apiKey.key);
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
      message: 'OpenAI Responses input must be a string or an array.',
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
        message: 'Untyped OpenAI Responses input items require a valid role and content.',
        param: 'input[0]',
      },
    }]);
  });
});

test('OpenAI Responses WebSocket forwards HTTP failures with status, error.code, and event_id', async () => {
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
      const client = await connectOpenAIResponsesWebSocket(apiKey.key);
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

test('OpenAI Responses WebSocket dump responseBytes counts an error envelope sent downstream', async () => {
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
      const client = await connectOpenAIResponsesWebSocket(apiKey.key);
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
          message: `Previous response with id '${firstResponseId}' not found.`,
          type: 'invalid_request_error',
          param: 'previous_response_id',
          code: 'previous_response_not_found',
        },
      }]);
    }),
  );
});

test('OpenAI Responses WebSocket evicts a failed continuation target so the next attempt reports previous_response_not_found', async () => {
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
          return new Response(JSON.stringify({
            error: { message: 'simulated upstream rejection', type: 'invalid_request_error', code: 'bad_request' },
          }), {
            status: 400,
            headers: { 'content-type': 'Application/Problem+JSON; charset=utf-8' },
          });
        }
        return sseOpenAIResponsesResponse({
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
      const client = await connectOpenAIResponsesWebSocket(apiKey.key);
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
test('OpenAI Responses WebSocket evicts a continuation that failed through a streamed terminal event', async () => {
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
        return sseOpenAIResponsesResponse({
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

test('OpenAI Responses WebSocket store:true durable snapshots can chain through local session cache', async () => {
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
        return sseOpenAIResponsesResponse({
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
      const client = await connectOpenAIResponsesWebSocket(apiKey.key);
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

  const firstSnapshot = await repo.openaiResponsesSnapshots.lookup(apiKey.id, firstResponseId!, 0);
  const secondSnapshot = await repo.openaiResponsesSnapshots.lookup(apiKey.id, secondResponseId!, 0);
  assertExists(firstSnapshot);
  assertExists(secondSnapshot);
  assertEquals(secondSnapshot.itemIds.length > firstSnapshot.itemIds.length, true);
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
        return sseOpenAIResponsesResponse({
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
        await waitForMicrotasks();
      }
    }),
  );
});

// Exercises the session-level item cache directly: createOpenAIResponsesWsSession
// builds a per-session MemoryOpenAIResponsesStatefulBacking that mirrors every
// durable write. Wiping the D1-backed repo between turns proves the second
// message resolves the prior snapshot purely from in-RAM session cache.
// A fresh WS session after the repo wipe MUST NOT see it (the cache is
// per-session, not per-api-key).
test('OpenAI Responses WebSocket session-level store: second message resolves prior items via session cache', async () => {
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
      const sessionA = await connectOpenAIResponsesWebSocket(apiKey.key);
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
      assertExists(await repo.openaiResponsesSnapshots.lookup(apiKey.id, firstResponseId, 0));
      await repo.openaiResponsesSnapshots.deleteAll();
      await repo.openaiResponsesItems.deleteAll();
      assertEquals(await repo.openaiResponsesSnapshots.lookup(apiKey.id, firstResponseId, 0), null);

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

      const restored = await repo.openaiResponsesSnapshots.lookup(apiKey.id, firstResponseId, 0);
      assertExists(restored);
      assertEquals((await repo.openaiResponsesItems.lookupMany(apiKey.id, restored.itemIds, 0)).length, restored.itemIds.length);
      await repo.openaiResponsesSnapshots.deleteAll();
      await repo.openaiResponsesItems.deleteAll();

      // A fresh WS session for the same api key has its own empty cache; with
      // the repo wiped, the snapshot is unreachable.
      const sessionB = await connectOpenAIResponsesWebSocket(apiKey.key);
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

test('OpenAI Responses WebSocket aborts the in-flight OpenAI Responses request when the client closes', async () => {
  const { apiKey } = await setupAppTest();
  let resolveOpenAIResponsesStarted: (() => void) | undefined;
  const openaiResponsesStarted = new Promise<void>(resolve => {
    resolveOpenAIResponsesStarted = resolve;
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
        resolveOpenAIResponsesStarted?.();
        return await new Promise<Response>(resolve => {
          request.signal.addEventListener('abort', () => {
            resolveUpstreamAborted?.();
            resolve(sseOpenAIResponsesResponse({
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
      const client = await connectOpenAIResponsesWebSocket(apiKey.key);
      client.send(JSON.stringify({
        type: 'response.create',
        response: {
          model: 'gpt-direct-responses',
          input: 'hello',
        },
      }));

      await openaiResponsesStarted;
      client.close();
      await upstreamAborted;
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
                output_text: '',
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

// The four chat HTTP transports render a mid-attempt throw (interceptor
// bug, translation error, provider-layer JS exception not represented as a ChatServeFailure) through an
// `internalErrorResult(..., ctx.attempt.telemetry)` envelope,
// which internally reaches `recordFailedRequest` and lands an error row
// attributed to the throwing candidate. The WS transport's outer catch
// must do the same: alongside its sendError / dump.failed / dump.finalize,
// it calls `recordFailedRequest(ctx, ctx.attempt.telemetry)` so
// the failure shows up in performance_summary.
test('OpenAI Responses WebSocket outer catch records a failed perf sample attributed to the throwing candidate', async () => {
  const { apiKey, repo } = await setupAppTest();

  // Mirror what openaiResponsesServe.generate would have stamped before failing
  // — telemetry set for the throwing candidate — then throw.
  const generateSpy = vi.spyOn(openaiResponsesServe, 'generate').mockImplementation(async ({ ctx }) => {
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
        const client = await connectOpenAIResponsesWebSocket(apiKey.key);
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

test('OpenAI Responses WebSocket dispatches each Codex turn with the metadata blob that turn carried', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.save(buildCodexUpstreamRecord());
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
      if (url.pathname === '/backend-api/codex/models') return jsonResponse(codexModels([{ slug: 'gpt-5.4' }]));
      if (url.pathname === '/backend-api/codex/responses') {
        upstreamBodies.push(JSON.parse(await request.text()) as Record<string, unknown>);
        const turn = upstreamBodies.length;
        return sseOpenAIResponsesResponse({
          id: `resp_codex_ws_${turn}`,
          object: 'response',
          model: 'gpt-5.4',
          status: 'completed',
          output_text: `answer ${turn}`,
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
});
