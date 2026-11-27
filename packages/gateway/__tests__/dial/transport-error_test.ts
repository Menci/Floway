import { expect, test } from 'vitest';

import { isUpstreamTransportError } from '../../src/dial/transport-error.ts';
import { HttpTransportError } from '@floway-dev/http';
import { ProxyDialError } from '@floway-dev/proxy';

test('transport classification excludes cancellations, configuration errors and mixed internal failures', () => {
  const abort = new DOMException('cancelled', 'AbortError');
  const dial = new ProxyDialError('refused', 'tcp-connect');
  expect(isUpstreamTransportError(new AggregateError([dial, new HttpTransportError(new Error('fetch failed'))]))).toBe(true);
  for (const error of [abort, new ProxyDialError('invalid proxy', 'config'), new AggregateError([]), new AggregateError([dial, new Error('repo failed')])]) {
    expect(isUpstreamTransportError(error)).toBe(false);
  }
});
