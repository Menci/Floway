import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import { mockGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import { inboundHeaders, filterInboundHeaders, filterInboundHeadersForProvider } from '../../../src/data-plane/shared/inbound-headers.ts';
import { buildUpstreamCallOptions } from '../../../src/data-plane/shared/upstream-call-options.ts';
import type { UpstreamProviderKind } from '@floway-dev/provider';
import { claudeCodeProviderModule } from '@floway-dev/provider-claude-code';
import { codexProviderModule } from '@floway-dev/provider-codex';
import { stubModelCandidate, stubProvider } from '@floway-dev/test-utils';

const headerRecord = (headers: Headers): Record<string, string> => Object.fromEntries(headers);

describe('inboundHeaders', () => {
  test('copies the complete request bag for candidate-specific filtering', async () => {
    const app = new Hono();
    let first: Headers | undefined;
    let second: Headers | undefined;
    app.get('/test', c => {
      first = inboundHeaders(c);
      second = inboundHeaders(c);
      return c.text('ok');
    });

    await app.request('/test', {
      headers: {
        authorization: 'Bearer gateway-key',
        'x-client-request-id': 'request-1',
      },
    });

    expect(first?.get('authorization')).toBe('Bearer gateway-key');
    expect(first?.get('x-client-request-id')).toBe('request-1');
    expect(first).not.toBe(second);
    first?.set('x-client-request-id', 'mutated');
    expect(second?.get('x-client-request-id')).toBe('request-1');
  });
});

describe('filterInboundHeaders', () => {
  test('matches exact names case-insensitively and strips every other name', () => {
    const source = new Headers({
      authorization: 'Bearer secret',
      'x-client-request-id': 'request-1',
      'x-debug': 'discard',
    });

    expect(headerRecord(filterInboundHeaders(source, ['X-Client-Request-ID']))).toEqual({
      'x-client-request-id': 'request-1',
    });
    expect(headerRecord(source)).toEqual({
      authorization: 'Bearer secret',
      'x-client-request-id': 'request-1',
      'x-debug': 'discard',
    });
  });

  test('matches regular expressions against lowercase names without retaining matcher state', () => {
    const matcher = /^x-trace-(?:one|two)$/g;
    const filtered = filterInboundHeaders(new Headers({
      'x-trace-one': '1',
      'x-trace-two': '2',
      'x-trace-three': '3',
    }), [matcher]);

    expect(headerRecord(filtered)).toEqual({ 'x-trace-one': '1', 'x-trace-two': '2' });
    expect(matcher.lastIndex).toBe(0);
  });

  test('returns a fresh empty bag for an empty allowlist', () => {
    const source = new Headers({ 'x-client-request-id': 'request-1' });
    const first = filterInboundHeaders(source, []);
    const second = filterInboundHeaders(source, []);

    expect([...first]).toEqual([]);
    expect(first).not.toBe(second);
  });
});

describe('provider inbound header policies', () => {
  test.each<UpstreamProviderKind>(['custom', 'azure', 'ollama', 'copilot'])(
    '%s accepts no client headers',
    kind => {
      const filtered = filterInboundHeadersForProvider(new Headers({
        'anthropic-beta': 'context-1m',
        authorization: 'Bearer secret',
        'x-client-request-id': 'request-1',
      }), kind);
      expect([...filtered]).toEqual([]);
    },
  );

  test('Claude Code accepts only its declared fingerprint', () => {
    const source = new Headers({
      accept: 'application/json',
      authorization: 'Bearer secret',
      'anthropic-beta': 'claude-code-20250219',
      'content-type': 'application/json',
      'user-agent': 'claude-cli/2.1.181',
      'x-client-request-id': 'request-1',
      'x-leaky-debug': 'discard',
      'x-stainless-runtime-version': '24.0.0',
    });

    const filtered = filterInboundHeadersForProvider(source, 'claude-code');
    expect(headerRecord(filtered)).toEqual({
      accept: 'application/json',
      'anthropic-beta': 'claude-code-20250219',
      'content-type': 'application/json',
      'user-agent': 'claude-cli/2.1.181',
      'x-client-request-id': 'request-1',
      'x-stainless-runtime-version': '24.0.0',
    });
    expect(headerRecord(filterInboundHeaders(source, claudeCodeProviderModule.inboundHeaderAllowlist))).toEqual(headerRecord(filtered));
  });

  test('Codex accepts only request identity and turn metadata', () => {
    const source = new Headers({
      authorization: 'Bearer secret',
      'session-id': 'session-1',
      'thread-id': 'thread-1',
      'user-agent': 'untrusted',
      'x-client-request-id': 'request-1',
      'x-codex-installation-id': 'discard',
      'x-codex-turn-metadata': '{}',
      'x-codex-window-id': 'window-1',
    });

    const filtered = filterInboundHeadersForProvider(source, 'codex');
    expect(headerRecord(filtered)).toEqual({
      'session-id': 'session-1',
      'thread-id': 'thread-1',
      'x-client-request-id': 'request-1',
      'x-codex-turn-metadata': '{}',
      'x-codex-window-id': 'window-1',
    });
    expect(headerRecord(filterInboundHeaders(source, codexProviderModule.inboundHeaderAllowlist))).toEqual(headerRecord(filtered));
  });

  test('buildUpstreamCallOptions filters independently for each failover candidate', () => {
    const source = new Headers({
      authorization: 'Bearer secret',
      'user-agent': 'claude-cli/2.1.181',
      'x-client-request-id': 'request-1',
    });
    const provider = (kind: UpstreamProviderKind) => ({
      ...stubModelCandidate().provider,
      kind,
      instance: stubProvider(),
    });
    const ctx = mockGatewayCtx();

    const custom = buildUpstreamCallOptions(stubModelCandidate({ provider: provider('custom') }), ctx, source);
    const claude = buildUpstreamCallOptions(stubModelCandidate({ provider: provider('claude-code') }), ctx, source);
    custom.headers.set('x-client-request-id', 'candidate-mutation');

    expect([...custom.headers]).toEqual([['x-client-request-id', 'candidate-mutation']]);
    expect(headerRecord(claude.headers)).toEqual({
      'user-agent': 'claude-cli/2.1.181',
      'x-client-request-id': 'request-1',
    });
    expect(source.get('x-client-request-id')).toBe('request-1');
  });
});
