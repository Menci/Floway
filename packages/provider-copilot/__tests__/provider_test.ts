import { test, vi } from 'vitest';

import { clearInProcessCopilotTokenCache } from '../src/auth.ts';
import { emptyKnownModels, mergeKnownModels } from '../src/known-models.ts';
import { createCopilotProvider } from '../src/provider.ts';
import { readCopilotUpstreamState, type CopilotUpstreamState } from '../src/state.ts';
import type { CopilotModelsResponse } from '../src/types.ts';
import { createInMemoryImageProcessor, initImageProcessor } from '@floway-dev/platform';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { UpstreamRecord } from '@floway-dev/provider';
import { directFetcher, initProviderRepo } from '@floway-dev/provider';
import { assertEquals, assertRejects, jsonResponse, noopMessagesUpstreamCallOptions, noopUpstreamCallOptions, sseResponse, withMockedFetch } from '@floway-dev/test-utils';

const mergeClaudeVariantsControl = vi.hoisted<{
  override: ((models: CopilotModelsResponse) => CopilotModelsResponse) | null;
}>(() => ({ override: null }));

vi.mock('../src/merge-claude-variants.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../src/merge-claude-variants.ts')>();
  return {
    ...original,
    mergeClaudeVariants: (models: CopilotModelsResponse): CopilotModelsResponse =>
      mergeClaudeVariantsControl.override?.(models) ?? original.mergeClaudeVariants(models),
  };
});

const buildCopilotUpstream = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => {
  const { config: overrideConfig, ...rest } = overrides;
  return {
    id: 'up_copilot',
    kind: 'copilot',
    name: 'GitHub Copilot (tester)',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-03-15T00:00:00.000Z',
    updatedAt: '2026-03-15T00:00:00.000Z',
    state: null,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
    ...rest,
    config: overrideConfig ?? {
      githubToken: `ghu_${crypto.randomUUID().replace(/-/g, '')}`,
      user: { id: 1, login: 'tester', name: 'Test User', avatar_url: 'https://example.com/avatar.png' },
    },
  };
};

interface CopilotTestRepo {
  copilotUpstream: UpstreamRecord;
  savedStates: unknown[];
  setUpstreamState: (state: unknown) => void;
  getCurrentState: () => unknown;
  overrideGetById: (impl: () => Promise<UpstreamRecord | null>) => void;
  overrideSaveState: (impl: (id: string, mutate: (current: unknown) => unknown) => Promise<void>) => void;
}

const setupCopilotTest = async (recordOverrides: Partial<UpstreamRecord> = {}): Promise<CopilotTestRepo> => {
  let upstream = buildCopilotUpstream(recordOverrides);
  const savedStates: unknown[] = [];
  let getByIdImpl: () => Promise<UpstreamRecord | null> = async () => upstream;
  // Applies the mutator to the row as it stands, the way the repo does.
  let saveStateImpl: (id: string, mutate: (current: unknown) => unknown) => Promise<void> = async (_id, mutate) => {
    const next = mutate(upstream.state);
    savedStates.push(next);
    upstream = { ...upstream, state: next };
  };
  initProviderRepo(() => ({
    upstreams: {
      getById: () => getByIdImpl(),
      saveState: (id, mutate) => saveStateImpl(id, mutate),
    },
  }));
  initImageProcessor(createInMemoryImageProcessor());
  clearInProcessCopilotTokenCache();
  return {
    copilotUpstream: upstream,
    savedStates,
    setUpstreamState: state => { upstream = { ...upstream, state }; },
    getCurrentState: () => upstream.state,
    overrideGetById: impl => { getByIdImpl = impl; },
    overrideSaveState: impl => { saveStateImpl = impl; },
  };
};

interface CopilotModelFixture {
  id: string;
  display_name?: string;
  supported_endpoints?: string[];
  reasoningEfforts?: string[];
  maxContextWindowTokens?: number;
  maxPromptTokens?: number;
  maxOutputTokens?: number;
}

const copilotModels = (models: CopilotModelFixture[]) => ({
  object: 'list',
  data: models.map(model => ({
    id: model.id,
    name: model.id,
    ...(model.display_name !== undefined ? { display_name: model.display_name } : {}),
    version: '1',
    supported_endpoints: model.supported_endpoints ?? [],
    capabilities: {
      type: 'chat',
      limits: {
        ...(model.maxContextWindowTokens !== undefined ? { max_context_window_tokens: model.maxContextWindowTokens } : {}),
        ...(model.maxPromptTokens !== undefined ? { max_prompt_tokens: model.maxPromptTokens } : {}),
        ...(model.maxOutputTokens !== undefined ? { max_output_tokens: model.maxOutputTokens } : {}),
      },
      ...(model.reasoningEfforts !== undefined ? { supports: { reasoning_effort: model.reasoningEfforts } } : {}),
    },
  })),
});

