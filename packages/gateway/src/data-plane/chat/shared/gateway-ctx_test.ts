import { Hono } from 'hono';
import { describe, test } from 'vitest';

import { createGatewayCtxFromHono, type AttemptState, stampUpstreamCallStart } from './gateway-ctx.ts';
import type { RequestBody } from './request-body.ts';
import type { AuthVars } from '../../../middleware/auth.ts';
import type { ApiKey, User } from '../../../repo/types.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { assert, assertEquals, assertExists } from '@floway-dev/test-utils';

const EMPTY_REQUEST_BODY: RequestBody = { bytes: new Uint8Array(), streamError: null };
const NOOP_SCHEDULER: BackgroundScheduler = () => {};

const buildApiKey = (overrides: Partial<ApiKey> = {}): ApiKey => ({
  id: 'test-key',
  userId: 1,
  name: 'test',
  key: 'sk-test',
  serverSecret: '00'.repeat(32),
  createdAt: '2026-01-01T00:00:00.000Z',
  upstreamIds: null,
  deletedAt: null,
  dumpRetentionSeconds: null,
  ...overrides,
});

const buildUser = (overrides: Partial<User> = {}): User => ({
  id: 1,
  username: 'tester',
  passwordHash: null,
  isAdmin: false,
  upstreamIds: null,
  canViewGlobalTelemetry: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
  ...overrides,
});

// Mirrors the production guarantee: by the time a data-plane handler runs,
// auth middleware has stamped apiKey + user on the context. Tests that want to
// model an unrestricted key on an uncapped user can rely on the defaults;
// tests that want to model a capped key or user override at the handler.
const makeApp = (): Hono<{ Variables: AuthVars }> => {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use('*', async (c, next) => {
    c.set('apiKey', buildApiKey());
    c.set('user', buildUser());
    await next();
  });
  return app;
};

