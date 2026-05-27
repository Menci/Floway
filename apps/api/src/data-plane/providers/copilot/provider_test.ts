import { test } from 'vitest';

import { messagesCopilotInterceptors, messagesCopilotSourceInterceptors } from './interceptors/messages/index.ts';
import { createCopilotProvider } from './provider.ts';
import { assertEquals, assertRejects } from '../../../test-assert.ts';
import { copilotModels, jsonResponse, setupAppTest, withMockedFetch } from '../../../test-helpers.ts';
import { runInterceptors, type MessagesInvocation, type RequestContext } from '../../llm/interceptors.ts';
import { eventResult, type ExecuteResult } from '../../llm/shared/errors/result.ts';
import { clearModelsStore, ProviderModelsUnavailableError } from '../models-store.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEventData } from '@floway-dev/protocols/messages';

test('Copilot provider exposes the highest-priority non-Claude endpoint', async () => {
  const { copilotUpstream } = await setupAppTest();
  const instance = await createCopilotProvider(copilotUpstream);
  const provider = instance.provider;

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(
          copilotModels([
            {
              id: 'gpt-dual',
              supported_endpoints: ['/responses', '/chat/completions', '/v1/messages'],
            },
          ]),
        );
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const models = await provider.getProvidedModels();

      assertEquals(
        models.map(model => model.id),
        ['gpt-dual'],
      );
      assertEquals(models[0].upstreamEndpoints, ['responses']);
    },
  );
});

test('Copilot provider exposes only Responses for Claude when available', async () => {
  const { copilotUpstream } = await setupAppTest();
  const instance = await createCopilotProvider(copilotUpstream);
  const provider = instance.provider;

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(
          copilotModels([
            {
              id: 'claude-opus-4.7',
              display_name: 'Claude Opus 4.7',
              supported_endpoints: ['/responses', '/chat/completions'],
            },
            {
              id: 'claude-opus-4.7-xhigh',
              supported_endpoints: ['/v1/messages'],
              reasoningEfforts: ['xhigh'],
            },
          ]),
        );
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [model] = await provider.getProvidedModels();

      assertEquals(model.id, 'claude-opus-4-7');
      assertEquals(model.display_name, 'Claude Opus 4.7');
      assertEquals(model.upstreamEndpoints, ['responses']);
    },
  );
});

test('Copilot provider owns the claude-* Messages capability workaround', async () => {
  const { copilotUpstream } = await setupAppTest();
  const instance = await createCopilotProvider(copilotUpstream);
  const provider = instance.provider;
  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(
          copilotModels([
            {
              id: 'claude-haiku-chat-listed',
              supported_endpoints: ['/chat/completions'],
            },
          ]),
        );
      }
      if (url.pathname === '/v1/messages') {
        upstreamBody = (await request.json()) as Record<string, unknown>;
        return jsonResponse({
          id: 'msg_claude_workaround',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: 'claude-haiku-chat-listed',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [model] = await provider.getProvidedModels();

      assertEquals(model.id, 'claude-haiku-chat-listed');
      assertEquals(model.upstreamEndpoints, ['messages', 'messages_count_tokens']);

      await provider.callMessages(model, {
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hello' }],
      });
    },
  );

  assertEquals(upstreamBody?.model, 'claude-haiku-chat-listed');
});

test('Copilot provider selects raw variants that support the target endpoint', async () => {
  const { copilotUpstream } = await setupAppTest();
  const instance = await createCopilotProvider(copilotUpstream);
  const provider = instance.provider;
  let responsesBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(
          copilotModels([
            {
              id: 'claude-opus-4.7',
              supported_endpoints: ['/responses'],
              reasoningEfforts: ['medium'],
            },
            {
              id: 'claude-opus-4.7-xhigh',
              supported_endpoints: ['/v1/messages'],
              reasoningEfforts: ['xhigh'],
            },
          ]),
        );
      }
      if (url.pathname === '/responses') {
        responsesBody = (await request.json()) as Record<string, unknown>;
        return jsonResponse({
          id: 'resp_endpoint_variant',
          object: 'response',
          model: 'claude-opus-4.7',
          output: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [model] = await provider.getProvidedModels();
      await provider.callResponses(model, {
        input: [],
        reasoning: { effort: 'xhigh' },
      });
    },
  );

  assertEquals(responsesBody?.model, 'claude-opus-4.7');
});

