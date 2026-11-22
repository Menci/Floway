import { createGatewayServices } from '../../../src/data-plane/pipeline/services.ts';
import type { ApiKey } from '../../../src/repo/types.ts';
import { testAdminUser } from '../../test-utils/app.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { ModelKind } from '@floway-dev/protocols/common';

const apiKey: ApiKey = {
  id: 'key-directory', userId: 1, name: 'test', key: 'secret', serverSecret: '00'.repeat(32),
  createdAt: '2026-01-01', upstreamIds: null, randomizeUpstreams: false, deletedAt: null,
  dumpRetentionSeconds: null, openaiResponsesRetentionSeconds: 0,
};

export const enumerateModelCandidates = (input: {
  readonly upstreamIds: readonly string[] | null;
  readonly randomizeUpstreams: boolean;
  readonly model: string;
  readonly kind: ModelKind;
  readonly runtimeLocation: string;
  readonly scheduler: BackgroundScheduler;
}) => createGatewayServices({ apiKey, runtimeLocation: input.runtimeLocation, scheduler: input.scheduler }).providers.enumerate({
  'request.auth.apiKeyId': apiKey.id,
  'request.auth.user': { id: testAdminUser.id, isAdmin: testAdminUser.isAdmin },
  'request.route.upstreamIds': input.upstreamIds,
  'request.route.randomizeUpstreams': input.randomizeUpstreams,
  'request.route.runtimeLocation': input.runtimeLocation,
}, input.model, input.kind);
