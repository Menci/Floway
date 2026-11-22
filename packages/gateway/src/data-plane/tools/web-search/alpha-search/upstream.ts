import type { GatewayRequestDirectory } from '../../../pipeline/services.ts';
import type { WebSearchConfig } from '../types.ts';
import type { RouteCandidate } from '@floway-dev/provider';

export type AlphaSearchDispatcher = (body: Record<string, unknown>, signal: AbortSignal | undefined, headers: Headers) => Promise<Response>;

export class AlphaSearchModelNotFoundError extends Error {
  constructor() {
    super('Search model not found.');
    this.name = 'AlphaSearchModelNotFoundError';
  }
}

export const resolveAlphaSearchRouteCandidate = async (
  directory: GatewayRequestDirectory,
  config: Pick<WebSearchConfig['passthroughOpenAiSearch'], 'upstreamId' | 'model'>,
): Promise<RouteCandidate> => {
  const { candidates } = await directory.enumerateCandidates(config.model, 'chat');
  const candidate = candidates.find(value => value.upstreamId === config.upstreamId);
  if (candidate === undefined) throw new AlphaSearchModelNotFoundError();
  if (candidate.kind !== 'chatgpt' && candidate.kind !== 'custom') {
    throw new Error('Selected upstream does not support OpenAI search passthrough');
  }
  return candidate;
};
