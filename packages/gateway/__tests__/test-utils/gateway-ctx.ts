import { createOpenAIResponsesHttpStore, type OpenAIResponsesStatefulStore } from '../../src/data-plane/chat/openai-responses/items/store.ts';
import { AffinityRequestContext } from '../../src/data-plane/chat/shared/affinity/index.ts';
import type { ChatGatewayCtx } from '../../src/data-plane/chat/shared/gateway-ctx.ts';
import { createSidecarCodecFactory } from '../../src/data-plane/chat/shared/sidecar-codec.ts';
import type { GatewayCtx } from '../../src/data-plane/shared/gateway-ctx.ts';
import type { User } from '../../src/repo/types.ts';
import { stubModelCandidate } from '@floway-dev/test-utils';

const testUser: User = {
  id: 1,
  username: 'admin',
  passwordHash: null,
  isAdmin: true,
  createdAt: '1970-01-01T00:00:00.000Z',
  deletedAt: null,
};

// Shared minimal GatewayCtx for tests that exercise serve / respond /
// interceptor code in isolation. Defaults satisfy every required field; pass
// `overrides` to nudge what each test cares about. Callers that need a
// downstream abort controller should construct one and spread
// `{ abortSignal: controller.signal, downstreamAbortController: controller }`
// into the overrides.
export const mockGatewayCtx = (overrides: Partial<GatewayCtx> = {}): GatewayCtx => ({
  apiKeyId: 'key_test',
  user: testUser,
  requestStartedAt: 0,
  upstreamIds: null,
  randomizeUpstreams: false,
  wantsStream: false,
  runtimeLocation: 'TEST',
  dump: null,
  backgroundScheduler: promise => { void promise; },
  attempt: { timing: { firstOutputTokenAt: null, upstreamCallStartedAt: null }, telemetry: undefined },
  ...overrides,
});

// Chat-protocol counterpart: adds affinity, a sidecar factory, and the OpenAI Responses item
// store. Tests that exercise durable OpenAI Responses behavior override `.store`
// explicitly.
export const mockChatGatewayCtx = (overrides: Partial<ChatGatewayCtx> = {}): ChatGatewayCtx & { readonly store: OpenAIResponsesStatefulStore } => {
  const base = mockGatewayCtx(overrides);
  const affinity = overrides.affinity ?? new AffinityRequestContext('00'.repeat(32));
  if (overrides.affinity === undefined) affinity.select(stubModelCandidate());
  return {
    ...base,
    affinity,
    sidecarCodecFactory: overrides.sidecarCodecFactory ?? createSidecarCodecFactory('00'.repeat(32)),
    store: overrides.store ?? createOpenAIResponsesHttpStore({ id: base.apiKeyId, openaiResponsesRetentionSeconds: 0 }, base.requestStartedAt, false),
  };
};
