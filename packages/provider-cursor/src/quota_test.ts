import { describe, expect, test } from 'vitest';

import {
  CURSOR_DASHBOARD_USAGE_URL,
  CursorDashboardSessionExpiredError,
  CursorDashboardUpstreamError,
  fetchCursorDashboardUsage,
} from './quota.ts';
import type { Fetcher } from '@floway-dev/provider';

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const captureFetcher = (respond: (url: string, init: RequestInit) => Response | Promise<Response>) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, init });
    return await respond(url, init);
  };
  return { fetcher, calls };
};

describe('fetchCursorDashboardUsage', () => {
  const validPlanUsage = {
    limit: 2000, // $20.00
    totalSpend: 512,
    autoPercentUsed: 12.5,
    apiPercentUsed: 87.5,
    totalPercentUsed: 25.6,
  };
  const validBody = { planUsage: validPlanUsage, billingCycleEnd: '1738000000000' };

  test('sends WorkOS cookie + browser-shaped headers to the dashboard URL', async () => {
    const { fetcher, calls } = captureFetcher(() => jsonResponse(200, validBody));
    await fetchCursorDashboardUsage({ userId: 'user_abc', accessToken: 'jwt.xyz', fetcher });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(CURSOR_DASHBOARD_USAGE_URL);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.redirect).toBe('manual');
    expect(calls[0]!.init.body).toBe('{}');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Cookie).toBe('WorkosCursorSessionToken=user_abc::jwt.xyz');
    expect(headers.Origin).toBe('https://cursor.com');
    expect(headers.Referer).toBe('https://cursor.com/dashboard/spending');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['User-Agent']).toMatch(/^Mozilla\/5\.0 .*Chrome\//);
  });

  test('parses the happy-path body into typed cents / percent fields', async () => {
    const { fetcher } = captureFetcher(() => jsonResponse(200, validBody));
    const usage = await fetchCursorDashboardUsage({ userId: 'u', accessToken: 't', fetcher });
    expect(usage).toEqual({
      limitCents: 2000,
      totalSpendCents: 512,
      autoPercentUsed: 12.5,
      apiPercentUsed: 87.5,
      totalPercentUsed: 25.6,
      billingCycleEndMs: 1738000000000,
    });
  });

  test('accepts numeric billingCycleEnd', async () => {
    const { fetcher } = captureFetcher(() =>
      jsonResponse(200, { planUsage: validPlanUsage, billingCycleEnd: 1738000000000 }));
    const usage = await fetchCursorDashboardUsage({ userId: 'u', accessToken: 't', fetcher });
    expect(usage.billingCycleEndMs).toBe(1738000000000);
  });

  test('clamps percentages into [0, 100]', async () => {
    const { fetcher } = captureFetcher(() =>
      jsonResponse(200, {
        planUsage: { limit: 100, totalSpend: 200, autoPercentUsed: -5, apiPercentUsed: 150, totalPercentUsed: 200 },
        billingCycleEnd: '0',
      }));
    const usage = await fetchCursorDashboardUsage({ userId: 'u', accessToken: 't', fetcher });
    expect(usage.autoPercentUsed).toBe(0);
    expect(usage.apiPercentUsed).toBe(100);
    expect(usage.totalPercentUsed).toBe(100);
  });

  test('coerces string cents into numbers and floors negatives at 0', async () => {
    const { fetcher } = captureFetcher(() =>
      jsonResponse(200, {
        planUsage: { limit: '2500', totalSpend: '-10', autoPercentUsed: '3.2', apiPercentUsed: 0, totalPercentUsed: 0 },
        billingCycleEnd: '1',
      }));
    const usage = await fetchCursorDashboardUsage({ userId: 'u', accessToken: 't', fetcher });
    expect(usage.limitCents).toBe(2500);
    expect(usage.totalSpendCents).toBe(0);
    expect(usage.autoPercentUsed).toBe(3.2);
  });

  test('empty planUsage surfaces null limit + zero spend but keeps cycle end', async () => {
    const { fetcher } = captureFetcher(() =>
      jsonResponse(200, { planUsage: {}, billingCycleEnd: '1738000000000' }));
    const usage = await fetchCursorDashboardUsage({ userId: 'u', accessToken: 't', fetcher });
    expect(usage.limitCents).toBeNull();
    expect(usage.totalSpendCents).toBe(0);
    expect(usage.totalPercentUsed).toBe(0);
    expect(usage.billingCycleEndMs).toBe(1738000000000);
  });

  test('null billingCycleEnd is tolerated', async () => {
    const { fetcher } = captureFetcher(() =>
      jsonResponse(200, { planUsage: validPlanUsage, billingCycleEnd: null }));
    const usage = await fetchCursorDashboardUsage({ userId: 'u', accessToken: 't', fetcher });
    expect(usage.billingCycleEndMs).toBeNull();
  });

  test.each([301, 302, 303, 307])('%d redirect maps to CursorDashboardSessionExpiredError', async status => {
    const { fetcher } = captureFetcher(() => new Response('', { status, headers: { location: 'https://authkit.cursor.com/sign-in' } }));
    await expect(fetchCursorDashboardUsage({ userId: 'u', accessToken: 't', fetcher }))
      .rejects.toBeInstanceOf(CursorDashboardSessionExpiredError);
  });

  test.each([401, 403])('%d maps to CursorDashboardSessionExpiredError', async status => {
    const { fetcher } = captureFetcher(() => new Response('nope', { status }));
    await expect(fetchCursorDashboardUsage({ userId: 'u', accessToken: 't', fetcher }))
      .rejects.toBeInstanceOf(CursorDashboardSessionExpiredError);
  });

  test('other non-2xx maps to CursorDashboardUpstreamError with status', async () => {
    const { fetcher } = captureFetcher(() => new Response('oops', { status: 500 }));
    await expect(fetchCursorDashboardUsage({ userId: 'u', accessToken: 't', fetcher }))
      .rejects.toMatchObject({ name: 'CursorDashboardUpstreamError', status: 500 });
  });

  test('transport failure maps to CursorDashboardUpstreamError with status 0', async () => {
    const fetcher: Fetcher = async () => { throw new Error('econnreset'); };
    await expect(fetchCursorDashboardUsage({ userId: 'u', accessToken: 't', fetcher }))
      .rejects.toMatchObject({ name: 'CursorDashboardUpstreamError', status: 0 });
  });

  test('non-JSON body maps to CursorDashboardUpstreamError', async () => {
    const { fetcher } = captureFetcher(() =>
      new Response('<!doctype html>...', { status: 200, headers: { 'content-type': 'text/html' } }));
    await expect(fetchCursorDashboardUsage({ userId: 'u', accessToken: 't', fetcher }))
      .rejects.toBeInstanceOf(CursorDashboardUpstreamError);
  });

  test('non-object JSON body maps to CursorDashboardUpstreamError', async () => {
    const { fetcher } = captureFetcher(() => jsonResponse(200, [1, 2, 3]));
    await expect(fetchCursorDashboardUsage({ userId: 'u', accessToken: 't', fetcher }))
      .rejects.toBeInstanceOf(CursorDashboardUpstreamError);
  });
});
