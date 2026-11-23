import type { GatewayProviders, GatewayRouteFacts } from '../../../pipeline/services.ts';
import { providerSupportsOperation } from '../../../providers/upstreams.ts';
import type { WebSearchConfig } from '../types.ts';

export const resolveAlphaSearchRoute = async (
  providers: GatewayProviders,
  facts: GatewayRouteFacts,
  config: Pick<WebSearchConfig['passthroughOpenAiSearch'], 'upstreamId' | 'model'>,
) => {
  const upstreamIds = facts['request.route.upstreamIds'];
  if (upstreamIds !== null && !upstreamIds.includes(config.upstreamId)) return { candidate: undefined, staleRefreshes: [] };
  const { candidates, staleRefreshes } = await providers.enumerate({
    ...facts,
    'request.route.upstreamIds': [config.upstreamId],
    'request.route.randomizeUpstreams': false,
  }, config.model, 'chat');
  const candidate = candidates.find(value => value.upstreamId === config.upstreamId);
  if (candidate !== undefined && !providerSupportsOperation(candidate.kind, 'alphaSearch')) {
    throw new Error('Selected upstream does not support OpenAI search passthrough');
  }
  return { candidate, staleRefreshes };
};
