import type { ExecutionContext } from 'hono';
import { expect, it } from 'vitest';

import { app as gatewayApp } from '../../../src/app.ts';
import { copilotModels, setupAppTest, sseResponsesResponse } from '../../test-utils/app.ts';
import { installWorkerWebSocketRuntime, type TestWorkerWebSocket } from '../../test-utils/worker-websocket.ts';
import { jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

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

const withWorkerWebSocketRuntime = async <T>(run: (runtime: ReturnType<typeof installWorkerWebSocketRuntime>) => Promise<T>): Promise<T> => {
  const runtime = installWorkerWebSocketRuntime();
  try {
    return await run(runtime);
  } finally {
    runtime.restore();
  }
};

const connectCodexResponsesWebSocket = async (
  runtime: ReturnType<typeof installWorkerWebSocketRuntime>,
  apiKey: string,
): Promise<TestWorkerWebSocket> => {
  const executionCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  } satisfies ExecutionContext;
  const response = await gatewayApp.fetch(new Request('https://example.test/azure-api.codex/responses', {
    method: 'GET',
    headers: {
      upgrade: 'websocket',
      authorization: `Bearer ${apiKey}`,
    },
  }), {}, executionCtx);
  expect(response.status).toBe(101);
  const pair = runtime.pairs.at(-1);
  expect(pair).toBeDefined();
  return pair!.client;
};

const isTerminalResponseEvent = (message: Record<string, unknown>): boolean =>
  message.type === 'response.completed' || message.type === 'response.failed' || message.type === 'response.incomplete';

const terminalResponseId = (messages: readonly Record<string, unknown>[]): string => {
  const terminal = messages.find(isTerminalResponseEvent) as { response?: { id?: unknown } } | undefined;
  expect(terminal?.response?.id).toEqual(expect.any(String));
  return terminal!.response!.id as string;
};

it('chains previous_response_id on the Codex Responses WebSocket', async () => {
  const { apiKey } = await setupAppTest();
  const upstreamBodies: unknown[] = [];
  let turn = 0;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'test-copilot-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-direct-responses', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        upstreamBodies.push(JSON.parse(await request.text()));
        turn += 1;
        return sseResponsesResponse({
          id: `resp_codex_ws_${turn}`,
          object: 'response',
          model: 'gpt-direct-responses',
          status: 'completed',
          output_text: `codex ws answer ${turn}`,
          output: [{
            id: `assistant_codex_ws_${turn}`,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: `codex ws answer ${turn}`, annotations: [] }],
          }],
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => await withWorkerWebSocketRuntime(async runtime => {
      const client = await connectCodexResponsesWebSocket(runtime, apiKey.key);
      const firstTerminal = waitForMessages(client, messages => messages.some(isTerminalResponseEvent));
      client.send(JSON.stringify({
        type: 'response.create',
        response: { model: 'gpt-direct-responses', input: 'codex first', store: false },
      }));
      const firstResponseId = terminalResponseId(await firstTerminal);
      expect(firstResponseId).not.toBe('resp_codex_ws_1');

      const secondTerminal = waitForMessages(client, messages => messages.some(isTerminalResponseEvent));
      client.send(JSON.stringify({
        type: 'response.create',
        response: {
          model: 'gpt-direct-responses',
          previous_response_id: firstResponseId,
          input: 'codex second',
          store: false,
        },
      }));
      const secondResponseId = terminalResponseId(await secondTerminal);
      expect(secondResponseId).not.toBe('resp_codex_ws_2');
      expect(secondResponseId).not.toBe(firstResponseId);
    }),
  );

  const secondBody = upstreamBodies[1] as { previous_response_id?: unknown; input: Array<{ type: string; role?: string; content?: unknown }> };
  expect(secondBody.previous_response_id).toBeUndefined();
  expect(secondBody.input.map(item => [item.type, item.role, item.content])).toEqual([
    ['message', 'user', 'codex first'],
    ['message', 'assistant', [{ type: 'output_text', text: 'codex ws answer 1', annotations: [] }]],
    ['message', 'user', 'codex second'],
  ]);
});
