import { test } from 'vitest';

import { clearCopilotTokenCache } from '../../../../shared/copilot.ts';
import { assertEquals, assertExists, assertFalse, assertStringIncludes } from '../../../../test-assert.ts';
import { buildCustomUpstreamRecord, copilotModels, jsonResponse, parseSSEText, requestApp, setupAppTest, sseMessagesResponse, sseResponse, withMockedFetch } from '../../../../test-helpers.ts';
import { clearModelsStore } from '../../../providers/models-store.ts';
import type { SearchConfig } from '../../../tools/web-search/types.ts';
import type { ResponsesResult } from '@floway-dev/protocols/responses';

const ENABLED_SEARCH_CONFIG: SearchConfig = {
  provider: 'tavily',
  tavily: { apiKey: 'tvly-test' },
  microsoftGrounding: { apiKey: '' },
};

const encodeShimPayloadForTest = (payload: unknown): string => {
  const json = JSON.stringify(payload);
  let binary = '';
  for (const byte of new TextEncoder().encode(json)) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const encodeWebSearchResultPayloadForTest = (payload: { content: Array<{ type: 'text'; text: string }> }) => encodeShimPayloadForTest({ content: payload.content });

const encodeWebSearchCitationPayloadForTest = (payload: { search_result_index: number; start_block_index: number; end_block_index: number }) =>
  encodeShimPayloadForTest({
    search_result_index: payload.search_result_index,
    start_block_index: payload.start_block_index,
    end_block_index: payload.end_block_index,
  });

const makeWebSearchTool = () => ({
  type: 'web_search_20260209' as const,
  name: 'web_search',
  max_uses: 2,
});

const makeAssistantSSE = (messageId: string, contentBlocks: Array<{ event: string; data: Record<string, unknown> }>, stopReason: 'end_turn' | 'pause_turn' | 'tool_use' = 'end_turn') =>
  sseResponse([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-native',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
    },
    ...contentBlocks,
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 4 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);

const textBlock = (text: string) => [
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
      delta: { type: 'text_delta', text },
    },
  },
  {
    event: 'content_block_stop',
    data: { type: 'content_block_stop', index: 0 },
  },
];

const toolUseBlock = (index: number, id: string, name: string, input: Record<string, unknown>) => [
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id, name, input: {} },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify(input),
      },
    },
  },
  {
    event: 'content_block_stop',
    data: { type: 'content_block_stop', index },
  },
];

const makeNativeSearchReplayMessages = () => [
  { role: 'user', content: 'latest React docs' },
  {
    role: 'assistant',
    content: [
      {
        type: 'server_tool_use',
        id: 'srvtoolu_1',
        name: 'web_search',
        input: { query: 'latest React docs' },
      },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_1',
        content: [
          {
            type: 'web_search_result',
            url: 'https://react.dev',
            title: 'React',
            encrypted_content: encodeWebSearchResultPayloadForTest({
              content: [{ type: 'text', text: 'Official React documentation' }],
            }),
          },
        ],
      },
      {
        type: 'text',
        text: 'Use the React docs.',
        citations: [
          {
            type: 'web_search_result_location',
            url: 'https://react.dev',
            title: 'React',
            encrypted_index: encodeWebSearchCitationPayloadForTest({
              search_result_index: 0,
              start_block_index: 0,
              end_block_index: 0,
            }),
            cited_text: 'Official React documentation',
          },
        ],
      },
    ],
  },
];

const makeForeignSearchReplayMessages = () => [
  { role: 'user', content: 'latest React docs' },
  {
    role: 'assistant',
    content: [
      {
        type: 'server_tool_use',
        id: 'srvtoolu_foreign',
        name: 'web_search',
        input: { query: 'latest React docs' },
      },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_foreign',
        content: [
          {
            type: 'web_search_result',
            url: 'https://react.dev',
            title: 'React',
            encrypted_content: 'foreign.payload',
          },
        ],
      },
    ],
  },
];

const makeNativeSearchErrorReplayMessages = () => [
  { role: 'user', content: 'latest React docs' },
  {
    role: 'assistant',
    content: [
      {
        type: 'server_tool_use',
        id: 'srvtoolu_1',
        name: 'web_search',
        input: { query: 'latest React docs' },
      },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_1',
        content: {
          type: 'web_search_tool_result_error',
          error_code: 'too_many_requests',
        },
      },
    ],
  },
];

const makeNativeWebSearchUpstreamHandler =
  (options: {
    upstreamResponse: Response;
    searchResponse?: Response;
    capture?: {
      upstreamBody?: Record<string, unknown>;
      upstreamBeta?: string | null;
      searchBody?: Record<string, unknown>;
    };
  }) =>
    async (request: Request): Promise<Response> => {
      const url = new URL(request.url);

      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }

      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-native', supported_endpoints: ['/v1/messages'] }]));
      }

      if (url.pathname === '/v1/messages') {
        if (options.capture) {
          options.capture.upstreamBody = JSON.parse(await request.text());
          options.capture.upstreamBeta = request.headers.get('anthropic-beta');
        }

        return options.upstreamResponse;
      }

      if (url.hostname === 'api.tavily.com' && url.pathname === '/search') {
        if (options.capture) {
          options.capture.searchBody = JSON.parse(await request.text());
        }

        return (
          options.searchResponse ??
        jsonResponse({
          results: [
            {
              title: 'React',
              url: 'https://react.dev',
              published_date: '2026-04-01',
              content: 'Official React docs',
            },
          ],
        })
        );
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    };

const setupNativeWebSearchRouteTest = () =>
  setupAppTest({
    searchConfig: ENABLED_SEARCH_CONFIG,
  });

test('/v1/messages malformed JSON returns structured internal debug error', async () => {
  const { apiKey } = await setupAppTest();

  const response = await requestApp('/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey.key,
    },
    body: '{',
  });

  assertEquals(response.status, 502);

  const body = await response.json();
  assertEquals(body.type, 'error');
  assertEquals(body.error.type, 'internal_error');
  assertEquals(body.error.name, 'SyntaxError');
  assertEquals(body.error.source_api, 'messages');
  assertExists(body.error.stack);
});

test('/v1/messages rejects body anthropic_beta', async () => {
  const { apiKey } = await setupAppTest();

  const response = await requestApp('/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey.key,
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4',
      max_tokens: 64,
      anthropic_beta: ['context-1m-2025-08-07'],
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });

  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.error.type, 'invalid_request_error');
  assertEquals(body.error.param, 'anthropic_beta');
});

test('/v1/messages does not record performance for an unresolved bracket-suffixed client model string', async () => {
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
              id: 'claude-opus-4.7',
              supported_endpoints: ['/v1/messages'],
              maxContextWindowTokens: 1_000_000,
            },
          ]),
        );
      }
      if (url.pathname === '/v1/messages') {
        generationFetchCalls++;
        return sseMessagesResponse({
          id: 'msg_unexpected',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'unexpected' }],
          model: 'claude-opus-4.7',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-opus-4-7[1m]',
          max_tokens: 32,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      assertEquals(response.status, 404);
      assertEquals(generationFetchCalls, 0);
      assertEquals(await repo.performance.listAll(), []);
    },
  );
});

test('/v1/messages rejects body betas', async () => {
  const { apiKey } = await setupAppTest();

  const response = await requestApp('/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey.key,
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4',
      max_tokens: 64,
      betas: ['context-1m-2025-08-07'],
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });

  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.error.type, 'invalid_request_error');
  assertEquals(body.error.param, 'betas');
});