test('Copilot provider exposes the highest-priority non-Claude endpoint', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const instance = createCopilotProvider(copilotUpstream);
  const provider = instance.instance;

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
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
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
      const models = await provider.getProvidedModels(directFetcher);

      assertEquals(
        models.map(model => model.id),
        ['gpt-dual'],
      );
      assertEquals(models[0].endpoints, { responses: {} });
    },
  );
});

test('Copilot provider exposes only Responses for Claude when available', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const instance = createCopilotProvider(copilotUpstream);
  const provider = instance.instance;

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
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
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
      const [model] = await provider.getProvidedModels(directFetcher);

      assertEquals(model.id, 'claude-opus-4-7');
      assertEquals(model.display_name, 'Claude Opus 4.7');
      assertEquals(model.endpoints, { responses: {} });
    },
  );
});

test('Copilot provider owns the claude-* Messages capability workaround', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const instance = createCopilotProvider(copilotUpstream);
  const provider = instance.instance;
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
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
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
        return sseResponse();
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [providerModel] = await provider.getProvidedModels(directFetcher);

      assertEquals(providerModel.id, 'claude-haiku-chat-listed');
      assertEquals(providerModel.endpoints, { messages: {} });

      await provider.callMessages(providerModel, {
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hello' }],
      }, undefined, noopMessagesUpstreamCallOptions());
    },
  );

  assertEquals(upstreamBody?.model, 'claude-haiku-chat-listed');
});

test('Copilot provider selects raw variants that support the target endpoint', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const instance = createCopilotProvider(copilotUpstream);
  const provider = instance.instance;
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
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
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
        return sseResponse();
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [providerModel] = await provider.getProvidedModels(directFetcher);
      await provider.callResponses(providerModel, {
        input: [],
        reasoning: { effort: 'xhigh' },
      }, 'generate', undefined, noopUpstreamCallOptions());
    },
  );

  assertEquals(responsesBody?.model, 'claude-opus-4.7');
});

test('Copilot provider runs the Responses boundary chain on the compact path', async () => {
  // The compact-path boundary registers payload mutators (force-store-false,
  // strip-service-tier, strip-image-generation, ...) plus header derivers
  // (set-vision-header, set-initiator-header). Driving callResponses with
  // action='compact' through a real upstream stub exercises the integration
  // end-to-end: the payload mutators reach the wire body, the header
  // derivers reach the wire request headers, and the compact-shaped envelope
  // still comes back through `compactionResponse`.
  const { copilotUpstream } = await setupCopilotTest();
  const instance = createCopilotProvider(copilotUpstream);
  const provider = instance.instance;
  let responsesBody: Record<string, unknown> | undefined;
  let visionHeader: string | null = null;
  let initiatorHeader: string | null = null;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-resp', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        responsesBody = (await request.json()) as Record<string, unknown>;
        visionHeader = request.headers.get('copilot-vision-request');
        initiatorHeader = request.headers.get('x-initiator');
        return jsonResponse({
          id: 'resp_test',
          object: 'response',
          model: 'gpt-resp',
          status: 'completed',
          output: [{ type: 'compaction', summary: 'compacted state' }],
          incomplete_details: null,
          error: null,
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [providerModel] = await provider.getProvidedModels(directFetcher);
      // service_tier is set so withServiceTierStripped has something to strip;
      // an input_image is included so withVisionHeaderSet fires; the last
      // input item is a user message so withInitiatorHeaderSet picks 'user'.
      const result = await provider.callResponses(providerModel, {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'compact me' },
              { type: 'input_image', image_url: 'https://example.com/x.png', detail: 'auto' },
            ],
          },
        ],
        service_tier: 'priority',
      }, 'compact', undefined, noopUpstreamCallOptions());

      if (!result.ok) throw new Error('expected ok compaction result');
      if (result.action !== 'compact') throw new Error(`expected compact action tag, got ${result.action}`);
      assertEquals(result.result.object, 'response.compaction');
    },
  );

  assertEquals(responsesBody?.store, false);
  if (!responsesBody) throw new Error('expected /responses to be hit');
  assertEquals('service_tier' in responsesBody, false);
  const wireInput = responsesBody?.input as Array<{ type: string }>;
  assertEquals(wireInput[0]?.type, 'message');
  assertEquals(wireInput.at(-1)?.type, 'compaction_trigger');
  assertEquals(visionHeader, 'true');
  assertEquals(initiatorHeader, 'user');
});

test('Copilot provider exposes its default flag set via ProviderModel.enabledFlags', async () => {
  const { copilotUpstream } = await setupCopilotTest({
    flagOverrides: { 'messages-web-search-shim': true },
    disabledPublicModelIds: [],
  });
  const instance = createCopilotProvider(copilotUpstream);

  assertEquals(instance.upstreamId, 'up_copilot');
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
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-test', supported_endpoints: ['/chat/completions'] }]));
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const models = await instance.instance.getProvidedModels(directFetcher);
      const model = models[0];
      if (!model) throw new Error('expected at least one Copilot model in test fixture');
      assertEquals(model.enabledFlags.has('strip-billing-attribution'), true);
      assertEquals(model.enabledFlags.has('messages-web-search-shim'), true);
    },
  );
});