test('Copilot provider exposes its default flag set via UpstreamModel.enabledFlags', async () => {
  const { copilotUpstream } = await setupAppTest();
  const instance = await createCopilotProvider({
    ...copilotUpstream,
    flagOverrides: { 'messages-web-search-shim': true },
  });

  assertEquals(instance.upstream, 'up_copilot');
  assertEquals(instance.name, copilotUpstream.name);

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-test', supported_endpoints: ['/chat/completions'] }]));
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const models = await instance.provider.getProvidedModels();
      const model = models[0];
      if (!model) throw new Error('expected at least one Copilot model in test fixture');
      assertEquals(model.enabledFlags.has('retry-cyber-policy'), true);
      assertEquals(model.enabledFlags.has('messages-web-search-shim'), true);
    },
  );
});

test('Copilot provider enables Copilot-owned Messages source interceptors by default', async () => {
  const { copilotUpstream } = await setupAppTest();
  const instance = await createCopilotProvider(copilotUpstream);

  assertEquals(instance.sourceInterceptors?.messages, messagesCopilotSourceInterceptors);
});

test('Copilot provider rejects malformed account type instead of falling back', async () => {
  const { copilotUpstream } = await setupAppTest();

  await assertRejects(
    () =>
      createCopilotProvider({
        ...copilotUpstream,
        config: {
          ...(copilotUpstream.config as Record<string, unknown>),
          accountType: 'toString',
        },
      }),
    Error,
    'accountType must be one of individual, business, enterprise',
  );
});

test('Copilot provider forces stream=true for streaming endpoints and leaves count-tokens/embeddings alone', async () => {
  const { copilotUpstream } = await setupAppTest();
  const instance = await createCopilotProvider(copilotUpstream);
  const provider = instance.provider;
  const bodies: Record<string, Record<string, unknown>> = {};

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(
          copilotModels([
            { id: 'gpt-chat', supported_endpoints: ['/chat/completions'] },
            { id: 'gpt-resp', supported_endpoints: ['/responses'] },
            { id: 'claude-msg', supported_endpoints: ['/v1/messages'] },
            { id: 'emb-mini', supported_endpoints: ['/embeddings'] },
          ]),
        );
      }

      const path = url.pathname;
      bodies[path] = (await request.json()) as Record<string, unknown>;

      if (path === '/chat/completions') {
        return jsonResponse({ id: 'cc', object: 'chat.completion', model: 'gpt-chat', choices: [], usage: {} });
      }
      if (path === '/responses') {
        return jsonResponse({ id: 'r', object: 'response', model: 'gpt-resp', output: [], usage: {} });
      }
      if (path === '/v1/messages') {
        return jsonResponse({ id: 'm', type: 'message', role: 'assistant', content: [], model: 'claude-msg', stop_reason: 'end_turn', stop_sequence: null, usage: {} });
      }
      if (path === '/v1/messages/count_tokens') {
        return jsonResponse({ input_tokens: 1 });
      }
      if (path === '/embeddings') {
        return jsonResponse({ object: 'list', data: [], model: 'emb-mini' });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const models = await provider.getProvidedModels();
      const byId = new Map(models.map(model => [model.id, model]));

      await provider.callChatCompletions(byId.get('gpt-chat')!, { messages: [{ role: 'user', content: 'hi' }] });
      await provider.callResponses(byId.get('gpt-resp')!, { input: [] });
      await provider.callMessages(byId.get('claude-msg')!, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      await provider.callMessagesCountTokens(byId.get('claude-msg')!, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      await provider.callEmbeddings(byId.get('emb-mini')!, { input: 'hi' });
    },
  );

  assertEquals(bodies['/chat/completions'].stream, true);
  assertEquals(bodies['/responses'].stream, true);
  assertEquals(bodies['/v1/messages'].stream, true);
  assertEquals('stream' in bodies['/v1/messages/count_tokens'], false);
  assertEquals('stream' in bodies['/embeddings'], false);
});