test('/v1/messages rewrites upstream context-window errors to Messages compact form', async () => {
  const { apiKey } = await setupAppTest();

  const upstreamError = {
    error: {
      message: 'Request body is too large for model context window',
      type: 'invalid_request_error',
    },
  };

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-native', supported_endpoints: ['/v1/messages'] }]));
      }
      if (url.pathname === '/v1/messages') {
        return jsonResponse(upstreamError, 400);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-native',
          max_tokens: 64,
          stream: false,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });

      assertEquals(response.status, 400);
      const body = await response.json();
      assertEquals(body, {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'prompt is too long: your prompt is too long. Please reduce the number of messages or use a model with a larger context window.',
        },
      });
    },
  );
});

test('/messages uses the same data-plane handler as /v1/messages', async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-native', supported_endpoints: ['/v1/messages'] }]));
      }
      if (url.pathname === '/v1/messages') {
        return sseResponse([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                id: 'msg_alias',
                type: 'message',
                role: 'assistant',
                content: [],
                model: 'claude-native',
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
      const response = await requestApp('/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-native',
          max_tokens: 64,
          stream: false,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.id, 'msg_alias');
      assertEquals(body.content[0].text, 'ok');
    },
  );
});

test('/v1/messages uses native endpoint and applies native request workarounds', async () => {
  const { apiKey, githubAccount } = await setupAppTest();

  let upstreamBody: Record<string, unknown> | undefined;
  let upstreamBeta: string | null = null;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-native', supported_endpoints: ['/v1/messages'] }]));
      }
      if (url.pathname === '/v1/messages') {
        upstreamBody = JSON.parse(await request.text());
        upstreamBeta = request.headers.get('anthropic-beta');
        return sseResponse([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                id: 'msg_native',
                type: 'message',
                role: 'assistant',
                content: [],
                model: 'claude-native',
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
              usage: { output_tokens: 4 },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
          'anthropic-beta': 'context-management-2025-06-27,unknown-beta',
        },
        body: JSON.stringify({
          model: 'claude-native',
          max_tokens: 64,
          stream: false,
          system: 'system note\nx-anthropic-billing-header: cc_version=2.1.114; cc_entrypoint=cli; cch=abcde12345;',
          service_tier: 'auto',
          thinking: { type: 'enabled', budget_tokens: 512 },
          tools: [
            {
              name: 'calc',
              description: 'calculator',
              input_schema: { type: 'object' },
            },
          ],
          messages: [
            { role: 'user', content: 'hello x-anthropic-billing-header world' },
            {
              role: 'assistant',
              content: [
                {
                  type: 'thinking',
                  thinking: 'first thought',
                  signature: 'sig_first',
                },
                {
                  type: 'redacted_thinking',
                  data: 'opaque_blob',
                },
                {
                  type: 'thinking',
                  thinking: 'second thought',
                  signature: 'sig_second',
                },
                { type: 'text', text: 'previous reply' },
              ],
            },
            { role: 'user', content: 'continue' },
          ],
        }),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.id, 'msg_native');
      assertEquals(body.content[0].text, 'ok');
    },
  );

  assertExists(upstreamBody);
  assertEquals(upstreamBody!.stream, true);
  assertEquals(upstreamBody!.system, 'system note');
  assertEquals(upstreamBody!.service_tier, 'auto');
  assertEquals((upstreamBody!.tools as Array<Record<string, unknown>>).length, 1);
  assertEquals((upstreamBody!.tools as Array<Record<string, unknown>>)[0].name, 'calc');
  assertEquals((upstreamBody!.messages as Array<Record<string, unknown>>)[0].content, 'hello x-anthropic-billing-header world');
  const assistantMessage = (upstreamBody!.messages as Array<Record<string, unknown>>)[1];
  const assistantContent = assistantMessage.content as Array<Record<string, unknown>>;
  assertEquals(assistantContent.length, 4);
  assertEquals(assistantContent[0].type, 'thinking');
  assertEquals(assistantContent[0].thinking, 'first thought');
  assertEquals(assistantContent[1].type, 'redacted_thinking');
  assertEquals(assistantContent[1].data, 'opaque_blob');
  assertEquals(assistantContent[2].type, 'thinking');
  assertEquals(assistantContent[2].thinking, 'second thought');
  assertEquals(assistantContent[3].type, 'text');
  // Caller-supplied anthropic-beta is respected exactly: the filter keeps
  // allow-listed values and never auto-adds `interleaved-thinking-2025-05-14`
  // on the inbound branch, even when `thinking.budget_tokens` is set. The
  // auto-add only fires when the caller sent NO inbound header.
  assertEquals(upstreamBeta, 'context-management-2025-06-27');
  assertEquals(githubAccount.accountType, 'individual');
});

test('/v1/messages keeps caller thinking and tool_choice unchanged on native adaptive models', async () => {
  const { apiKey } = await setupAppTest();

  let upstreamBody: Record<string, unknown> | undefined;
  let upstreamBeta: string | null = null;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

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
              id: 'claude-adaptive',
              supported_endpoints: ['/v1/messages'],
            },
          ]),
        );
      }
      if (url.pathname === '/v1/messages') {
        upstreamBody = JSON.parse(await request.text());
        upstreamBeta = request.headers.get('anthropic-beta');
        return sseResponse([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                id: 'msg_native',
                type: 'message',
                role: 'assistant',
                content: [],
                model: 'claude-adaptive',
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
              usage: { output_tokens: 4 },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-adaptive',
          max_tokens: 64,
          stream: false,
          tool_choice: { type: 'any' },
          tools: [
            {
              name: 'calc',
              description: 'calculator',
              input_schema: { type: 'object' },
            },
          ],
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });

      assertEquals(response.status, 200);
    },
  );

  assertExists(upstreamBody);
  assertEquals(upstreamBody!.stream, true);
  assertFalse('thinking' in upstreamBody!);
  assertFalse('output_config' in upstreamBody!);
  assertEquals((upstreamBody!.tool_choice as Record<string, unknown>).type, 'any');
  assertEquals(upstreamBeta, null);
});

test('/v1/messages sends summarized thinking upstream while exposing 4.7 default omitted downstream', async () => {
  const { apiKey } = await setupAppTest();

  let upstreamBody: Record<string, unknown> | undefined;
  let upstreamBeta: string | null = null;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

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
              id: 'claude-opus-4.7-1m-internal',
              supported_endpoints: ['/v1/messages'],
            },
          ]),
        );
      }
      if (url.pathname === '/v1/messages') {
        upstreamBody = JSON.parse(await request.text());
        upstreamBeta = request.headers.get('anthropic-beta');
        return makeAssistantSSE('msg_thinking', [
          {
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'thinking', thinking: '' },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'thinking_delta', thinking: 'private summary' },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'signature_delta', signature: 'sig_4_7' },
            },
          },
          {
            event: 'content_block_stop',
            data: { type: 'content_block_stop', index: 0 },
          },
        ]);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
          'anthropic-beta': 'redact-thinking-2026-02-12',
        },
        body: JSON.stringify({
          model: 'claude-opus-4.7-1m-internal',
          max_tokens: 64,
          stream: false,
          thinking: { type: 'adaptive' },
          messages: [{ role: 'user', content: 'think' }],
        }),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.content, [
        {
          type: 'thinking',
          thinking: '',
          signature: 'sig_4_7',
        },
      ]);
    },
  );

  assertExists(upstreamBody);
  assertEquals((upstreamBody!.thinking as Record<string, unknown>).display, 'summarized');
  assertEquals(upstreamBeta, null);
});

