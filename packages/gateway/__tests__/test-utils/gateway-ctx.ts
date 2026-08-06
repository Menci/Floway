import { createResponsesHttpStore, type StatefulResponsesStore } from '../../src/data-plane/chat/responses/items/store.ts';
import { AffinityRequestContext } from '../../src/data-plane/chat/shared/affinity/index.ts';
import type { ChatGatewayCtx } from '../../src/data-plane/chat/shared/gateway-ctx.ts';
import type { GatewayCtx } from '../../src/data-plane/shared/gateway-ctx.ts';
import { stubModelCandidate } from '@floway-dev/test-utils';

// Shared minimal GatewayCtx for tests that exercise serve / respond /
// interceptor code in isolation. Defaults satisfy every required field; pass
// `overrides` to nudge what each test cares about.
export const mockGatewayCtx = (overrides: Partial<GatewayCtx> = {}): GatewayCtx => {
  const clientDisconnectController = overrides.clientDisconnectController ?? new AbortController();
  const executionController = overrides.executionController ?? new AbortController();
  return {
    apiKeyId: 'key_test',
    requestStartedAt: 0,
    upstreamIds: null,
    clientDisconnectSignal: overrides.clientDisconnectSignal ?? clientDisconnectController.signal,
    clientDisconnectController,
    executionSignal: overrides.executionSignal ?? executionController.signal,
    executionController,
    finishExecution: () => {},
    wantsStream: false,
    runtimeLocation: 'TEST',
    dump: null,
    backgroundScheduler: promise => { void promise; },
    attempt: { firstOutputTokenAt: null, upstreamCallStartedAt: null, telemetry: undefined },
    ...overrides,
  };
};

// Chat-protocol counterpart: adds the affinity membrane and the Responses item
// store. Tests that exercise durable Responses behavior override `.store`
// explicitly.
export const mockChatGatewayCtx = (overrides: Partial<ChatGatewayCtx> = {}): ChatGatewayCtx & { readonly store: StatefulResponsesStore } => {
  const base = mockGatewayCtx(overrides);
  const affinity = overrides.affinity ?? new AffinityRequestContext('00'.repeat(32));
  if (overrides.affinity === undefined) affinity.select(stubModelCandidate());
  return {
    ...base,
    affinity,
    store: overrides.store ?? createResponsesHttpStore({ id: base.apiKeyId, responsesRetentionSeconds: 0 }, base.requestStartedAt, false),
  };
};
