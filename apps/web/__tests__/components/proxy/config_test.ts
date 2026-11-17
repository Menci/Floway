import { describe, expect, it } from 'vitest';

import { hostPortLabel, parseDialTimeoutInput, parseProxyInput } from '../../../src/components/proxy/config';

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
});

describe('proxy address label', () => {
  it('keeps the credential out of the label of a URI this build cannot parse', () => {
    expect(hostPortLabel('quic://user:s3cret@example.com:8443')).toBe('example.com:8443');
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