test('/v1/messages streams explicit omitted without thinking_delta while preserving signature', async () => {
  const { apiKey } = await setupAppTest();

  let upstreamBody: Record<string, unknown> | undefined;
  let upstreamBeta: string | null = null;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

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
            },
          ]),
        );
      }
      if (url.pathname === '/v1/messages') {
        upstreamBody = JSON.parse(await request.text());
        upstreamBeta = request.headers.get('anthropic-beta');
        return makeAssistantSSE('msg_thinking_stream', [
          {
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'thinking', thinking: '' },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'thinking_delta', thinking: 'hidden summary' },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'signature_delta', signature: 'sig_stream' },
            },
          },
          {
            event: 'content_block_stop',
            data: { type: 'content_block_stop', index: 0 },
          },
        ]);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
          'anthropic-beta': 'redact-thinking-2026-02-12',
        },
        body: JSON.stringify({
          model: 'claude-opus-4.7',
          max_tokens: 64,
          stream: true,
          thinking: { type: 'adaptive', display: 'omitted' },
          messages: [{ role: 'user', content: 'think' }],
        }),
      });

      assertEquals(response.status, 200);
      const events = parseSSEText(await response.text()).map(event => JSON.parse(event.data));

      const thinkingStart = events.find(event => event.type === 'content_block_start' && event.content_block.type === 'thinking');
      assertExists(thinkingStart);
      assertEquals(thinkingStart.content_block.thinking, '');
      assertFalse(events.some(event => event.type === 'content_block_delta' && event.delta.type === 'thinking_delta'));
      assertExists(events.find(event => event.type === 'content_block_delta' && event.delta.type === 'signature_delta' && event.delta.signature === 'sig_stream'));
    },
  );

  assertExists(upstreamBody);
  assertEquals((upstreamBody!.thinking as Record<string, unknown>).display, 'summarized');
  assertEquals(upstreamBeta, null);
});

test('/v1/messages resolves base Claude models to effort variants before planning', async () => {
  const { apiKey } = await setupAppTest();

  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

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
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-opus-4-7',
          max_tokens: 64,
          output_config: { effort: 'xhigh' },
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      assertEquals(response.status, 200);
      await response.json();
    },
  );

  assertEquals(upstreamBody?.model, 'claude-opus-4.7-xhigh');
});

test('/v1/messages native streaming filters trailing DONE sentinel', async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-native', supported_endpoints: ['/v1/messages'] }]));
      }
      if (url.pathname === '/v1/messages') {
        return sseResponse([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                id: 'msg_123',
                type: 'message',
                role: 'assistant',
                content: [],
                model: 'claude-native',
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 11, output_tokens: 0 },
              },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
          { data: '[DONE]' },
        ]);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-native',
          max_tokens: 64,
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });

      assertEquals(response.status, 200);

      const text = await response.text();
      assertFalse(text.includes('[DONE]'));

      const events = parseSSEText(text);
      assertEquals(events.length, 2);
      assertEquals(events[0].event, 'message_start');
      assertEquals(events[1].event, 'message_stop');
    },
  );
});

test('/v1/messages streams malformed upstream Messages SSE as an error event', async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

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
              id: 'claude-malformed-messages',
              supported_endpoints: ['/v1/messages'],
            },
          ]),
        );
      }
      if (url.pathname === '/v1/messages') {
        return new Response('event: message_delta\ndata: not json', {
          headers: { 'content-type': 'text/event-stream' },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-malformed-messages',
          max_tokens: 64,
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });

      assertEquals(response.status, 200);

      const events = parseSSEText(await response.text());
      assertEquals(events.length, 1);
      assertEquals(events[0].event, 'error');

      const event = JSON.parse(events[0].data);
      assertEquals(event.type, 'error');
      assertEquals(event.error.type, 'internal_error');
      assertStringIncludes(event.error.message, 'Malformed upstream Messages SSE JSON for event "message_delta": not json');
      assertExists(event.error.stack);
    },
  );
});

test('/v1/messages strips Messages tool strict field on native messages (Copilot Vertex rejects structured_outputs)', async () => {
  const { apiKey } = await setupAppTest();

  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-native', supported_endpoints: ['/v1/messages'] }]));
      }
      if (url.pathname === '/v1/messages') {
        upstreamBody = JSON.parse(await request.text());
        return sseResponse([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                id: 'msg_native',
                type: 'message',
                role: 'assistant',
                content: [],
                model: 'claude-native',
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
              usage: { output_tokens: 4 },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-native',
          max_tokens: 64,
          stream: false,
          tools: [
            {
              name: 'calc',
              input_schema: { type: 'object' },
              strict: true,
            },
          ],
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });

      assertEquals(response.status, 200);
    },
  );

  assertExists(upstreamBody);
  assertEquals(upstreamBody!.stream, true);
  assertEquals((upstreamBody!.tools as Array<Record<string, unknown>>)[0].strict, undefined);
});

test('/v1/messages keeps strict Messages tools on native messages when both endpoints are available', async () => {
  const { apiKey } = await setupAppTest();

  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

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
              id: 'claude-dual-endpoint',
              supported_endpoints: ['/v1/messages', '/chat/completions'],
            },
          ]),
        );
      }
      if (url.pathname === '/v1/messages') {
        upstreamBody = JSON.parse(await request.text());
        return sseResponse([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                id: 'msg_dual',
                type: 'message',
                role: 'assistant',
                content: [],
                model: 'claude-dual-endpoint',
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
              usage: { output_tokens: 4 },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]);
      }
      if (url.pathname === '/chat/completions') {
        throw new Error('chat fallback should not be used for strict Messages tools');
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-dual-endpoint',
          max_tokens: 64,
          stream: false,
          tools: [
            {
              name: 'calc',
              description: 'calculator',
              input_schema: { type: 'object' },
              strict: true,
            },
          ],
          messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
        }),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.id, 'msg_dual');
    },
  );

  assertExists(upstreamBody);
  assertEquals(upstreamBody!.stream, true);
  assertEquals((upstreamBody!.tools as Array<Record<string, unknown>>)[0].strict, undefined);
});

test('/v1/messages falls back to chat completions and translates both directions', async () => {
  const { apiKey } = await setupAppTest();

  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-chat-only', supported_endpoints: ['/chat/completions'] }]));
      }
      if (url.pathname === '/chat/completions') {
        upstreamBody = JSON.parse(await request.text());
        return sseResponse([
          {
            data: {
              id: 'chatcmpl_test123',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-chat-only',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    content: 'Need a tool',
                    reasoning_text: 'thinking',
                    reasoning_opaque: 'opaque',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_1',
                        type: 'function',
                        function: { name: 'lookup', arguments: '{"city":"Tokyo"}' },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: {
                prompt_tokens: 40,
                completion_tokens: 8,
                prompt_tokens_details: { cached_tokens: 5 },
              },
            },
          },
          { data: '[DONE]' },
        ]);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'gpt-chat-only',
          max_tokens: 128,
          stream: false,
          system: 'be precise',
          tool_choice: { type: 'any' },
          tools: [
            {
              name: 'lookup',
              description: 'Find facts',
              input_schema: { type: 'object' },
              strict: true,
            },
          ],
          messages: [{ role: 'user', content: 'What is the weather?' }],
        }),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.stop_reason, 'tool_use');
      assertEquals(body.usage.input_tokens, 35);
      assertEquals(body.usage.cache_read_input_tokens, 5);
      // Block order: thinking → tool_use → text. The same chunk carried
      // both `content` and `tool_calls`; aligning with caozhiyuan's
      // handleContent (isToolBlockOpen || hasToolCallDelta) defers the
      // text so it lands AFTER the tool_use block rather than around it.
      // See:
      // https://github.com/caozhiyuan/copilot-api/blob/main/src/routes/messages/stream-translation.ts#L240
      assertEquals(body.content[0].type, 'thinking');
      assertEquals(body.content[1].type, 'tool_use');
      assertEquals(body.content[2].type, 'text');
      assertEquals(body.content[2].text, 'Need a tool');
    },
  );

  assertExists(upstreamBody);
  assertEquals(upstreamBody!.stream, true);
  const messages = upstreamBody!.messages as Array<Record<string, unknown>>;
  assertEquals(messages[0].role, 'system');
  assertEquals(messages[1].role, 'user');
  assertEquals(upstreamBody!.tool_choice, 'required');
  assertEquals((upstreamBody!.tools as Array<Record<string, unknown>>)[0].type, 'function');
  assertEquals(((upstreamBody!.tools as Array<Record<string, unknown>>)[0].function as Record<string, unknown>).strict, true);
});

