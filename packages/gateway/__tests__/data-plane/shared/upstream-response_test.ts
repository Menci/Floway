import { expect, test } from 'vitest';

import { isForwardableUpstreamHeader } from '../../../src/data-plane/shared/upstream-response.ts';
import { filterHeaders, type HttpHeaders } from '@floway-dev/http';

test('upstream response header policy preserves vendor metadata and blocks hop-by-hop, session and representation headers', () => {
  const headers: HttpHeaders = [
    ['X-Request-ID', 'abc'],
    ['retry-after', '7'],
    ['X-RateLimit', '5'],
    ['x-ratelimit', 'counted'],
    ['Connection', 'close'],
    ['Proxy-Authenticate', 'Basic'],
    ['Set-Cookie', 'upstream=session'],
    ['Content-Length', '15'],
    ['Content-Encoding', 'gzip'],
    ['Content-Type', 'text/event-stream'],
  ];
  expect(filterHeaders(headers, isForwardableUpstreamHeader)).toEqual([
    ['X-Request-ID', 'abc'],
    ['retry-after', '7'],
    ['X-RateLimit', '5'],
    ['x-ratelimit', 'counted'],
  ]);
});
