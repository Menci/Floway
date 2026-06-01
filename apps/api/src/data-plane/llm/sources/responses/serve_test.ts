import { test } from 'vitest';

import { createStoredResponsesItemId, isStoredResponsesItemId } from './items/format.ts';
import { clearCopilotTokenCache } from '../../../../shared/copilot.ts';
import { assertEquals, assertExists, assertFalse, assertStringIncludes } from '../../../../test-assert.ts';
import { buildCustomUpstreamRecord, copilotModels, jsonResponse, parseSSEText, requestApp, setupAppTest, sseChatCompletionsResponse, sseResponse, sseResponsesResponse, withMockedFetch } from '../../../../test-helpers.ts';
import { FakeTime } from '../../../../test-time.ts';
import { clearModelsStore } from '../../../providers/models-store.ts';
import { DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS } from '../../shared/stream/proxy-sse.ts';

type PromiseState<T> = { type: 'pending' } | { type: 'fulfilled'; value: T } | { type: 'rejected'; error: unknown };

const promiseStateWithin = async <T>(promise: Promise<T>, timeoutMs: number): Promise<PromiseState<T>> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        (value): PromiseState<T> => ({ type: 'fulfilled', value }),
        (error): PromiseState<T> => ({ type: 'rejected', error }),
      ),
      new Promise<PromiseState<T>>(resolve => {
        timeoutId = setTimeout(() => resolve({ type: 'pending' }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

const decodeChunk = (value: Uint8Array | undefined): string => new TextDecoder().decode(value);

test('/v1/responses rejects previous_response_id at the entrypoint', async () => {
  const { apiKey } = await setupAppTest();
  let fetchCalls = 0;

  await withMockedFetch(
    () => {
      fetchCalls++;
      throw new Error('unexpected upstream fetch');
    },
    async () => {
      const response = await requestApp('/v1/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'gpt-direct-responses',
          previous_response_id: 'resp_previous',
          input: [{ type: 'message', role: 'user', content: 'Hi' }],
          stream: false,
        }),
      });

      assertEquals(response.status, 400);
      const body = await response.json();
      assertEquals(body.error.message, "Previous response with id 'resp_previous' not found.");
      assertEquals(body.error.type, 'invalid_request_error');
      assertEquals(body.error.param, 'previous_response_id');
      assertEquals(body.error.code, 'previous_response_not_found');
    },
  );

  assertEquals(fetchCalls, 0);
});

test('/v1/responses returns planner not_found for non-stored item_reference without generation', async () => {
  const { apiKey } = await setupAppTest();
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
        return jsonResponse(copilotModels([{ id: 'gpt-direct-responses', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        generationFetchCalls++;
        throw new Error('unexpected upstream generation fetch');
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'gpt-direct-responses',
          input: [
            { type: 'item_reference', id: 'item_previous' },
            { type: 'message', role: 'user', content: 'Continue' },
          ],
          stream: false,
        }),
      });

      assertEquals(response.status, 404);
      const body = await response.json();
      assertEquals(body.error.message, "Item with id 'item_previous' not found.");
      assertEquals(body.error.type, 'invalid_request_error');
      assertEquals(body.error.param, 'input');
      assertEquals(body.error.code, null);
    },
  );

  assertEquals(generationFetchCalls, 0);
});

test('/v1/responses expands stored synthetic item_reference before the upstream request', async () => {
  const { apiKey, repo } = await setupAppTest();
  const storedItem = {
    type: 'message',
    id: 'msg_synthetic_body',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'expanded synthetic context' }],
  };
  const id = createStoredResponsesItemId('message');
  await repo.responsesItems.insertMany([
    {
      id,
      apiKeyId: apiKey.id,
      upstreamId: null,
      upstreamItemId: null,
      itemType: 'message',
      encryptedContentHash: null,
      // payload.item.id is the original wire id, distinct from the stored row
      // id; the rewriter preserves it verbatim on the wire for synthetic rows.
      payload: { item: storedItem },
      createdAt: Date.now(),
    },
  ]);

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
        return jsonResponse(copilotModels([{ id: 'gpt-direct-responses', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        upstreamBody = JSON.parse(await request.text()) as Record<string, unknown>;
        return sseResponsesResponse({
          id: 'resp_stored_reference',
          object: 'response',
          model: 'gpt-direct-responses',
          status: 'completed',
          output: [],
          output_text: 'ok',
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'gpt-direct-responses',
          input: [
            { type: 'item_reference', id },
            { type: 'message', role: 'user', content: 'Continue' },
          ],
          stream: false,
        }),
      });

      assertEquals(response.status, 200);
      await response.json();
    },
  );

  assertExists(upstreamBody);
  const input = upstreamBody.input as Array<Record<string, unknown>>;
  assertEquals(input[0].type, 'message');
  assertEquals(input[0].id, storedItem.id);
  assertEquals(input[0].content, [{ type: 'output_text', text: 'expanded synthetic context' }]);
});

