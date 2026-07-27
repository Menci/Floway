import { describe, expect, it, beforeEach } from 'vitest';

import {
  getSocketDial,
  initSocketDial,
  normalizeDialHost,
  resetSocketDialForTesting,
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
});
