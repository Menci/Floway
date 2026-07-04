import { describe, expect, it, beforeEach } from 'vitest';

import {
  FakeDurableHttpSession,
  getDurableHttpSession,
  initDurableHttpSession,
  resetDurableHttpSessionForTesting,
  type DurableHttpSession,
  type DurableHttpSessionHandle,
} from './durable-http-session.ts';

describe('DurableHttpSession singleton', () => {
  beforeEach(() => {
    resetDurableHttpSessionForTesting();
  });

  it('throws when used before init', () => {
    expect(() => getDurableHttpSession()).toThrow('DurableHttpSession not initialized');
  });

  it('returns the registered impl after init', () => {
    const fake: DurableHttpSession = {
      acquire: async (): Promise<DurableHttpSessionHandle | null> => null,
    };
    initDurableHttpSession(fake);
    expect(getDurableHttpSession()).toBe(fake);
  });

  it('overwrites the previously registered impl on re-init', () => {
    const first: DurableHttpSession = { acquire: async () => null };
    const second: DurableHttpSession = { acquire: async () => null };
    initDurableHttpSession(first);
    initDurableHttpSession(second);
    expect(getDurableHttpSession()).toBe(second);
  });

  it('resets to uninitialized after resetDurableHttpSessionForTesting()', () => {
    initDurableHttpSession({ acquire: async () => null });
    expect(getDurableHttpSession()).toBeDefined();
    resetDurableHttpSessionForTesting();
    expect(() => getDurableHttpSession()).toThrow('DurableHttpSession not initialized');
  });
});

describe('FakeDurableHttpSession', () => {
  it('returns null on miss when init is null', async () => {
    const fake = new FakeDurableHttpSession();
    const handle = await fake.acquire('key', null);
    expect(handle).toBeNull();
    expect(fake.acquired).toEqual([{ sessionKey: 'key', init: null }]);
  });

  it('seeds a new entry from registered scripts on miss + init non-null', async () => {
    const fake = new FakeDurableHttpSession();
    fake.scripts.set('key', {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      body: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])],
    });
    const handle = await fake.acquire('key', { method: 'POST', url: 'https://x', headers: {} });
    expect(handle).not.toBeNull();
    expect(handle!.status).toBe(200);
    expect(handle!.headers.get('content-type')).toBe('application/octet-stream');

    const chunks: Uint8Array[] = [];
    const reader = handle!.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(chunks.map(c => Array.from(c))).toEqual([[1, 2, 3], [4, 5]]);
  });

  it('hits the cached entry on a subsequent acquire(key, null)', async () => {
    const fake = new FakeDurableHttpSession();
    fake.scripts.set('key', { status: 201, headers: {}, body: [new Uint8Array([9])] });
    await fake.acquire('key', { method: 'POST', url: 'https://x', headers: {} });
    const handle = await fake.acquire('key', null);
    expect(handle).not.toBeNull();
    expect(handle!.status).toBe(201);
  });

  it('records release and discard calls in order', async () => {
    const fake = new FakeDurableHttpSession();
    fake.scripts.set('a', { status: 200, headers: {}, body: [] });
    fake.scripts.set('b', { status: 200, headers: {}, body: [] });
    const a = await fake.acquire('a', { method: 'GET', url: 'https://x', headers: {} });
    const b = await fake.acquire('b', { method: 'GET', url: 'https://x', headers: {} });
    await a!.release();
    await b!.discard('protocol error');
    expect(fake.released).toEqual(['a']);
    expect(fake.discarded).toEqual([{ sessionKey: 'b', reason: 'protocol error' }]);
  });

  it('discard evicts the entry so the next acquire(key, null) returns null', async () => {
    const fake = new FakeDurableHttpSession();
    fake.scripts.set('k', { status: 200, headers: {}, body: [] });
    const h = await fake.acquire('k', { method: 'GET', url: 'https://x', headers: {} });
    await h!.discard('done');
    const next = await fake.acquire('k', null);
    expect(next).toBeNull();
  });

  it('throws when acquiring with init for a key that has no registered script', async () => {
    const fake = new FakeDurableHttpSession();
    await expect(
      fake.acquire('unknown', { method: 'GET', url: 'https://x', headers: {} }),
    ).rejects.toThrow('no script registered');
  });
});