test('/v1/messages falls back to responses and preserves readable reasoning without opaque Responses state', async () => {
  const { apiKey } = await setupAppTest();

  let upstreamBody: Record<string, unknown> | undefined;
  let responsesRequests = 0;

  const responsesResult: ResponsesResult = {
    id: 'resp_123',
    object: 'response',
    model: 'gpt-responses-only',
    status: 'completed',
    output_text: 'Answer text',
    output: [
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'brief reasoning' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Answer text' }],
      },
    ],
    usage: {
      input_tokens: 30,
      output_tokens: 9,
      total_tokens: 39,
      input_tokens_details: { cached_tokens: 5 },
    },
  };

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-responses-only', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        responsesRequests += 1;
        upstreamBody = JSON.parse(await request.text());
        return sseResponse([
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: responsesResult,
            },
          },
        ]);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'gpt-responses-only',
          max_tokens: 256,
          system: 'system instructions',
          stream: false,
          tools: [
            {
              name: 'lookup',
              description: 'Find facts',
              input_schema: { type: 'object' },
              strict: true,
            },
          ],
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.id, 'resp_123');
      assertEquals(body.usage.input_tokens, 25);
      assertEquals(body.usage.cache_read_input_tokens, 5);
      assertEquals(body.content[0].type, 'thinking');
      assertFalse('signature' in body.content[0]);
      assertEquals(body.content[1].text, 'Answer text');
    },
  );

  assertExists(upstreamBody);
  assertEquals(upstreamBody!.stream, true);
  assertEquals(responsesRequests, 1);
  assertEquals(upstreamBody!.instructions, 'system instructions');
  assertFalse('temperature' in upstreamBody!);
  assertEquals(upstreamBody!.max_output_tokens, 256);
  assertFalse('reasoning' in upstreamBody!);
  assertFalse('include' in upstreamBody!);
  assertEquals((upstreamBody!.tools as Array<Record<string, unknown>>)[0].strict, true);
});

test('/v1/messages routes Azure Responses-only deployments through OpenAI v1 Responses', async () => {
  const { repo, apiKey, copilotUpstream } = await setupAppTest();
  await repo.upstreams.delete(copilotUpstream.id);
  await repo.upstreams.save({
    id: 'up_azure_responses',
    provider: 'azure',
    name: 'Azure Responses',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
    flagOverrides: {},
    config: {
      endpoint: 'https://example.openai.azure.com/openai/v1',
      apiKey: 'az-key',
      deployments: [
        {
          deployment: 'gpt-5.4-pro',
          supportedEndpoints: ['/responses'],
        },
      ],
    },
  });

  let upstreamBody: Record<string, unknown> | undefined;
  let upstreamApiKey: string | null = null;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'example.openai.azure.com' && url.pathname === '/openai/v1/responses') {
        upstreamApiKey = request.headers.get('api-key');
        upstreamBody = JSON.parse(await request.text());
        return sseResponse([
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: {
                id: 'resp_azure',
                object: 'response',
                model: 'gpt-5.4-pro',
                status: 'completed',
                output_text: 'ok',
                output: [
                  {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'ok' }],
                  },
                ],
                usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
              },
            },
          },
        ]);
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'gpt-5.4-pro',
          max_tokens: 64,
          stream: false,
          messages: [{ role: 'user', content: 'Reply with ok.' }],
        }),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.id, 'resp_azure');
      assertEquals(body.content[0].text, 'ok');
    },
  );

  assertEquals(upstreamApiKey, 'az-key');
  assertExists(upstreamBody);
  assertEquals(upstreamBody!.model, 'gpt-5.4-pro');
  assertEquals(upstreamBody!.max_output_tokens, 64);
});

test('/v1/messages preserves output_config.effort max when translating to responses', async () => {
  const { apiKey } = await setupAppTest();

  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

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
              id: 'gpt-responses-max-effort',
              supported_endpoints: ['/responses'],
            },
          ]),
        );
      }
      if (url.pathname === '/responses') {
        upstreamBody = JSON.parse(await request.text());
        return sseResponse([
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: {
                id: 'resp_max_effort',
                object: 'response',
                model: 'gpt-responses-max-effort',
                status: 'completed',
                output_text: 'ok',
                output: [
                  {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'ok' }],
                  },
                ],
                usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
              },
            },
          },
        ]);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'gpt-responses-max-effort',
          max_tokens: 256,
          stream: false,
          output_config: { effort: 'max' },
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.content[0].text, 'ok');
    },
  );

  assertExists(upstreamBody);
  assertEquals((upstreamBody!.reasoning as Record<string, unknown>).effort, 'max');
  assertFalse('include' in upstreamBody!);
});

test('/v1/messages prefers responses on dual-endpoint models when native messages is unavailable', async () => {
  const { apiKey } = await setupAppTest();

  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

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
              id: 'gpt-dual-endpoint',
              supported_endpoints: ['/responses', '/chat/completions'],
            },
          ]),
        );
      }
      if (url.pathname === '/chat/completions') {
        throw new Error('chat/completions should not be used when /responses is available');
      }
      if (url.pathname === '/responses') {
        const body = JSON.parse(await request.text()) as Record<string, unknown>;
        upstreamBody = body;
        return sseResponse([
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: {
                id: 'resp_plain',
                object: 'response',
                model: 'gpt-dual-endpoint',
                status: 'completed',
                output_text: 'plain',
                output: [
                  {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'plain' }],
                  },
                ],
                usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
              },
            },
          },
        ]);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'gpt-dual-endpoint',
          max_tokens: 256,
          stream: false,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.content[0].text, 'plain');
    },
  );

  assertExists(upstreamBody);
  assertFalse('reasoning' in upstreamBody!);
  assertFalse('include' in upstreamBody!);
});

test('stripReservedKeywords removes entire billing header line from string system', async () => {
  const { apiKey } = await setupAppTest();

  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'tok',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(
          copilotModels([
            {
              id: 'claude-native',
              supported_endpoints: ['/v1/messages'],
            },
          ]),
        );
      }
      if (url.pathname === '/v1/messages') {
        upstreamBody = JSON.parse(await request.text());
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
                model: 'claude-native',
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
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({
          model: 'claude-native',
          max_tokens: 10,
          stream: false,
          system: 'You are helpful.\nx-anthropic-billing-header: cc_version=2.1.114; cc_entrypoint=cli; cch=abcde12345;\nBe concise.',
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });
      assertEquals(response.status, 200);
    },
  );

  assertExists(upstreamBody);
  const sys = upstreamBody!.system as string;
  assertFalse(sys.includes('x-anthropic-billing-header'));
  assertFalse(sys.includes('cch='));
  assertEquals(sys.includes('You are helpful.'), true);
  assertEquals(sys.includes('Be concise.'), true);
});

