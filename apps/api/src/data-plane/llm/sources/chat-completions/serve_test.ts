import { test } from 'vitest';

import { clearCopilotTokenCache } from '../../../../shared/copilot.ts';
import { assertEquals, assertExists, assertStringIncludes } from '../../../../test-assert.ts';
import { buildCustomUpstreamRecord, copilotModels, jsonResponse, parseSSEText, requestApp, setupAppTest, sseChatCompletionsResponse, sseMessagesResponse, sseResponse, withMockedFetch } from '../../../../test-helpers.ts';
import { clearModelsStore } from '../../../providers/models-store.ts';

const getUsageOnlyChatChunks = (events: Array<{ event: string; data: string }>): Array<Record<string, unknown>> =>
  events.flatMap(event => {
    if (event.data === '[DONE]') return [];

    const data = JSON.parse(event.data) as Record<string, unknown>;
    return Array.isArray(data.choices) && data.choices.length === 0 && 'usage' in data ? [data] : [];
  });

const responsesCyberPolicyFailureEvent = (model: string) => ({
  event: 'response.failed',
  data: {
    type: 'response.failed',
    response: {
      id: 'resp_stream_policy_failure',
      object: 'response',
      model,
      status: 'failed',
      output: [],
      output_text: '',
      error: {
        message: 'This request was flagged for cyber policy.',
        type: 'invalid_request_error',
        code: 'cyber_policy',
      },
    },
  },
});

test('/v1/chat/completions malformed JSON returns structured internal debug error', async () => {
  const { apiKey } = await setupAppTest();

  const response = await requestApp('/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey.key,
    },
    body: '{',
  });

  assertEquals(response.status, 502);

  const body = await response.json();
  assertEquals(body.error.type, 'internal_error');
  assertEquals(body.error.name, 'SyntaxError');
  assertEquals(body.error.source_api, 'chat-completions');
  assertExists(body.error.stack);
});

test('/v1/chat/completions does not record performance for an unresolved client model string', async () => {
  const { apiKey, repo } = await setupAppTest();
  let generationFetchCalls = 0;

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
              id: 'gpt-real-model',
              supported_endpoints: ['/chat/completions'],
            },
          ]),
        );
      }
      if (url.pathname === '/chat/completions') {
        generationFetchCalls++;
        return sseChatCompletionsResponse({
          id: 'chatcmpl_unexpected',
          model: 'gpt-real-model',
          choices: [{ message: { role: 'assistant', content: 'unexpected' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-opus-4-7[1m]',
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      assertEquals(response.status, 404);
      assertEquals(generationFetchCalls, 0);
      assertEquals(await repo.performance.listAll(), []);
    },
  );
});

test('/v1/chat/completions streams malformed upstream Chat SSE as an error event', async () => {
  const { apiKey } = await setupAppTest();

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
              id: 'gpt-malformed-chat',
              supported_endpoints: ['/chat/completions'],
            },
          ]),
        );
      }
      if (url.pathname === '/chat/completions') {
        return new Response('data: not json', {
          headers: { 'content-type': 'text/event-stream' },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'gpt-malformed-chat',
          stream: true,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      assertEquals(response.status, 200);

      const events = parseSSEText(await response.text());
      assertEquals(events.length, 1);
      assertEquals(events[0].event, 'error');

      const event = JSON.parse(events[0].data);
      assertEquals(event.error.type, 'internal_error');
      assertStringIncludes(event.error.message, 'Malformed upstream Chat Completions SSE JSON: not json');
      assertExists(event.error.stack);
    },
  );
});

test('/v1/chat/completions rejects upstream Chat SSE error payloads in non-stream responses', async () => {
  const { apiKey } = await setupAppTest();

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
              id: 'gpt-chat-error-payload',
              supported_endpoints: ['/chat/completions'],
            },
          ]),
        );
      }
      if (url.pathname === '/chat/completions') {
        return new Response(
          `data: ${JSON.stringify({
            error: {
              type: 'server_error',
              message: 'upstream chat failed',
            },
          })}`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'gpt-chat-error-payload',
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      assertEquals(response.status, 502);
      const body = await response.json();
      assertEquals(body.error.type, 'internal_error');
      assertStringIncludes(body.error.message, 'Upstream Chat Completions SSE error: server_error: upstream chat failed');
    },
  );
});