test('per-model provider default beats operator upstream override — Claude < 4.8 keeps the system rewrite even when the upstream flag is off', async () => {
  const { copilotUpstream } = await setupCopilotTest({
    // Operator flipped the upstream-wide flag off. Provider says
    // Claude < 4.8 must keep the system rewrite (its Vertex backend rejects
    // inline `role:'system'`), and the per-model layer sits after the
    // upstream override in the resolve chain, so the provider judgment
    // wins for the affected model while every other model honors the
    // operator setting.
    flagOverrides: { 'rewrite-mid-conv-system-to-user': false },
  });
  const instance = createCopilotProvider(copilotUpstream);

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
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([
          { id: 'claude-opus-4.6', supported_endpoints: ['/chat/completions'] },
          { id: 'claude-opus-4.8', supported_endpoints: ['/chat/completions'] },
          { id: 'gpt-test', supported_endpoints: ['/chat/completions'] },
        ]));
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const models = await instance.instance.getProvidedModels(directFetcher);
      const claude46 = models.find(m => m.id === 'claude-opus-4-6');
      const claude48 = models.find(m => m.id === 'claude-opus-4-8');
      const gpt = models.find(m => m.id === 'gpt-test');
      if (!claude46 || !claude48 || !gpt) throw new Error('expected all three models in the emitted catalog');
      // Per-model layer forces the rewrite on for Claude < 4.8, even though
      // the operator upstream override said off.
      assertEquals(claude46.enabledFlags.has('rewrite-mid-conv-system-to-user'), true);
      // No per-model rule for Claude >= 4.8; the operator upstream
      // override wins on this row.
      assertEquals(claude48.enabledFlags.has('rewrite-mid-conv-system-to-user'), false);
      // Non-Claude ids never get a per-model rule; operator setting
      // stands.
      assertEquals(gpt.enabledFlags.has('rewrite-mid-conv-system-to-user'), false);
    },
  );
});

test('Copilot provider forces stream=true for streaming endpoints and leaves count-tokens/embeddings alone', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const instance = createCopilotProvider(copilotUpstream);
  const provider = instance.instance;
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
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
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

      if (['/chat/completions', '/responses', '/v1/messages'].includes(path)) {
        return sseResponse();
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
      const models = await provider.getProvidedModels(directFetcher);
      const byId = new Map(models.map(model => [model.id, model]));
      const opts = noopUpstreamCallOptions();
      const messagesOpts = noopMessagesUpstreamCallOptions();

      await provider.callChatCompletions(byId.get('gpt-chat')!, { messages: [{ role: 'user', content: 'hi' }] }, undefined, opts);
      await provider.callResponses(byId.get('gpt-resp')!, { input: [] }, 'generate', undefined, opts);
      await provider.callMessages(byId.get('claude-msg')!, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, undefined, messagesOpts);
      await provider.callMessagesCountTokens(byId.get('claude-msg')!, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, undefined, messagesOpts);
      await provider.callEmbeddings(byId.get('emb-mini')!, { input: 'hi' }, undefined, opts);
    },
  );

  assertEquals(bodies['/chat/completions'].stream, true);
  assertEquals(bodies['/responses'].stream, true);
  assertEquals(bodies['/v1/messages'].stream, true);
  assertEquals('stream' in bodies['/v1/messages/count_tokens'], false);
  assertEquals('stream' in bodies['/embeddings'], false);
});

test('Copilot provider sets copilot-vision-request when an image is nested inside tool_result.content', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const instance = createCopilotProvider(copilotUpstream);
  const provider = instance.instance;
  const visionHeaders: (string | null)[] = [];

  // The vision-detection interceptor runs inside `provider.callMessages`, so
  // it must walk into nested `tool_result.content` to find the image.
  const driveMessages = async (providerModel: Awaited<ReturnType<typeof instance.instance.getProvidedModels>>[number], body: Omit<MessagesPayload, 'model'>): Promise<void> => {
    await provider.callMessages(providerModel, body, undefined, noopMessagesUpstreamCallOptions());
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
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-msg', supported_endpoints: ['/v1/messages'] }]));
      }
      if (url.pathname === '/v1/messages') {
        visionHeaders.push(request.headers.get('copilot-vision-request'));
        await request.text();
        return sseResponse();
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [model] = await provider.getProvidedModels(directFetcher);

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

  assertEquals(visionHeaders, ['true', null]);
});