test('/v1/responses expands same-origin item_reference for Copilot because Copilot does not support references', async () => {
  const { apiKey, repo, copilotUpstream } = await setupAppTest();
  const storedItem = {
    type: 'message',
    id: 'raw_msg_copilot_body',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'expanded Copilot context' }],
  };
  const id = createStoredResponsesItemId('message');
  await repo.responsesItems.insertMany([
    {
      id,
      apiKeyId: apiKey.id,
      upstreamId: copilotUpstream.id,
      upstreamItemId: 'raw_msg_copilot',
      itemType: 'message',
      encryptedContentHash: null,
      payload: { item: { ...storedItem, id } },
      createdAt: Date.now(),
    },
  ]);

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
        return jsonResponse(copilotModels([{ id: 'gpt-direct-responses', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        upstreamBody = JSON.parse(await request.text()) as Record<string, unknown>;
        return sseResponsesResponse({
          id: 'resp_stored_reference',
          object: 'response',
          model: 'gpt-direct-responses',
          status: 'completed',
          output: [],
          output_text: 'ok',
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'gpt-direct-responses',
          input: [
            { type: 'item_reference', id },
            { type: 'message', role: 'user', content: 'Continue' },
          ],
          stream: false,
        }),
      });

      assertEquals(response.status, 200);
      await response.json();
    },
  );

  assertExists(upstreamBody);
  const input = upstreamBody.input as Array<Record<string, unknown>>;
  assertEquals(input[0], {
    type: 'message',
    id: 'raw_msg_copilot',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'expanded Copilot context' }],
  });
});

test('/v1/responses rejects metadata-only item_reference for Copilot before upstream generation', async () => {
  const { apiKey, repo, copilotUpstream } = await setupAppTest();
  const id = createStoredResponsesItemId('message');
  await repo.responsesItems.insertMany([
    {
      id,
      apiKeyId: apiKey.id,
      upstreamId: copilotUpstream.id,
      upstreamItemId: 'raw_msg_copilot_metadata',
      itemType: 'message',
      encryptedContentHash: null,
      payload: null,
      createdAt: Date.now(),
    },
  ]);
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
        return jsonResponse(copilotModels([{ id: 'gpt-direct-responses', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        generationFetchCalls++;
        throw new Error('unexpected upstream generation fetch');
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'gpt-direct-responses',
          input: [
            { type: 'item_reference', id },
            { type: 'message', role: 'user', content: 'Continue' },
          ],
          stream: false,
        }),
      });

      assertEquals(response.status, 404);
      const body = await response.json();
      assertEquals(body.error.message, `Item with id '${id}' not found.`);
      assertEquals(body.error.type, 'invalid_request_error');
      assertEquals(body.error.param, 'input');
      assertEquals(body.error.code, null);
    },
  );

  assertEquals(generationFetchCalls, 0);
});

