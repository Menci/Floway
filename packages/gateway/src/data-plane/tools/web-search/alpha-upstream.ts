import { enumerateModelCandidates } from '../../providers/registry.ts';
import type { SearchConfig } from './types.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { identityWrapUpstreamCall, providerModelOf } from '@floway-dev/provider';

export interface AlphaSearchDispatcher {
  call(body: Record<string, unknown>, signal: AbortSignal | undefined, headers?: Headers): Promise<Response>;
}

export class AlphaSearchConfigError extends Error {}

export const resolveAlphaSearchDispatcher = async ({
  config,
  upstreamIds,
  scheduler,
  runtimeLocation,
}: {
  config: SearchConfig['passthroughOpenAiSearch'];
  upstreamIds: readonly string[] | null;
  scheduler: BackgroundScheduler;
  runtimeLocation: string;
}): Promise<AlphaSearchDispatcher> => {
  if (!config.enabled) throw new AlphaSearchConfigError('OpenAI search passthrough is disabled');
  if (upstreamIds !== null && !upstreamIds.includes(config.upstreamId)) {
    throw new AlphaSearchConfigError('Selected OpenAI search upstream is outside this API key scope');
  }
  const { candidates } = await enumerateModelCandidates({
    upstreamIds: [config.upstreamId],
    model: config.model,
    kind: 'chat',
    scheduler,
    runtimeLocation,
  });
  const candidate = candidates.find(value => value.provider.upstream === config.upstreamId);
  if (candidate === undefined) {
    throw new AlphaSearchConfigError(`Selected OpenAI search model ${config.model} is unavailable`);
  }
  if (candidate.provider.kind !== 'codex' && candidate.provider.kind !== 'custom') {
    throw new AlphaSearchConfigError('Selected upstream does not support OpenAI search passthrough');
  }

  return {
    call: async (body, signal, headers = new Headers()) => {
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
          headers,
          wrapUpstreamCall: identityWrapUpstreamCall,
        },
      );
      return result.response;
    },
  };
};