test('Copilot Messages boundary chain does NOT fire on the Chat Completions wire (translated path)', async () => {
  // Boundary isolation: each provider call method runs only its own protocol
  // boundary chain. The Messages-only `withClaudeAgentHeadersSet` interceptor
  // would set x-interaction-type to 'messages-proxy' for Claude Code SDK
  // metadata, but it MUST NOT run when the translated path calls Copilot's
  // chat-completions wire — that path runs `COPILOT_CHAT_COMPLETIONS_BOUNDARY`,
  // which has no Messages-source headers in it.
  const { copilotUpstream } = await setupCopilotTest();
  const instance = createCopilotProvider(copilotUpstream);
  const provider = instance.instance;
  const observedInteractionType: (string | null)[] = [];

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-chat', supported_endpoints: ['/chat/completions'] }]));
      }
      if (url.pathname === '/chat/completions') {
        observedInteractionType.push(request.headers.get('x-interaction-type'));
        await request.text();
        return sseResponse();
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [providerModel] = await provider.getProvidedModels(directFetcher);
      // Even with a Claude-Code-shaped metadata blob, the chat-completions
      // boundary chain has no Messages-source interceptor, so the
      // messages-proxy intent must not appear on the wire.
      await provider.callChatCompletions(providerModel, {
        messages: [{ role: 'user', content: 'hi' }],
        metadata: { user_id: JSON.stringify({ device_id: 'dev-1', session_id: 'sess-1' }) },
      }, undefined, noopUpstreamCallOptions());
    },
  );

  // The chat-completions wire defaults to `conversation-agent` (set by
  // `copilotAuthedFetch` in `packages/provider-copilot/src/auth.ts`). The
  // Messages-boundary `withClaudeAgentHeadersSet` would overwrite it to
  // `messages-proxy` if it had run — its absence is the
  // proof that the Messages boundary chain did NOT fire on this wire.
  assertEquals(observedInteractionType, ['conversation-agent']);
});

const copilotPreflight = (request: Request): Response | null => {
  const url = new URL(request.url);
  if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
  if (url.pathname === '/copilot_internal/v2/token') {
    return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
  }
  return null;
};