test('Copilot provider sets copilot-vision-request when an image is nested inside tool_result.content', async () => {
  const { copilotUpstream } = await setupAppTest();
  const instance = await createCopilotProvider(copilotUpstream);
  const provider = instance.provider;
  const visionHeaders: string[] = [];

  const stubRequest: RequestContext = {
    requestStartedAt: 0,
    runtimeLocation: 'test',
    clientStream: false,
  };

  const testTelemetryModelIdentity = {
    model: 'claude-msg',
    upstream: 'up_copilot',
    modelKey: 'claude-msg',
    cost: null,
  };

  // Drive a Messages payload through the full Copilot target interceptor list
  // and on to the provider's callMessages, then observe the header that
  // actually reached the upstream HTTP request. This exercises the integration
  // contract — the vision-detection interceptor sets `invocation.headers`, the
  // emit passes it to `provider.callMessages`, and the upstream sees it.
  const driveMessages = async (model: typeof instance.provider extends never ? never : Awaited<ReturnType<typeof instance.provider.getProvidedModels>>[number], body: Omit<MessagesPayload, 'model'>): Promise<void> => {
    const invocation: MessagesInvocation = {
      sourceApi: 'messages',
      targetApi: 'messages',
      model: model.id,
      upstream: 'up_copilot',
      upstreamModel: model,
      provider,
      enabledFlags: model.enabledFlags,
      payload: { ...body, model: model.id },
      headers: {},
    };

    await runInterceptors<MessagesInvocation, RequestContext, ExecuteResult<ProtocolFrame<MessagesStreamEventData>>>(
      invocation,
      stubRequest,
      messagesCopilotInterceptors,
      async () => {
        const { model: _model, ...callBody } = invocation.payload;
        await provider.callMessages(invocation.upstreamModel, callBody, undefined, invocation.headers);
        return eventResult((async function* () {})(), testTelemetryModelIdentity);
      },
    );
  };

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-msg', supported_endpoints: ['/v1/messages'] }]));
      }
      if (url.pathname === '/v1/messages') {
        visionHeaders.push(request.headers.get('copilot-vision-request') ?? '');
        await request.text();
        return jsonResponse({
          id: 'm',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-msg',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {},
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [model] = await provider.getProvidedModels();

      // Tool result carrying an image — the only image in the conversation
      // lives nested inside `tool_result.content`, so the vision detector must
      // recurse into tool_result.content to discover it.
      await driveMessages(model, {
        max_tokens: 10,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_image',
                content: [
                  {
                    type: 'image',
                    source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
                  },
                ],
              },
            ],
          },
        ],
      });

      // No image anywhere — header must not be set.
      await driveMessages(model, {
        max_tokens: 10,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_text',
                content: [{ type: 'text', text: 'plain result' }],
              },
            ],
          },
        ],
      });
    },
  );

  assertEquals(visionHeaders, ['true', '']);
});

const withMutableNow = async <T>(initial: number, run: (setNow: (value: number) => void) => Promise<T>): Promise<T> => {
  const originalNow = Date.now;
  let now = initial;
  Date.now = () => now;
  try {
    return await run(value => { now = value; });
  } finally {
    Date.now = originalNow;
  }
};

const copilotPreflight = (request: Request): Response | null => {
  const url = new URL(request.url);
  if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
  if (url.pathname === '/copilot_internal/v2/token') {
    return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600 });
  }
  return null;
};

