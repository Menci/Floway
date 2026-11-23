import { expect, test } from 'vitest';

import { createSidecarCodecFactory, SidecarDomain } from '../../../../src/data-plane/chat/shared/sidecar-codec.ts';
import { createGatewayServices } from '../../../../src/data-plane/pipeline/services.ts';
import type { ApiKey } from '../../../../src/repo/types.ts';

test('signs sidecars with the authenticated key secret', async () => {
  const apiKey: ApiKey = {
    id: 'key', userId: 1, name: 'test', key: 'test-key', serverSecret: '11'.repeat(32),
    createdAt: '2026-01-01T00:00:00.000Z', upstreamIds: null, randomizeUpstreams: false, deletedAt: null,
    dumpRetentionSeconds: null, openaiResponsesRetentionSeconds: 0,
  };
  const services = createGatewayServices({ apiKey, runtimeLocation: 'test' });
  const encoded = await services.sidecarCodecs.codecFor(SidecarDomain.TranslatedAssistantTurn).encode({ value: 1 });
  expect(await createSidecarCodecFactory(apiKey.serverSecret).codecFor(SidecarDomain.TranslatedAssistantTurn).decode(encoded)).toEqual({ value: 1 });
  expect(await createSidecarCodecFactory('22'.repeat(32)).codecFor(SidecarDomain.TranslatedAssistantTurn).decode(encoded)).toBeUndefined();
});
