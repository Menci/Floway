import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { buildClaudeCodeCatalog, type ClaudeCodeApiModel } from '../src/models.ts';
import type { ClaudeCodeAccessTokenEntry, ClaudeCodeAccountCredential, ClaudeCodeUpstreamState } from '../src/state.ts';
import { createClaudeCodeUpstream } from '../src/upstream.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesTextBlockParam } from '@floway-dev/protocols/anthropic-messages';
import { noopAnthropicMessagesUpstreamCallOptions, readJsonRequest } from '@floway-dev/test-utils';
import { initUpstreamRuntimeRepo, type FlagId, type AnthropicMessagesUpstreamCallOptions, type UpstreamRecord } from '@floway-dev/upstream';

const upstreamId = 'up_cc_provider';

type WireAnthropicMessagesPayload = AnthropicMessagesPayload & {
  system: AnthropicMessagesTextBlockParam[];
  metadata: { user_id: string };
};

// The catalog builder emits a `UpstreamModel` with the dated upstream id on
// upstreamData, which the messages-routing tests need on the wire.
const API_MODELS: ClaudeCodeApiModel[] = [
  { id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5', max_input_tokens: 1_000_000 },
];
const sonnetUpstreamModel = buildClaudeCodeCatalog(API_MODELS, new Set<FlagId>())
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
  kind: 'claude-code',
  name: 'CC',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  config: { accounts: [{ email: 'a@b.com', accountUuid: 'acc-1', organizationUuid: null, subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' }] },
  state,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  hue: 210,
});

let currentRecord: UpstreamRecord;

beforeEach(() => {
  currentRecord = makeRecord({ accounts: [{ ...activeAccount }] });
  initUpstreamRuntimeRepo(() => ({
    recordUpstreamMetric: async () => {},
    upstreams: {
      getById: async () => ({ ...currentRecord, version: 1 }),
      saveState: async (_id, mutate) => {
        currentRecord = { ...currentRecord, state: mutate(currentRecord.state, 1) };
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

const cliClientCallOpts = (overrides: Partial<AnthropicMessagesUpstreamCallOptions> = {}): AnthropicMessagesUpstreamCallOptions => ({
  ...noopAnthropicMessagesUpstreamCallOptions(),
  headers: new Headers({
    'user-agent': 'claude-cli/2.1.280 (external, cli)',
    'x-app': 'cli',
    'anthropic-version': '2023-06-01',
  }),
  anthropicBeta: ['oauth-2025-04-20'],
  ...overrides,
});

describe('createClaudeCodeUpstream — callAnthropicMessages routes through chain', () => {
  test('unshaped request runs the re-mimicry chain (3-block system, pinned UA, metadata.user_id)', async () => {
    const instance = createClaudeCodeUpstream(currentRecord);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());

    await instance.instance.callAnthropicMessages(
      sonnetUpstreamModel,
      { max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] },
      undefined,
      noopAnthropicMessagesUpstreamCallOptions(),
    );

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const wireHeaders = new Headers(init.headers);
    expect(wireHeaders.get('user-agent')).toMatch(/^claude-cli\//);
    expect(wireHeaders.get('anthropic-beta')).toBeTruthy();

    const body = await readJsonRequest(init) as WireAnthropicMessagesPayload;
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system).toHaveLength(3);
    expect(body.system[0].text).toMatch(/^x-anthropic-billing-header:/);
    expect(body.system[1].text).toMatch(/^You are Claude Code/);
    expect(body.system[2].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
    expect(typeof body.metadata.user_id).toBe('string');
    expect(body.metadata.user_id.startsWith('{')).toBe(true);
  });

  test('shaped request preserves caller-supplied system + headers (chain skipped)', async () => {
    const instance = createClaudeCodeUpstream(currentRecord);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());

    const userId = JSON.stringify({ device_id: 'd'.repeat(32), account_uuid: '', session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    await instance.instance.callAnthropicMessages(
      sonnetUpstreamModel,
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
    const body = await readJsonRequest(init) as WireAnthropicMessagesPayload;
    // System stays as the operator sent it — the chain did NOT mutate to
    // the 3-block re-mimicry shape.
    expect(body.system).toHaveLength(1);
    expect(body.system[0].text).toMatch(/^You are Claude Code/);
    // metadata.user_id stays verbatim.
    expect(body.metadata.user_id).toBe(userId);
    // Whitelisted inbound headers reach the wire so the operator's CC
    // fingerprint stays end-to-end consistent (sub2api allowedHeaders).
    const wireHeaders = new Headers(init.headers);
    expect(wireHeaders.get('user-agent')).toBe('claude-cli/2.1.280 (external, cli)');
    expect(wireHeaders.get('x-app')).toBe('cli');
    expect(wireHeaders.get('anthropic-beta')).toBe('oauth-2025-04-20');
    expect(wireHeaders.get('anthropic-version')).toBe('2023-06-01');
    // Authorization is replaced by the cached OAuth token.
    expect(wireHeaders.get('authorization')).toBe('Bearer at_cached');
  });
});