test('/v1/chat/completions uses the native chat path on chat-only models', async () => {
  const { apiKey } = await setupAppTest();

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
              id: 'gpt-chat-native',
              supported_endpoints: ['/chat/completions'],
            },
          ]),
        );
      }
      if (url.pathname === '/responses') {
        throw new Error('responses should not be used when native chat/completions is available');
      }
      if (url.pathname === '/chat/completions') {
        upstreamBody = JSON.parse(await request.text()) as Record<string, unknown>;
        return sseChatCompletionsResponse({
          id: 'chatcmpl_dual',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-chat-native',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'gpt-chat-native',
          max_tokens: 256,
          stream: false,
          service_tier: 'auto',
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.choices[0].message.content, 'ok');
    },
  );

  assertExists(upstreamBody);
  const messages = upstreamBody!.messages as Array<Record<string, unknown>>;
  assertEquals(messages[0].role, 'user');
  assertEquals(upstreamBody!.service_tier, 'auto');
});

test("/v1/chat/completions uses Copilot's provider-projected Responses endpoint on dual-endpoint models", async () => {
  const { apiKey } = await setupAppTest();

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
              id: 'gpt-dual-chat',
              supported_endpoints: ['/responses', '/v1/messages', '/chat/completions'],
            },
          ]),
        );
      }
      if (url.pathname === '/chat/completions' || url.pathname === '/v1/messages') {
        throw new Error('Copilot provider should expose only Responses for this model');
      }
      if (url.pathname === '/responses') {
        upstreamBody = JSON.parse(await request.text()) as Record<string, unknown>;
        return sseResponse([
          {
            event: 'response.created',
            data: {
              type: 'response.created',
              response: {
                id: 'resp_dual_projected',
                object: 'response',
                model: 'gpt-dual-chat',
                status: 'in_progress',
                output: [],
                output_text: '',
              },
            },
          },
          {
            event: 'response.output_text.delta',
            data: {
              type: 'response.output_text.delta',
              item_id: 'msg_0',
              output_index: 0,
              content_index: 0,
              delta: 'ok',
            },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: {
                id: 'resp_dual_projected',
                object: 'response',
                model: 'gpt-dual-chat',
                status: 'completed',
                output: [],
                output_text: 'ok',
                usage: {
                  input_tokens: 1,
                  output_tokens: 1,
                  total_tokens: 2,
                },
              },
            },
          },
        ]);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'gpt-dual-chat',
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.choices[0].message.content, 'ok');
    },
  );

  assertEquals(upstreamBody?.model, 'gpt-dual-chat');
  assertEquals(upstreamBody?.stream, true);
});

test('/v1/chat/completions plans per provider without letting a later native provider preempt provider order', async () => {
  const { apiKey, repo } = await setupAppTest();

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_native_chat',
    name: 'Native Chat Provider',
    enabled: true,
    sortOrder: 100,
    createdAt: '2026-05-01T00:00:00.000Z',
    flagOverrides: {},
    config: {
      baseUrl: 'https://chat.example.com',
      bearerToken: 'sk-chat',
      supportedEndpoints: ['/chat/completions'],
    },
  }));

  let upstreamPath = '';
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
      if (url.hostname === 'api.githubcopilot.com' && url.pathname === '/models') {
        return jsonResponse(
          copilotModels([
            {
              id: 'shared-chat-model',
              supported_endpoints: ['/v1/messages'],
            },
          ]),
        );
      }
      if (url.hostname === 'api.githubcopilot.com' && url.pathname === '/v1/messages') {
        upstreamPath = url.pathname;
        upstreamBody = (await request.json()) as Record<string, unknown>;
        return sseResponse([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                id: 'msg_provider_order',
                type: 'message',
                role: 'assistant',
                content: [],
                model: 'shared-chat-model',
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            },
          },
          {
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'messages first' },
            },
          },
          {
            event: 'content_block_stop',
            data: { type: 'content_block_stop', index: 0 },
          },
          {
            event: 'message_delta',
            data: {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 1 },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]);
      }
      if (url.hostname === 'chat.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: [{ id: 'shared-chat-model' }],
        });
      }
      if (url.hostname === 'chat.example.com' && url.pathname === '/v1/chat/completions') {
        upstreamBody = (await request.json()) as Record<string, unknown>;
        return jsonResponse({
          id: 'chatcmpl_shared_native',
          object: 'chat.completion',
          created: 1,
          model: 'shared-chat-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'shared-chat-model',
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.choices[0].message.content, 'messages first');
    },
  );

  assertEquals(upstreamPath, '/v1/messages');
  assertEquals(upstreamBody?.model, 'shared-chat-model');
});

