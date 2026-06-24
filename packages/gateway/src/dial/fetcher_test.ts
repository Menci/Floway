import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFetcher, type ProxyEntry } from './fetcher.ts';
import { InMemoryRepo } from '../repo/memory.ts';
import type { HttpRequest } from '@floway-dev/http';
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

  const proxyA: ProxyEntry = { config: { kind: 'socks5', host: 'a', port: 1, name: 'a' }, dialTimeoutMs: null };
  const proxyB: ProxyEntry = { config: { kind: 'socks5', host: 'b', port: 1, name: 'b' }, dialTimeoutMs: null };

  it('first-pass tries each non-backoff entry in order and short-circuits on success', async () => {
    const repo = new InMemoryRepo();
    await repo.proxyBackoffs.recordDialFailure('a', 'u', 'x');
    const calls: string[] = [];
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }, { id: 'b' }, { id: 'direct' }],
      currentColo: 'TEST',
      proxyById: new Map([['a', proxyA], ['b', proxyB]]),
      runProxied: async (config: ProxyConfig) => {
        calls.push(config.host);
        return new Response('ok');
      },
      runDirect: async () => {
        calls.push('direct');
        return new Response('direct');
      },
      socketDial: () => stubSocketDial,
    });
    const res = await fetcher('https://api.openai.com/v1/models', { method: 'GET' });
    expect(await res.text()).toBe('ok');
    expect(calls).toEqual(['b']);
  });

  it('records exactly one dial failure per call when the same entry is the only fallback', async () => {
    const repo = new InMemoryRepo();
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }],
      currentColo: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => { throw new ProxyDialError('boom', 'tcp-connect'); },
      runDirect: async () => new Response('ok'),
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
    await repo.proxyBackoffs.recordDialFailure('a', 'u', 'x');
    await repo.proxyBackoffs.recordDialFailure('a', 'u', 'x');
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }],
      currentColo: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => new Response('ok'),
      runDirect: async () => new Response('ok'),
      socketDial: () => stubSocketDial,
    });
    // first-pass skips a (in backoff). second-pass ignores backoff and succeeds.
    await fetcher('https://api.openai.com', { method: 'GET' });
    expect(await repo.proxyBackoffs.listForUpstream('u')).toEqual([]);
  });

  it('falls through to second pass when first pass exhausts', async () => {
    const repo = new InMemoryRepo();
    await repo.proxyBackoffs.recordDialFailure('a', 'u', 'x');
    await repo.proxyBackoffs.recordDialFailure('b', 'u', 'x');
    const order: string[] = [];
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }, { id: 'b' }],
      currentColo: 'TEST',
      proxyById: new Map([['a', proxyA], ['b', proxyB]]),
      runProxied: async (config: ProxyConfig) => {
        order.push(config.host);
        if (order.length < 2) throw new ProxyDialError('still bad', 'tcp-connect');
        return new Response('ok');
      },
      runDirect: async () => new Response('ok'),
      socketDial: () => stubSocketDial,
    });
    await fetcher('https://api.openai.com', { method: 'GET' });
    expect(order).toEqual(['a', 'b']);
  });

  it('only adds one failure when an already-backed-off entry fails again on pass 2', async () => {
    const repo = new InMemoryRepo();
    // Pre-record two failures so 'a' is in active backoff with failCount=2.
    await repo.proxyBackoffs.recordDialFailure('a', 'u', 'old');
    await repo.proxyBackoffs.recordDialFailure('a', 'u', 'old');
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }],
      currentColo: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => { throw new ProxyDialError('still bad', 'tcp-connect'); },
      runDirect: async () => new Response('ok'),
      socketDial: () => stubSocketDial,
    });
    // Pass 1 skips 'a' (in backoff). Pass 2 retries it and fails — the
    // retry must increment failCount by exactly 1 so the geometric
    // schedule advances one step per real failure, not one step per pass.
    await expect(fetcher('https://api.openai.com', { method: 'GET' })).rejects.toBeInstanceOf(ProxyDialError);
    const [row] = await repo.proxyBackoffs.listForUpstream('u');
    expect(row!.failCount).toBe(3);
  });

  it('falls through when a fallback-list entry references an unknown proxy id', async () => {
    const repo = new InMemoryRepo();
    let directCalls = 0;
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      // 'p_unknown' is in the list but not in proxyById — simulating a
      // mid-request DELETE between catalog load and dial. The chain must
      // advance to 'direct' rather than killing the whole call.
      fallbackList: [{ id: 'p_unknown' }, { id: 'direct' }],
      currentColo: 'TEST',
      proxyById: new Map(),
      runProxied: async () => new Response('proxy'),
      runDirect: async () => { directCalls++; return new Response('direct'); },
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
      // No 'direct' fallback — the only entry is the unknown id, so the
      // call fails and the typed ProxyDialError surfaces directly (single-
      // entry chains skip the AggregateError wrapper).
      fallbackList: [{ id: 'p_unknown' }],
      currentColo: 'TEST',
      proxyById: new Map(),
      runProxied: async () => new Response('proxy'),
      runDirect: async () => { throw new Error('unreachable'); },
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
    const calls: string[] = [];
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }, { id: 'b' }],
      currentColo: 'TEST',
      proxyById: new Map([['a', proxyA], ['b', proxyB]]),
      runProxied: async (config: ProxyConfig) => {
        calls.push(config.host);
        throw new ProxyDialError('fail', 'tcp-connect');
      },
      runDirect: async () => new Response('ok'),
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
      currentColo: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => { throw new Error('upstream 500'); },
      runDirect: async () => new Response('ok'),
      socketDial: () => stubSocketDial,
    });
    await expect(fetcher('https://api.openai.com', { method: 'GET' })).rejects.toThrow('upstream 500');
    expect(await repo.proxyBackoffs.listForUpstream('u')).toEqual([]);
  });

  it('empty fallback list defaults to ["direct"]', async () => {
    const repo = new InMemoryRepo();
    let directCalled = false;
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [],
      currentColo: 'TEST',
      proxyById: new Map(),
      runProxied: async () => new Response('proxy'),
      runDirect: async () => { directCalled = true; return new Response('direct'); },
      socketDial: () => stubSocketDial,
    });
    const res = await fetcher('https://api.openai.com', { method: 'GET' });
    expect(directCalled).toBe(true);
    expect(await res.text()).toBe('direct');
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
        { id: 'direct' },                     // no whitelist — attempt
      ],
      currentColo: 'HKG',
      proxyById: new Map([['a', proxyA], ['b', proxyB]]),
      runProxied: async (config: ProxyConfig) => {
        calls.push(config.host);
        return new Response('ok');
      },
      runDirect: async () => {
        calls.push('direct');
        return new Response('direct');
      },
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
    await repo.proxyBackoffs.recordDialFailure('b', 'u', 'x');
    const calls: string[] = [];
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [
        { id: 'a', colos: ['NRT'] },   // colo-filtered out for HKG
        { id: 'b' },                   // in backoff, retried in pass 2
      ],
      currentColo: 'HKG',
      proxyById: new Map([['a', proxyA], ['b', proxyB]]),
      runProxied: async (config: ProxyConfig) => {
        calls.push(config.host);
        throw new ProxyDialError('boom', 'tcp-connect');
      },
      runDirect: async () => new Response('direct'),
      socketDial: () => stubSocketDial,
    });
    await expect(fetcher('https://api.openai.com', { method: 'GET' })).rejects.toBeInstanceOf(ProxyDialError);
    // Only 'b' is dialed — 'a' is filtered before the loop. 'a' would have
    // been the host 'a' on the calls list otherwise.
    expect(calls).toEqual(['b']);
  });

  it('collapses to implicit ["direct"] when every entry is colo-filtered out', async () => {
    const repo = new InMemoryRepo();
    let directCalled = false;
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [
        { id: 'a', colos: ['NRT'] },
        { id: 'b', colos: ['LAX'] },
      ],
      currentColo: 'HKG',
      proxyById: new Map([['a', proxyA], ['b', proxyB]]),
      runProxied: async () => new Response('proxy'),
      runDirect: async () => { directCalled = true; return new Response('direct'); },
      socketDial: () => stubSocketDial,
    });
    const res = await fetcher('https://api.openai.com', { method: 'GET' });
    expect(directCalled).toBe(true);
    expect(await res.text()).toBe('direct');
  });

  it('rethrows AbortError without continuing the chain', async () => {
    const repo = new InMemoryRepo();
    const calls: string[] = [];
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'direct' }, { id: 'a' }],
      currentColo: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async (config: ProxyConfig) => {
        calls.push(`proxy:${config.host}`);
        return new Response('proxy-should-not-be-called');
      },
      runDirect: async () => {
        calls.push('direct');
        throw new DOMException('client gone', 'AbortError');
      },
      socketDial: () => stubSocketDial,
    });
    await expect(fetcher('https://api.openai.com', { method: 'GET' }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toEqual(['direct']);
    // No proxy was attempted, so backoff stays empty.
    expect(await repo.proxyBackoffs.listForUpstream('u')).toEqual([]);
  });

  it('forwards init.signal to runProxied so the dialer can honour client cancellation', async () => {
    const repo = new InMemoryRepo();
    let observedSignal: AbortSignal | undefined;
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }],
      currentColo: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async (_c, _t, _r, options) => {
        observedSignal = options.signal;
        return new Response('ok');
      },
      runDirect: async () => new Response('direct'),
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
      currentColo: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async (_config, _target, request) => { captured.push(request); return new Response('ok'); },
      runDirect: async () => new Response('direct'),
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
      currentColo: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async (_config, _target, request) => { captured.push(request); return new Response('ok'); },
      runDirect: async () => new Response('direct'),
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
      currentColo: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => new Response('ok'),
      runDirect: async () => new Response('direct'),
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

  it('persists the failed dial stage in the backoff lastError tag', async () => {
    const repo = new InMemoryRepo();
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }],
      currentColo: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => { throw new ProxyDialError('cert mismatch', 'inner-tls'); },
      runDirect: async () => new Response('ok'),
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
    await repo.proxyBackoffs.recordDialFailure('a', 'u', 'old');
    const original = repo.proxyBackoffs.recordDialSuccess.bind(repo.proxyBackoffs);
    repo.proxyBackoffs.recordDialSuccess = async () => { throw new Error('transient store outage'); };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'a' }],
      currentColo: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async () => new Response('ok'),
      runDirect: async () => new Response('direct'),
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
      currentColo: 'TEST',
      proxyById: new Map([['a', proxyA]]),
      runProxied: async (_c, target) => {
        captured = target;
        return new Response('ok');
      },
      runDirect: async () => new Response('direct'),
      socketDial: () => stubSocketDial,
    });
    await fetcher('https://[::1]:8443/v1/models', { method: 'GET' });
    // `URL#hostname` keeps the brackets ([::1]); the DialTarget contract
    // requires the bare address. The fetcher must strip them at the seam.
    expect(captured?.host).toBe('::1');
    expect(captured?.port).toBe(8443);
  });

  it('records latency only for the successful dial when an earlier fallback rejects late', async () => {
    // Real-world reproducer for the bug this fix addresses: a broken proxy
    // that hangs for hundreds of ms before rejecting must not pollute the
    // upstream-latency metric with the time spent walking the chain. The
    // recorder's "last wrap wins" semantics let only the successful entry's
    // measurement survive.
    vi.useRealTimers();
    const repo = new InMemoryRepo();
    const fetcher = createFetcher({
      repo,
      upstreamId: 'u',
      fallbackList: [{ id: 'broken' }, { id: 'good' }],
      currentColo: 'TEST',
      proxyById: new Map([
        ['broken', { config: { kind: 'socks5', host: 'broken', port: 1, name: 'broken' }, dialTimeoutMs: null }],
        ['good', { config: { kind: 'socks5', host: 'good', port: 1, name: 'good' }, dialTimeoutMs: null }],
      ]),
      runProxied: async (config: ProxyConfig) => {
        if (config.host === 'broken') {
          await new Promise(resolve => setTimeout(resolve, 200));
          throw new ProxyDialError('refused', 'tcp-connect');
        }
        await new Promise(resolve => setTimeout(resolve, 20));
        return new Response('ok');
      },
      runDirect: async () => new Response('direct'),
      socketDial: () => stubSocketDial,
    });
    let last: number | undefined;
    const record = <T>(promise: Promise<T>): Promise<T> => {
      const startedAt = performance.now();
      return promise.finally(() => { last = performance.now() - startedAt; });
    };
    const res = await fetcher('https://api.openai.com', { method: 'GET' }, record);
    expect(await res.text()).toBe('ok');
    // The successful dial took ~20ms; if the metric had timed the whole
    // chain it would read ~220ms. Allow generous slack for CI timer jitter
    // while still excluding the broken-leg's 200ms.
    expect(last).toBeDefined();
    expect(last!).toBeLessThan(150);
  });
});