test('Copilot provider rejects a merged public model without a raw variant group', async () => {
  const harness = await setupCopilotTest();
  const instance = createCopilotProvider(harness.copilotUpstream);
  mergeClaudeVariantsControl.override = models => {
    const rawModel = models.data[0];
    if (rawModel === undefined) throw new Error('expected a raw model fixture');
    return { ...models, data: [{ ...rawModel, id: 'orphan-public-model' }] };
  };

  try {
    await withMockedFetch(
      request => {
        const preflight = copilotPreflight(request);
        if (preflight !== null) return preflight;
        const url = new URL(request.url);
        if (url.pathname === '/models') {
          return jsonResponse(copilotModels([{ id: 'gpt-raw-model', supported_endpoints: ['/responses'] }]));
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => {
        await assertRejects(
          () => instance.instance.getProvidedModels(directFetcher),
          Error,
          "Copilot model projection invariant violated: merged model 'orphan-public-model' has no raw variant group (raw model ids: gpt-raw-model)",
        );
      },
    );
  } finally {
    mergeClaudeVariantsControl.override = null;
  }
});

test('Copilot provider persists the minted token and the merged known-models view as two writes to distinct slots', async () => {
  const harness = await setupCopilotTest();
  const { copilotUpstream, savedStates } = harness;

  await withMockedFetch(
    request => {
      const pre = copilotPreflight(request);
      if (pre) return pre;
      const url = new URL(request.url);
      if (url.pathname === '/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'm1', supported_endpoints: ['/v1/messages'] }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const instance = createCopilotProvider(copilotUpstream);
      const result = await instance.instance.getProvidedModels(directFetcher);
      assertEquals(result.map(m => m.id), ['m1']);
    },
  );

  assertEquals(savedStates.length, 2);
  const [tokenWrite, modelsWrite] = savedStates as [CopilotUpstreamState, CopilotUpstreamState];
  // The token mint runs inside the models fetch, so it writes first and only
  // fills its own slot.
  assertEquals(tokenWrite.knownModels, null);
  assertEquals(typeof tokenWrite.copilotToken?.token, 'string');
  if (!modelsWrite.knownModels) throw new Error('expected knownModels persisted');
  assertEquals(Object.keys(modelsWrite.knownModels.models), ['m1']);
  // Spreading the state it was handed is what carries the token through.
  assertEquals(modelsWrite.copilotToken?.token, tokenWrite.copilotToken?.token);
});

test('Copilot provider merges known-models into the row as it stands after the fetch, not into the pre-fetch snapshot', async () => {
  const harness = await setupCopilotTest();
  const { copilotUpstream } = harness;

  await withMockedFetch(
    request => {
      const pre = copilotPreflight(request);
      if (pre) return pre;
      const url = new URL(request.url);
      if (url.pathname === '/models') {
        // A concurrent quota harvest lands while the catalog fetch is in
        // flight, on top of the token the mint just persisted.
        const current = readCopilotUpstreamState(harness.getCurrentState());
        harness.setUpstreamState({
          ...current,
          quotaSnapshot: { fetchedAt: 1, data: { observed_at: '2026-08-01T00:00:00.000Z', reset_at: null, quotas: {} } },
        } satisfies CopilotUpstreamState);
        return jsonResponse({ object: 'list', data: [{ id: 'm1', supported_endpoints: ['/v1/messages'] }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const instance = createCopilotProvider(copilotUpstream);
      await instance.instance.getProvidedModels(directFetcher);
    },
  );

  const final = readCopilotUpstreamState(harness.getCurrentState());
  if (!final.knownModels) throw new Error('expected knownModels to be persisted');
  assertEquals(Object.keys(final.knownModels.models), ['m1']);
  if (!final.copilotToken) throw new Error('expected the minted token to survive the known-models write');
  assertEquals(final.quotaSnapshot?.fetchedAt, 1);
});

test('Copilot provider accumulates known-models across calls so a model dropped from the fetch still surfaces', async () => {
  const harness = await setupCopilotTest();
  const { copilotUpstream } = harness;

  let fetches = 0;
  await withMockedFetch(
    request => {
      const pre = copilotPreflight(request);
      if (pre) return pre;
      const url = new URL(request.url);
      if (url.pathname === '/models') {
        fetches++;
        const data = fetches === 1
          ? [{ id: 'm1', supported_endpoints: ['/v1/messages'] }]
          : [{ id: 'm2', supported_endpoints: ['/v1/messages'] }];
        return jsonResponse({ object: 'list', data });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const instance = createCopilotProvider(copilotUpstream);
      const first = await instance.instance.getProvidedModels(directFetcher);
      assertEquals(first.map(m => m.id), ['m1']);
      const second = await instance.instance.getProvidedModels(directFetcher);
      assertEquals(second.map(m => m.id).sort(), ['m1', 'm2']);
    },
  );
  assertEquals(fetches, 2);
});

test('Copilot provider throws when the upstream fetch fails — no in-provider fallback to stored projection', async () => {
  const harness = await setupCopilotTest();
  // Seed prior knownModels so a fallback would have something to return if one
  // existed — proving the provider deliberately re-throws regardless.
  const seeded = mergeKnownModels(
    emptyKnownModels(),
    { object: 'list', data: [{ id: 'm-prior', name: 'm-prior', version: '1', supported_endpoints: ['/v1/messages'], capabilities: { type: 'chat', limits: {} } }] },
    Date.now(),
  );
  harness.setUpstreamState({ knownModels: seeded, copilotToken: null });

  await withMockedFetch(
    request => {
      const pre = copilotPreflight(request);
      if (pre) return pre;
      const url = new URL(request.url);
      if (url.pathname === '/models') return new Response('unavailable', { status: 503 });
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const instance = createCopilotProvider(harness.copilotUpstream);
      await assertRejects(() => instance.instance.getProvidedModels(directFetcher));
    },
  );
});

test('Copilot provider throws "disappeared mid-request" when the upstream row vanishes between construction and call', async () => {
  const harness = await setupCopilotTest();
  const instance = createCopilotProvider(harness.copilotUpstream);
  harness.overrideGetById(async () => null);

  await assertRejects(
    () => instance.instance.getProvidedModels(directFetcher),
    Error,
    'Copilot upstream up_copilot disappeared mid-request',
  );
});

test('Copilot provider swallows a saveState throw so a transient persistence hiccup does not invalidate the fetched models', async () => {
  // Persistence is best-effort: the fetched models are the user-facing
  // payload, and a storage-level error on the write must not propagate out of
  // getProvidedModels. Mirrors the gateway SWR layer's persistence policy.
  const harness = await setupCopilotTest();
  harness.overrideSaveState(() => Promise.reject(new Error('D1 hiccup')));

  await withMockedFetch(
    request => {
      const pre = copilotPreflight(request);
      if (pre) return pre;
      const url = new URL(request.url);
      if (url.pathname === '/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'm1', supported_endpoints: ['/v1/messages'] }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const instance = createCopilotProvider(harness.copilotUpstream);
      const result = await instance.instance.getProvidedModels(directFetcher);
      assertEquals(result.map(m => m.id), ['m1']);
    },
  );
});

test('readCopilotUpstreamState round-trips a persisted state with both knownModels and copilotToken', () => {
  const seeded: CopilotUpstreamState = {
    knownModels: mergeKnownModels(
      emptyKnownModels(),
      { object: 'list', data: [{ id: 'm1', name: 'm1', version: '1', supported_endpoints: [], capabilities: { type: 'chat', limits: {} } }] },
      1_000_000,
    ),
    copilotToken: { token: 'tok', expiresAt: 2_000_000, baseUrl: 'https://api.individual.githubcopilot.com' },
    quotaSnapshot: null,
  };
  const round = readCopilotUpstreamState(JSON.parse(JSON.stringify(seeded)));
  assertEquals(round.copilotToken?.token, 'tok');
  if (!round.knownModels) throw new Error('expected knownModels in round-trip');
  assertEquals(Object.keys(round.knownModels.models), ['m1']);
});

// ---------------------------------------------------------------------------
// Anthropic Fast Mode end-to-end through the Copilot provider.
//
// The catalog merges `claude-opus-4.6` and `claude-opus-4.6-fast` into one
// public id; `speed: "fast"` on the request picks the `-fast` raw variant,
// `withSpeedFast` strips the field from the wire, and the response stream
// gets `usage.speed = 'fast'` stamped before it leaves the provider.
// ---------------------------------------------------------------------------

const sseEvent = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const sseDone = (): string => 'data: [DONE]\n\n';

const messagesSseBody = (): string =>
  sseEvent('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-opus-4.6-fast',
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 0 },
    },
  })
  + sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 7 },
  })
  + sseEvent('message_stop', { type: 'message_stop' })
  + sseDone();

const fastModelCatalog = () =>
  copilotModels([
    {
      id: 'claude-opus-4.6',
      display_name: 'Claude Opus 4.6',
      supported_endpoints: ['/v1/messages'],
    },
    {
      id: 'claude-opus-4.6-fast',
      display_name: 'Claude Opus 4.6 (fast)',
      supported_endpoints: ['/v1/messages'],
    },
  ]);

const betaModelCatalog = () => copilotModels([
  { id: 'claude-opus-4.6', supported_endpoints: ['/v1/messages'], maxContextWindowTokens: 200_000 },
  { id: 'claude-opus-4.6-1m', supported_endpoints: ['/v1/messages'], maxContextWindowTokens: 1_000_000 },
]);

const betaIntent = ['context-1m-2025-08-07', 'advanced-tool-use-2025-11-20', 'unknown-beta'];

test('Copilot consumes Messages beta intent before serializing its supported wire subset', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const provider = createCopilotProvider(copilotUpstream).instance;
  let upstreamModel: unknown;
  let upstreamBeta: string | null = null;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') {
        return jsonResponse(betaModelCatalog());
      }
      if (url.pathname === '/v1/messages') {
        upstreamModel = ((await request.json()) as Record<string, unknown>).model;
        upstreamBeta = request.headers.get('anthropic-beta');
        return sseResponse(messagesSseBody());
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [providerModel] = await provider.getProvidedModels(directFetcher);
      const result = await provider.callMessages(
        providerModel,
        { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
        undefined,
        noopMessagesUpstreamCallOptions({ anthropicBeta: betaIntent }),
      );
      assertEquals(result.modelKey, 'claude-opus-4.6-1m');
    },
  );

  assertEquals(upstreamModel, 'claude-opus-4.6-1m');
  assertEquals(upstreamBeta, 'advanced-tool-use-2025-11-20');
});

test('Copilot count_tokens consumes and serializes the same Messages beta intent', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const provider = createCopilotProvider(copilotUpstream).instance;
  let upstreamModel: unknown;
  let upstreamBeta: string | null = null;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') return jsonResponse(betaModelCatalog());
      if (url.pathname === '/v1/messages/count_tokens') {
        upstreamModel = ((await request.json()) as Record<string, unknown>).model;
        upstreamBeta = request.headers.get('anthropic-beta');
        return jsonResponse({ input_tokens: 1 });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [providerModel] = await provider.getProvidedModels(directFetcher);
      const result = await provider.callMessagesCountTokens(
        providerModel,
        { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
        undefined,
        noopMessagesUpstreamCallOptions({ anthropicBeta: betaIntent }),
      );
      assertEquals(result.modelKey, 'claude-opus-4.6-1m');
    },
  );

  assertEquals(upstreamModel, 'claude-opus-4.6-1m');
  assertEquals(upstreamBeta, 'advanced-tool-use-2025-11-20');
});