test('/v1/responses prefers latest portable stored-item origin and rewrites only that origin id', async () => {
  const { apiKey, repo, copilotUpstream } = await setupAppTest();
  await repo.upstreams.delete(copilotUpstream.id);
  clearModelsStore();
  await clearCopilotTokenCache();

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_a',
    name: 'Origin A',
    sortOrder: 0,
    config: { baseUrl: 'https://origin-a.example.com', bearerToken: 'sk-a', supportedEndpoints: ['/responses'] },
  }));
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_b',
    name: 'Origin B',
    sortOrder: 100,
    config: { baseUrl: 'https://origin-b.example.com', bearerToken: 'sk-b', supportedEndpoints: ['/responses'] },
  }));

  const firstItem = { type: 'reasoning', id: 'rs_first_body', summary: [{ type: 'summary_text', text: 'first' }] };
  const secondItem = { type: 'reasoning', id: 'rs_second_body', summary: [{ type: 'summary_text', text: 'second' }] };
  const firstId = createStoredResponsesItemId('reasoning');
  const secondId = createStoredResponsesItemId('reasoning');
  await repo.responsesItems.insertMany([
    {
      id: firstId,
      apiKeyId: apiKey.id,
      upstreamId: 'up_a',
      upstreamItemId: 'raw_rs_a',
      itemType: 'reasoning',
      encryptedContentHash: null,
      payload: { item: { ...firstItem, id: firstId } },
      createdAt: Date.now(),
    },
    {
      id: secondId,
      apiKeyId: apiKey.id,
      upstreamId: 'up_b',
      upstreamItemId: 'raw_rs_b',
      itemType: 'reasoning',
      encryptedContentHash: null,
      payload: { item: { ...secondItem, id: secondId } },
      createdAt: Date.now(),
    },
  ]);

  let upstreamHost = '';
  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if ((url.hostname === 'origin-a.example.com' || url.hostname === 'origin-b.example.com') && url.pathname === '/v1/models') {
        return jsonResponse({ data: [{ id: 'stored-model' }] });
      }
      if (url.pathname === '/v1/responses') {
        upstreamHost = url.hostname;
        upstreamBody = JSON.parse(await request.text()) as Record<string, unknown>;
        return sseResponsesResponse({
          id: 'resp_stored_reasoning',
          object: 'response',
          model: 'stored-model',
          status: 'completed',
          output: [],
          output_text: 'ok',
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'stored-model',
          input: [
            { type: 'reasoning', id: firstId, summary: [{ type: 'summary_text', text: 'first' }] },
            { type: 'reasoning', id: secondId, summary: [{ type: 'summary_text', text: 'second' }] },
            { type: 'message', role: 'user', content: 'Continue' },
          ],
        }),
      });

      assertEquals(response.status, 200);
      await response.json();
    },
  );

  assertEquals(upstreamHost, 'origin-b.example.com');
  assertExists(upstreamBody);
  assertEquals(upstreamBody.input, [
    { type: 'reasoning', id: 'raw_rs_b', summary: [{ type: 'summary_text', text: 'second' }] },
    { type: 'message', role: 'user', content: 'Continue' },
  ]);
});

test('/v1/responses falls back with portable non-origin message items using temporary ids', async () => {
  const { apiKey, repo, copilotUpstream } = await setupAppTest();
  await repo.upstreams.delete(copilotUpstream.id);
  clearModelsStore();
  await clearCopilotTokenCache();

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_a',
    name: 'Origin A',
    sortOrder: 0,
    config: { baseUrl: 'https://origin-a.example.com', bearerToken: 'sk-a', supportedEndpoints: ['/responses'] },
  }));
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_b',
    name: 'Origin B',
    sortOrder: 100,
    config: { baseUrl: 'https://origin-b.example.com', bearerToken: 'sk-b', supportedEndpoints: ['/responses'] },
  }));

  const firstItem = { type: 'message', id: 'msg_first_body', role: 'assistant', content: [{ type: 'output_text', text: 'first' }] };
  const secondItem = { type: 'message', id: 'msg_second_body', role: 'assistant', content: [{ type: 'output_text', text: 'second' }] };
  const firstId = createStoredResponsesItemId('message');
  const secondId = createStoredResponsesItemId('message');
  await repo.responsesItems.insertMany([
    {
      id: firstId,
      apiKeyId: apiKey.id,
      upstreamId: 'up_a',
      upstreamItemId: 'raw_msg_a',
      itemType: 'message',
      encryptedContentHash: null,
      payload: { item: { ...firstItem, id: firstId } },
      createdAt: Date.now(),
    },
    {
      id: secondId,
      apiKeyId: apiKey.id,
      upstreamId: 'up_b',
      upstreamItemId: 'raw_msg_b',
      itemType: 'message',
      encryptedContentHash: null,
      payload: { item: { ...secondItem, id: secondId } },
      createdAt: Date.now(),
    },
  ]);

  let upstreamHost = '';
  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if ((url.hostname === 'origin-a.example.com' || url.hostname === 'origin-b.example.com') && url.pathname === '/v1/models') {
        return jsonResponse({ data: [{ id: 'stored-model' }] });
      }
      if (url.pathname === '/v1/responses') {
        upstreamHost = url.hostname;
        upstreamBody = JSON.parse(await request.text()) as Record<string, unknown>;
        return sseResponsesResponse({
          id: 'resp_stored_messages',
          object: 'response',
          model: 'stored-model',
          status: 'completed',
          output: [],
          output_text: 'ok',
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'stored-model',
          input: [
            { type: 'message', id: firstId, role: 'assistant', content: [{ type: 'output_text', text: 'stale first' }] },
            { type: 'message', id: secondId, role: 'assistant', content: [{ type: 'output_text', text: 'stale second' }] },
            { type: 'message', role: 'user', content: 'Continue' },
          ],
        }),
      });

      assertEquals(response.status, 200);
      await response.json();
    },
  );

  assertEquals(upstreamHost, 'origin-b.example.com');
  assertExists(upstreamBody);
  const input = upstreamBody.input as Array<Record<string, unknown>>;
  assertEquals((input[0].id as string).startsWith('msg_tmp_'), true);
  assertEquals(input[0].content, [{ type: 'output_text', text: 'first' }]);
  assertEquals(input[1].id, 'raw_msg_b');
  assertEquals(input[1].content, [{ type: 'output_text', text: 'second' }]);
  assertEquals(input[2], { type: 'message', role: 'user', content: 'Continue' });
});