test('/v1/chat/completions strips dated Claude aliases before model routing', async () => {
  const { apiKey } = await setupAppTest();

  let upstreamPath = '';
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
              id: 'claude-haiku-4.5-20251001',
              supported_endpoints: ['/chat/completions'],
            },
            {
              id: 'claude-haiku-4.5',
              supported_endpoints: ['/v1/messages'],
            },
          ]),
        );
      }
      if (url.pathname === '/v1/messages') {
        upstreamPath = url.pathname;
        upstreamBody = JSON.parse(await request.text()) as Record<string, unknown>;
        return sseResponse([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                id: 'msg_dated_alias_wins',
                type: 'message',
                role: 'assistant',
                content: [],
                model: 'claude-haiku-4.5',
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 0 },
              },
            },
          },
          {
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'ok' },
            },
          },
          {
            event: 'content_block_stop',
            data: { type: 'content_block_stop', index: 0 },
          },
          {
            event: 'message_delta',
            data: {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 1 },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]);
      }
      if (url.pathname === '/chat/completions') {
        throw new Error('dated Claude aliases should be stripped before routing');
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-haiku-4.5-20251001',
          max_tokens: 256,
          stream: false,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      assertEquals(response.status, 200);
      assertEquals(upstreamPath, '/v1/messages');
      assertEquals(upstreamBody?.model, 'claude-haiku-4.5');
    },
  );
});

test('/v1/chat/completions sends base model upstream after dated alias fallback', async () => {
  const { apiKey } = await setupAppTest();

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
              id: 'claude-haiku-4.5',
              supported_endpoints: ['/v1/messages'],
            },
          ]),
        );
      }
      if (url.pathname === '/v1/messages') {
        upstreamBody = JSON.parse(await request.text()) as Record<string, unknown>;
        return sseResponse([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                id: 'msg_dated_alias',
                type: 'message',
                role: 'assistant',
                content: [],
                model: 'claude-haiku-4.5',
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 0 },
              },
            },
          },
          {
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'ok' },
            },
          },
          {
            event: 'content_block_stop',
            data: { type: 'content_block_stop', index: 0 },
          },
          {
            event: 'message_delta',
            data: {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 1 },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 256,
          stream: false,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      assertEquals(response.status, 200);
      assertEquals(upstreamBody?.model, 'claude-haiku-4.5');
    },
  );
});

test('/v1/chat/completions resolves base Claude models to effort variants before planning', async () => {
  const { apiKey } = await setupAppTest();

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
              id: 'claude-opus-4.7',
              supported_endpoints: ['/v1/messages'],
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
      if (url.pathname === '/v1/messages') {
        upstreamBody = JSON.parse(await request.text()) as Record<string, unknown>;
        return sseMessagesResponse({
          id: 'msg_effort_variant',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: 'claude-opus-4.7-xhigh',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-opus-4-7',
          max_tokens: 256,
          reasoning_effort: 'xhigh',
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      assertEquals(response.status, 200);
      await response.json();
    },
  );

  assertEquals(upstreamBody?.model, 'claude-opus-4.7-xhigh');
});

test('/v1/chat/completions omits the final usage-only SSE chunk unless the caller requested include_usage', async () => {
  const { apiKey } = await setupAppTest();

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
              id: 'gpt-chat-stream-filter',
              supported_endpoints: ['/chat/completions'],
            },
          ]),
        );
      }
      if (url.pathname === '/chat/completions') {
        return sseResponse([
          {
            data: {
              id: 'chatcmpl_stream_filter',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-chat-stream-filter',
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant' },
                  finish_reason: null,
                },
              ],
            },
          },
          {
            data: {
              id: 'chatcmpl_stream_filter',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-chat-stream-filter',
              choices: [
                {
                  index: 0,
                  delta: { content: 'Hello' },
                  finish_reason: null,
                },
              ],
            },
          },
          {
            data: {
              id: 'chatcmpl_stream_filter',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-chat-stream-filter',
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: 'stop',
                },
              ],
            },
          },
          {
            data: {
              id: 'chatcmpl_stream_filter',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-chat-stream-filter',
              choices: [],
              usage: {
                prompt_tokens: 12,
                completion_tokens: 4,
                total_tokens: 16,
              },
            },
          },
          { data: '[DONE]' },
        ]);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'gpt-chat-stream-filter',
          stream: true,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      assertEquals(response.status, 200);
      const events = parseSSEText(await response.text());
      assertEquals(getUsageOnlyChatChunks(events), []);
    },
  );
});