test('stripReservedKeywords removes billing-only system block without 400 error', async () => {
  const { apiKey } = await setupAppTest();

  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'tok',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(
          copilotModels([
            {
              id: 'claude-native',
              supported_endpoints: ['/v1/messages'],
            },
          ]),
        );
      }
      if (url.pathname === '/v1/messages') {
        upstreamBody = JSON.parse(await request.text());
        return sseResponse([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                id: 'msg_2',
                type: 'message',
                role: 'assistant',
                content: [],
                model: 'claude-native',
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 5, output_tokens: 0 },
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
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({
          model: 'claude-native',
          max_tokens: 10,
          stream: false,
          system: [
            {
              type: 'text',
              text: 'x-anthropic-billing-header: cc_version=2.1.114; cc_entrypoint=cli; cch=ff00ff00ff;',
            },
            {
              type: 'text',
              text: 'You are a helpful assistant.',
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });
      assertEquals(response.status, 200);
    },
  );

  assertExists(upstreamBody);
  const sys = upstreamBody!.system as Array<Record<string, unknown>>;
  assertEquals(sys.length, 1);
  assertEquals(sys[0].text, 'You are a helpful assistant.');
  assertExists(sys[0].cache_control);
});

test('/v1/messages strips cache_control.scope only for Copilot Messages', async () => {
  const { apiKey } = await setupAppTest();

  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'tok',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(
          copilotModels([
            {
              id: 'claude-native',
              supported_endpoints: ['/v1/messages'],
            },
          ]),
        );
      }
      if (url.pathname === '/v1/messages') {
        upstreamBody = await request.json();
        return sseResponse([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                id: 'msg_cache_scope',
                type: 'message',
                role: 'assistant',
                content: [],
                model: 'claude-native',
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 5, output_tokens: 0 },
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
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({
          model: 'claude-native',
          max_tokens: 10,
          stream: false,
          system: [
            {
              type: 'text',
              text: 'You are helpful.',
              cache_control: { type: 'ephemeral', scope: 'tools' },
            },
          ],
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Hi',
                  cache_control: { type: 'ephemeral', scope: 'tools' },
                },
              ],
            },
          ],
        }),
      });

      assertEquals(response.status, 200);
    },
  );

  assertExists(upstreamBody);
  const system = upstreamBody.system as Array<Record<string, unknown>>;
  const messages = upstreamBody.messages as Array<{ content: unknown }>;
  const content = messages[0].content as Array<Record<string, unknown>>;
  assertEquals(system[0].cache_control, { type: 'ephemeral' });
  assertEquals(content[0].cache_control, { type: 'ephemeral' });
});

test('/v1/messages preserves cache_control.scope for custom Messages providers', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearModelsStore();
  await clearCopilotTokenCache();

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_messages',
    name: 'Messages Provider',
    sortOrder: 100,
    flagOverrides: {},
    config: {
      baseUrl: 'https://messages.example.com',
      bearerToken: 'sk-messages',
      supportedEndpoints: ['/v1/messages'],
    },
  }));

  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.hostname === 'messages.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: [{ id: 'custom-claude' }],
        });
      }
      if (url.hostname === 'messages.example.com' && url.pathname === '/v1/messages') {
        upstreamBody = await request.json();
        return sseMessagesResponse({
          id: 'msg_custom_cache_scope',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: 'custom-claude',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'custom-claude',
          max_tokens: 10,
          stream: false,
          system: [
            {
              type: 'text',
              text: 'You are helpful.',
              cache_control: { type: 'ephemeral', scope: 'tools' },
            },
          ],
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Hi',
                  cache_control: { type: 'ephemeral', scope: 'tools' },
                },
              ],
            },
          ],
        }),
      });

      assertEquals(response.status, 200);
    },
  );

  assertExists(upstreamBody);
  const system = upstreamBody.system as Array<Record<string, unknown>>;
  const messages = upstreamBody.messages as Array<{ content: unknown }>;
  const content = messages[0].content as Array<Record<string, unknown>>;
  assertEquals(system[0].cache_control, {
    type: 'ephemeral',
    scope: 'tools',
  });
  assertEquals(content[0].cache_control, {
    type: 'ephemeral',
    scope: 'tools',
  });
});

test('/v1/messages forwards native web search unchanged to custom Messages providers by default', async () => {
  const { apiKey, repo } = await setupAppTest({
    searchConfig: ENABLED_SEARCH_CONFIG,
  });
  await repo.upstreams.deleteAll();
  clearModelsStore();
  await clearCopilotTokenCache();

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_messages_native_search',
    name: 'Messages Native Search Provider',
    sortOrder: 100,
    flagOverrides: {},
    config: {
      baseUrl: 'https://messages-native-search.example.com',
      bearerToken: 'sk-messages',
      supportedEndpoints: ['/v1/messages'],
    },
  }));

  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.hostname === 'messages-native-search.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: [{ id: 'custom-native-search' }],
        });
      }
      if (url.hostname === 'messages-native-search.example.com' && url.pathname === '/v1/messages') {
        upstreamBody = await request.json();
        return sseMessagesResponse({
          id: 'msg_custom_native_search',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: 'custom-native-search',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }
      if (url.hostname === 'api.tavily.com') {
        throw new Error('search provider should not be called without opt-in');
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'custom-native-search',
          max_tokens: 64,
          stream: false,
          tools: [makeWebSearchTool()],
          tool_choice: { type: 'tool', name: 'web_search' },
          messages: [{ role: 'user', content: 'latest React docs' }],
        }),
      });

      assertEquals(response.status, 200);
    },
  );

  assertExists(upstreamBody);
  assertEquals((upstreamBody.tools as Array<Record<string, unknown>>)[0].type, 'web_search_20260209');
  assertEquals(upstreamBody.tool_choice, {
    type: 'tool',
    name: 'web_search',
  });
});

test('/v1/messages applies native web search shim to custom Messages providers when opted in', async () => {
  const { apiKey, repo } = await setupAppTest({
    searchConfig: ENABLED_SEARCH_CONFIG,
  });
  await repo.upstreams.deleteAll();
  clearModelsStore();
  await clearCopilotTokenCache();

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_messages_shimmed_search',
    name: 'Messages Shimmed Search Provider',
    sortOrder: 100,
    flagOverrides: { 'messages-web-search-shim': true },
    config: {
      baseUrl: 'https://messages-shimmed-search.example.com',
      bearerToken: 'sk-messages',
      supportedEndpoints: ['/v1/messages'],
    },
  }));

  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.hostname === 'messages-shimmed-search.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: [{ id: 'custom-shimmed-search' }],
        });
      }
      if (url.hostname === 'messages-shimmed-search.example.com' && url.pathname === '/v1/messages') {
        upstreamBody = await request.json();
        return sseMessagesResponse({
          id: 'msg_custom_shimmed_search',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: 'custom-shimmed-search',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'custom-shimmed-search',
          max_tokens: 64,
          stream: false,
          tools: [makeWebSearchTool()],
          tool_choice: { type: 'tool', name: 'web_search' },
          messages: [{ role: 'user', content: 'latest React docs' }],
        }),
      });

      assertEquals(response.status, 200);
    },
  );

  assertExists(upstreamBody);
  const upstreamTool = (upstreamBody.tools as Array<Record<string, unknown>>)[0];
  assertEquals(upstreamTool.type, undefined);
  assertEquals(upstreamTool.name, 'web_search');
  assertEquals(upstreamTool.input_schema, {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query',
      },
    },
    required: ['query'],
  });
  assertEquals(upstreamBody.tool_choice, {
    type: 'tool',
    name: 'web_search',
  });
});