test('/v1/responses rejects multiple forcing stored-item origins before generation', async () => {
  const { apiKey, repo } = await setupAppTest();
  const firstItem = { type: 'compaction', id: 'cmp_first' };
  const secondItem = { type: 'compaction', id: 'cmp_second' };
  const firstId = createStoredResponsesItemId('compaction');
  const secondId = createStoredResponsesItemId('compaction');
  await repo.responsesItems.insertMany([
    {
      id: firstId,
      apiKeyId: apiKey.id,
      upstreamId: 'up_a',
      upstreamItemId: 'raw_cmp_a',
      itemType: 'compaction',
      encryptedContentHash: null,
      payload: { item: { ...firstItem, id: firstId } },
      createdAt: Date.now(),
    },
    {
      id: secondId,
      apiKeyId: apiKey.id,
      upstreamId: 'up_b',
      upstreamItemId: 'raw_cmp_b',
      itemType: 'compaction',
      encryptedContentHash: null,
      payload: { item: { ...secondItem, id: secondId } },
      createdAt: Date.now(),
    },
  ]);
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
        return jsonResponse(copilotModels([{ id: 'gpt-direct-responses', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        generationFetchCalls++;
        throw new Error('unexpected upstream generation fetch');
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'gpt-direct-responses',
          input: [
            { type: 'compaction', id: firstId },
            { type: 'compaction', id: secondId },
          ],
        }),
      });

      assertEquals(response.status, 400);
      const body = await response.json();
      assertEquals(body.error.code, 'responses_item_routing_unavailable');
    },
  );

  assertEquals(generationFetchCalls, 0);
});

test('/v1/responses rewrites codex-auto-review to gpt-5.4 low reasoning at the entrypoint', async () => {
  const { apiKey, repo } = await setupAppTest();

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
              id: 'gpt-5.4',
              supported_endpoints: ['/responses'],
              reasoningEfforts: ['low', 'medium', 'high'],
            },
          ]),
        );
      }
      if (url.pathname === '/responses') {
        upstreamBody = JSON.parse(await request.text()) as Record<string, unknown>;
        return sseResponse([
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: {
                id: 'resp_codex_auto_review',
                object: 'response',
                model: 'gpt-5.4-internal-version',
                status: 'completed',
                output: [],
                output_text: 'done',
                usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
              },
            },
          },
        ]);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'codex-auto-review',
          input: [{ type: 'message', role: 'user', content: 'Review this' }],
          reasoning: { effort: 'high', summary: 'auto' },
          stream: false,
        }),
      });

      assertEquals(response.status, 200);
      await response.json();
    },
  );

  assertExists(upstreamBody);
  assertEquals(upstreamBody.model, 'gpt-5.4');
  assertEquals(upstreamBody.reasoning, { summary: 'auto', effort: 'low' });

  const usage = await repo.usage.listAll();
  assertEquals(usage.length, 1);
  assertEquals(usage[0].model, 'gpt-5.4');
  assertEquals(usage[0].tokens.input, 3);
  assertEquals(usage[0].tokens.output, 5);
});

