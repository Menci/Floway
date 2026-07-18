import { ResponsesAttemptState } from '../data-plane/chat/responses/attempt-state.ts';
import { createResponsesHttpStore, type StatefulResponsesStore } from '../data-plane/chat/responses/items/store.ts';
import { AffinityRequestContext } from '../data-plane/chat/shared/affinity/index.ts';
import type { ChatGatewayCtx, GatewayCtx } from '../data-plane/chat/shared/gateway-ctx.ts';
import { stubModelCandidate } from '@floway-dev/test-utils';

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

// Chat-protocol counterpart: adds the affinity membrane and request-local
// Responses invocation state. Tests that exercise durable Responses behavior
// override `.store` explicitly.
export const mockChatGatewayCtx = (overrides: Partial<ChatGatewayCtx> = {}): ChatGatewayCtx & { readonly store: StatefulResponsesStore } => {
  const base = mockGatewayCtx(overrides);
  const affinity = overrides.affinity ?? new AffinityRequestContext('00'.repeat(32));
  if (overrides.affinity === undefined) affinity.select(stubModelCandidate());
  return {
    ...base,
    affinity,
    responsesAttemptState: overrides.responsesAttemptState ?? new ResponsesAttemptState(),
    store: overrides.store ?? createResponsesHttpStore(base.apiKeyId, false),
  };
};