test('Copilot provider routes speed=fast to the -fast raw variant and stamps usage.speed on the way out', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const instance = createCopilotProvider(copilotUpstream);
  const provider = instance.instance;
  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') return jsonResponse(fastModelCatalog());
      if (url.pathname === '/v1/messages') {
        upstreamBody = (await request.json()) as Record<string, unknown>;
        return sseResponse(messagesSseBody());
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [providerModel] = await provider.getProvidedModels(directFetcher);
      assertEquals(providerModel.id, 'claude-opus-4-6');

      const result = await provider.callMessages(
        providerModel,
        { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], speed: 'fast' },
        undefined,
        noopMessagesUpstreamCallOptions(),
      );

      if (!result.ok) throw new Error(`expected ok stream, got ${JSON.stringify(result.response)}`);

      const frames = [];
      for await (const frame of result.events) frames.push(frame);

      const messageStart = frames.find(f => f.type === 'event' && f.event.type === 'message_start');
      if (messageStart?.type !== 'event' || messageStart.event.type !== 'message_start') {
        throw new Error('expected message_start frame');
      }
      assertEquals(messageStart.event.message.usage.speed, 'fast');

      const messageDelta = frames.find(f => f.type === 'event' && f.event.type === 'message_delta');
      if (messageDelta?.type !== 'event' || messageDelta.event.type !== 'message_delta') {
        throw new Error('expected message_delta frame');
      }
      assertEquals(messageDelta.event.usage?.speed, 'fast');

      assertEquals(result.modelKey, 'claude-opus-4.6-fast');
    },
  );

  assertEquals(upstreamBody?.model, 'claude-opus-4.6-fast');
  if (!upstreamBody) throw new Error('expected /v1/messages to be hit');
  assertEquals('speed' in upstreamBody, false);
});

