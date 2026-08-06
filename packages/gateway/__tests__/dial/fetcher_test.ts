import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFetcher } from '../../src/dial/fetcher.ts';
import type { ProxyEntry } from '../../src/dial/proxy-catalog.ts';
import { InMemoryRepo } from '../repo/memory.ts';
import type { HttpRequest } from '@floway-dev/http';
import { createReplayableBody, directFetcher, replayableBodySource } from '@floway-dev/provider';
import { ProxyDialError, type ProxyConfig, type ProxyRequestTarget, type SocketDial } from '@floway-dev/proxy';

const stubSocketDial: SocketDial = {
  connect: async () => {
    throw new Error('stub socket dial — runProxied is mocked, this should not be called');
  },
};

describe('createFetcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  const proxyAUrl = 'socks5://a:1';
  const proxyBUrl = 'socks5://b:1';
  const proxyA: ProxyEntry = { revision: 1, config: { kind: 'socks5', host: 'a', port: 1, name: 'a' }, dialTimeoutMs: null };
  const proxyB: ProxyEntry = { revision: 1, config: { kind: 'socks5', host: 'b', port: 1, name: 'b' }, dialTimeoutMs: null };

  const insertProxy = async (repo: InMemoryRepo, id: string, url: string, entry: ProxyEntry): Promise<void> => {
    const inserted = await repo.proxies.insert({ id, name: id, url, dialTimeoutSeconds: null });
    entry.revision = inserted.revision;
  };

  it('first-pass tries each non-backoff entry in order and short-circuits on success', async () => {
    const repo = new InMemoryRepo();
    await insertProxy(repo, 'a', proxyAUrl, proxyA);
    await repo.proxyBackoffs.recordDialFailure('a', 'u', proxyA.revision, 'x');
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

  it('records exactly one dial failure per call when the same entry is the only fallback', async () => {
    const repo = new InMemoryRepo();
    await insertProxy(repo, 'a', proxyAUrl, proxyA);
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => { throw new ProxyDialError('boom', 'tcp-connect'); },
      runDirectFetch: async () => new Response('ok'),
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });
    await expect(fetcher('https://api.openai.com', { method: 'GET' })).rejects.toBeInstanceOf(ProxyDialError);
    const [row] = await repo.proxyBackoffs.listForUpstream('u');
    // Pass-2 only walks entries pass-1 skipped (i.e. ones in active backoff).
    // A fresh entry that fails pass-1 stays out of pass-2, so we record one
    // failure per real failure — preserving the geometric backoff schedule.
    expect(row!.failCount).toBe(1);
  });

  it('clears backoff on dial success', async () => {
    const repo = new InMemoryRepo();
    await insertProxy(repo, 'a', proxyAUrl, proxyA);
    await repo.proxyBackoffs.recordDialFailure('a', 'u', proxyA.revision, 'x');
    await repo.proxyBackoffs.recordDialFailure('a', 'u', proxyA.revision, 'x');
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => new Response('ok'),
      runDirectFetch: async () => new Response('ok'),
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });
    // first-pass skips a (in backoff). second-pass ignores backoff and succeeds.
    await fetcher('https://api.openai.com', { method: 'GET' });
    expect(await repo.proxyBackoffs.listForUpstream('u')).toEqual([]);
  });

  it('falls through to second pass when first pass exhausts', async () => {
    const repo = new InMemoryRepo();
    await insertProxy(repo, 'a', proxyAUrl, proxyA);
    await insertProxy(repo, 'b', proxyBUrl, proxyB);
    await repo.proxyBackoffs.recordDialFailure('a', 'u', proxyA.revision, 'x');
    await repo.proxyBackoffs.recordDialFailure('b', 'u', proxyB.revision, 'x');
    const order: string[] = [];
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }, { id: 'b' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA], ['b', proxyB]]),
      runProxied: async (config: ProxyConfig) => {
        order.push(config.host);
        if (order.length < 2) throw new ProxyDialError('still bad', 'tcp-connect');
        return new Response('ok');
      },
      runDirectFetch: async () => new Response('ok'),
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });
    await fetcher('https://api.openai.com', { method: 'GET' });
    expect(order).toEqual(['a', 'b']);
  });

  it('only adds one failure when an already-backed-off entry fails again on pass 2', async () => {
    const repo = new InMemoryRepo();
    await insertProxy(repo, 'a', proxyAUrl, proxyA);
    // Pre-record two failures so 'a' is in active backoff with failCount=2.
    await repo.proxyBackoffs.recordDialFailure('a', 'u', proxyA.revision, 'old');
    await repo.proxyBackoffs.recordDialFailure('a', 'u', proxyA.revision, 'old');
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => { throw new ProxyDialError('still bad', 'tcp-connect'); },
      runDirectFetch: async () => new Response('ok'),
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });
    // Pass 1 skips 'a' (in backoff). Pass 2 retries it and fails — the
    // retry must increment failCount by exactly 1 so the geometric
    // schedule advances one step per real failure, not one step per pass.
    await expect(fetcher('https://api.openai.com', { method: 'GET' })).rejects.toBeInstanceOf(ProxyDialError);
    const [row] = await repo.proxyBackoffs.listForUpstream('u');
    expect(row!.failCount).toBe(3);
  });

  it('does not let an old generation mutate backoff after an A -> B -> A edit', async () => {
    const replacementUrl = 'socks5://replacement:1';
    const returnedToA: ProxyEntry = { ...proxyA, revision: 3 };

    const failureRepo = new InMemoryRepo();
    await insertProxy(failureRepo, 'a', proxyAUrl, proxyA);
    let rejectOldFailure!: (reason: unknown) => void;
    let markFailureStarted!: () => void;
    const failureStarted = new Promise<void>(resolve => { markFailureStarted = resolve; });
    const oldFailureFetcher = createFetcher({
      repo: failureRepo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => {
        markFailureStarted();
        return await new Promise<Response>((_resolve, reject) => { rejectOldFailure = reject; });
      },
      runDirectFetch: async () => new Response('direct'),
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });
    const oldFailureRequest = oldFailureFetcher('https://api.openai.com', { method: 'GET' });
    await failureStarted;
    await failureRepo.proxies.patch('a', { url: replacementUrl });
    await failureRepo.proxies.patch('a', { url: proxyAUrl });
    await failureRepo.proxyBackoffs.recordDialFailure('a', 'u', returnedToA.revision, 'current failure');
    rejectOldFailure(new ProxyDialError('late old failure', 'tcp-connect'));
    await expect(oldFailureRequest).rejects.toBeInstanceOf(ProxyDialError);
    expect(await failureRepo.proxyBackoffs.listForUpstream('u')).toMatchObject([
      { failCount: 1, lastError: 'current failure' },
    ]);

    const successRepo = new InMemoryRepo();
    await insertProxy(successRepo, 'a', proxyAUrl, proxyA);
    let resolveOldSuccess!: (response: Response) => void;
    let markSuccessStarted!: () => void;
    const successStarted = new Promise<void>(resolve => { markSuccessStarted = resolve; });
    const oldSuccessFetcher = createFetcher({
      repo: successRepo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => {
        markSuccessStarted();
        return await new Promise<Response>(resolve => { resolveOldSuccess = resolve; });
      },
      runDirectFetch: async () => new Response('direct'),
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });
    const oldSuccessRequest = oldSuccessFetcher('https://api.openai.com', { method: 'GET' });
    await successStarted;
    await successRepo.proxies.patch('a', { url: replacementUrl });
    await successRepo.proxies.patch('a', { url: proxyAUrl });
    await successRepo.proxyBackoffs.recordDialFailure('a', 'u', returnedToA.revision, 'current failure');
    resolveOldSuccess(new Response('old success'));
    expect(await (await oldSuccessRequest).text()).toBe('old success');
    expect(await successRepo.proxyBackoffs.listForUpstream('u')).toMatchObject([
      { failCount: 1, lastError: 'current failure' },
    ]);
  });

  it('falls through when a fallback-list entry references an unknown proxy id', async () => {
    const repo = new InMemoryRepo();
    let directCalls = 0;
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      // 'p_unknown' is in the list but not in proxyById — simulating a
      // mid-request DELETE between catalog load and dial. The chain must
      // advance to direct-fetch rather than killing the whole call.
      fallbackList: [{ id: 'p_unknown' }, { id: 'direct_fetch' }],
      runtimeLocation: 'TEST',
      proxyById: new Map(),
      runProxied: async () => new Response('proxy'),
      runDirectFetch: async () => { directCalls++; return new Response('direct'); },
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });
    const res = await fetcher('https://api.openai.com', { method: 'GET' });
    expect(await res.text()).toBe('direct');
    expect(directCalls).toBe(1);
  });

  it('tags the unknown-proxy-id failure as stage=config so it does not register against backoff', async () => {
    const repo = new InMemoryRepo();
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
      message: expect.stringContaining('unknown proxy id'),
    });
    // The unknown-id failure is a control-plane race, not a dial-stage
    // failure: backoff entries must stay untouched.
    const rows = await repo.proxyBackoffs.listForUpstream('u');
    expect(rows).toEqual([]);
  });

  it('does not retry an entry that already failed in the first pass', async () => {
    const repo = new InMemoryRepo();
    await insertProxy(repo, 'a', proxyAUrl, proxyA);
    await insertProxy(repo, 'b', proxyBUrl, proxyB);
    const calls: string[] = [];
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }, { id: 'b' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA], ['b', proxyB]]),
      runProxied: async (config: ProxyConfig) => {
        calls.push(config.host);
        throw new ProxyDialError('fail', 'tcp-connect');
      },
      runDirectFetch: async () => new Response('ok'),
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });
    await expect(fetcher('https://api.openai.com', { method: 'GET' })).rejects.toBeInstanceOf(AggregateError);
    expect(calls).toEqual(['a', 'b']);
    // Each entry recorded one failure, not two.
    const rows = await repo.proxyBackoffs.listForUpstream('u');
    expect(rows.map(r => [r.proxyId, r.failCount]).sort()).toEqual([['a', 1], ['b', 1]]);
  });

  it('non-ProxyDialError errors propagate immediately and do not update backoff', async () => {
    const repo = new InMemoryRepo();
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => { throw new Error('upstream 500'); },
      runDirectFetch: async () => new Response('ok'),
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });
    await expect(fetcher('https://api.openai.com', { method: 'GET' })).rejects.toThrow('upstream 500');
    expect(await repo.proxyBackoffs.listForUpstream('u')).toEqual([]);
  });

  it('empty fallback list defaults to ["direct_connect"]', async () => {
    const repo = new InMemoryRepo();
    let directConnectCalled = false;
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [],
      runtimeLocation: 'TEST',
      proxyById: new Map(),
      runProxied: async () => new Response('proxy'),
      runDirectFetch: async () => new Response('direct fetch'),
      runDirectConnect: async () => { directConnectCalled = true; return new Response('direct connect'); },
      socketDial: () => stubSocketDial,
    });
    const res = await fetcher('https://api.openai.com', { method: 'GET' });
    expect(directConnectCalled).toBe(true);
    expect(await res.text()).toBe('direct connect');
  });

  it('runs direct-connect as a built-in materialized transport', async () => {
    const repo = new InMemoryRepo();
    let observedTarget: ProxyRequestTarget | undefined;
    let observedRequest: HttpRequest | undefined;
    let observedSocketDial: SocketDial | undefined;
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'direct_connect' }],
      runtimeLocation: 'TEST',
      proxyById: new Map(),
      runProxied: async () => new Response('proxy'),
      runDirectFetch: async () => new Response('direct fetch'),
      runDirectConnect: async (target, request, options) => {
        observedTarget = target;
        observedRequest = request;
        observedSocketDial = options.socketDial;
        return new Response('direct connect');
      },
      socketDial: () => stubSocketDial,
    });

    const response = await fetcher('https://api.openai.com/v1/responses?stream=1', {
      method: 'POST',
      body: 'request body',
    });

    expect(await response.text()).toBe('direct connect');
    expect(observedTarget).toEqual({ host: 'api.openai.com', port: 443, tls: true });
    if (observedRequest === undefined) throw new Error('direct-connect request was not observed');
    expect(observedRequest?.method).toBe('POST');
    expect(observedRequest?.path).toBe('/v1/responses?stream=1');
    expect(new TextDecoder().decode(observedRequest.body)).toBe('request body');
    expect(observedSocketDial).toBe(stubSocketDial);
    expect(await repo.proxyBackoffs.listForUpstream('u')).toEqual([]);
  });

  it('falls through from a direct-connect dial failure without writing proxy backoff', async () => {
    const repo = new InMemoryRepo();
    const calls: string[] = [];
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'direct_connect' }, { id: 'direct_fetch' }],
      runtimeLocation: 'TEST',
      proxyById: new Map(),
      runProxied: async () => new Response('proxy'),
      runDirectConnect: async () => {
        calls.push('direct_connect');
        throw new ProxyDialError('socket unavailable', 'tcp-connect');
      },
      runDirectFetch: async () => {
        calls.push('direct_fetch');
        return new Response('ok');
      },
      socketDial: () => stubSocketDial,
    });

    const response = await fetcher('https://api.openai.com', { method: 'GET' });

    expect(await response.text()).toBe('ok');
    expect(calls).toEqual(['direct_connect', 'direct_fetch']);
    expect(await repo.proxyBackoffs.listForUpstream('u')).toEqual([]);
  });

  it('skips entries whose colos whitelist excludes the current colo', async () => {
    const repo = new InMemoryRepo();
    const calls: string[] = [];
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [
        { id: 'a', colos: ['NRT'] },          // wrong colo — skip
        { id: 'b', colos: ['HKG', 'NRT'] },   // matches — attempt
        { id: 'direct_fetch' },                     // no whitelist — attempt
      ],
      runtimeLocation: 'HKG',
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
    const res = await fetcher('https://api.openai.com', { method: 'GET' });
    expect(await res.text()).toBe('ok');
    // 'a' was filtered out by colo — 'b' is first reachable entry.
    expect(calls).toEqual(['b']);
  });

  it('does NOT retry colo-filtered entries in the second pass', async () => {
    const repo = new InMemoryRepo();
    // 'b' is in active backoff — first pass skips it. 'a' is colo-filtered.
    // We expect the call to fail with no dials made (both entries unavailable
    // for opposite reasons), and crucially 'a' must NOT be re-attempted in
    // pass 2 — pass 2 is only for backoff-skipped entries.
    await insertProxy(repo, 'b', proxyBUrl, proxyB);
    await repo.proxyBackoffs.recordDialFailure('b', 'u', proxyB.revision, 'x');
    const calls: string[] = [];
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [
        { id: 'a', colos: ['NRT'] },   // colo-filtered out for HKG
        { id: 'b' },                   // in backoff, retried in pass 2
      ],
      runtimeLocation: 'HKG',
      proxyById: new Map([['a', proxyA], ['b', proxyB]]),
      runProxied: async (config: ProxyConfig) => {
        calls.push(config.host);
        throw new ProxyDialError('boom', 'tcp-connect');
      },
      runDirectFetch: async () => new Response('direct'),
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });
    await expect(fetcher('https://api.openai.com', { method: 'GET' })).rejects.toBeInstanceOf(ProxyDialError);
    // Only 'b' is dialed — 'a' is filtered before the loop. 'a' would have
    // been the host 'a' on the calls list otherwise.
    expect(calls).toEqual(['b']);
  });

  it('collapses to implicit ["direct_connect"] when every entry is colo-filtered out', async () => {
    const repo = new InMemoryRepo();
    let directConnectCalled = false;
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [
        { id: 'a', colos: ['NRT'] },
        { id: 'b', colos: ['LAX'] },
      ],
      runtimeLocation: 'HKG',
      proxyById: new Map([['a', proxyA], ['b', proxyB]]),
      runProxied: async () => new Response('proxy'),
      runDirectFetch: async () => new Response('direct fetch'),
      runDirectConnect: async () => { directConnectCalled = true; return new Response('direct connect'); },
      socketDial: () => stubSocketDial,
    });
    const res = await fetcher('https://api.openai.com', { method: 'GET' });
    expect(directConnectCalled).toBe(true);
    expect(await res.text()).toBe('direct connect');
  });

  it('rethrows AbortError without continuing the chain', async () => {
    const repo = new InMemoryRepo();
    const calls: string[] = [];
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
        throw new DOMException('client gone', 'AbortError');
      },
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });
    await expect(fetcher('https://api.openai.com', { method: 'GET' }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toEqual(['direct']);
    // No proxy was attempted, so backoff stays empty.
    expect(await repo.proxyBackoffs.listForUpstream('u')).toEqual([]);
  });

  it('rethrows a generic execution-signal reason without continuing the chain', async () => {
    const repo = new InMemoryRepo();
    const calls: string[] = [];
    const reason = new Error('execution deadline');
    const controller = new AbortController();
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'direct_fetch' }, { id: 'a' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => { calls.push('proxy'); return new Response('proxy'); },
      runDirectFetch: async () => {
        calls.push('direct');
        controller.abort(reason);
        throw reason;
      },
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });

    await expect(fetcher('https://api.openai.com', { method: 'GET', signal: controller.signal }))
      .rejects.toBe(reason);
    expect(calls).toEqual(['direct']);
  });

  it('keeps a concurrent transport failure behind a generic execution-signal reason', async () => {
    const repo = new InMemoryRepo();
    const reason = new Error('execution deadline');
    const transportFailure = new TypeError('socket failed concurrently');
    const controller = new AbortController();
    let proxyCalls = 0;
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'direct_fetch' }, { id: 'a' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => { proxyCalls += 1; return new Response('proxy'); },
      runDirectFetch: async () => {
        controller.abort(reason);
        throw transportFailure;
      },
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });

    const rejection = await fetcher('https://api.openai.com', {
      method: 'GET', signal: controller.signal,
    }).catch((error: unknown) => error) as AggregateError;
    expect(rejection.errors).toEqual([reason, transportFailure]);
    expect(rejection.cause).toBe(reason);
    expect(proxyCalls).toBe(0);
  });

  it.each([
    ['hostile cause accessor', () => Object.defineProperty(new Error('hostile'), 'cause', {
      get: () => { throw new Error('cause getter must not run'); },
    })],
    ['cyclic cause', () => {
      const error = new Error('cycle');
      error.cause = error;
      return error;
    }],
    ['over-deep cause chain', (reason: Error) => {
      let error = reason;
      for (let index = 0; index < 80; index++) error = new Error(`layer ${index}`, { cause: error });
      return error;
    }],
  ])('safely aggregates cancellation with a %s', async (_label, makeFailure) => {
    const repo = new InMemoryRepo();
    const reason = new Error('execution deadline');
    const transportFailure = makeFailure(reason);
    const controller = new AbortController();
    let proxyCalls = 0;
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'direct_fetch' }, { id: 'a' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => { proxyCalls += 1; return new Response('proxy'); },
      runDirectFetch: async () => {
        controller.abort(reason);
        throw transportFailure;
      },
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });

    const rejection = await fetcher('https://api.openai.com', {
      method: 'GET', signal: controller.signal,
    }).catch((error: unknown) => error) as AggregateError;
    expect(rejection.errors).toEqual([reason, transportFailure]);
    expect(rejection.cause).toBe(reason);
    expect(proxyCalls).toBe(0);
  });

  it('replays materialized bytes to a direct fallback without mutating the caller init', async () => {
    const repo = new InMemoryRepo();
    let directBody: BodyInit | null | undefined;
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }, { id: 'direct_fetch' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async (_config, _target, request) => {
        if (!(request.body instanceof Uint8Array)) throw new Error('expected materialized byte body');
        expect(new TextDecoder().decode(request.body)).toBe('request body');
        throw new ProxyDialError('proxy unavailable', 'tcp-connect');
      },
      runDirectFetch: async (_url, init) => {
        directBody = init.body;
        return new Response('direct');
      },
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });
    const init: RequestInit = { method: 'POST', body: 'request body' };

    const response = await fetcher('https://api.openai.com/v1/responses', init);

    expect(await response.text()).toBe('direct');
    expect(directBody).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(directBody as Uint8Array)).toBe('request body');
    expect(init.body).toBe('request body');
  });

  it('removes stale framing when a proxy-materialized body falls through to native fetch', async () => {
    const repo = new InMemoryRepo();
    let nativeBody: BodyInit | null | undefined;
    let nativeHeaders: Headers | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      nativeBody = init?.body;
      nativeHeaders = new Headers(init?.headers);
      return new Response('direct');
    }));
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }, { id: 'direct_fetch' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => { throw new ProxyDialError('proxy unavailable', 'tcp-connect'); },
      runDirectFetch: directFetcher,
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-length': '999', 'transfer-encoding': 'chunked' },
      body: 'request body',
    };
    try {
      const response = await fetcher('https://api.openai.com/v1/responses', init);

      expect(await response.text()).toBe('direct');
      expect(nativeBody).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(nativeBody as Uint8Array)).toBe('request body');
      expect(nativeHeaders?.has('content-length')).toBe(false);
      expect(nativeHeaders?.has('transfer-encoding')).toBe(false);
      expect(new Headers(init.headers).get('content-length')).toBe('999');
      expect(new Headers(init.headers).get('transfer-encoding')).toBe('chunked');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(['GET', 'OPTIONS'])('falls through after an ambiguous bodyless %s direct-fetch failure', async (method) => {
    const repo = new InMemoryRepo();
    const calls: string[] = [];
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'direct_fetch' }, { id: 'a' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async (_config, _target, request) => {
        calls.push('proxy');
        expect(request.body).toBeUndefined();
        return new Response('proxy');
      },
      runDirectFetch: async () => {
        calls.push('direct');
        throw new TypeError('direct dial failed');
      },
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });

    const response = await fetcher('https://api.openai.com/v1/models', { method });

    expect(await response.text()).toBe('proxy');
    expect(calls).toEqual(['direct', 'proxy']);
  });

  it.each(['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])('keeps an ambiguous bodyless %s direct-fetch failure terminal', async (method) => {
    const repo = new InMemoryRepo();
    const directFailure = new TypeError('direct fetch may have reached upstream');
    let proxyCalls = 0;
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'direct_fetch' }, { id: 'a' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => { proxyCalls += 1; return new Response('proxy'); },
      runDirectFetch: async () => { throw directFailure; },
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });

    await expect(fetcher('https://api.openai.com/v1/mutation', { method })).rejects.toBe(directFailure);
    expect(proxyCalls).toBe(0);
  });

  it('does not replay a mutating request after a lazy proxy error may follow HTTP dispatch', async () => {
    const repo = new InMemoryRepo();
    await insertProxy(repo, 'a', proxyAUrl, proxyA);
    const ambiguous = new ProxyDialError('lazy proxy authentication failed', 'proxy-handshake')
      .markRequestMayHaveBeenSent();
    let directCalls = 0;
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }, { id: 'direct_fetch' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => { throw ambiguous; },
      runDirectFetch: async () => { directCalls += 1; return new Response('direct'); },
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });

    await expect(fetcher('https://api.openai.com/v1/responses', {
      method: 'POST', body: 'request body',
    })).rejects.toBe(ambiguous);
    expect(directCalls).toBe(0);
    expect((await repo.proxyBackoffs.listForUpstream('u'))[0]?.lastError)
      .toBe('[proxy-handshake] lazy proxy authentication failed');
  });

  it('can fail over a bodyless GET after a lazy proxy error', async () => {
    const repo = new InMemoryRepo();
    await insertProxy(repo, 'a', proxyAUrl, proxyA);
    const ambiguous = new ProxyDialError('lazy proxy authentication failed', 'proxy-handshake')
      .markRequestMayHaveBeenSent();
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }, { id: 'direct_fetch' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => { throw ambiguous; },
      runDirectFetch: async () => new Response('direct'),
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });

    const response = await fetcher('https://api.openai.com/v1/models', { method: 'GET' });
    expect(await response.text()).toBe('direct');
  });

  it('forwards init.signal to runProxied so the dialer can honour client cancellation', async () => {
    const repo = new InMemoryRepo();
    let observedSignal: AbortSignal | undefined;
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async (_c, _t, _r, options) => {
        observedSignal = options.signal;
        return new Response('ok');
      },
      runDirectFetch: async () => new Response('direct'),
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });
    const ac = new AbortController();
    await fetcher('https://api.openai.com', { method: 'GET', signal: ac.signal });
    expect(observedSignal).toBe(ac.signal);
  });

  it('captures the runtime-synthesized multipart Content-Type when posting FormData', async () => {
    const repo = new InMemoryRepo();
    const captured: HttpRequest[] = [];
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async (_config, _target, request) => { captured.push(request); return new Response('ok'); },
      runDirectFetch: async () => new Response('direct'),
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });
    const fd = new FormData();
    fd.append('field', 'value');
    await fetcher('https://api.openai.com/v1/upload', { method: 'POST', body: fd });
    expect(captured).toHaveLength(1);
    const contentType = captured[0]!.headers['content-type'];
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
  });

  it('lets the caller override the FormData-synthesized Content-Type', async () => {
    const repo = new InMemoryRepo();
    const captured: HttpRequest[] = [];
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async (_config, _target, request) => { captured.push(request); return new Response('ok'); },
      runDirectFetch: async () => new Response('direct'),
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });
    const fd = new FormData();
    fd.append('field', 'value');
    await fetcher('https://api.openai.com/v1/upload', {
      method: 'POST',
      body: fd,
      headers: { 'Content-Type': 'application/x-explicit-override' },
    });
    expect(captured[0]!.headers['content-type']).toBe('application/x-explicit-override');
  });

  it('rejects ReadableStream bodies upfront', async () => {
    const repo = new InMemoryRepo();
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
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hi'));
        controller.close();
      },
    });
    await expect(fetcher('https://api.openai.com/v1/x', { method: 'POST', body: stream }))
      .rejects.toThrow(/streaming request bodies/);
  });

  it('passes replayable segment identities through direct-connect without concatenation', async () => {
    const repo = new InMemoryRepo();
    const first = Uint8Array.of(1, 2);
    const second = Uint8Array.of(3, 4);
    let capturedBody!: HttpRequest['body'];
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [],
      runtimeLocation: 'TEST',
      proxyById: new Map(),
      runProxied: async () => new Response('proxy'),
      runDirectFetch: async () => new Response('direct'),
      runDirectConnect: async (_target, request) => {
        capturedBody = request.body;
        return new Response('direct connect');
      },
      socketDial: () => stubSocketDial,
    });

    const response = await fetcher('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      body: createReplayableBody([first, second]),
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
    });

    expect(await response.text()).toBe('direct connect');
    if (!Array.isArray(capturedBody)) throw new Error('expected segmented request body');
    expect(capturedBody[0]).toBe(first);
    expect(capturedBody[1]).toBe(second);
  });

  it('does not replay a consumed POST after an ambiguous direct-fetch failure', async () => {
    const repo = new InMemoryRepo();
    await insertProxy(repo, 'a', proxyAUrl, proxyA);
    const payload = Uint8Array.of(1, 2, 3, 4);
    const directFailure = new TypeError('socket closed after request write');
    let directBody: number[] | undefined;
    let proxyCalls = 0;
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'direct_fetch' }, { id: 'a' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => {
        proxyCalls += 1;
        return new Response('proxy');
      },
      runDirectFetch: async (_url, init) => {
        expect(new Headers(init.headers).get('content-length')).toBe('4');
        expect(replayableBodySource(init.body)).not.toBeNull();
        if (!(init.body instanceof ReadableStream)) throw new Error('expected replayable stream');
        directBody = Array.from(new Uint8Array(await new Response(init.body).arrayBuffer()));
        throw directFailure;
      },
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });

    await expect(fetcher('https://api.openai.com/v1/images/edits', {
      method: 'POST', body: createReplayableBody([payload]),
    })).rejects.toBe(directFailure);

    expect(directBody).toEqual([1, 2, 3, 4]);
    expect(proxyCalls).toBe(0);
  });

  it('replays segmented views from a failed proxy into a fresh direct-fetch stream', async () => {
    const repo = new InMemoryRepo();
    await insertProxy(repo, 'a', proxyAUrl, proxyA);
    const payload = Uint8Array.of(5, 6, 7);
    let proxyBody!: HttpRequest['body'];
    let directBody: number[] | undefined;
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }, { id: 'direct_fetch' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async (_config, _target, request) => {
        proxyBody = request.body;
        throw new ProxyDialError('proxy failed before HTTP dispatch', 'tcp-connect');
      },
      runDirectFetch: async (_url, init) => {
        if (!(init.body instanceof ReadableStream)) throw new Error('expected replayable stream');
        directBody = Array.from(new Uint8Array(await new Response(init.body).arrayBuffer()));
        return new Response('direct');
      },
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });

    const response = await fetcher('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      body: createReplayableBody([payload]),
    });

    expect(await response.text()).toBe('direct');
    if (!Array.isArray(proxyBody)) throw new Error('expected segmented request body');
    expect(proxyBody[0]).toBe(payload);
    expect(directBody).toEqual([5, 6, 7]);
  });

  it('persists the failed dial stage in the backoff lastError tag', async () => {
    const repo = new InMemoryRepo();
    await insertProxy(repo, 'a', proxyAUrl, proxyA);
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => { throw new ProxyDialError('cert mismatch', 'inner-tls'); },
      runDirectFetch: async () => new Response('ok'),
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });
    await expect(fetcher('https://api.openai.com', { method: 'GET' })).rejects.toBeInstanceOf(ProxyDialError);
    const [row] = await repo.proxyBackoffs.listForUpstream('u');
    expect(row!.lastError).toBe('[inner-tls] cert mismatch');
  });

  it('does not discard a healthy Response when the success-path backoff clear rejects', async () => {
    // Pre-record a failure so recordDialSuccess has a row to DELETE; then
    // wedge the backoff repo so the clear write rejects mid-call. The
    // Response we already hold MUST reach the caller — bookkeeping
    // failures cannot shadow request outcomes (mirrors the failure
    // path's existing log-and-swallow policy).
    const repo = new InMemoryRepo();
    await insertProxy(repo, 'a', proxyAUrl, proxyA);
    await repo.proxyBackoffs.recordDialFailure('a', 'u', proxyA.revision, 'old');
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
    expect(warnSpy).toHaveBeenCalledOnce();
    repo.proxyBackoffs.recordDialSuccess = original;
    warnSpy.mockRestore();
  });

  it('strips the IPv6 envelope from URL.hostname before handing the target to the dialer', async () => {
    const repo = new InMemoryRepo();
    let captured: ProxyRequestTarget | undefined;
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async (_c, target) => {
        captured = target;
        return new Response('ok');
      },
      runDirectFetch: async () => new Response('direct'),
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });
    await fetcher('https://[::1]:8443/v1/models', { method: 'GET' });
    // `URL#hostname` keeps the brackets ([::1]); the DialTarget contract
    // requires the bare address. The fetcher must strip them at the seam.
    expect(captured?.host).toBe('::1');
    expect(captured?.port).toBe(8443);
  });

  it('uses the successful fallback even when an earlier entry rejects late', async () => {
    vi.useRealTimers();
    const repo = new InMemoryRepo();
    const broken: ProxyEntry = { revision: 1, config: { kind: 'socks5', host: 'broken', port: 1, name: 'broken' }, dialTimeoutMs: null };
    const good: ProxyEntry = { revision: 1, config: { kind: 'socks5', host: 'good', port: 1, name: 'good' }, dialTimeoutMs: null };
    await insertProxy(repo, 'broken', 'socks5://broken:1', broken);
    await insertProxy(repo, 'good', 'socks5://good:1', good);
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'broken' }, { id: 'good' }],
      runtimeLocation: 'TEST',
      proxyById: new Map([
        ['broken', broken],
        ['good', good],
      ]),
      runProxied: async (config: ProxyConfig) => {
        if (config.host === 'broken') {
          await new Promise(resolve => setTimeout(resolve, 200));
          throw new ProxyDialError('refused', 'tcp-connect');
        }
        await new Promise(resolve => setTimeout(resolve, 20));
        return new Response('ok');
      },
      runDirectFetch: async () => new Response('direct'),
      runDirectConnect: async () => new Response('direct connect'),
      socketDial: () => stubSocketDial,
    });
    const res = await fetcher('https://api.openai.com', { method: 'GET' });
    expect(await res.text()).toBe('ok');
  });
});
