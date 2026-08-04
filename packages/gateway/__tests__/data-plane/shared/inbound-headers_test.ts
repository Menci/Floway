import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import { inboundHeaders, filterInboundHeaders, filterInboundHeadersForProvider } from '../../../src/data-plane/shared/inbound-headers.ts';
import { buildUpstreamCallOptions } from '../../../src/data-plane/shared/upstream-call-options.ts';
import { mockGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import type { UpstreamProviderKind } from '@floway-dev/provider';
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
  test.each<UpstreamProviderKind>(['custom', 'azure', 'ollama'])(
    '%s accepts no client headers',
    kind => {
      const filtered = filterInboundHeadersForProvider(new Headers({
        'anthropic-beta': 'context-1m',
        authorization: 'Bearer secret',
        'x-client-request-id': 'request-1',
      }), kind, 'callMessages');
      expect([...filtered]).toEqual([]);
    },
  );

  test('Copilot accepts anthropic-beta only on Messages surfaces', () => {
    const source = new Headers({
      'anthropic-beta': 'context-1m-2025-08-07',
      authorization: 'Bearer secret',
    });
    expect(headerRecord(filterInboundHeadersForProvider(source, 'copilot', 'callMessages'))).toEqual({
      'anthropic-beta': 'context-1m-2025-08-07',
    });
    expect(headerRecord(filterInboundHeadersForProvider(source, 'copilot', 'callMessagesCountTokens'))).toEqual({
      'anthropic-beta': 'context-1m-2025-08-07',
    });
    expect([...filterInboundHeadersForProvider(source, 'copilot', 'callResponses')]).toEqual([]);
  });

  test('Claude Code accepts only its declared fingerprint', () => {
    const accepted = {
      accept: 'application/json',
      'accept-encoding': 'identity',
      'accept-language': 'en-US',
      'anthropic-beta': 'claude-code-20250219',
      'anthropic-dangerous-direct-browser-access': 'true',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'sec-fetch-mode': 'cors',
      'user-agent': 'claude-cli/2.1.181',
      'x-app': 'cli',
      'x-claude-code-session-id': 'session-1',
      'x-client-request-id': 'request-1',
      'x-stainless-arch': 'arm64',
      'x-stainless-helper-method': 'stream',
      'x-stainless-lang': 'js',
      'x-stainless-os': 'Linux',
      'x-stainless-package-version': '0.94.0',
      'x-stainless-retry-count': '0',
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': '24.0.0',
      'x-stainless-timeout': '600',
    };
    const source = new Headers({
      ...accepted,
      authorization: 'Bearer secret',
      'x-leaky-debug': 'discard',
      'x-stainless-future': 'discard',
    });

    const filtered = filterInboundHeadersForProvider(source, 'claude-code', 'callMessages');
    expect(headerRecord(filtered)).toEqual(accepted);
  });

  test('Codex accepts only request identity and turn metadata', () => {
    const source = new Headers({
      authorization: 'Bearer secret',
      'session-id': 'session-1',
      session_id: 'session-legacy',
      'thread-id': 'thread-1',
      'user-agent': 'untrusted',
      'x-client-request-id': 'request-1',
      'x-codex-installation-id': 'discard',
      'x-codex-turn-metadata': '{}',
      'x-codex-window-id': 'window-1',
    });

    const filtered = filterInboundHeadersForProvider(source, 'codex', 'callResponses');
    expect(headerRecord(filtered)).toEqual({
      'session-id': 'session-1',
      session_id: 'session-legacy',
      'thread-id': 'thread-1',
      'x-client-request-id': 'request-1',
      'x-codex-turn-metadata': '{}',
      'x-codex-window-id': 'window-1',
    });
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

    const custom = buildUpstreamCallOptions(stubModelCandidate({ provider: provider('custom') }), ctx, source, 'callMessages');
    const claude = buildUpstreamCallOptions(stubModelCandidate({ provider: provider('claude-code') }), ctx, source, 'callMessages');
    custom.headers.set('x-client-request-id', 'candidate-mutation');

    expect([...custom.headers]).toEqual([['x-client-request-id', 'candidate-mutation']]);
    expect(headerRecord(claude.headers)).toEqual({
      'user-agent': 'claude-cli/2.1.181',
      'x-client-request-id': 'request-1',
    });
    expect(source.get('x-client-request-id')).toBe('request-1');
  });

  test('passes Copilot Messages beta intent without exposing it to other surfaces', () => {
    const base = stubModelCandidate();
    const candidate = stubModelCandidate({
      provider: { ...base.provider, kind: 'copilot' },
    });
    const source = new Headers({
      'anthropic-beta': 'other-beta, context-1m-2025-08-07',
      authorization: 'Bearer secret',
    });
    const messages = buildUpstreamCallOptions(candidate, mockGatewayCtx(), source, 'callMessages');
    const responses = buildUpstreamCallOptions(candidate, mockGatewayCtx(), source, 'callResponses');

    expect(headerRecord(messages.headers)).toEqual({
      'anthropic-beta': 'other-beta, context-1m-2025-08-07',
    });
    expect([...responses.headers]).toEqual([]);
  });
});
