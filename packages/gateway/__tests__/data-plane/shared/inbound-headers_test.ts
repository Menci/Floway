import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import { inboundHeaders, filterInboundHeaders, filterInboundHeadersForProvider } from '../../../src/data-plane/shared/inbound-headers.ts';
import { buildUpstreamCallOptions } from '../../../src/data-plane/shared/upstream-call-options.ts';
import { mockGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import type { InboundHeaderMatcher } from '@floway-dev/provider';
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
  const provider = (inboundHeaderAllowlist: readonly InboundHeaderMatcher[]) => ({
    ...stubModelCandidate().provider,
    inboundHeaderAllowlist,
  });

  test('reads the selected provider instance allowlist', () => {
    const source = new Headers({ 'x-first': 'one', 'x-second': 'two' });

    expect(headerRecord(filterInboundHeadersForProvider(source, provider(['x-first'])))).toEqual({ 'x-first': 'one' });
    expect(headerRecord(filterInboundHeadersForProvider(source, provider(['x-second'])))).toEqual({ 'x-second': 'two' });
  });

  test('buildUpstreamCallOptions filters independently for each failover candidate', () => {
    const source = new Headers({
      authorization: 'Bearer secret',
      'user-agent': 'claude-cli/2.1.181',
      'x-client-request-id': 'request-1',
    });
    const ctx = mockGatewayCtx();
    const first = buildUpstreamCallOptions(stubModelCandidate({ provider: provider([]) }), ctx, source);
    const second = buildUpstreamCallOptions(stubModelCandidate({
      provider: {
        ...provider(['user-agent', 'x-client-request-id']),
        instance: stubProvider(),
      },
    }), ctx, source);
    first.headers.set('x-client-request-id', 'candidate-mutation');

    expect([...first.headers]).toEqual([['x-client-request-id', 'candidate-mutation']]);
    expect(headerRecord(second.headers)).toEqual({
      'user-agent': 'claude-cli/2.1.181',
      'x-client-request-id': 'request-1',
    });
    expect(source.get('x-client-request-id')).toBe('request-1');
  });
});
