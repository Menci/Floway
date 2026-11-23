import type { GatewayProviders, GatewayRouteFacts } from '../../../pipeline/services.ts';
import type { WebSearchConfig } from '../types.ts';

export const resolveAlphaSearchRouteCandidate = async (
  providers: GatewayProviders,
  facts: GatewayRouteFacts,
  config: Pick<WebSearchConfig['passthroughOpenAiSearch'], 'upstreamId' | 'model'>,
) => {
  const upstreamIds = facts['request.route.upstreamIds'];
  if (upstreamIds !== null && !upstreamIds.includes(config.upstreamId)) return undefined;
  const { candidates } = await providers.enumerate({
    ...facts,
    'request.route.upstreamIds': [config.upstreamId],
    'request.route.randomizeUpstreams': false,
  }, config.model, 'chat');
  const candidate = candidates.find(value => value.upstreamId === config.upstreamId);
  if (candidate !== undefined && providers.resolve(candidate.upstreamId).pipelines.alphaSearch === undefined) {
    throw new Error('Selected upstream does not support OpenAI search passthrough');
  }
  return candidate;
};