test('/v1/responses direct mode preserves custom apply_patch and fixes mismatched stream item IDs', async () => {
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
        return jsonResponse(copilotModels([{ id: 'gpt-direct-responses', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        upstreamBody = JSON.parse(await request.text());
        return sseResponse([
          {
            event: 'response.output_item.added',
            data: {
              type: 'response.output_item.added',
              output_index: 0,
              item: {
                id: 'item_orig',
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: '' }],
              },
            },
          },
          {
            event: 'response.output_item.done',
            data: {
              type: 'response.output_item.done',
              output_index: 0,
              item: {
                id: 'item_wrong',
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'done' }],
              },
            },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: {
                id: 'resp_direct',
                object: 'response',
                model: 'gpt-direct-responses',
                status: 'completed',
                output_text: 'done',
                output: [],
              },
            },
          },
        ]);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'gpt-direct-responses',
          input: [{ type: 'message', role: 'user', content: 'Patch this' }],
          instructions: null,
          temperature: 1,
          top_p: null,
          service_tier: 'auto',
          max_output_tokens: 32,
          tools: [
            { type: 'image_generation' },
            {
              type: 'custom',
              name: 'apply_patch',
              description: 'Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.',
              format: { type: 'grammar', syntax: 'lark', definition: 'start: "ok"' },
            },
          ],
          tool_choice: 'auto',
          metadata: null,
          stream: true,
          store: false,
          parallel_tool_calls: true,
        }),
      });

      assertEquals(response.status, 200);
      const text = await response.text();
      const events = parseSSEText(text);
      assertEquals(events.length, 3);
      const added = JSON.parse(events[0].data as string) as { item: { id: string } };
      const done = JSON.parse(events[1].data as string) as { item: { id: string } };
      assertEquals(isStoredResponsesItemId(added.item.id), true);
      assertEquals(done.item.id, added.item.id);
      assertFalse(text.includes('"id":"item_orig"'));
      assertFalse(text.includes('"id":"item_wrong"'));
    },
  );

  assertExists(upstreamBody);
  assertEquals((upstreamBody!.tools as Array<Record<string, unknown>>).length, 1);
  const tool = (upstreamBody!.tools as Array<Record<string, unknown>>)[0];
  assertEquals(tool.type, 'custom');
  assertEquals(tool.name, 'apply_patch');
  assertEquals(tool.format, { type: 'grammar', syntax: 'lark', definition: 'start: "ok"' });
  assertFalse('parameters' in tool);
  assertFalse('service_tier' in upstreamBody!);
});

test('/v1/responses direct mode emits keepalive before the first upstream Responses frame', async () => {
  const { apiKey } = await setupAppTest();
  const encoder = new TextEncoder();
  let upstreamStarted!: () => void;
  const upstreamStartedPromise = new Promise<void>(resolve => {
    upstreamStarted = resolve;
  });
  let upstreamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let upstreamCanceled = false;
  const upstreamBody = new ReadableStream<Uint8Array>({
    start(controller) {
      upstreamController = controller;
    },
    cancel() {
      upstreamCanceled = true;
    },
  });
  const completedFrame = encoder.encode(
    `event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_idle_keepalive',
        object: 'response',
        model: 'gpt-idle-responses',
        status: 'completed',
        output_text: '',
        output: [],
      },
    })}\n\n`,
  );

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
        return jsonResponse(copilotModels([{ id: 'gpt-idle-responses', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        upstreamStarted();
        return new Response(upstreamBody, {
          headers: { 'content-type': 'text/event-stream' },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const time = new FakeTime();
      try {
        const responsePromise = requestApp('/v1/responses', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey.key,
          },
          body: JSON.stringify({
            model: 'gpt-idle-responses',
            input: [{ type: 'message', role: 'user', content: 'Hi' }],
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
          }),
        });

        await upstreamStartedPromise;
        const responseStatePromise = promiseStateWithin(responsePromise, 1);
        await time.tickAsync(1);
        const responseState = await responseStatePromise;
        if (responseState.type !== 'fulfilled') {
          upstreamController?.enqueue(completedFrame);
          upstreamController?.close();
          const response = await responsePromise;
          await response.body?.cancel();
        }

        assertEquals(responseState.type, 'fulfilled');
        if (responseState.type !== 'fulfilled') return;

        const reader = responseState.value.body!.getReader();
        try {
          const read = reader.read();
          await time.tickAsync(DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS);
          const chunk = await read;

          assertEquals(chunk.done, false);
          assertEquals(decodeChunk(chunk.value), ': keepalive\n\n');

          await reader.cancel('client stopped while upstream was idle');
          for (let i = 0; i < 10; i++) {
            if (upstreamCanceled) break;
            await Promise.resolve();
          }
          assertEquals(upstreamCanceled, true);
        } finally {
          await reader.cancel().catch(() => {});
        }
      } finally {
        time.restore();
      }
    },
  );
});

test('/v1/responses streams malformed upstream Responses SSE as an error event', async () => {
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
        return jsonResponse(copilotModels([{ id: 'gpt-malformed-responses', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        return new Response('event: response.output_text.delta\ndata: not json', { headers: { 'content-type': 'text/event-stream' } });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'gpt-malformed-responses',
          input: [{ type: 'message', role: 'user', content: 'Hi' }],
          stream: true,
        }),
      });

      assertEquals(response.status, 200);

      const events = parseSSEText(await response.text());
      assertEquals(events.length, 1);
      assertEquals(events[0].event, 'error');

      const event = JSON.parse(events[0].data);
      assertEquals(event.type, 'error');
      assertEquals(event.code, 'internal_error');
      assertStringIncludes(event.message, 'Malformed upstream Responses SSE JSON for event "response.output_text.delta": not json');
      assertExists(event.stack);
    },
  );
});

