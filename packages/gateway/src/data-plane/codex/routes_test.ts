import type { ExecutionContext } from 'hono';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { mountCodexRoutes } from './routes.ts';
import { app as gatewayApp } from '../../app.ts';
import { type AuthVars, authMiddleware } from '../../middleware/auth.ts';
import { copilotModels, setupAppTest, sseResponsesResponse } from '../../test-helpers.ts';
import { isStoredResponseId } from '../chat/responses/items/format.ts';
import { jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

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

const responseDoneId = (messages: readonly Record<string, unknown>[]): string => {
  const done = messages.find(message => message.type === 'response.done') as { response?: { id?: unknown } } | undefined;
  expect(done?.response?.id).toEqual(expect.any(String));
  return done!.response!.id as string;
};

const buildCodexApp = () => {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use('*', authMiddleware);
  mountCodexRoutes(app);
  return app;
};

// Copilot models-list responder seeded with whatever slugs/limits the test
// wants the registry to advertise. Other Copilot endpoints (token mint,
// editor version) are answered with the canned shapes that every
// withMockedFetch caller expects.
const copilotFetch = (models: Array<{ id: string; maxContextWindowTokens?: number; supported_endpoints?: string[] }>) =>
  (request: Request): Response => {
    const url = new URL(request.url);
    if (url.hostname === 'update.code.visualstudio.com') {
      return jsonResponse(['1.110.1']);
    }
    if (url.pathname === '/copilot_internal/v2/token') {
      return jsonResponse({ token: 'test-copilot-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
    }
    if (url.hostname === 'api.individual.githubcopilot.com' && url.pathname === '/models') {
      return jsonResponse(copilotModels(models));
    }
    throw new Error(`Unhandled fetch ${request.url}`);
  };

interface CodexModelsResponse {
  models: Array<{
    slug: string;
    context_window?: number;
    max_context_window?: number;
    auto_compact_token_limit?: number | null;
  }>;
}

describe('codex 1p namespace', () => {
  describe('auth', () => {
    it('accepts a Floway api key supplied as `Authorization: Bearer <key>`', async () => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();

      const response = await app.request('/azure-api.codex/wham/agent-identities/jwks', {
        headers: { authorization: `Bearer ${apiKey.key}` },
      });
      expect(response.status).toBe(200);
    });

    it('rejects an unknown bearer with 401', async () => {
      await setupAppTest();
      const app = buildCodexApp();

      const response = await app.request('/azure-api.codex/wham/agent-identities/jwks', {
        headers: { authorization: 'Bearer not-a-floway-key' },
      });
      expect(response.status).toBe(401);
    });

    it('rejects requests with no auth header', async () => {
      await setupAppTest();
      const app = buildCodexApp();

      const response = await app.request('/azure-api.codex/wham/agent-identities/jwks');
      expect(response.status).toBe(401);
    });
  });

  describe('chatgpt-backend stubs', () => {
    it('serves an empty JWKS so AgentIdentity deployments can opt in later', async () => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const response = await app.request('/azure-api.codex/wham/agent-identities/jwks', {
        headers: { authorization: `Bearer ${apiKey.key}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ keys: [] });
    });

    it('accepts analytics events and returns 200 so turn metadata is captured locally', async () => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const response = await app.request('/azure-api.codex/codex/analytics-events/events', {
        method: 'POST',
        body: JSON.stringify({ events: [] }),
        headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
      });
      expect(response.status).toBe(200);
    });

    it.each([
      '/azure-api.codex/plugins/featured',
      '/azure-api.codex/plugins/list',
    ])('serves an empty plugin list at %s', async path => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const response = await app.request(path, {
        headers: { authorization: `Bearer ${apiKey.key}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
    });

    it.each([
      '/azure-api.codex/ps/plugins/list',
      '/azure-api.codex/ps/plugins/installed',
    ])('serves an empty paginated plugin page at %s', async path => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const response = await app.request(path, {
        headers: { authorization: `Bearer ${apiKey.key}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ plugins: [], pagination: { next_page_token: null } });
    });
  });

  describe('responses WebSocket mount', () => {
    it('returns 426 on GET /responses without an upgrade header so the mount delegates to the generic WS handler', async () => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const response = await app.request('/azure-api.codex/responses', {
        headers: { authorization: `Bearer ${apiKey.key}` },
      });
      expect(response.status).toBe(426);
      expect(await response.json()).toEqual({ error: 'Expected Upgrade: websocket' });
    });

    it('chains previous_response_id on /azure-api.codex/responses WebSocket using response.done id', async () => {
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
                content: [{ type: 'output_text', text: `codex ws answer ${turn}` }],
              }],
            });
          }
          throw new Error(`Unhandled fetch ${request.url}`);
        },
        async () => await withWorkerWebSocketRuntime(async runtime => {
          const client = await connectCodexResponsesWebSocket(runtime, apiKey.key);
          const firstDone = waitForMessages(client, messages => messages.some(message => message.type === 'response.done'));
          client.send(JSON.stringify({
            type: 'response.create',
            response: { model: 'gpt-direct-responses', input: 'codex first', store: false },
          }));
          const firstResponseId = responseDoneId(await firstDone);
          expect(isStoredResponseId(firstResponseId)).toBe(true);

          const secondDone = waitForMessages(client, messages => messages.some(message => message.type === 'response.done'));
          client.send(JSON.stringify({
            type: 'response.create',
            response: {
              model: 'gpt-direct-responses',
              previous_response_id: firstResponseId,
              input: 'codex second',
              store: false,
            },
          }));
          const secondResponseId = responseDoneId(await secondDone);
          expect(isStoredResponseId(secondResponseId)).toBe(true);
        }),
      );

      const secondBody = upstreamBodies[1] as { previous_response_id?: unknown; input: Array<{ type: string; role?: string; content?: unknown }> };
      expect(secondBody.previous_response_id).toBeUndefined();
      expect(secondBody.input.map(item => [item.type, item.role, item.content])).toEqual([
        ['message', 'user', 'codex first'],
        ['message', 'assistant', [{ type: 'output_text', text: 'codex ws answer 1' }]],
        ['message', 'user', 'codex second'],
      ]);
    });
  });

  describe('apps MCP server', () => {
    it('answers the JSON-RPC `initialize` handshake with zero-tool capabilities', async () => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const response = await app.request('/azure-api.codex/api/codex/apps', {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'test', version: '0' },
          },
        }),
        headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
        },
      });
    });

    it('answers `tools/list` with an empty list', async () => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const response = await app.request('/azure-api.codex/api/codex/apps', {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
        headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 2, result: { tools: [], nextCursor: null } });
    });
  });

  describe('/models', () => {
    it('writes both context_window and max_context_window from the registry value, leaving auto_compact null so codex picks 90% itself', async () => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const body = await withMockedFetch(
        copilotFetch([{ id: 'gpt-5.5', maxContextWindowTokens: 1050000 }]),
        async () => {
          const response = await app.request('/azure-api.codex/models', {
            headers: { authorization: `Bearer ${apiKey.key}` },
          });
          expect(response.status).toBe(200);
          return await response.json() as CodexModelsResponse;
        },
      );
      const gpt55 = body.models.find(m => m.slug === 'gpt-5.5');
      expect(gpt55).toMatchObject({
        context_window: 1050000,
        max_context_window: 1050000,
        auto_compact_token_limit: null,
      });
    });

    it('downgrades the bundled max_context_window when the registry advertises less than the bundled tier', async () => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const body = await withMockedFetch(
        copilotFetch([{ id: 'gpt-5.4', maxContextWindowTokens: 272000 }]),
        async () => {
          const response = await app.request('/azure-api.codex/models', {
            headers: { authorization: `Bearer ${apiKey.key}` },
          });
          expect(response.status).toBe(200);
          return await response.json() as CodexModelsResponse;
        },
      );
      // Bundled rust-v0.136.0 catalog has gpt-5.4 at context_window=272000
      // and max_context_window=1000000. Registry says the gateway can only
      // serve 272000, so both fields collapse to that — codex must not
      // believe a 1M ceiling we cannot honour.
      const gpt54 = body.models.find(m => m.slug === 'gpt-5.4');
      expect(gpt54?.context_window).toBe(272000);
      expect(gpt54?.max_context_window).toBe(272000);
    });

    it('registry-driven output: bundled entries surface only when a registry model resolves to them', async () => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const body = await withMockedFetch(
        copilotFetch([{ id: 'gpt-5.5', maxContextWindowTokens: 1050000 }]),
        async () => {
          const response = await app.request('/azure-api.codex/models', {
            headers: { authorization: `Bearer ${apiKey.key}` },
          });
          expect(response.status).toBe(200);
          return await response.json() as CodexModelsResponse;
        },
      );
      // Pipeline iterates the addressable-listed chat models (gpt-5.5 is the
      // only one the registry advertises here) and matches each against the
      // bundled catalog. The other bundled slugs (gpt-5.4, gpt-5.4-mini,
      // gpt-5.3-codex, gpt-5.2, codex-auto-review) have no registry counterpart
      // and never appear in the output.
      expect(body.models.map(m => m.slug)).toEqual(['gpt-5.5']);
    });

    it('synthesizes a catalog entry for registry chat models with no bundled match', async () => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const body = await withMockedFetch(
        copilotFetch([{ id: 'claude-sonnet-4', supported_endpoints: ['/v1/messages'] }]),
        async () => {
          const response = await app.request('/azure-api.codex/models', {
            headers: { authorization: `Bearer ${apiKey.key}` },
          });
          expect(response.status).toBe(200);
          return await response.json() as CodexModelsResponse;
        },
      );
      // claude-sonnet-4 is not in the bundled codex catalog, so it gets a
      // synthesized entry using the codex-shaped baseline from synthesize.ts.
      expect(body.models).toHaveLength(1);
      expect(body.models[0].slug).toBe('claude-sonnet-4');
    });
  });
});