test('/v1/chat/completions emits requested usage-only SSE chunk on native chat', async () => {
  const { apiKey } = await setupAppTest();

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
              id: 'gpt-chat-stream-usage',
              supported_endpoints: ['/chat/completions'],
            },
          ]),
        );
      }
      if (url.pathname === '/chat/completions') {
        return sseResponse([
          {
            data: {
              id: 'chatcmpl_stream_usage',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-chat-stream-usage',
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant' },
                  finish_reason: null,
                },
              ],
            },
          },
          {
            data: {
              id: 'chatcmpl_stream_usage',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-chat-stream-usage',
              choices: [
                {
                  index: 0,
                  delta: { content: 'Hello' },
                  finish_reason: null,
                },
              ],
            },
          },
          {
            data: {
              id: 'chatcmpl_stream_usage',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-chat-stream-usage',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            },
          },
          {
            data: {
              id: 'chatcmpl_stream_usage',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-chat-stream-usage',
              choices: [],
              usage: {
                prompt_tokens: 12,
                completion_tokens: 4,
                total_tokens: 16,
              },
            },
          },
          { data: '[DONE]' },
        ]);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'gpt-chat-stream-usage',
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      assertEquals(response.status, 200);
      const usageChunks = getUsageOnlyChatChunks(parseSSEText(await response.text()));
      assertEquals(usageChunks.length, 1);
      assertEquals(usageChunks[0].usage, {
        prompt_tokens: 12,
        completion_tokens: 4,
        total_tokens: 16,
      });
    },
  );
});

test('/v1/chat/completions preserves upstream 400 errors on the native chat path', async () => {
  const { apiKey } = await setupAppTest();

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
              id: 'gpt-chat-only',
              supported_endpoints: ['/chat/completions'],
            },
          ]),
        );
      }
      if (url.pathname === '/chat/completions') {
        upstreamBody = JSON.parse(await request.text()) as Record<string, unknown>;
        return jsonResponse({ error: { message: 'upstream bad request' } }, 400);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'gpt-chat-only',
          max_tokens: 256,
          stream: false,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      assertEquals(response.status, 400);
      const body = await response.json();
      assertEquals(body.error.message, 'upstream bad request');
    },
  );

  assertExists(upstreamBody);
  const messages = upstreamBody!.messages as Array<Record<string, unknown>>;
  assertEquals(messages[0].role, 'user');
});

test('/v1/chat/completions translates through messages when the model only supports /v1/messages', async () => {
  const { apiKey } = await setupAppTest();

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
              id: 'claude-chat-source',
              supported_endpoints: ['/v1/messages'],
            },
          ]),
        );
      }
      if (url.pathname === '/v1/messages') {
        upstreamBody = JSON.parse(await request.text()) as Record<string, unknown>;
        return sseResponse([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                id: 'msg_1',
                type: 'message',
                role: 'assistant',
                content: [],
                model: 'claude-chat-source',
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 0 },
              },
            },
          },
          {
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'ok' },
            },
          },
          {
            event: 'content_block_stop',
            data: { type: 'content_block_stop', index: 0 },
          },
          {
            event: 'message_delta',
            data: {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 1 },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-chat-source',
          max_tokens: 256,
          stream: false,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.choices[0].message.content, 'ok');
    },
  );

  assertExists(upstreamBody);
  const messages = upstreamBody!.messages as Array<Record<string, unknown>>;
  assertEquals(messages[0].role, 'user');
});

