import { createPerRequestFetcher } from '../../../dial/per-request.ts';
import { listModelProviders, resolveModelForProvider } from '../../providers/registry.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { LlmTargetApi, ProviderCandidate } from '@floway-dev/provider';

export type { ProviderCandidate };

// Returns the candidates that satisfy both the model resolution and the
// target-endpoint pick, plus a `sawModel` flag that distinguishes the
// "model is missing entirely" failure from "model exists but does not
// expose the endpoint this source needs", plus the names of upstreams
// whose catalog fetch rejected this round so the caller's failure
// renderer can surface them parenthetically.
export const enumerateProviderCandidates = async ({
  upstreamIds, model, pickTarget, scheduler, currentColo,
}: {
  // null = unrestricted; empty list = no providers visible.
  upstreamIds: readonly string[] | null;
  model: string;
  pickTarget: (endpoints: ModelEndpoints) => LlmTargetApi | null;
  // Threaded into `resolveModelForProvider` so the per-upstream catalog
  // lookup hits the SWR-cached `fetchUpstreamModelsCached` instead of
  // round-tripping to the upstream on every LLM serve.
  scheduler: BackgroundScheduler;
  // Current colo for this request — see GatewayCtx.currentColo. Threaded
  // into the per-request fetcher so colo-scoped fallback entries can be
  // honoured at dial time.
  currentColo: string;
}): Promise<{ readonly candidates: readonly ProviderCandidate[]; readonly sawModel: boolean; readonly failedUpstreams: readonly string[] }> => {
  const fetcherForUpstream = await createPerRequestFetcher(currentColo);
  const providers = await listModelProviders(upstreamIds);

  // Fan out per-upstream and recover each rejection as a "this upstream
  // has no models for this request" result rather than propagating the
  // first failure: one upstream past HARD whose force re-fetch fails
  // must not poison routing for other upstreams. The cache layer
  // already memoizes in-flight fetches per upstream so the parallel
  // walk does not multiply upstream round trips. Results are kept in
  // input order so candidate priority (first viable candidate wins)
  // matches the configured provider order.
  const settled = await Promise.allSettled(providers.map(provider =>
    resolveModelForProvider(provider, model, fetcherForUpstream(provider.upstream), scheduler)
      .then(resolved => ({ provider, resolved }))));

  const candidates: ProviderCandidate[] = [];
  const failedUpstreams: string[] = [];
  let sawModel = false;

  for (const [index, result] of settled.entries()) {
    const provider = providers[index];
    if (result.status === 'rejected') {
      const error = result.reason;
      // Caller-driven cancellation must propagate; see the matching
      // guard in `collectProviderModels`.
      if (error instanceof Error && error.name === 'AbortError') throw error;
      failedUpstreams.push(provider.name);
      continue;
    }

    const { resolved } = result.value;
    if (!resolved) continue;
    sawModel = true;

    const targetApi = pickTarget(resolved.binding.upstreamModel.endpoints);
    if (!targetApi) continue;

    candidates.push({ provider, binding: resolved.binding, targetApi, fetcher: fetcherForUpstream(provider.upstream) });
  }

  return { candidates, sawModel, failedUpstreams };
};
