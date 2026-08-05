import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import { inboundHeaders, resolveIngressHeaders, resolveIngressHeadersForProvider } from '../../../src/data-plane/shared/inbound-headers.ts';
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

describe('resolveIngressHeaders', () => {
  test('matches exact names case-insensitively and strips every other name', () => {
    const source = new Headers({
      authorization: 'Bearer secret',
      'x-client-request-id': 'request-1',
      'x-debug': 'discard',
    });

    expect(headerRecord(resolveIngressHeaders(source, ['X-Client-Request-ID'], []))).toEqual({
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
    const filtered = resolveIngressHeaders(new Headers({
      'x-trace-one': '1',
      'x-trace-two': '2',
      'x-trace-three': '3',
    }), [matcher], []);

    expect(headerRecord(filtered)).toEqual({ 'x-trace-one': '1', 'x-trace-two': '2' });
    expect(matcher.lastIndex).toBe(0);
  });

  test('returns a fresh empty bag for an empty policy', () => {
    const source = new Headers({ 'x-client-request-id': 'request-1' });
    const first = resolveIngressHeaders(source, [], []);
    const second = resolveIngressHeaders(source, [], []);

    expect([...first]).toEqual([]);
    expect(first).not.toBe(second);
  });
});

describe('provider inbound header policies', () => {
  const provider = (kind: UpstreamProviderKind, ingressHeaderRules = stubModelCandidate().provider.ingressHeaderRules) => ({
    ...stubModelCandidate().provider,
    kind,
    ingressHeaderRules,
  });

  test.each<UpstreamProviderKind>(['custom', 'azure', 'ollama', 'copilot'])(
    '%s accepts no ordinary client headers',
    kind => {
      const filtered = resolveIngressHeadersForProvider(new Headers({
        'anthropic-beta': 'context-1m',
        authorization: 'Bearer secret',
        'x-client-request-id': 'request-1',
      }), provider(kind));
      expect([...filtered]).toEqual([]);
    },
  );

  test('Claude Code accepts only its declared ordinary fingerprint', () => {
    const accepted = {
      accept: 'application/json',
      'accept-encoding': 'identity',
      'accept-language': 'en-US',
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
      'anthropic-beta': 'claude-code-20250219',
      authorization: 'Bearer secret',
      'x-leaky-debug': 'discard',
      'x-stainless-future': 'discard',
    });

    expect(headerRecord(resolveIngressHeadersForProvider(source, provider('claude-code')))).toEqual(accepted);
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

    expect(headerRecord(resolveIngressHeadersForProvider(source, provider('codex')))).toEqual({
      'session-id': 'session-1',
      session_id: 'session-legacy',
      'thread-id': 'thread-1',
      'x-client-request-id': 'request-1',
      'x-codex-turn-metadata': '{}',
      'x-codex-window-id': 'window-1',
    });
  });

  test('Custom rules passthrough or overwrite only matching ingress headers', () => {
    const source = new Headers({
      'x-empty': 'client-empty',
      'x-overwrite': 'client-overwrite',
      'x-passthrough': 'client-passthrough',
      'x-unlisted': 'discard',
    });
    const custom = provider('custom', [
      { matcher: 'X-Passthrough', value: null },
      { matcher: 'x-overwrite', value: 'configured' },
      { matcher: 'x-empty', value: '' },
      { matcher: 'x-missing', value: 'not-injected' },
    ]);

    expect(headerRecord(resolveIngressHeadersForProvider(source, custom))).toEqual({
      'x-empty': '',
      'x-overwrite': 'configured',
      'x-passthrough': 'client-passthrough',
    });
    expect(headerRecord(source)).toEqual({
      'x-empty': 'client-empty',
      'x-overwrite': 'client-overwrite',
      'x-passthrough': 'client-passthrough',
      'x-unlisted': 'discard',
    });
  });

  test('resolves instance rules independently for same-kind failover candidates', () => {
    const source = new Headers({ 'x-route': 'client' });
    const first = resolveIngressHeadersForProvider(source, provider('custom', [{ matcher: 'x-route', value: 'first' }]));
    const second = resolveIngressHeadersForProvider(source, provider('custom', [{ matcher: 'x-route', value: 'second' }]));

    expect(first.get('x-route')).toBe('first');
    expect(second.get('x-route')).toBe('second');
    expect(source.get('x-route')).toBe('client');
  });

  test('buildUpstreamCallOptions resolves independently for each failover candidate', () => {
    const source = new Headers({
      authorization: 'Bearer secret',
      'user-agent': 'claude-cli/2.1.181',
      'x-client-request-id': 'request-1',
    });
    const providerWithInstance = (kind: UpstreamProviderKind) => ({
      ...provider(kind),
      instance: stubProvider(),
    });
    const ctx = mockGatewayCtx();

    const custom = buildUpstreamCallOptions(stubModelCandidate({ provider: providerWithInstance('custom') }), ctx, source);
    const claude = buildUpstreamCallOptions(stubModelCandidate({ provider: providerWithInstance('claude-code') }), ctx, source);
    custom.headers.set('x-client-request-id', 'candidate-mutation');

    expect([...custom.headers]).toEqual([['x-client-request-id', 'candidate-mutation']]);
    expect(headerRecord(claude.headers)).toEqual({
      'user-agent': 'claude-cli/2.1.181',
      'x-client-request-id': 'request-1',
    });
    expect(source.get('x-client-request-id')).toBe('request-1');
  });
});
