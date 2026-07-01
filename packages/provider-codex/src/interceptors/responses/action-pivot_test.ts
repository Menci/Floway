import { afterEach, beforeEach, test, vi } from 'vitest';

import type { ResponsesBoundaryCtx } from './types.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import { initProviderRepo, type ProviderResponsesResult, type UpstreamRecord } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

// Codex's terminal handler in provider.ts switches on `ctx.action` (the
// post-chain value), so an interceptor that flips it mid-chain reroutes
// dispatch. Drive the contract by swapping CODEX_RESPONSES_BOUNDARY for one
// that ends in a pivot interceptor (generate → compact), then call with
// action='generate' and a generate-shaped body. The wire request seen at
// the upstream MUST hit /codex/responses/compact AND the body MUST NOT
// carry generate-only fields (tools/reasoning/temperature/...) — the
// per-action narrowing through `toCompactPayloadShape` is what closes that
// gap.
const pivotGenerateToCompact: Interceptor<ResponsesBoundaryCtx, object, ProviderResponsesResult> = async (ctx, _request, run) => {
  ctx.action = 'compact';
  return await run();
};

vi.mock('./index.ts', async () => {
  const original = await vi.importActual<typeof import('./index.ts')>('./index.ts');
  return {
    ...original,
    CODEX_RESPONSES_BOUNDARY: [...original.CODEX_RESPONSES_BOUNDARY, pivotGenerateToCompact],
  };
});

// Imports below MUST follow the vi.mock so the provider module resolves
// against the mocked chain on first import.
const { createCodexProvider } = await import('../../provider.ts');
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
};

beforeEach(() => {
  initProviderRepo(() => ({
    upstreams: {
      getById: async () => baseRecord,
      saveState: async () => ({ updated: true }),
    },
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

test('Codex terminal dispatches on post-chain ctx.action (interceptor flip generate→compact routes to the unary /responses/compact path with a narrowed body)', async () => {
  let compactUrl: string | undefined;
  let compactBody: Record<string, unknown> | undefined;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
    if (url.endsWith('/codex/responses/compact')) {
      compactUrl = url;
      compactBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return compactJsonResponse();
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  const instance = await createCodexProvider(baseRecord);
  // Generate-shaped body — carries tools, reasoning, temperature, etc. None
  // of these are allowed on /responses/compact. The pivot above flips action
  // to 'compact'; the terminal must narrow the body before sending upstream.
  const result = await instance.instance.callResponses(
    stubProviderModel({ id: 'gpt-5.4', display_name: 'gpt-5.4', endpoints: { responses: {} } }),
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

  // Wire body MUST carry the compact-allowed fields (input, model) and MUST
  // NOT carry any of the generate-only fields the caller passed in.
  assertEquals('input' in compactBody, true);
  assertEquals(compactBody.model, 'gpt-5.4');
  for (const banned of ['tools', 'reasoning', 'temperature', 'max_output_tokens', 'stream', 'parallel_tool_calls']) {
    assertEquals(banned in compactBody, false, `compact wire body must not carry generate-only field "${banned}"`);
  }
});