test('/v1/chat/completions via messages hides forced streaming usage unless requested', async () => {
  const { apiKey } = await setupAppTest();

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
              id: 'claude-chat-source-stream',
              supported_endpoints: ['/v1/messages'],
            },
          ]),
        );
      }
      if (url.pathname === '/v1/messages') {
        return sseResponse([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                id: 'msg_stream_usage',
                type: 'message',
                role: 'assistant',
                content: [],
                model: 'claude-chat-source-stream',
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 0 },
              },
            },
          },
          {
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'ok' },
            },
          },
          {
            event: 'content_block_stop',
            data: { type: 'content_block_stop', index: 0 },
          },
          {
            event: 'message_delta',
            data: {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 1 },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-chat-source-stream',
          max_tokens: 256,
          stream: true,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      assertEquals(response.status, 200);
      const events = parseSSEText(await response.text());
      assertEquals(getUsageOnlyChatChunks(events), []);
    },
  );
});

test('/v1/chat/completions via messages emits requested usage-only SSE chunk', async () => {
  const { apiKey } = await setupAppTest();

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
              id: 'claude-chat-source-include-usage',
              supported_endpoints: ['/v1/messages'],
            },
          ]),
        );
      }
      if (url.pathname === '/v1/messages') {
        return sseResponse([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                id: 'msg_stream_include_usage',
                type: 'message',
                role: 'assistant',
                content: [],
                model: 'claude-chat-source-include-usage',
                stop_reason: null,
                stop_sequence: null,
                usage: {
                  input_tokens: 10,
                  output_tokens: 0,
                  cache_read_input_tokens: 2,
                },
              },
            },
          },
          {
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'ok' },
            },
          },
          {
            event: 'content_block_stop',
            data: { type: 'content_block_stop', index: 0 },
          },
          {
            event: 'message_delta',
            data: {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 3 },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-chat-source-include-usage',
          max_tokens: 256,
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      assertEquals(response.status, 200);
      const usageChunks = getUsageOnlyChatChunks(parseSSEText(await response.text()));
      assertEquals(usageChunks.length, 1);
      assertEquals(usageChunks[0].usage, {
        prompt_tokens: 12,
        completion_tokens: 3,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 2 },
      });
    },
  );
});

test('/v1/chat/completions via responses emits requested usage-only SSE chunk', async () => {
  const { apiKey } = await setupAppTest();

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
              id: 'gpt-responses-chat-include-usage',
              supported_endpoints: ['/responses'],
            },
          ]),
        );
      }
      if (url.pathname === '/responses') {
        return sseResponse([
          {
            event: 'response.created',
            data: {
              type: 'response.created',
              response: {
                id: 'resp_chat_include_usage',
                object: 'response',
                model: 'gpt-responses-chat-include-usage',
                status: 'in_progress',
                output: [],
                output_text: '',
              },
            },
          },
          {
            event: 'response.output_text.delta',
            data: {
              type: 'response.output_text.delta',
              item_id: 'msg_0',
              output_index: 0,
              content_index: 0,
              delta: 'Hello',
            },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: {
                id: 'resp_chat_include_usage',
                object: 'response',
                model: 'gpt-responses-chat-include-usage',
                status: 'completed',
                output: [],
                output_text: 'Hello',
                usage: {
                  input_tokens: 21,
                  output_tokens: 5,
                  total_tokens: 26,
                  input_tokens_details: { cached_tokens: 7 },
                },
              },
            },
          },
        ]);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'gpt-responses-chat-include-usage',
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      assertEquals(response.status, 200);
      const usageChunks = getUsageOnlyChatChunks(parseSSEText(await response.text()));
      assertEquals(usageChunks.length, 1);
      assertEquals(usageChunks[0].usage, {
        prompt_tokens: 21,
        completion_tokens: 5,
        total_tokens: 26,
        prompt_tokens_details: { cached_tokens: 7 },
      });
    },
  );
});

