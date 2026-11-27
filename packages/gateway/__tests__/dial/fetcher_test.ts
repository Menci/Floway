import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFetcher } from '../../src/dial/fetcher.ts';
import type { ProxyEntry } from '../../src/dial/proxy-catalog.ts';
import { InMemoryRepo } from '../repo/memory.ts';
import { saveUpstreamForTest } from '../repo/upstreams.ts';
import { buildCustomUpstreamRecord } from '../test-utils/app.ts';
import { HttpTransportError } from '@floway-dev/http';
import { ProxyDialError, type ProxyConfig, type SocketDial } from '@floway-dev/proxy';
import { isReplayableBody, type ReplayableBody } from '@floway-dev/upstream';

const stubSocketDial: SocketDial = {
  connect: async () => {
    throw new Error('stub socket dial — runProxied is mocked, this should not be called');
  },
  startTls: async () => {
    throw new Error('stub socket dial — runProxied is mocked, this should not be called');
  },
};

// Backoff rows reference saved proxies and upstreams, so the fixtures the
// fetcher dials through exist in the repository it records against.
const seededRepo = async (): Promise<InMemoryRepo> => {
  const repo = new InMemoryRepo();
  for (const id of ['a', 'b']) await repo.proxies.insert({ id, name: id, url: `socks5://${id}:1`, dialTimeoutSeconds: null });
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'u' }));
  return repo;
};

