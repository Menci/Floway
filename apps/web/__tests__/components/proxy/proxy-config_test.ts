import { describe, expect, it } from 'vitest';

import { defaultsFor, parseDialTimeoutInput, parseProxyInput, proxyUrlPlaceholder } from '../../../src/components/proxy/proxy-config';

describe('proxy URL editing', () => {
  it('parses a complete URI into the structured form', () => {
    expect(parseProxyInput('socks5://user:pass@example.com:1080').config).toMatchObject({
      kind: 'socks5',
      host: 'example.com',
      port: 1080,
      username: 'user',
      password: 'pass',
    });
  });

  it('keeps parse errors and protocol-specific examples available to the form', () => {
    expect(parseProxyInput('not a proxy').error).toBe('malformed proxy URI: not a proxy');
    expect(proxyUrlPlaceholder(defaultsFor('reality', { host: '', port: 0, name: '' }))).toContain('security=reality');
  });
});

describe('proxy dial timeout', () => {
  it('distinguishes the default, malformed values, and the upper bound', () => {
    expect(parseDialTimeoutInput('')).toEqual({ value: null, error: null });
    expect(parseDialTimeoutInput('1.5')).toEqual({ value: null, error: 'positive' });
    expect(parseDialTimeoutInput('601')).toEqual({ value: null, error: 'maximum' });
    expect(parseDialTimeoutInput('600')).toEqual({ value: 600, error: null });
  });
});