test('/v1/chat/completions via responses surfaces final HTTP cyber policy retry failure as an internal error', async () => {
  const { apiKey } = await setupAppTest();
  const model = 'gpt-responses-chat-cyber-policy';
  let responseAttempts = 0;

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
        return jsonResponse(copilotModels([{ id: model, supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        responseAttempts += 1;
        if (responseAttempts === 1) {
          return sseResponse([responsesCyberPolicyFailureEvent(model)]);
        }

        return jsonResponse(
          {
            error: {
              message: `blocked ${responseAttempts}`,
              type: 'invalid_request_error',
              code: 'cyber_policy',
            },
          },
          400,
        );
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model,
          stream: true,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      assertEquals(response.status, 200);
      const events = parseSSEText(await response.text());
      assertEquals(responseAttempts, 11);
      assertEquals(events.length, 1);
      assertEquals(events[0].event, 'error');

      const payload = JSON.parse(events[0].data);
      assertEquals(payload.error.type, 'internal_error');
      assertStringIncludes(payload.error.message, 'HTTP 400');
      assertStringIncludes(payload.error.message, 'blocked 11');
      assertStringIncludes(payload.error.message, 'cyber_policy');
    },
  );
});

test('/v1/chat/completions via responses surfaces later HTTP retry failure as an internal error', async () => {
  const { apiKey } = await setupAppTest();
  const model = 'gpt-responses-chat-server-error';
  let responseAttempts = 0;

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
        return jsonResponse(copilotModels([{ id: model, supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        responseAttempts += 1;
        if (responseAttempts === 1) {
          return sseResponse([responsesCyberPolicyFailureEvent(model)]);
        }

        return jsonResponse(
          {
            error: {
              message: 'upstream failed after retry',
              type: 'server_error',
              code: 'upstream_failed',
            },
          },
          500,
        );
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model,
          stream: true,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      assertEquals(response.status, 200);
      const events = parseSSEText(await response.text());
      assertEquals(responseAttempts, 2);
      assertEquals(events.length, 1);
      assertEquals(events[0].event, 'error');

      const payload = JSON.parse(events[0].data);
      assertEquals(payload.error.type, 'internal_error');
      assertStringIncludes(payload.error.message, 'HTTP 500');
      assertStringIncludes(payload.error.message, 'upstream failed after retry');
      assertStringIncludes(payload.error.message, 'upstream_failed');
    },
  );
});

test('/v1/chat/completions fills missing max_tokens from model limits on the messages path', async () => {
  const { apiKey } = await setupAppTest();

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
        return jsonResponse({
          object: 'list',
          data: [
            {
              id: 'claude-chat-limit',
              name: 'claude-chat-limit',
              version: '1',
              object: 'model',
              supported_endpoints: ['/v1/messages'],
              capabilities: {
                family: 'test',
                type: 'chat',
                limits: { max_output_tokens: 6144 },
                supports: {},
              },
            },
          ],
        });
      }
      if (url.pathname === '/v1/messages') {
        upstreamBody = JSON.parse(await request.text()) as Record<string, unknown>;
        return sseResponse([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                id: 'msg_limit',
                type: 'message',
                role: 'assistant',
                content: [],
                model: 'claude-chat-limit',
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 0 },
              },
            },
          },
          {
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'ok' },
            },
          },
          {
            event: 'content_block_stop',
            data: { type: 'content_block_stop', index: 0 },
          },
          {
            event: 'message_delta',
            data: {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 1 },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-chat-limit',
          stream: false,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.choices[0].message.content, 'ok');
    },
  );

  assertExists(upstreamBody);
  assertEquals(upstreamBody!.max_tokens, 6144);
});

test('/v1/chat/completions preserves custom upstream /models HTTP errors', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearModelsStore();
  await clearCopilotTokenCache();

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_custom',
    name: 'Custom Provider',
    enabled: true,
    sortOrder: 100,
    createdAt: '2026-05-01T00:00:00.000Z',
    flagOverrides: {},
    config: {
      baseUrl: 'https://custom.example.com',
      bearerToken: 'sk-custom',
      supportedEndpoints: ['/chat/completions'],
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ error: { message: 'bad custom key' } }, 401);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'custom-chat-model',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });

      assertEquals(response.status, 401);
      assertEquals(await response.json(), {
        error: { message: 'bad custom key' },
      });
    },
  );
});