test('/v1/messages applies native web search shim to custom Responses targets', async () => {
  const { apiKey, repo } = await setupAppTest({
    searchConfig: ENABLED_SEARCH_CONFIG,
  });
  await repo.upstreams.deleteAll();
  clearModelsStore();
  await clearCopilotTokenCache();

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_responses_search',
    name: 'Responses Search Provider',
    sortOrder: 100,
    flagOverrides: {},
    config: {
      baseUrl: 'https://responses-search.example.com',
      bearerToken: 'sk-responses',
      supportedEndpoints: ['/responses'],
    },
  }));

  let upstreamBody: Record<string, unknown> | undefined;
  let searchBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.hostname === 'responses-search.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: [{ id: 'custom-search-via-responses' }],
        });
      }
      if (url.hostname === 'responses-search.example.com' && url.pathname === '/v1/responses') {
        upstreamBody = JSON.parse(await request.text());
        return sseResponse([
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: {
                id: 'resp_custom_search',
                object: 'response',
                model: 'custom-search-via-responses',
                status: 'completed',
                output_text: '',
                output: [
                  {
                    type: 'function_call',
                    id: 'fc_1',
                    call_id: 'toolu_search_1',
                    name: 'web_search',
                    arguments: '{"query":"latest React docs"}',
                    status: 'completed',
                  },
                ],
                usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
              },
            },
          },
        ]);
      }
      if (url.hostname === 'api.tavily.com' && url.pathname === '/search') {
        searchBody = JSON.parse(await request.text());
        return jsonResponse({
          results: [
            {
              title: 'React',
              url: 'https://react.dev',
              published_date: '2026-04-01',
              content: 'Official React docs',
            },
          ],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'custom-search-via-responses',
          max_tokens: 64,
          stream: false,
          tools: [makeWebSearchTool()],
          messages: [{ role: 'user', content: 'latest React docs' }],
        }),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.stop_reason, 'pause_turn');
      assertEquals(body.content[0].type, 'server_tool_use');
      assertEquals(body.content[1].type, 'web_search_tool_result');
    },
  );

  assertExists(upstreamBody);
  const upstreamTools = upstreamBody!.tools as Array<Record<string, unknown>>;
  assertEquals(upstreamTools.length, 1);
  assertEquals(upstreamTools[0].type, 'function');
  assertEquals(upstreamTools[0].name, 'web_search');
  assertEquals(searchBody?.query, 'latest React docs');
});

test('/v1/messages applies native web search shim to custom Chat Completions targets', async () => {
  const { apiKey, repo } = await setupAppTest({
    searchConfig: ENABLED_SEARCH_CONFIG,
  });
  await repo.upstreams.deleteAll();
  clearModelsStore();
  await clearCopilotTokenCache();

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_chat_search',
    name: 'Chat Search Provider',
    sortOrder: 100,
    flagOverrides: {},
    config: {
      baseUrl: 'https://chat-search.example.com',
      bearerToken: 'sk-chat',
      supportedEndpoints: ['/chat/completions'],
    },
  }));

  let upstreamBody: Record<string, unknown> | undefined;
  let searchBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.hostname === 'chat-search.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: [{ id: 'custom-search-via-chat' }],
        });
      }
      if (url.hostname === 'chat-search.example.com' && url.pathname === '/v1/chat/completions') {
        upstreamBody = JSON.parse(await request.text());
        return sseResponse([
          {
            data: {
              id: 'chatcmpl_custom_search',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'custom-search-via-chat',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'toolu_search_1',
                        type: 'function',
                        function: {
                          name: 'web_search',
                          arguments: '{"query":"latest React docs"}',
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: { prompt_tokens: 12, completion_tokens: 5 },
            },
          },
          { data: '[DONE]' },
        ]);
      }
      if (url.hostname === 'api.tavily.com' && url.pathname === '/search') {
        searchBody = JSON.parse(await request.text());
        return jsonResponse({
          results: [
            {
              title: 'React',
              url: 'https://react.dev',
              published_date: '2026-04-01',
              content: 'Official React docs',
            },
          ],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'custom-search-via-chat',
          max_tokens: 64,
          stream: false,
          tools: [makeWebSearchTool()],
          messages: [{ role: 'user', content: 'latest React docs' }],
        }),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.stop_reason, 'pause_turn');
      assertEquals(body.content[0].type, 'server_tool_use');
      assertEquals(body.content[1].type, 'web_search_tool_result');
    },
  );

  assertExists(upstreamBody);
  const upstreamTools = upstreamBody!.tools as Array<Record<string, unknown>>;
  assertEquals(upstreamTools.length, 1);
  assertEquals(upstreamTools[0].type, 'function');
  assertEquals((upstreamTools[0].function as Record<string, unknown>).name, 'web_search');
  assertEquals(searchBody?.query, 'latest React docs');
});

test('stripReservedKeywords handles all-billing system blocks by removing system entirely', async () => {
  const { apiKey } = await setupAppTest();

  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'tok',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(
          copilotModels([
            {
              id: 'claude-native',
              supported_endpoints: ['/v1/messages'],
            },
          ]),
        );
      }
      if (url.pathname === '/v1/messages') {
        upstreamBody = JSON.parse(await request.text());
        return sseResponse([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                id: 'msg_3',
                type: 'message',
                role: 'assistant',
                content: [],
                model: 'claude-native',
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 5, output_tokens: 0 },
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
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({
          model: 'claude-native',
          max_tokens: 10,
          stream: false,
          system: [
            {
              type: 'text',
              text: 'x-anthropic-billing-header: cc_version=2.1.114; cc_entrypoint=cli; cch=aabbccdd;',
            },
          ],
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });
      assertEquals(response.status, 200);
    },
  );

  assertExists(upstreamBody);
  assertFalse('system' in upstreamBody!);
});

test('/v1/messages rewrites native web search to an upstream client tool without renaming web_search and returns pause_turn', async () => {
  const { apiKey, repo } = await setupNativeWebSearchRouteTest();
  const capture: {
    upstreamBody?: Record<string, unknown>;
    upstreamBeta?: string | null;
    searchBody?: Record<string, unknown>;
  } = {};

  await withMockedFetch(
    makeNativeWebSearchUpstreamHandler({
      capture,
      upstreamResponse: makeAssistantSSE('msg_native_search', [
        ...toolUseBlock(0, 'toolu_1', 'web_search', {
          query: 'latest React docs',
        }),
      ]),
    }),
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-native',
          max_tokens: 64,
          stream: false,
          tools: [makeWebSearchTool()],
          tool_choice: { type: 'tool', name: 'web_search' },
          messages: [{ role: 'user', content: 'latest React docs' }],
        }),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.id, 'msg_native_search');
      assertEquals(body.stop_reason, 'pause_turn');
      assertEquals(body.content[0].type, 'server_tool_use');
      assertEquals(body.content[1].type, 'web_search_tool_result');
      assertEquals(body.usage.server_tool_use.web_search_requests, 1);
    },
  );

  assertExists(capture.upstreamBody);
  assertEquals((capture.upstreamBody!.tools as Array<Record<string, unknown>>)[0].name, 'web_search');
  assertEquals((capture.upstreamBody!.tools as Array<Record<string, unknown>>)[0].description, 'The web_search tool searches the internet and returns up-to-date information from web sources.');
  assertEquals((capture.upstreamBody!.tools as Array<Record<string, unknown>>)[0].input_schema, {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query',
      },
    },
    required: ['query'],
  });
  assertEquals(capture.upstreamBody!.tool_choice, {
    type: 'tool',
    name: 'web_search',
  });
  assertEquals(capture.searchBody?.query, 'latest React docs');
  assertEquals(await repo.searchUsage.listAll(), [
    {
      provider: 'tavily',
      keyId: apiKey.id,
      hour: new Date().toISOString().slice(0, 13),
      requests: 1,
    },
  ]);
});