test('/v1/responses direct mode expands upstream fast-path (wrapper-only SSE) into the full Responses SSE sequence', async () => {
  // Upstreams (notably Copilot for short prompts) sometimes only stream the
  // created/in_progress wrappers and a terminal response.completed without
  // emitting any structured item/delta frames. The target boundary expands
  // that fast-path in place via responsesResultToEvents so downstream clients
  // always observe one canonical full sequence.
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
              id: 'gpt-direct-responses-fastpath',
              supported_endpoints: ['/responses'],
            },
          ]),
        );
      }
      if (url.pathname === '/responses') {
        return sseResponsesResponse({
          id: 'resp_fastpath',
          object: 'response',
          model: 'gpt-direct-responses-fastpath',
          status: 'completed',
          output_text: 'Hello',
          output: [
            {
              type: 'message',
              id: 'msg_fastpath',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Hello' }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'gpt-direct-responses-fastpath',
          input: [{ type: 'message', role: 'user', content: 'Hi' }],
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
        }),
      });

      assertEquals(response.status, 200);
      assertEquals(response.headers.get('content-type'), 'text/event-stream');

      const events = parseSSEText(await response.text());

      assertEquals(
        events.map(event => event.event),
        [
          'response.created',
          'response.in_progress',
          'response.output_item.added',
          'response.content_part.added',
          'response.output_text.delta',
          'response.output_text.done',
          'response.content_part.done',
          'response.output_item.done',
          'response.completed',
        ],
      );

      const created = JSON.parse(events[0].data) as Record<string, unknown>;
      const inProgress = JSON.parse(events[1].data) as Record<string, unknown>;
      const delta = JSON.parse(events[4].data) as Record<string, unknown>;
      const completed = JSON.parse(events[8].data) as Record<string, unknown>;

      assertEquals(created.sequence_number, 0);
      assertEquals((created.response as Record<string, unknown>).status, 'in_progress');
      assertEquals((created.response as Record<string, unknown>).output, []);
      assertEquals((created.response as Record<string, unknown>).output_text, '');
      assertFalse('error' in (created.response as Record<string, unknown>));
      assertFalse('incomplete_details' in (created.response as Record<string, unknown>));
      assertEquals((inProgress.response as Record<string, unknown>).output, []);
      assertEquals((inProgress.response as Record<string, unknown>).output_text, '');
      assertEquals(delta.sequence_number, 4);
      assertEquals(delta.delta, 'Hello');
      assertEquals((completed.response as Record<string, unknown>).status, 'completed');
      assertEquals((completed.response as Record<string, unknown>).output_text, 'Hello');
    },
  );
});