test('Copilot provider keeps a model in the ledger for 24 h even when the next fetch omits it', async () => {
  const { copilotUpstream } = await setupAppTest();
  clearModelsStore();

  let fetches = 0;
  await withMockedFetch(
    request => {
      const pre = copilotPreflight(request);
      if (pre) return pre;
      const url = new URL(request.url);
      if (url.pathname === '/models') {
        fetches++;
        const data = fetches === 1
          ? [{ id: 'a', supported_endpoints: ['/v1/messages'] }, { id: 'b', supported_endpoints: ['/v1/messages'] }]
          : [{ id: 'a', supported_endpoints: ['/v1/messages'] }];
        return jsonResponse({ object: 'list', data });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const instance = await createCopilotProvider(copilotUpstream);
      await withMutableNow(1_000_000, async setNow => {
        const first = await instance.provider.getProvidedModels();
        assertEquals(first.map(m => m.id).sort(), ['a', 'b']);
        setNow(1_000_000 + 11 * 60_000); // past soft window so we re-fetch
        clearModelsStore();
        const second = await instance.provider.getProvidedModels();
        assertEquals(second.map(m => m.id).sort(), ['a', 'b'], 'b should still appear from the ledger');
      });
    },
  );
  assertEquals(fetches, 2);
});

test('Copilot provider drops a model after 24 h of continuous absence', async () => {
  const { copilotUpstream } = await setupAppTest();
  clearModelsStore();

  let fetches = 0;
  await withMockedFetch(
    request => {
      const pre = copilotPreflight(request);
      if (pre) return pre;
      const url = new URL(request.url);
      if (url.pathname === '/models') {
        fetches++;
        const data = fetches === 1
          ? [{ id: 'a', supported_endpoints: ['/v1/messages'] }, { id: 'b', supported_endpoints: ['/v1/messages'] }]
          : [{ id: 'a', supported_endpoints: ['/v1/messages'] }];
        return jsonResponse({ object: 'list', data });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const instance = await createCopilotProvider(copilotUpstream);
      await withMutableNow(1_000_000, async setNow => {
        await instance.provider.getProvidedModels();
        setNow(1_000_000 + 25 * 60 * 60_000); // 25h after first fetch
        clearModelsStore();
        const after = await instance.provider.getProvidedModels();
        assertEquals(after.map(m => m.id), ['a']);
      });
    },
  );
  assertEquals(fetches, 2);
});

test('Copilot provider returns ledger projection when fetch fails but ledger is non-empty', async () => {
  const { copilotUpstream } = await setupAppTest();
  clearModelsStore();

  let fetches = 0;
  await withMockedFetch(
    request => {
      const pre = copilotPreflight(request);
      if (pre) return pre;
      const url = new URL(request.url);
      if (url.pathname === '/models') {
        fetches++;
        if (fetches === 1) return jsonResponse({ object: 'list', data: [{ id: 'a', supported_endpoints: ['/v1/messages'] }] });
        return new Response('unavailable', { status: 503 });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const instance = await createCopilotProvider(copilotUpstream);
      await withMutableNow(1_000_000, async setNow => {
        await instance.provider.getProvidedModels();
        setNow(1_000_000 + 11 * 60_000);
        clearModelsStore();
        const after = await instance.provider.getProvidedModels();
        assertEquals(after.map(m => m.id), ['a']);
      });
    },
  );
});

test('Copilot provider throws ProviderModelsUnavailableError when ledger is empty and fetch fails', async () => {
  const { copilotUpstream } = await setupAppTest();
  clearModelsStore();

  let thrown: unknown;
  await withMockedFetch(
    request => {
      const pre = copilotPreflight(request);
      if (pre) return pre;
      const url = new URL(request.url);
      if (url.pathname === '/models') return new Response('unavailable', { status: 503 });
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const instance = await createCopilotProvider(copilotUpstream);
      try { await instance.provider.getProvidedModels(); } catch (e) { thrown = e; }
    },
  );
  if (!(thrown instanceof ProviderModelsUnavailableError)) throw new Error('expected ProviderModelsUnavailableError');
  assertEquals(thrown.httpResponse?.status, 503);
});
