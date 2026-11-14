import type { User } from '../../../../repo/types.ts';
import { enumerateModelCandidates } from '../../../providers/resolution.ts';
import type { WebSearchConfig } from '../types.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { ModelCandidate } from '@floway-dev/provider';

export type AlphaSearchDispatcher = (body: Record<string, unknown>, signal: AbortSignal | undefined, headers: Headers) => Promise<Response>;

export class AlphaSearchModelNotFoundError extends Error {
  constructor() {
    super('Search model not found.');
    this.name = 'AlphaSearchModelNotFoundError';
  }
}

interface AlphaSearchResolution {
  config: Pick<WebSearchConfig['passthroughOpenAiSearch'], 'upstreamId' | 'model'>;
  subject: User;
  upstreamIds: readonly string[] | null;
  scheduler: BackgroundScheduler;
  runtimeLocation: string;
}

/** The operator's pinned search candidate. The configured model is private, so a key outside
 *  its scope and a model that is missing share one answer. */
export const resolveAlphaSearchCandidate = async ({
  config,
  subject,
  upstreamIds,
  scheduler,
  runtimeLocation,
}: AlphaSearchResolution): Promise<ModelCandidate> => {
  if (upstreamIds !== null && !upstreamIds.includes(config.upstreamId)) {
    throw new AlphaSearchModelNotFoundError();
  }
  const { candidates } = await enumerateModelCandidates({
    subject,
    upstreamIds: [config.upstreamId],
    randomizeUpstreams: false,
    model: config.model,
    kind: 'chat',
    scheduler,
    runtimeLocation,
  });
  const candidate = candidates.find(value => value.provider.upstreamId === config.upstreamId);
  if (candidate === undefined) {
    throw new AlphaSearchModelNotFoundError();
  }
  if (candidate.provider.kind !== 'codex' && candidate.provider.kind !== 'custom') {
    throw new Error('Selected upstream does not support OpenAI search passthrough');
  }
  return candidate;
};