test('/v1/responses resolves Claude reasoning variants before planning', async () => {
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
              supported_endpoints: ['/responses'],
              reasoningEfforts: ['medium'],
            },
            {
              id: 'claude-opus-4.7-xhigh',
              supported_endpoints: ['/responses'],
              reasoningEfforts: ['xhigh'],
            },
          ]),
        );
      }
      if (url.pathname === '/responses') {
        upstreamBody = JSON.parse(await request.text()) as Record<string, unknown>;
        return sseResponsesResponse({
          id: 'resp_claude_variant',
          object: 'response',
          model: 'claude-opus-4.7-xhigh',
          status: 'completed',
          output_text: 'ok',
          output: [
            {
              type: 'message',
              id: 'msg_reasoning',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'ok' }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-opus-4-7',
          input: [{ type: 'message', role: 'user', content: 'Hi' }],
          reasoning: { effort: 'xhigh' },
          max_output_tokens: 32,
          stream: false,
        }),
      });

      assertEquals(response.status, 200);
      assertEquals((await response.json()).output_text, 'ok');
    },
  );

  assertEquals(upstreamBody?.model, 'claude-opus-4.7-xhigh');
});

test('/v1/responses malformed JSON returns structured internal debug error', async () => {
  const { apiKey } = await setupAppTest();

  const response = await requestApp('/v1/responses', {
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
  assertEquals(body.error.source_api, 'responses');
  assertExists(body.error.stack);
});

test('/v1/responses falls back to chat completions for chat-only models', async () => {
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
              id: 'gpt-chat-only-responses',
              supported_endpoints: ['/chat/completions'],
            },
          ]),
        );
      }
      if (url.pathname === '/chat/completions') {
        upstreamBody = JSON.parse(await request.text());
        return sseChatCompletionsResponse({
          id: 'chatcmpl_resp_only',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-chat-only-responses',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'Hello from chat',
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 4,
            total_tokens: 16,
          },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'gpt-chat-only-responses',
          input: [{ type: 'message', role: 'user', content: 'Hi' }],
          instructions: 'system prompt',
          temperature: 0.7,
          top_p: 0.8,
          max_output_tokens: 128,
          tools: null,
          tool_choice: 'auto',
          metadata: null,
          stream: false,
          store: false,
          parallel_tool_calls: true,
        }),
      });

      assertEquals(response.status, 200);

      const body = await response.json();
      assertEquals(body.status, 'completed');
      assertEquals(body.output_text, 'Hello from chat');
      assertEquals(body.output[0].type, 'message');
      assertEquals(body.output[0].content[0].text, 'Hello from chat');
    },
  );

  assertExists(upstreamBody);
  const messages = upstreamBody!.messages as Array<Record<string, unknown>>;
  assertEquals(upstreamBody!.model, 'gpt-chat-only-responses');
  assertEquals(messages[0].role, 'system');
  assertEquals(messages[0].content, 'system prompt');
  assertEquals(messages[1].role, 'user');
  assertEquals(messages[1].content, 'Hi');
  assertEquals(upstreamBody!.max_tokens, 128);
});

test('/v1/responses streams chat completions as Responses SSE for chat-only models', async () => {
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
              id: 'gpt-chat-only-stream',
              supported_endpoints: ['/chat/completions'],
            },
          ]),
        );
      }
      if (url.pathname === '/chat/completions') {
        return sseResponse([
          {
            data: {
              id: 'chatcmpl_stream_only',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-chat-only-stream',
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
              id: 'chatcmpl_stream_only',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-chat-only-stream',
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
              id: 'chatcmpl_stream_only',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-chat-only-stream',
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
              id: 'chatcmpl_stream_only',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-chat-only-stream',
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
      const response = await requestApp('/v1/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'gpt-chat-only-stream',
          input: [{ type: 'message', role: 'user', content: 'Hi' }],
          instructions: null,
          temperature: 1,
          top_p: null,
          max_output_tokens: 64,
          tools: null,
          tool_choice: 'auto',
          metadata: null,
          stream: true,
          store: false,
          parallel_tool_calls: true,
        }),
      });

      assertEquals(response.status, 200);
      assertEquals(response.headers.get('content-type'), 'text/event-stream');

      const events = parseSSEText(await response.text());

      assertEquals(
        events.map(event => event.event),
        [
          'response.created',
          'response.in_progress',
          'response.output_item.added',
          'response.content_part.added',
          'response.output_text.delta',
          'response.output_text.done',
          'response.content_part.done',
          'response.output_item.done',
          'response.completed',
        ],
      );

      const delta = JSON.parse(events[4].data) as Record<string, unknown>;
      const completed = JSON.parse(events[8].data) as Record<string, unknown>;

      assertEquals(delta.delta, 'Hello');
      assertEquals((completed.response as Record<string, unknown>).output_text, 'Hello');
      assertEquals(((completed.response as Record<string, unknown>).usage as Record<string, unknown>).output_tokens, 4);
    },
  );
});

