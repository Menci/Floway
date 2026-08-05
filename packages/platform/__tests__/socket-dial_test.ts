import { describe, expect, it, beforeEach } from 'vitest';

import {
  getSocketDial,
  initSocketDial,
  normalizeDialHost,
  resetSocketDialForTesting,
  validateDialPort,
  type SocketDial,
  type DialedSocket,
} from '../src/socket-dial.ts';

describe('SocketDial singleton', () => {
  beforeEach(() => {
    initSocketDial({
      connect: async () => {
        throw new Error('stub');
      },
    });
  });

  it('throws when used before init', () => {
    resetSocketDialForTesting();
    expect(() => getSocketDial()).toThrow('SocketDial not initialized');
  });

  it('returns the registered impl after init', () => {
    const fake: SocketDial = {
      connect: async (_host, _port): Promise<DialedSocket> => ({
        readable: new ReadableStream(),
        writable: new WritableStream(),
        close: async () => {},
      }),
    };
    initSocketDial(fake);
    expect(getSocketDial()).toBe(fake);
  });
});

describe('normalizeDialHost', () => {
  it('strips brackets around an IPv6 literal', () => {
    expect(normalizeDialHost('[::1]')).toBe('::1');
    expect(normalizeDialHost('[2001:db8::1]')).toBe('2001:db8::1');
  });

  it('passes through a DNS name unchanged', () => {
    expect(normalizeDialHost('api.example.com')).toBe('api.example.com');
  });

  it('passes through an IPv4 literal unchanged', () => {
    expect(normalizeDialHost('127.0.0.1')).toBe('127.0.0.1');
  });

  it.each(['', '[]'])('rejects empty host %j', host => {
    expect(() => normalizeDialHost(host)).toThrow('SocketDial host must not be empty');
  });
});

describe('validateDialPort', () => {
  it.each([1, 65_535])('accepts boundary port %d', port => {
    expect(validateDialPort(port)).toBe(port);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5, 65_536])('rejects invalid port %s', port => {
    expect(() => validateDialPort(port)).toThrow('SocketDial port must be an integer between 1 and 65535');
  });
});
