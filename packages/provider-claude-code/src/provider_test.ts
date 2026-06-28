import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { buildClaudeCodeCatalog, type ClaudeCodeApiModel } from './models.ts';
import { pricingForClaudeCodeModelKey } from './pricing.ts';
import { createClaudeCodeProvider } from './provider.ts';
import type { ClaudeCodeAccessTokenEntry, ClaudeCodeAccountCredential, ClaudeCodeUpstreamState } from './state.ts';
import { initProviderRepo, type UpstreamCallOptions, type UpstreamRecord } from '@floway-dev/provider';
import { noopUpstreamCallOptions } from '@floway-dev/test-utils';

const upstreamId = 'up_cc_provider';

// Canned `/v1/models` payload the fetcher mock returns; mirrors the live
// June-2026 catalog shape (mixed dated and alias-shape ids).
const API_MODELS: ClaudeCodeApiModel[] = [
  { id: 'claude-fable-5', display_name: 'Claude Fable 5', max_input_tokens: 1_000_000 },
  { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7', max_input_tokens: 1_000_000 },
  { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', max_input_tokens: 1_000_000 },
  { id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5', max_input_tokens: 1_000_000 },
  { id: 'claude-opus-4-5-20251101', display_name: 'Claude Opus 4.5', max_input_tokens: 200_000 },
  { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', max_input_tokens: 200_000 },
];

// Used by the messages-routing tests; carries the dated-upstream-id provider
// data the wire path expects.
const upstreamModel = buildClaudeCodeCatalog(API_MODELS, new Set<string>())
  .find(m => m.id === 'claude-sonnet-4-5')!;

const activeAccount: ClaudeCodeAccountCredential = {
  accountUuid: 'acc-1',
  tokenKind: 'oauth',
  refreshToken: 'rt_v1',
  state: 'active',
  stateUpdatedAt: '2026-01-01T00:00:00Z',
  accessToken: {
    token: 'at_cached',
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    refreshedAt: new Date(Date.now() - 60 * 1000).toISOString(),
  } as ClaudeCodeAccessTokenEntry,
  quotaSnapshot: null,
  usageProbeSnapshot: null,
};

const makeRecord = (state: ClaudeCodeUpstreamState): UpstreamRecord => ({
  id: upstreamId,
  provider: 'claude-code',
  name: 'CC',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  config: { accounts: [{ email: 'a@b.com', accountUuid: 'acc-1', organizationUuid: null, subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' }] },
  state,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
});

let currentRecord: UpstreamRecord;

beforeEach(() => {
  currentRecord = makeRecord({ accounts: [{ ...activeAccount }] });
  initProviderRepo(() => ({
    upstreams: {
      getById: async () => currentRecord,
      saveState: async (_id, newState) => {
        currentRecord = { ...currentRecord, state: newState as ClaudeCodeUpstreamState };
        return { updated: true };
      },
    },
  }));
});

afterEach(() => vi.restoreAllMocks());

const sseResponse = (): Response => new Response(
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start","message":{"id":"x","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-5-20250929","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n'));
      c.close();
    },
  }),
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
);

const cliClientCallOpts = (overrides: Partial<UpstreamCallOptions> = {}): UpstreamCallOptions => ({
  ...noopUpstreamCallOptions(),
  headers: new Headers({
    'user-agent': 'claude-cli/2.1.181 (external, cli)',
    'x-app': 'cli',
    'anthropic-beta': 'oauth-2025-04-20',
    'anthropic-version': '2023-06-01',
  }),
  ...overrides,
});

// Spy on globalThis.fetch to return the canned /v1/models payload. The
// cached access token on `activeAccount` short-circuits the OAuth mint, so
// the only outbound request the catalog refresh issues is the /v1/models
// GET — making a single mock sufficient.
const stubModelsListFetch = (): ReturnType<typeof vi.spyOn> => vi.spyOn(globalThis, 'fetch').mockResolvedValue(
  new Response(JSON.stringify({ data: API_MODELS }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }),
);

describe('createClaudeCodeProvider — factory surface', () => {
  test('getProvidedModels mirrors the live /v1/models catalog under public aliases', async () => {
    stubModelsListFetch();
    const instance = await createClaudeCodeProvider(currentRecord);
    const models = await instance.provider.getProvidedModels(noopUpstreamCallOptions().fetcher);
    expect(models.map(m => m.id)).toEqual([
      'claude-fable-5',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-opus-4-5',
      'claude-haiku-4-5',
    ]);
  });

  test('getProvidedModels stamps the effective flag set onto every model', async () => {
    // claude-code has zero declared flag defaults — verify the effective set
    // stays empty regardless of the other providers' defaults.
    stubModelsListFetch();
    const instance = await createClaudeCodeProvider(currentRecord);
    const models = await instance.provider.getProvidedModels(noopUpstreamCallOptions().fetcher);
    for (const m of models) {
      expect(m.enabledFlags.has('strip-billing-attribution')).toBe(false);
    }
  });

  test('getPricingForModelKey wires through the pricing table (keyed by dated upstream id)', async () => {
    const instance = await createClaudeCodeProvider(currentRecord);
    expect(instance.provider.getPricingForModelKey('claude-sonnet-4-5-20250929'))
      .toEqual(pricingForClaudeCodeModelKey('claude-sonnet-4-5-20250929'));
    expect(instance.provider.getPricingForModelKey('unknown-id')).toBeNull();
  });

  test('providerKind is "claude-code" and supportsResponsesItemReference is false', async () => {
    const instance = await createClaudeCodeProvider(currentRecord);
    expect(instance.providerKind).toBe('claude-code');
    expect(instance.supportsResponsesItemReference).toBe(false);
    expect(instance.upstream).toBe(upstreamId);
  });
});

describe('createClaudeCodeProvider — callMessages routes through chain', () => {
  test('unshaped request runs the re-mimicry chain (3-block system, pinned UA, metadata.user_id)', async () => {
    const instance = await createClaudeCodeProvider(currentRecord);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());

    await instance.provider.callMessages(
      upstreamModel,
      { max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] },
      undefined,
      noopUpstreamCallOptions(),
    );

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const wireHeaders = new Headers(init.headers);
    expect(wireHeaders.get('user-agent')).toMatch(/^claude-cli\//);
    expect(wireHeaders.get('anthropic-beta')).toBeTruthy();

    const body = JSON.parse(init.body as string);
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system).toHaveLength(3);
    expect(body.system[0].text).toMatch(/^x-anthropic-billing-header:/);
    expect(body.system[1].text).toMatch(/^You are Claude Code/);
    expect(body.system[2].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
    expect(typeof body.metadata.user_id).toBe('string');
    expect(body.metadata.user_id.startsWith('{')).toBe(true);
  });

  test('shaped request preserves caller-supplied system + headers (chain skipped)', async () => {
    const instance = await createClaudeCodeProvider(currentRecord);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());

    const userId = JSON.stringify({ device_id: 'd'.repeat(32), account_uuid: '', session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    await instance.provider.callMessages(
      upstreamModel,
      {
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
        system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
        metadata: { user_id: userId },
      },
      undefined,
      cliClientCallOpts(),
    );

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    // System stays as the operator sent it — the chain did NOT mutate to
    // the 3-block re-mimicry shape.
    expect(body.system).toHaveLength(1);
    expect(body.system[0].text).toMatch(/^You are Claude Code/);
    // metadata.user_id stays verbatim.
    expect(body.metadata.user_id).toBe(userId);
    // Whitelisted inbound headers reach the wire so the operator's CC
    // fingerprint stays end-to-end consistent (sub2api allowedHeaders).
    const wireHeaders = new Headers(init.headers);
    expect(wireHeaders.get('user-agent')).toBe('claude-cli/2.1.181 (external, cli)');
    expect(wireHeaders.get('x-app')).toBe('cli');
    expect(wireHeaders.get('anthropic-beta')).toBe('oauth-2025-04-20');
    expect(wireHeaders.get('anthropic-version')).toBe('2023-06-01');
    // Authorization is replaced by the cached OAuth token.
    expect(wireHeaders.get('authorization')).toBe('Bearer at_cached');
  });

  test('CC UA but a payload that fails the strict shape gate still runs the chain', async () => {
    const instance = await createClaudeCodeProvider(currentRecord);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());

    await instance.provider.callMessages(
      upstreamModel,
      { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      { ...noopUpstreamCallOptions(), headers: new Headers({ 'user-agent': 'claude-cli/2.1.181' }) },
    );

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    // Re-mimicry ran: system was rebuilt into the 3-block shape.
    expect(body.system).toHaveLength(3);
  });
});