test('/v1/responses via messages fills missing max_tokens from model limits', async () => {
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
              id: 'claude-via-messages-limit',
              name: 'claude-via-messages-limit',
              version: '1',
              object: 'model',
              supported_endpoints: ['/v1/messages'],
              capabilities: {
                family: 'test',
                type: 'chat',
                limits: { max_output_tokens: 4096 },
                supports: {},
              },
            },
          ],
        });
      }
      if (url.pathname === '/v1/messages') {
        upstreamBody = JSON.parse(await request.text());
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
                model: 'claude-via-messages-limit',
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
      const response = await requestApp('/v1/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-via-messages-limit',
          input: [{ type: 'message', role: 'user', content: 'Hi' }],
          instructions: null,
          temperature: 1,
          top_p: null,
          max_output_tokens: null,
          tools: null,
          tool_choice: 'auto',
          metadata: null,
          stream: false,
          store: false,
          parallel_tool_calls: true,
        }),
      });

      assertEquals(response.status, 200);
      assertEquals((await response.json()).status, 'completed');
    },
  );

  assertExists(upstreamBody);
  assertEquals(upstreamBody!.max_tokens, 4096);
});

test('/v1/responses prefers messages over chat completions when both translated paths are available', async () => {
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
              id: 'claude-via-messages',
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
                id: 'msg_123',
                type: 'message',
                role: 'assistant',
                content: [],
                model: 'claude-via-messages',
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 11, output_tokens: 0 },
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
              delta: { type: 'text_delta', text: 'Hello' },
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
              usage: { output_tokens: 9 },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-via-messages',
          input: [{ type: 'message', role: 'user', content: 'Hi' }],
          instructions: null,
          temperature: 1,
          top_p: null,
          max_output_tokens: null,
          tools: [
            {
              type: 'function',
              name: 'lookup',
              parameters: { type: 'object' },
              strict: false,
            },
          ],
          tool_choice: 'auto',
          metadata: null,
          stream: true,
          store: false,
          parallel_tool_calls: true,
        }),
      });

      assertEquals(response.status, 200);
      const text = await response.text();
      const events = parseSSEText(text);

      assertEquals(events[0].event, 'response.created');
      assertEquals(events[1].event, 'response.in_progress');
      assertEquals(events[4].event, 'response.output_text.delta');
      assertEquals(events[events.length - 1].event, 'response.completed');

      const first = JSON.parse(events[0].data) as Record<string, unknown>;
      const delta = JSON.parse(events[4].data) as Record<string, unknown>;
      const completed = JSON.parse(events[events.length - 1].data) as Record<string, unknown>;

      assertEquals(first.sequence_number, 0);
      assertEquals(delta.sequence_number, 4);
      assertEquals((completed.response as Record<string, unknown>).status, 'completed');
      assertEquals(((completed.response as Record<string, unknown>).usage as Record<string, unknown>).output_tokens, 9);
    },
  );

  assertExists(upstreamBody);
  assertEquals((upstreamBody!.tools as Array<Record<string, unknown>>)[0].name, 'lookup');
  assertEquals(upstreamBody!.max_tokens, 8192);
  assertEquals(upstreamBody!.stream, true);
});

test('/v1/responses preserves custom upstream /models HTTP errors', async () => {
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
    disabledPublicModelIds: [],
    config: {
      baseUrl: 'https://custom.example.com',
      bearerToken: 'sk-custom',
      supportedEndpoints: ['/responses'],
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
      const response = await requestApp('/v1/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'custom-responses-model',
          input: [{ type: 'message', role: 'user', content: 'hello' }],
        }),
      });

      assertEquals(response.status, 401);
      assertEquals(await response.json(), {
        error: { message: 'bad custom key' },
      });
    },
  );
});