describe('createGatewayCtxFromHono', () => {
  test('copies auth fields when both are set', async () => {
    const app = makeApp();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    app.get('/test', c => {
      c.set('apiKey', buildApiKey({ id: 'key-1', upstreamIds: ['up-1', 'up-2'] }));
      ctx = createGatewayCtxFromHono(c, { wantsStream: true, requestBody: EMPTY_REQUEST_BODY, backgroundScheduler: NOOP_SCHEDULER });
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertEquals(ctx.apiKeyId, 'key-1');
    assertEquals(ctx.upstreamIds, ['up-1', 'up-2']);
  });

  test('passes upstreamIds through as null on an unrestricted key + uncapped user', async () => {
    const app = makeApp();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    app.get('/test', c => {
      ctx = createGatewayCtxFromHono(c, { wantsStream: false, requestBody: EMPTY_REQUEST_BODY, backgroundScheduler: NOOP_SCHEDULER });
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertEquals(ctx.apiKeyId, 'test-key');
    assertEquals(ctx.upstreamIds, null);
  });

  test('respects wantsStream=true', async () => {
    const app = makeApp();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    app.get('/test', c => {
      ctx = createGatewayCtxFromHono(c, { wantsStream: true, requestBody: EMPTY_REQUEST_BODY, backgroundScheduler: NOOP_SCHEDULER });
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertEquals(ctx.wantsStream, true);
  });

  test('respects wantsStream=false', async () => {
    const app = makeApp();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    app.get('/test', c => {
      ctx = createGatewayCtxFromHono(c, { wantsStream: false, requestBody: EMPTY_REQUEST_BODY, backgroundScheduler: NOOP_SCHEDULER });
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertEquals(ctx.wantsStream, false);
  });

  test('wantsStream=true: downstreamAbortController is defined and abortSignal matches its signal', async () => {
    const app = makeApp();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    app.get('/test', c => {
      ctx = createGatewayCtxFromHono(c, { wantsStream: true, requestBody: EMPTY_REQUEST_BODY, backgroundScheduler: NOOP_SCHEDULER });
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertExists(ctx.downstreamAbortController);
    assertEquals(ctx.abortSignal, ctx.downstreamAbortController.signal);
  });

  test('wantsStream=false: downstreamAbortController and abortSignal are both undefined', async () => {
    const app = makeApp();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    app.get('/test', c => {
      ctx = createGatewayCtxFromHono(c, { wantsStream: false, requestBody: EMPTY_REQUEST_BODY, backgroundScheduler: NOOP_SCHEDULER });
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertEquals(ctx.downstreamAbortController, undefined);
    assertEquals(ctx.abortSignal, undefined);
  });

  test('caller-supplied downstreamAbortController overrides the factory-minted one (websocket path)', async () => {
    const app = makeApp();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    let controller: AbortController | undefined;
    app.get('/test', c => {
      controller = new AbortController();
      ctx = createGatewayCtxFromHono(c, { wantsStream: true, downstreamAbortController: controller, requestBody: EMPTY_REQUEST_BODY, backgroundScheduler: NOOP_SCHEDULER });
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertExists(controller);
    assertEquals(ctx.downstreamAbortController, controller);
    assertEquals(ctx.abortSignal, controller.signal);
    assertEquals(ctx.wantsStream, true);
  });

  test('exposes the caller-supplied backgroundScheduler on ctx', async () => {
    const app = makeApp();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    const scheduler: BackgroundScheduler = () => {};
    app.get('/test', c => {
      ctx = createGatewayCtxFromHono(c, { wantsStream: false, requestBody: EMPTY_REQUEST_BODY, backgroundScheduler: scheduler });
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertEquals(ctx.backgroundScheduler, scheduler);
  });

  test('upstreamIds is the intersection of the per-user cap and the per-key whitelist', async () => {
    // Drives the headline multi-tenant invariant: an unrestricted key under a
    // capped user must not route to upstreams outside the user's cap.
    const app = makeApp();
    const collected: { capOnly?: readonly string[] | null; both?: readonly string[] | null; keyOnly?: readonly string[] | null } = {};
    app.get('/cap-only', c => {
      // Unrestricted key (apiKey.upstreamIds null) under a capped user.
      c.set('user', buildUser({ upstreamIds: ['up-a'] }));
      collected.capOnly = createGatewayCtxFromHono(c, { wantsStream: false, requestBody: EMPTY_REQUEST_BODY, backgroundScheduler: NOOP_SCHEDULER }).upstreamIds;
      return c.text('ok');
    });
    app.get('/both', c => {
      // Per-key whitelist further narrows the user cap and preserves per-key order.
      c.set('user', buildUser({ upstreamIds: ['up-a', 'up-b'] }));
      c.set('apiKey', buildApiKey({ upstreamIds: ['up-b', 'up-c'] }));
      collected.both = createGatewayCtxFromHono(c, { wantsStream: false, requestBody: EMPTY_REQUEST_BODY, backgroundScheduler: NOOP_SCHEDULER }).upstreamIds;
      return c.text('ok');
    });
    app.get('/key-only', c => {
      // Uncapped user with a per-key whitelist falls through to the per-key
      // list verbatim.
      c.set('apiKey', buildApiKey({ upstreamIds: ['up-x'] }));
      collected.keyOnly = createGatewayCtxFromHono(c, { wantsStream: false, requestBody: EMPTY_REQUEST_BODY, backgroundScheduler: NOOP_SCHEDULER }).upstreamIds;
      return c.text('ok');
    });
    await app.request('/cap-only');
    await app.request('/both');
    await app.request('/key-only');
    assertEquals(collected.capOnly, ['up-a']);
    assertEquals(collected.both, ['up-b']);
    assertEquals(collected.keyOnly, ['up-x']);
  });
});

describe('stampUpstreamCallStart', () => {
  const freshAttempt = (): AttemptState => ({
    upstreamCallStartedAt: null,
    firstOutputTokenAt: null,
    telemetry: undefined,
  });

  test('stamps upstreamCallStartedAt synchronously before the dispatch runs', async () => {
    const attempt = freshAttempt();
    let stampedAtDispatchEntry: number | null = null;
    const dispatch = () => {
      // Sampled inside the dispatch: the factory must have stamped the slot
      // before handing control off, so this read must see a real number.
      stampedAtDispatchEntry = attempt.upstreamCallStartedAt;
      return Promise.resolve('done');
    };
    const before = performance.now();
    await stampUpstreamCallStart(attempt)(dispatch);
    const after = performance.now();

    assertExists(stampedAtDispatchEntry);
    assert(stampedAtDispatchEntry >= before && stampedAtDispatchEntry <= after,
      `stamp ${stampedAtDispatchEntry} outside [${before}, ${after}]`);
  });

  test('resolves to the dispatched value', async () => {
    const attempt = freshAttempt();
    const result = await stampUpstreamCallStart(attempt)(() => Promise.resolve({ payload: 42 }));
    assertEquals(result, { payload: 42 });
  });

  test('propagates a rejection from the dispatch verbatim', async () => {
    const attempt = freshAttempt();
    const err = new Error('boom');
    let caught: unknown;
    await stampUpstreamCallStart(attempt)(() => Promise.reject(err)).catch(e => { caught = e; });
    assertEquals(caught, err);
    // Even a rejected dispatch reflects a real upstream-call start.
    assertExists(attempt.upstreamCallStartedAt);
  });

  test('stamps exactly once per invocation of the returned factory', async () => {
    const attempt = freshAttempt();
    const factory = stampUpstreamCallStart(attempt);
    let midDispatchReading: number | null = null;
    await factory(() => {
      midDispatchReading = attempt.upstreamCallStartedAt;
      return Promise.resolve();
    });
    // The slot is stamped once at factory entry; the dispatch body must
    // observe the same value, and the post-resolve value must match — no
    // hidden re-stamp on completion.
    assertEquals(attempt.upstreamCallStartedAt, midDispatchReading);
  });

  test('re-stamps on each invocation of the returned factory', async () => {
    const attempt = freshAttempt();
    const factory = stampUpstreamCallStart(attempt);

    await factory(() => Promise.resolve());
    const first = attempt.upstreamCallStartedAt;
    assertExists(first);

    // Force a monotonic gap so the second stamp is provably distinct.
    await new Promise(resolve => setTimeout(resolve, 1));

    await factory(() => Promise.resolve());
    const second = attempt.upstreamCallStartedAt;
    assertExists(second);
    assert(second > first, `expected second stamp ${second} to exceed first ${first}`);
  });
});
