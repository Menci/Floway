import type { GatewayCtx } from '../../src/data-plane/shared/gateway-ctx.ts';
import type { User } from '../../src/repo/types.ts';

const testUser: User = {
  id: 1,
  username: 'admin',
  passwordHash: null,
  isAdmin: true,
  createdAt: '1970-01-01T00:00:00.000Z',
  deletedAt: null,
};

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
