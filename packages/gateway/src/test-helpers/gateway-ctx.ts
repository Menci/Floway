import { createNonResponsesSourceStore } from '../data-plane/chat/responses/items/store.ts';
import type { ChatGatewayCtx, GatewayCtx } from '../data-plane/chat/shared/gateway-ctx.ts';

// Shared minimal GatewayCtx for tests that exercise serve / respond /
// interceptor code in isolation. Defaults satisfy every required field; pass
// `overrides` to nudge what each test cares about. Callers that need a
// downstream abort controller should construct one and spread
// `{ abortSignal: controller.signal, downstreamAbortController: controller }`
// into the overrides.
export const mockGatewayCtx = (overrides: Partial<GatewayCtx> = {}): GatewayCtx => ({
  apiKeyId: 'key_test',
  upstreamIds: null,
  wantsStream: false,
  runtimeLocation: 'TEST',
  dump: null,
  backgroundScheduler: promise => { void promise; },
  attempt: { firstOutputTokenAt: null, upstreamCallStartedAt: null, telemetry: undefined },
  responseHeaders: new Headers(),
  ...overrides,
});

// Chat-protocol counterpart: adds the stored-items store bound to the
// resolved apiKeyId (base default or override). Interceptor tests only
// need the store to exist; overriding `.store` explicitly is supported
// for tests that inspect its per-turn behaviour.
export const mockChatGatewayCtx = (overrides: Partial<ChatGatewayCtx> = {}): ChatGatewayCtx => {
  const base = mockGatewayCtx(overrides);
  return {
    ...base,
    store: overrides.store ?? createNonResponsesSourceStore(base.apiKeyId),
  };
};
