import type { GatewayCtx } from '../data-plane/chat/shared/gateway-ctx.ts';

// Shared minimal GatewayCtx for tests that exercise serve / respond /
// interceptor code in isolation. Defaults satisfy every required field; pass
// `overrides` to nudge what each test cares about (wantsStream, apiKeyId,
// abortSignal, etc.). Callers that need a downstream abort controller should
// construct one and spread `{ abortSignal: controller.signal,
// downstreamAbortController: controller }` into the overrides.
export const mockGatewayCtx = (overrides: Partial<GatewayCtx> = {}): GatewayCtx => ({
  apiKeyId: 'key_test',
  upstreamIds: null,
  wantsStream: false,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  backgroundScheduler: promise => { void promise; },
  requestStartedAt: 0,
  responseHeaders: new Headers(),
  ...overrides,
});
