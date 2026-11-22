import { expect, test } from 'vitest';

import type { GatewayRequestDirectory } from '../../../../../src/data-plane/pipeline/services.ts';
import {
  AlphaSearchModelNotFoundError,
  resolveAlphaSearchRouteCandidate,
} from '../../../../../src/data-plane/tools/web-search/alpha-search/upstream.ts';
import { stubRouteCandidate } from '../../../../test-utils/chat-pipeline.ts';

const directoryFor = (candidates: readonly ReturnType<typeof stubRouteCandidate>[]) => ({
  enumerateCandidates: async () => ({ candidates, sawModel: candidates.length > 0, failedUpstreams: [] }),
}) as unknown as GatewayRequestDirectory;

test('Alpha Search reports a missing model when the selected upstream has no matching candidate', async () => {
  await expect(resolveAlphaSearchRouteCandidate(directoryFor([]), {
    upstreamId: 'search-upstream',
    model: 'search-model',
  })).rejects.toBeInstanceOf(AlphaSearchModelNotFoundError);
});

test('Alpha Search rejects unsupported provider kinds', async () => {
  await expect(resolveAlphaSearchRouteCandidate(directoryFor([
    stubRouteCandidate({ upstreamId: 'search-upstream', kind: 'copilot', modelId: 'search-model' }),
  ]), {
    upstreamId: 'search-upstream',
    model: 'search-model',
  })).rejects.toThrow('does not support OpenAI search passthrough');
});

test('Alpha Search returns the native route candidate without a legacy conversion', async () => {
  const candidate = stubRouteCandidate({
    upstreamId: 'search-upstream',
    kind: 'chatgpt',
    modelId: 'search-model',
  });
  expect(await resolveAlphaSearchRouteCandidate(directoryFor([candidate]), {
    upstreamId: 'search-upstream',
    model: 'search-model',
  })).toBe(candidate);
});
