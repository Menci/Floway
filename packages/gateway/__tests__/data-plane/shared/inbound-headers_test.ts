import { describe, expect, test } from 'vitest';

import { filterInboundHeaders } from '../../../src/data-plane/shared/inbound-headers.ts';
import { buildUpstreamCallOptions } from '../../../src/data-plane/shared/upstream-call-options.ts';
import { mockGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import { stubModelCandidate, stubUpstream } from '@floway-dev/test-utils';
import type { InboundHeaderMatcher } from '@floway-dev/upstream';

const headerRecord = (headers: Headers): Record<string, string> => Object.fromEntries(headers);

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
});

describe('provider inbound header policies', () => {
  const upstream = (inboundHeaderAllowlist: readonly InboundHeaderMatcher[]) => ({
    ...stubModelCandidate().upstream,
    inboundHeaderAllowlist,
  });

  test('buildUpstreamCallOptions filters independently for each failover candidate', () => {
    const source = new Headers({
      authorization: 'Bearer secret',
      'user-agent': 'claude-cli/2.1.181',
      'x-client-request-id': 'request-1',
    });
    const ctx = mockGatewayCtx();
    const first = buildUpstreamCallOptions(stubModelCandidate({ upstream: upstream([]) }), ctx, source);
    const second = buildUpstreamCallOptions(stubModelCandidate({
      upstream: {
        ...upstream(['user-agent', 'x-client-request-id']),
        instance: stubUpstream(),
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
