import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { OpenAIResponsesBoundaryCtx } from '../../../src/interceptors/openai-responses/types.ts';
import { createUpstreamStateRepoStub } from '../../upstream-state-repo.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import { initProviderRepo, type ProviderOpenAIResponsesResult, type UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, readJsonRequest } from '@floway-dev/test-utils';

// Terminal dispatch must use the post-chain action and preserve late Standard
// tool/instruction changes until the private wire encoder and compact projector.
const pivotGenerateToCompact: Interceptor<OpenAIResponsesBoundaryCtx, object, ProviderOpenAIResponsesResult> = async (ctx, _env, run) => {
  ctx.action = 'compact';
  ctx.payload = {
    ...ctx.payload,
    instructions: 'Late instructions',
    tools: [...ctx.payload.tools ?? [], { type: 'custom', name: 'late_tool' }],
  };
  return await run();
};

vi.mock('../../../src/interceptors/openai-responses/index.ts', async () => {
  const original = await vi.importActual<typeof import('../../../src/interceptors/openai-responses/index.ts')>('../../../src/interceptors/openai-responses/index.ts');
  return {
    ...original,
    CODEX_OPENAI_RESPONSES_BOUNDARY: [...original.CODEX_OPENAI_RESPONSES_BOUNDARY, pivotGenerateToCompact],
  };
});

// Imports below MUST follow the vi.mock so the provider module resolves
// against the mocked chain on first import.
const { createCodexProvider } = await import('../../../src/provider.ts');
const { noopUpstreamCallOptions, stubProviderModel } = await import('@floway-dev/test-utils');

const farFutureMs = Date.now() + 24 * 60 * 60 * 1000;

const baseRecord: UpstreamRecord = {
  id: 'up_codex_pivot',
  kind: 'codex',
  name: 'Codex (pivot tester)',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-03-15T00:00:00.000Z',
  updatedAt: '2026-03-15T00:00:00.000Z',
  config: { accounts: [{ email: 'a@b.com', chatgptAccountId: 'acc', chatgptUserId: 'usr', planType: 'plus' }] },
  state: { accounts: [{ chatgptAccountId: 'acc', refresh_token: 'rt_v1', state: 'active', state_updated_at: '2026-01-01T00:00:00Z', openaiDeviceId: '11111111-2222-4333-8444-555555555555', accessToken: { token: 'at', expiresAt: farFutureMs, refreshedAt: 'now' }, quotaSnapshot: null }] },
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
};

beforeEach(() => {
  initProviderRepo(() => ({
    upstreams: createUpstreamStateRepoStub(() => baseRecord, () => {}),
  }));
});

afterEach(() => vi.restoreAllMocks());

const compactJsonResponse = (): Response => new Response(
  JSON.stringify({
    id: 'resp_pivot',
    object: 'response.compaction',
    created_at: 0,
    status: 'completed',
    model: 'gpt-5.4',
    output: [{ id: 'cmp_x', type: 'compaction', encrypted_content: 'BLOB' }],
  }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);

test.each([true, false])('Codex projects a post-chain compact pivot after catalog-selected encoding (Lite=%s)', async useResponsesLite => {
  let compactUrl: string | undefined;
  let compactBody: Record<string, unknown> | undefined;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
    if (url.endsWith('/codex/responses/compact')) {
      compactUrl = url;
      if (init === undefined) throw new Error('expected compact request init');
      compactBody = await readJsonRequest(init) as Record<string, unknown>;
      return compactJsonResponse();
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  const instance = createCodexProvider(baseRecord);
  const result = await instance.instance.callOpenAIResponses(
    stubProviderModel({ id: 'gpt-5.4', display_name: 'gpt-5.4', endpoints: { openaiResponses: {} }, providerData: { useResponsesLite } }),
    {
      input: [{ type: 'message', role: 'user', content: 'hi' }],
      tools: [{ type: 'function', name: 'noop', description: 'noop', parameters: { type: 'object' }, strict: false }],
      reasoning: { effort: 'medium' },
      temperature: 0.7,
      max_output_tokens: 64,
      stream: true,
      parallel_tool_calls: false,
    },
    'generate',
    undefined,
    noopUpstreamCallOptions(),
  );

  if (!result.ok) throw new Error('expected ok result');
  if (result.action !== 'compact') throw new Error(`expected compact variant after pivot, got ${result.action}`);

  if (compactUrl === undefined) throw new Error('expected /codex/responses/compact to be hit');
  if (compactBody === undefined) throw new Error('expected compact body capture');

  assertEquals('input' in compactBody, true);
  assertEquals(compactBody.model, 'gpt-5.4');
  const tools = [
    { type: 'function', name: 'noop', description: 'noop', parameters: { type: 'object' }, strict: false },
    { type: 'custom', name: 'late_tool' },
  ];
  if (useResponsesLite) {
    expect(compactBody).not.toHaveProperty('tools');
    expect(compactBody).not.toHaveProperty('instructions');
    expect(compactBody.input).toEqual([
      { type: 'additional_tools', role: 'developer', id: expect.stringMatching(/^at_/), tools: [{ type: 'namespace', name: 'functions', description: '', tools }] },
      { type: 'message', role: 'developer', id: expect.stringMatching(/^msg_/), content: [{ type: 'input_text', text: 'Late instructions' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] } },
      { type: 'message', role: 'user', content: 'hi' },
    ]);
    expect(compactBody.reasoning).toEqual({ effort: 'medium', context: 'all_turns' });
  } else {
    expect(compactBody.tools).toEqual(tools);
    expect(compactBody.instructions).toBe('Late instructions');
    expect(compactBody.reasoning).toEqual({ effort: 'medium' });
  }
  expect(compactBody.parallel_tool_calls).toBe(false);
  for (const banned of ['temperature', 'max_output_tokens', 'stream']) {
    assertEquals(banned in compactBody, false, `compact wire body must not carry unsupported field "${banned}"`);
  }
});