test('/v1/messages keeps tool_use when native web search shares a turn with client tools', async () => {
  const { apiKey } = await setupNativeWebSearchRouteTest();
  const capture: {
    upstreamBody?: Record<string, unknown>;
    upstreamBeta?: string | null;
    searchBody?: Record<string, unknown>;
  } = {};

  await withMockedFetch(
    makeNativeWebSearchUpstreamHandler({
      capture,
      upstreamResponse: makeAssistantSSE(
        'msg_mixed_tools',
        [
          ...toolUseBlock(0, 'toolu_1', 'web_search', {
            query: 'latest React docs',
          }),
          ...toolUseBlock(1, 'toolu_2', 'calc', { expression: '2+2' }),
        ],
        'tool_use',
      ),
    }),
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-native',
          max_tokens: 64,
          stream: false,
          tools: [
            makeWebSearchTool(),
            {
              name: 'calc',
              description: 'calculator',
              input_schema: { type: 'object' },
            },
          ],
          messages: [
            {
              role: 'user',
              content: 'latest React docs and add 2+2',
            },
          ],
        }),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.stop_reason, 'tool_use');
      assertEquals(
        body.content.some((block: { type: string }) => block.type === 'server_tool_use'),
        true,
      );
      assertEquals(
        body.content.some((block: { type: string }) => block.type === 'tool_use'),
        true,
      );
    },
  );

  assertExists(capture.upstreamBody);
  assertEquals(
    (capture.upstreamBody!.tools as Array<Record<string, unknown>>).map(tool => tool.name),
    ['web_search', 'calc'],
  );
  assertEquals(capture.searchBody?.query, 'latest React docs');
});

test('/v1/messages returns internal debug error when native web search is disabled in config', async () => {
  const { apiKey } = await setupAppTest({
    searchConfig: {
      provider: 'disabled',
      tavily: { apiKey: '' },
      microsoftGrounding: { apiKey: '' },
    },
  });

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-native', supported_endpoints: ['/v1/messages'] }]));
      }

      throw new Error(`Unexpected fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-native',
          max_tokens: 64,
          stream: false,
          tools: [makeWebSearchTool()],
          messages: [{ role: 'user', content: 'latest React docs' }],
        }),
      });

      assertEquals(response.status, 500);
      const body = await response.json();
      assertEquals(body.error.type, 'internal_error');
      assertEquals(body.error.source_api, 'messages');
      assertEquals(body.error.message, 'Native Messages web search requires an enabled search provider.');
      assertExists(body.error.stack);
    },
  );
});

test('/v1/messages decodes our native-looking replay into upstream search_result history', async () => {
  const { apiKey } = await setupNativeWebSearchRouteTest();
  const capture: {
    upstreamBody?: Record<string, unknown>;
    upstreamBeta?: string | null;
  } = {};

  await withMockedFetch(
    makeNativeWebSearchUpstreamHandler({
      capture,
      upstreamResponse: makeAssistantSSE('msg_replay_decoded', [...textBlock('Replay accepted.')]),
    }),
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-native',
          max_tokens: 64,
          stream: false,
          messages: makeNativeSearchReplayMessages(),
        }),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.content[0].text, 'Replay accepted.');
    },
  );

  assertExists(capture.upstreamBody);
  const messages = capture.upstreamBody!.messages as Array<Record<string, unknown>>;
  assertEquals(messages.length, 3);
  const replayAssistantContent = messages[1].content as Array<Record<string, unknown>>;
  assertEquals(replayAssistantContent[0].type, 'tool_use');
  assertEquals((replayAssistantContent[1] as { citations?: Array<{ type?: string }> }).citations?.[0]?.type, 'search_result_location');
  assertEquals(((messages[2].content as Array<Record<string, unknown>>)[0] as Record<string, unknown>).type, 'tool_result');
});

test('/v1/messages leaves native-looking replay errors untouched even when native web search stays enabled', async () => {
  const { apiKey } = await setupNativeWebSearchRouteTest();
  const capture: { upstreamBody?: Record<string, unknown> } = {};

  await withMockedFetch(
    makeNativeWebSearchUpstreamHandler({
      capture,
      upstreamResponse: makeAssistantSSE('msg_replay_error_passthrough', [...textBlock('Replay error passthrough accepted.')]),
    }),
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-native',
          max_tokens: 64,
          stream: false,
          tools: [makeWebSearchTool()],
          messages: [...makeNativeSearchErrorReplayMessages(), { role: 'user', content: 'What happened?' }],
        }),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.content[0].text, 'Replay error passthrough accepted.');
    },
  );

  assertExists(capture.upstreamBody);
  const messages = capture.upstreamBody!.messages as Array<Record<string, unknown>>;
  const replayAssistantContent = messages[1].content as Array<Record<string, unknown>>;
  assertEquals(replayAssistantContent[0].type, 'server_tool_use');
  assertEquals(replayAssistantContent[1].type, 'web_search_tool_result');
  assertEquals((replayAssistantContent[1].content as Record<string, unknown>).type, 'web_search_tool_result_error');
});

test('/v1/messages passes through foreign native-looking history and preserves upstream 400', async () => {
  const { apiKey } = await setupAppTest();
  const capture: { upstreamBody?: Record<string, unknown> } = {};
  const upstreamError = {
    error: {
      type: 'invalid_request_error',
      message: 'foreign native history rejected',
    },
  };

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-native', supported_endpoints: ['/v1/messages'] }]));
      }
      if (url.pathname === '/v1/messages') {
        capture.upstreamBody = JSON.parse(await request.text());
        return jsonResponse(upstreamError, 400);
      }

      throw new Error(`Unexpected fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-native',
          max_tokens: 64,
          stream: false,
          messages: makeForeignSearchReplayMessages(),
        }),
      });

      assertEquals(response.status, 400);
      assertEquals(await response.json(), upstreamError);
    },
  );

  assertExists(capture.upstreamBody);
  const foreignAssistantContent = (capture.upstreamBody!.messages as Array<Record<string, unknown>>)[1].content as Array<Record<string, unknown>>;
  assertEquals(foreignAssistantContent[0].type, 'server_tool_use');
});

test('/v1/messages rejects duplicate native web search tools before upstream fetch', async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-native', supported_endpoints: ['/v1/messages'] }]));
      }

      throw new Error(`Unexpected fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-native',
          max_tokens: 64,
          stream: false,
          tools: [{ type: 'web_search_20250305' }, { type: 'web_search_20260209' }],
          messages: [{ role: 'user', content: 'latest React docs' }],
        }),
      });

      assertEquals(response.status, 400);
      assertEquals(await response.json(), {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'Only one native web search tool definition is supported per request.',
        },
      });
    },
  );
});

test('/v1/messages rejects native web search tools whose name is not web_search', async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-native', supported_endpoints: ['/v1/messages'] }]));
      }

      throw new Error(`Unexpected fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-native',
          max_tokens: 64,
          stream: false,
          tools: [{ type: 'web_search_20260209', name: 'WebSearch' }],
          messages: [{ role: 'user', content: 'latest React docs' }],
        }),
      });

      assertEquals(response.status, 400);
      assertEquals(await response.json(), {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: "tools.0.web_search_20260209.name: Input should be 'web_search'",
        },
      });
    },
  );
});

