import { describe, expect, it } from 'vitest';

import { ProxyDialError } from '../src/dial-error.ts';
import { isUpstreamTransportError } from '@floway-dev/http';

describe('ProxyDialError transport classification', () => {
  it.each(['tcp-connect', 'outer-tls', 'proxy-handshake', 'inner-tls'] as const)('recognizes %s failures', stage => {
    expect(isUpstreamTransportError(new ProxyDialError('proxy dial failed', stage))).toBe(true);
  });

  it('rejects configuration failures', () => {
    expect(isUpstreamTransportError(new ProxyDialError('invalid proxy port', 'config'))).toBe(false);
  });
});
