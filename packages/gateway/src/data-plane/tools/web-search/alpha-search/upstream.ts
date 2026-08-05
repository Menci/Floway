import { enumerateModelCandidates } from '../../../providers/resolution.ts';
import { filterInboundHeadersForProvider } from '../../../shared/inbound-headers.ts';
import type { WebSearchConfig } from '../types.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { identityWrapUpstreamCall, providerModelOf } from '@floway-dev/provider';

export type AlphaSearchDispatcher = (body: Record<string, unknown>, signal: AbortSignal | undefined, headers: Headers) => Promise<Response>;

export const resolveAlphaSearchDispatcher = async ({
  config,
  upstreamIds,
  scheduler,
  runtimeLocation,
}: {
  config: Pick<WebSearchConfig['passthroughOpenAiSearch'], 'upstreamId' | 'model'>;
  upstreamIds: readonly string[] | null;
  scheduler: BackgroundScheduler;
  runtimeLocation: string;
}): Promise<AlphaSearchDispatcher> => {
  if (upstreamIds !== null && !upstreamIds.includes(config.upstreamId)) {
    throw new Error('Selected OpenAI search upstream is outside this API key scope');
  }
  const { candidates } = await enumerateModelCandidates({
    upstreamIds: [config.upstreamId],
    model: config.model,
    kind: 'chat',
    scheduler,
    runtimeLocation,
  });
  const candidate = candidates.find(value => value.provider.upstreamId === config.upstreamId);
  if (candidate === undefined) {
    throw new Error(`Selected OpenAI search model ${config.model} is unavailable`);
  }
  if (candidate.provider.kind !== 'codex' && candidate.provider.kind !== 'custom') {
    throw new Error('Selected upstream does not support OpenAI search passthrough');
  }

  return async (body, signal, headers) => {
    const { model: _callerModel, ...request } = body;
    // TODO: pin SearchRequest.id to one provider account when Codex upstreams
    // support account pools. The current Codex provider has one active account.
    const result = await candidate.provider.instance.callAlphaSearch(
      providerModelOf(candidate),
      request,
      signal,
      {
        fetcher: candidate.fetcher,
        waitUntil: scheduler,
        headers: filterInboundHeadersForProvider(headers, candidate.provider),
        wrapUpstreamCall: identityWrapUpstreamCall,
      },
    );
    return result.response;
  };
};