test('/v1/messages rejects native web search tool name collisions before upstream fetch', async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-native', supported_endpoints: ['/v1/messages'] }]));
      }

      throw new Error(`Unexpected fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-native',
          max_tokens: 64,
          stream: false,
          tools: [
            makeWebSearchTool(),
            {
              name: 'web_search',
              description: 'user-defined tool',
              input_schema: { type: 'object' },
            },
          ],
          messages: [{ role: 'user', content: 'latest React docs' }],
        }),
      });

      assertEquals(response.status, 400);
      assertEquals(await response.json(), {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'Native web search tool name collides with another client tool: web_search.',
        },
      });
    },
  );
});

test('/v1/messages routes native web search through translated /responses target', async () => {
  const { apiKey } = await setupNativeWebSearchRouteTest();
  let upstreamResponsesBody: Record<string, unknown> | undefined;
  let searchBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

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
              id: 'gpt-search-via-responses',
              supported_endpoints: ['/responses'],
            },
          ]),
        );
      }
      if (url.pathname === '/responses') {
        upstreamResponsesBody = JSON.parse(await request.text());
        return sseResponse([
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: {
                id: 'resp_search',
                object: 'response',
                model: 'gpt-search-via-responses',
                status: 'completed',
                output_text: '',
                output: [
                  {
                    type: 'function_call',
                    id: 'fc_1',
                    call_id: 'toolu_search_1',
                    name: 'web_search',
                    arguments: '{"query":"latest React docs"}',
                    status: 'completed',
                  },
                ],
                usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
              },
            },
          },
        ]);
      }
      if (url.hostname === 'api.tavily.com' && url.pathname === '/search') {
        searchBody = JSON.parse(await request.text());
        return jsonResponse({
          results: [
            {
              title: 'React',
              url: 'https://react.dev',
              published_date: '2026-04-01',
              content: 'Official React docs',
            },
          ],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'gpt-search-via-responses',
          max_tokens: 64,
          stream: false,
          tools: [makeWebSearchTool()],
          messages: [{ role: 'user', content: 'latest React docs' }],
        }),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.stop_reason, 'pause_turn');
      assertEquals(body.content[0].type, 'server_tool_use');
      assertEquals(body.content[0].name, 'web_search');
      assertEquals(body.content[0].input.query, 'latest React docs');
      assertEquals(body.content[1].type, 'web_search_tool_result');
      assertEquals(body.content[1].content[0].url, 'https://react.dev');
      assertEquals(body.usage.server_tool_use.web_search_requests, 1);
    },
  );

  assertExists(upstreamResponsesBody);
  // Shim rewrote the native tool into an ordinary client function tool before
  // the translator turned it into a Responses function tool.
  const upstreamTools = upstreamResponsesBody!.tools as Array<Record<string, unknown>>;
  assertEquals(upstreamTools.length, 1);
  assertEquals(upstreamTools[0].type, 'function');
  assertEquals(upstreamTools[0].name, 'web_search');
  assertEquals(searchBody?.query, 'latest React docs');
});

test('/v1/messages routes native web search through translated /chat/completions target', async () => {
  const { apiKey } = await setupNativeWebSearchRouteTest();
  let upstreamChatBody: Record<string, unknown> | undefined;
  let searchBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

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
              id: 'gpt-search-via-chat',
              supported_endpoints: ['/chat/completions'],
            },
          ]),
        );
      }
      if (url.pathname === '/chat/completions') {
        upstreamChatBody = JSON.parse(await request.text());
        return sseResponse([
          {
            data: {
              id: 'chatcmpl_search',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-search-via-chat',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'toolu_search_1',
                        type: 'function',
                        function: {
                          name: 'web_search',
                          arguments: '{"query":"latest React docs"}',
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: { prompt_tokens: 12, completion_tokens: 5 },
            },
          },
          { data: '[DONE]' },
        ]);
      }
      if (url.hostname === 'api.tavily.com' && url.pathname === '/search') {
        searchBody = JSON.parse(await request.text());
        return jsonResponse({
          results: [
            {
              title: 'React',
              url: 'https://react.dev',
              published_date: '2026-04-01',
              content: 'Official React docs',
            },
          ],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'gpt-search-via-chat',
          max_tokens: 64,
          stream: false,
          tools: [makeWebSearchTool()],
          messages: [{ role: 'user', content: 'latest React docs' }],
        }),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.stop_reason, 'pause_turn');
      assertEquals(body.content[0].type, 'server_tool_use');
      assertEquals(body.content[0].name, 'web_search');
      assertEquals(body.content[0].input.query, 'latest React docs');
      assertEquals(body.content[1].type, 'web_search_tool_result');
      assertEquals(body.content[1].content[0].url, 'https://react.dev');
      assertEquals(body.usage.server_tool_use.web_search_requests, 1);
    },
  );

  assertExists(upstreamChatBody);
  const upstreamTools = upstreamChatBody!.tools as Array<Record<string, unknown>>;
  assertEquals(upstreamTools.length, 1);
  assertEquals(upstreamTools[0].type, 'function');
  assertEquals((upstreamTools[0].function as Record<string, unknown>).name, 'web_search');
  assertEquals(searchBody?.query, 'latest React docs');
});

test('/v1/messages rejects embedding-only custom upstream model instead of legacy chat fallback', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearModelsStore();
  await clearCopilotTokenCache();

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_embed',
    name: 'Embedding Only',
    sortOrder: 100,
    flagOverrides: {},
    config: {
      baseUrl: 'https://embed.example.com',
      bearerToken: 'sk-embed',
      supportedEndpoints: [],
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'embed.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: [{ id: 'embed-model' }],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'embed-model',
          max_tokens: 100,
          stream: false,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });

      assertEquals(response.status, 400);
      const body = await response.json();
      assertStringIncludes(body.error.message, 'does not support the /messages endpoint');
    },
  );
});

test('/v1/messages preserves custom upstream /models HTTP errors', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearModelsStore();
  await clearCopilotTokenCache();

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_custom',
    name: 'Custom Provider',
    sortOrder: 100,
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
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'custom-chat-model',
          max_tokens: 100,
          stream: false,
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

// Regression: when the Messages source translates to a non-Messages upstream
// target (Responses / Chat Completions), the source-side header interceptors
// (compact / claude-agent / interaction-id) mutate the original Messages
// invocation's `headers` bag. Each translated emit must share that same bag
// by reference so the upstream HTTP call observes the mutations.
test('/v1/messages threads Claude Code messages-proxy headers through translated /chat/completions target', async () => {
  const { apiKey } = await setupAppTest();
  let upstreamHeaders: Headers | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-chat-only', supported_endpoints: ['/chat/completions'] }]));
      }
      if (url.pathname === '/chat/completions') {
        upstreamHeaders = request.headers;
        return sseResponse([
          {
            data: {
              id: 'chatcmpl_header_thread',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-chat-only',
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', content: 'ok' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 5, completion_tokens: 1 },
            },
          },
          { data: '[DONE]' },
        ]);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'gpt-chat-only',
          max_tokens: 16,
          stream: false,
          // The Claude Code SDK metadata fingerprint triggers
          // `withClaudeAgentHeadersSet` and `withInteractionIdHeaderSet`.
          metadata: { user_id: JSON.stringify({ device_id: 'dev-1', session_id: 'sess-r1' }) },
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });

      assertEquals(response.status, 200);
    },
  );

  assertExists(upstreamHeaders);
  // `messages-proxy` intent + interaction-id should reach the translated Chat
  // Completions upstream call exactly as they would reach a native Messages
  // call.
  assertEquals(upstreamHeaders!.get('x-interaction-type'), 'messages-proxy');
  assertEquals(upstreamHeaders!.get('openai-intent'), 'messages-proxy');
  // x-interaction-id is the SHA-256 of the raw session id formatted as a
  // UUIDv4 (matches caozhiyuan's getUUID); 'sess-r1' deterministically maps
  // to this value.
  assertEquals(upstreamHeaders!.get('x-interaction-id'), '382a0257-708e-4a7e-8be2-362b27fdbbbb');
});