describe('createFetcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  const proxyA: ProxyEntry = { config: { kind: 'socks5', host: 'a', port: 1, name: 'a' }, dialTimeoutMs: null };
  const proxyB: ProxyEntry = { config: { kind: 'socks5', host: 'b', port: 1, name: 'b' }, dialTimeoutMs: null };

  it('first-pass tries each non-backoff entry in order and short-circuits on success', async () => {
    const repo = await seededRepo();
    await repo.proxyBackoffs.recordDialFailure('a', 'u', 'x');
    const calls: string[] = [];
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }, { id: 'b' }, { id: 'direct_fetch' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA], ['b', proxyB]]),
      runProxied: async (config: ProxyConfig) => {
        calls.push(config.host);
        return new Response('ok');
      },
      runDirectFetch: async () => {
        calls.push('direct');
        return new Response('direct');
      },
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });
    const res = await fetcher('https://api.openai.com/v1/models', { method: 'GET' });
    expect(await res.text()).toBe('ok');
    expect(calls).toEqual(['b']);
  });

  it('tags the unknown-proxy-id failure as stage=config so it does not register against backoff', async () => {
    const repo = await seededRepo();
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      // No direct-fetch fallback — the only entry is the unknown id, so the
      // call fails and the typed ProxyDialError surfaces directly (single-
      // entry chains skip the AggregateError wrapper).
      fallbackList: [{ id: 'p_unknown' }],
      runtimeLocation: 'TEST',
      proxyById: new Map(),
      runProxied: async () => new Response('proxy'),
      runDirectFetch: async () => { throw new Error('unreachable'); },
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });
    await expect(
      fetcher('https://api.openai.com', { method: 'GET' }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
    });
    // The unknown-id failure is a control-plane race, not a dial-stage
    // failure: backoff entries must stay untouched.
    const rows = await repo.proxyBackoffs.listForUpstream('u');
    expect(rows).toEqual([]);
  });

  it('non-ProxyDialError errors propagate immediately and do not update backoff', async () => {
    const repo = await seededRepo();
    const failure = new TypeError('upstream request construction failed');
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => { throw failure; },
      runDirectFetch: async () => new Response('ok'),
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });
    await expect(fetcher('https://api.openai.com', { method: 'GET' })).rejects.toBe(failure);
    expect(await repo.proxyBackoffs.listForUpstream('u')).toEqual([]);
  });

  it('uses one implicit fetch for a Cloudflare CONNECT rejection when the current colo has no fetch entry', async () => {
    const repo = await seededRepo();
    const blocked = new Error('blocked by workerd');
    const dial: SocketDial & { shouldConnectErrorFallbackToFetch(error: unknown): boolean } = {
      ...stubSocketDial,
      shouldConnectErrorFallbackToFetch: error => error === blocked,
    };
    const calls: string[] = [];
    const body = new FormData();
    body.set('prompt', 'hello');
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'direct_connect' }, { id: 'a' }, { id: 'direct_fetch', colos: ['NRT'] }],
      runtimeLocation: 'HKG',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => { throw new Error('unexpected proxy'); },
      runDirectConnect: async () => {
        calls.push('connect');
        throw new ProxyDialError('tcp connect failed', 'tcp-connect', { cause: blocked });
      },
      runDirectFetch: async (_url, init) => {
        calls.push('fetch');
        expect(new Headers(init.headers).get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
        if (!(init.body instanceof Uint8Array)) throw new Error('expected buffered fetch body');
        expect(new TextDecoder().decode(init.body)).toContain('hello');
        return new Response('fetched', { status: 503 });
      },
      socketDial: () => dial,
    });

    const response = await fetcher('https://example.com/generate', { method: 'POST', body });

    expect(await response.text()).toBe('fetched');
    expect(response.status).toBe(503);
    expect(calls).toEqual(['connect', 'fetch']);
    expect(await repo.proxyBackoffs.listForUpstream('u')).toEqual([]);
  });

  it('does not implicitly fetch on other direct-connect failures', async () => {
    const blocked = new Error('blocked by workerd');
    const fetch = vi.fn(async () => new Response('fetched'));
    const run = (stage: ProxyDialError['stage'], cause: Error, socketDial: SocketDial) => createFetcher({
      repo: new InMemoryRepo(),
      upstreamId: 'u',
      fallbackList: [],
      runtimeLocation: 'HKG',
      proxyById: new Map(),
      runProxied: async () => { throw new Error('unexpected proxy'); },
      runDirectConnect: async () => { throw new ProxyDialError('dial failed', stage, { cause }); },
      runDirectFetch: fetch,
      socketDial: () => socketDial,
    });
    const cloudflareDial = { ...stubSocketDial, shouldConnectErrorFallbackToFetch: (error: unknown) => error === blocked };

    await expect(run('inner-tls', blocked, cloudflareDial)('https://example.com', { method: 'GET' })).rejects.toMatchObject({ cause: { stage: 'inner-tls', cause: blocked } });
    await expect(run('tcp-connect', new Error('connection refused'), cloudflareDial)('https://example.com', { method: 'GET' })).rejects.toMatchObject({ cause: { stage: 'tcp-connect' } });
    await expect(run('tcp-connect', blocked, stubSocketDial)('https://example.com', { method: 'GET' })).rejects.toMatchObject({ cause: { stage: 'tcp-connect', cause: blocked } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rethrows the caller cancellation without continuing the chain', async () => {
    const repo = await seededRepo();
    const calls: string[] = [];
    const controller = new AbortController();
    const reason = new Error('client gone');
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'direct_fetch' }, { id: 'a' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async (config: ProxyConfig) => {
        calls.push(`proxy:${config.host}`);
        return new Response('proxy-should-not-be-called');
      },
      runDirectFetch: async () => {
        calls.push('direct');
        controller.abort(reason);
        throw reason;
      },
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });
    await expect(fetcher('https://api.openai.com', { method: 'GET', signal: controller.signal })).rejects.toBe(reason);
    expect(calls).toEqual(['direct']);
    // No proxy was attempted, so backoff stays empty.
    expect(await repo.proxyBackoffs.listForUpstream('u')).toEqual([]);
  });

  it.each([false, true])('advances after a rejected direct fetch only with transport evidence (marked=%s)', async marked => {
    const failure = new TypeError('native fetch failed');
    const next = new Response('fallback');
    const runDirectConnect = vi.fn(async () => next);
    const fetcher = createFetcher({
      repo: new InMemoryRepo(),
      upstreamId: null,
      runtimeLocation: 'TEST',
      proxyById: new Map(),
      fallbackList: [{ id: 'direct_fetch' }, { id: 'direct_connect' }],
      runProxied: async () => { throw new Error('unexpected proxy'); },
      runDirectFetch: async () => { throw marked ? new HttpTransportError(failure) : failure; },
      runDirectConnect,
      socketDial: () => stubSocketDial,
    });

    const pending = fetcher('https://upstream.test', { method: 'GET' });
    if (marked) {
      await expect(pending).resolves.toBe(next);
      expect(runDirectConnect).toHaveBeenCalledOnce();
    } else {
      await expect(pending).rejects.toBe(failure);
      expect(runDirectConnect).not.toHaveBeenCalled();
    }
  });

  it('opens a fresh replayable body stream for each fallback attempt', async () => {
    const repo = await seededRepo();
    let opens = 0;
    const observed: string[] = [];
    const body: ReplayableBody = {
      contentLength: 12,
      open: () => {
        opens += 1;
        return new Blob(['request body']).stream();
      },
    };
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }, { id: 'direct_fetch' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async (_config, _target, request) => {
        if (request.body instanceof Uint8Array || request.body === undefined) throw new Error('expected replayable body');
        observed.push(await new Response(request.body.open()).text());
        throw new ProxyDialError('proxy unavailable', 'tcp-connect');
      },
      runDirectFetch: async (_url, init) => {
        if (!isReplayableBody(init.body)) throw new Error('expected replayable body');
        observed.push(await new Response(init.body.open()).text());
        return new Response('direct');
      },
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });

    const response = await fetcher('https://api.openai.com/v1/responses', { method: 'POST', body });

    expect(await response.text()).toBe('direct');
    expect(observed).toEqual(['request body', 'request body']);
    expect(opens).toBe(2);
  });

  it('does not discard a healthy Response when the success-path backoff clear rejects', async () => {
    // Pre-record a failure so recordDialSuccess has a row to DELETE; then
    // wedge the backoff repo so the clear write rejects mid-call. The
    // Response we already hold MUST reach the caller — bookkeeping
    // failures cannot shadow request outcomes (mirrors the failure
    // path's existing log-and-swallow policy).
    const repo = await seededRepo();
    await repo.proxyBackoffs.recordDialFailure('a', 'u', 'old');
    const original = repo.proxyBackoffs.recordDialSuccess.bind(repo.proxyBackoffs);
    repo.proxyBackoffs.recordDialSuccess = async () => { throw new Error('transient store outage'); };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => new Response('ok'),
      runDirectFetch: async () => new Response('direct'),
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });
    const res = await fetcher('https://api.openai.com', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    repo.proxyBackoffs.recordDialSuccess = original;
    warnSpy.mockRestore();
  });

  it('neither consults nor records backoff state without a saved upstream', async () => {
    const repo = await seededRepo();
    await repo.proxyBackoffs.recordDialFailure('a', 'u', 'saved upstream cooldown');
    const before = await repo.proxyBackoffs.listAll();
    const calls: string[] = [];
    const fetcher = createFetcher({
      repo,
      upstreamId: null,
      fallbackList: [{ id: 'a' }, { id: 'b' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA], ['b', proxyB]]),
      runProxied: async config => {
        calls.push(config.host);
        if (config.host === 'a') throw new ProxyDialError('tcp connect failed', 'tcp-connect');
        return new Response('ok');
      },
      runDirectFetch: async () => new Response('direct'),
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });

    expect(await (await fetcher('https://api.openai.com', { method: 'GET' })).text()).toBe('ok');
    // A saved upstream's cooldown on 'a' does not steer this dial, and the
    // failure on 'a' plus the success on 'b' leave the table untouched.
    expect(calls).toEqual(['a', 'b']);
    expect(await repo.proxyBackoffs.listAll()).toEqual(before);
  });
});