test('Copilot provider returns HTTP 400 invalid_request_error when speed=fast hits a model without a -fast variant', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const instance = createCopilotProvider(copilotUpstream);
  const provider = instance.instance;
  let messagesHit = false;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-haiku-4.5', supported_endpoints: ['/v1/messages'] }]));
      }
      if (url.pathname === '/v1/messages') {
        messagesHit = true;
        return sseResponse();
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [providerModel] = await provider.getProvidedModels(directFetcher);

      const result = await provider.callMessages(
        providerModel,
        { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], speed: 'fast' },
        undefined,
        noopMessagesUpstreamCallOptions(),
      );

      if (result.ok) throw new Error('expected 400 error, got ok stream');
      assertEquals(result.response.status, 400);
      const body = (await result.response.json()) as { type: string; error: { type: string; message: string } };
      // Byte-identical to the wire string Anthropic emits on real api.anthropic.com
      // for the same failure mode — recorded verbatim from a live response in
      // https://github.com/Yeachan-Heo/gajae-code/blob/main/packages/ai/test/anthropic-fast-mode.test.ts
      assertEquals(body.type, 'error');
      assertEquals(body.error.type, 'invalid_request_error');
      assertEquals(body.error.message, "'claude-haiku-4-5' does not support the `speed` parameter.");
      assertEquals(result.modelKey, providerModel.id);
    },
  );

  assertEquals(messagesHit, false);
});

test('Copilot provider passes unknown speed values to the upstream verbatim so the upstream owns rejecting them', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const instance = createCopilotProvider(copilotUpstream);
  const provider = instance.instance;
  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') return jsonResponse(fastModelCatalog());
      if (url.pathname === '/v1/messages') {
        upstreamBody = (await request.json()) as Record<string, unknown>;
        return sseResponse(messagesSseBody());
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [providerModel] = await provider.getProvidedModels(directFetcher);
      // `priority` is not a documented Messages `speed` value; the gateway
      // does not own rejecting it and must not strip it either — let
      // Copilot surface whatever error its strict validator returns.
      const speedValue = 'priority' as MessagesPayload['speed'];
      await provider.callMessages(
        providerModel,
        { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], speed: speedValue },
        undefined,
        noopMessagesUpstreamCallOptions(),
      );
    },
  );

  assertEquals(upstreamBody?.speed, 'priority');
});

// ---------------------------------------------------------------------------
// chat? auto-population from upstream /models capabilities
// ---------------------------------------------------------------------------

interface CopilotModelCapabilityFixture {
  id: string;
  supported_endpoints?: string[];
  supports?: {
    vision?: boolean;
    reasoning_effort?: string[];
    min_thinking_budget?: number;
    max_thinking_budget?: number;
    adaptive_thinking?: boolean;
  };
}

const copilotModelsWithCapabilities = (models: CopilotModelCapabilityFixture[]) => ({
  object: 'list',
  data: models.map(model => ({
    id: model.id,
    name: model.id,
    version: '1',
    supported_endpoints: model.supported_endpoints ?? ['/chat/completions'],
    capabilities: {
      type: 'chat',
      limits: {},
      ...(model.supports !== undefined ? { supports: model.supports } : {}),
    },
  })),
});

const getModelsWithCapabilities = async (fixtures: CopilotModelCapabilityFixture[]) => {
  const { copilotUpstream } = await setupCopilotTest();
  const instance = createCopilotProvider(copilotUpstream);
  let models: Awaited<ReturnType<typeof instance.instance.getProvidedModels>> = [];

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') return jsonResponse(copilotModelsWithCapabilities(fixtures));
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => { models = await instance.instance.getProvidedModels(directFetcher); },
  );

  return models;
};

test('Copilot chat field: vision-only → modalities with image input', async () => {
  const [model] = await getModelsWithCapabilities([
    { id: 'gpt-vision', supports: { vision: true } },
  ]);
  assertEquals(model.chat, { modalities: { input: ['text', 'image'], output: ['text'] } });
});

test('Copilot chat field: reasoning_effort with medium → effort with default medium', async () => {
  const [model] = await getModelsWithCapabilities([
    { id: 'o3-mini', supports: { reasoning_effort: ['low', 'medium', 'high'] } },
  ]);
  assertEquals(model.chat, {
    reasoning: { effort: { supported: ['low', 'medium', 'high'], default: 'medium' } },
  });
});

test('Copilot chat field: reasoning_effort full GPT-5 set → default is medium', async () => {
  const [model] = await getModelsWithCapabilities([
    { id: 'gpt-5', supports: { reasoning_effort: ['minimal', 'low', 'medium', 'high', 'xhigh'] } },
  ]);
  assertEquals(model.chat, {
    reasoning: { effort: { supported: ['minimal', 'low', 'medium', 'high', 'xhigh'], default: 'medium' } },
  });
});

test('Copilot chat field: reasoning_effort without medium → default is first', async () => {
  const [model] = await getModelsWithCapabilities([
    { id: 'o-nomedium', supports: { reasoning_effort: ['minimal', 'xhigh'] } },
  ]);
  assertEquals(model.chat, {
    reasoning: { effort: { supported: ['minimal', 'xhigh'], default: 'minimal' } },
  });
});

test('Copilot chat field: min+max_thinking_budget → budget_tokens', async () => {
  const [model] = await getModelsWithCapabilities([
    { id: 'claude-think', supported_endpoints: ['/v1/messages'], supports: { min_thinking_budget: 1024, max_thinking_budget: 16384 } },
  ]);
  assertEquals(model.chat, { reasoning: { budget_tokens: { min: 1024, max: 16384 } } });
});

test('Copilot chat field: adaptive_thinking: true → reasoning.adaptive', async () => {
  const [model] = await getModelsWithCapabilities([
    { id: 'claude-adaptive', supported_endpoints: ['/v1/messages'], supports: { adaptive_thinking: true } },
  ]);
  assertEquals(model.chat, { reasoning: { adaptive: true } });
});

test('Copilot chat field: combined vision + reasoning_effort + adaptive_thinking → full chat', async () => {
  const [model] = await getModelsWithCapabilities([
    {
      id: 'claude-opus-4.7',
      supported_endpoints: ['/v1/messages'],
      supports: {
        vision: true,
        reasoning_effort: ['low', 'medium', 'high', 'xhigh'],
        min_thinking_budget: 1024,
        max_thinking_budget: 32768,
        adaptive_thinking: true,
      },
    },
  ]);
  assertEquals(model.chat, {
    modalities: { input: ['text', 'image'], output: ['text'] },
    reasoning: {
      effort: { supported: ['low', 'medium', 'high', 'xhigh'], default: 'medium' },
      budget_tokens: { min: 1024, max: 32768 },
      adaptive: true,
    },
  });
});

test('Copilot chat field: no capabilities → no chat field', async () => {
  const [model] = await getModelsWithCapabilities([
    { id: 'basic-model' },
  ]);
  assertEquals(model.chat, undefined);
});

// Copilot reports the seat's entitlement on every data-plane response, so a
// served request is enough to keep the dashboard current — no GitHub REST poll
// and no operator click. The headers arrive with the response head, ahead of
// the SSE body, so a streaming call snapshots at stream start.
test('Copilot provider persists the quota snapshot a data-plane response carries', async () => {
  const harness = await setupCopilotTest();
  const provider = createCopilotProvider(harness.copilotUpstream).instance;

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'tid=x;exp=9999999999',
          expires_at: 9_999_999_999,
          refresh_in: 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-chat', supported_endpoints: ['/chat/completions'] }]));
      }
      if (url.pathname === '/chat/completions') {
        return sseResponse('data: [DONE]\n\n', 200, {
          'x-quota-snapshot-chat': 'ent=-1&ov=0.0&ovPerm=false&rem=100.0&rst=2026-09-01T00%3A00%3A00Z&totRem=-1',
          'x-quota-snapshot-premium_interactions': 'ent=300&ov=0.0&ovPerm=false&rem=90.0&rst=2026-09-01T00%3A00%3A00Z&totRem=270',
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [model] = await provider.getProvidedModels(directFetcher);
      await provider.callChatCompletions(model, { messages: [{ role: 'user', content: 'hi' }] }, undefined, noopUpstreamCallOptions());
      // The persist is fire-and-forget: on workerd `waitUntil` keeps it alive
      // past the response, and here it settles on the host event loop.
      await vi.waitFor(() => {
        if (readCopilotUpstreamState(harness.getCurrentState()).quotaSnapshot === null) {
          throw new Error('quota snapshot not persisted yet');
        }
      });
    },
  );

  const snapshot = readCopilotUpstreamState(harness.getCurrentState()).quotaSnapshot;
  assertEquals(snapshot?.data.quotas.premium_interactions.quota_remaining, 270);
  assertEquals(snapshot?.data.quotas.chat.unlimited, true);
  assertEquals(snapshot?.data.reset_at, '2026-09-01T00:00:00Z');
});

// `/models` and every 4xx we have observed come back without the header
// family. Writing an empty snapshot on those would erase a good reading for
// no upside, so the slot is left exactly as it was.
test('Copilot provider leaves the persisted snapshot alone when a response carries no quota headers', async () => {
  const harness = await setupCopilotTest();
  const provider = createCopilotProvider(harness.copilotUpstream).instance;

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'tid=x;exp=9999999999',
          expires_at: 9_999_999_999,
          refresh_in: 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-chat', supported_endpoints: ['/chat/completions'] }]));
      }
      if (url.pathname === '/chat/completions') return sseResponse();
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [model] = await provider.getProvidedModels(directFetcher);
      await provider.callChatCompletions(model, { messages: [{ role: 'user', content: 'hi' }] }, undefined, noopUpstreamCallOptions());
    },
  );

  assertEquals(readCopilotUpstreamState(harness.getCurrentState()).quotaSnapshot, null);
});
