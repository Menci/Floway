import type { PinnedSearchUpstream, Fields } from './facts.ts';
import { parseAlphaSearchResponse } from './protocol.ts';
import type { GatewayServices } from '../pipeline/services.ts';
import { enumerateModelCandidates } from '../providers/resolution.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import { filterInboundHeadersForProvider } from '../shared/inbound-headers.ts';
import { telemetryModelIdentity } from '../shared/telemetry/attribution.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import { providerModelOf, identityWrapUpstreamCall, type ModelCandidate } from '@floway-dev/provider';

/**
 * A misconfigured pin is the operator's to see with its stack, the way the gateway surfaces
 * any internal failure. It is not a failure value: a failure value exists so an earlier stage
 * can fail over it, and there is no earlier stage here with anywhere to go.
 */
const resolvePinnedUpstream = async (pinned: PinnedSearchUpstream, gateway: GatewayCtx): Promise<ModelCandidate> => {
  if (gateway.upstreamIds !== null && !gateway.upstreamIds.includes(pinned.upstreamId)) {
    throw new Error('Selected OpenAI search upstream is outside this API key scope');
  }
  const { candidates } = await enumerateModelCandidates({
    upstreamIds: [pinned.upstreamId],
    model: pinned.model,
    kind: 'chat',
    scheduler: gateway.backgroundScheduler,
    runtimeLocation: gateway.runtimeLocation,
  });
  const candidate = candidates.find(value => value.provider.upstreamId === pinned.upstreamId);
  if (candidate === undefined) {
    throw new Error(`Selected OpenAI search model ${pinned.model} is unavailable`);
  }
  if (candidate.provider.kind !== 'codex' && candidate.provider.kind !== 'custom') {
    throw new Error('Selected upstream does not support OpenAI search passthrough');
  }
  return candidate;
};

/** Codex projects one per-turn metadata snapshot onto several surfaces, and `SearchRequest`
 *  carries no field for it — so on this endpoint the header is the whole of that surface, and
 *  it is the only inbound header this call reads.
 *  https://github.com/openai/codex/blob/2e1607ee2fa8099a233df7437adee5f16a741905/codex-rs/codex-api/src/search.rs#L8-L29 */
const turnMetadataHeaders = (ingress: readonly (readonly [string, string])[]): Headers => {
  const headers = new Headers();
  const metadata = ingress.find(([name]) => name.toLowerCase() === 'x-codex-turn-metadata');
  if (metadata !== undefined) headers.set('x-codex-turn-metadata', metadata[1]);
  return headers;
};

/** The body as JSON, or nothing when it was not JSON at all. Which of the two happened is
 *  what the caller reports; here it is only the question being asked. */
const asJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * The pinned ending. Dials the operator's search upstream and provides what came back plus
 * what the call is billable for. A failure is a value here as everywhere, even though this
 * family has nothing that fails over it: the edge is what turns one into a status and a body.
 */
export const callSearchUpstream = (pinned: PinnedSearchUpstream) => defineStage<
  Fields<'request.search.alphaSearch' | 'ingress.http.headers'>,
  Fields<'response.search.alphaSearch' | 'response.usage.billable' | 'response.http.headers'>,
  GatewayServices
>({
  name: 'callSearchUpstream',
  return: { provides: ['response.search.alphaSearch', 'response.usage.billable', 'response.http.headers'] },
  execute: async (facts, use) => {
    const candidate = await resolvePinnedUpstream(pinned, use.gateway);
    // The caller's model is dropped: this endpoint is pinned to the operator's model, and the
    // provider stamps that one on the way out.
    // TODO: pin SearchRequest.id to one provider account when Codex upstreams support account
    // pools. The current Codex provider has one active account.
    const { model: _named, ...request } = facts['request.search.alphaSearch'];
    const result = await candidate.provider.instance.callAlphaSearch(
      providerModelOf(candidate),
      request,
      use.gateway.abortSignal,
      {
        fetcher: candidate.fetcher,
        waitUntil: use.gateway.backgroundScheduler,
        // The client's own headers reach the upstream from the record, not from a live
        // request object: what a provider is allowed to forward is filtered per provider,
        // and the dump shows what was there to filter.
        headers: filterInboundHeadersForProvider(turnMetadataHeaders(facts['ingress.http.headers']), candidate.provider),
        // No `PerformanceOperation` names search, so there is no performance row for a
        // stamping wrapper's interval to land on.
        wrapUpstreamCall: identityWrapUpstreamCall,
      },
    );
    // The alpha-search protocol reports no usage at all, so the entity is present with no
    // quantities — the upstream was called and reported nothing, which is a different
    // situation from reporting zero.
    const billable = [{ identity: telemetryModelIdentity(candidate, result.modelKey), quantities: {} }];

    // Every protocol the gateway carries is one it fully understands: the body is read here
    // and serialized again at the edge, an error body included.
    const raw = await result.response.text();
    if (!result.response.ok) {
      use.log.warn('upstream refused', { status: result.response.status });
      // The message is what came back as text and the body is the same thing parsed: a dump
      // reader gets the upstream's own words either way, and only the parsed form is
      // something the edge can serialize back out.
      const body = asJson(raw);
      return move({
        ...facts,
        'response.search.alphaSearch': {
          status: result.response.status,
          message: raw,
          ...(body === undefined ? {} : { body }),
        },
        'response.usage.billable': billable,
        'response.http.headers': [...result.response.headers],
      });
    }

    const verdict = parseAlphaSearchResponse(asJson(raw));
    if (!verdict.ok) {
      // A protocol that requires JSON and receives something else synthesizes its own error,
      // which is also why the raw text rides along: a dump reader is owed what came back.
      return move({
        ...facts,
        'response.search.alphaSearch': {
          status: 502,
          message: `The search upstream answered ${result.response.status} but not in the search protocol: ${verdict.reason}.`,
          body: raw,
        },
        'response.usage.billable': billable,
        'response.http.headers': [...result.response.headers],
      });
    }
    return move({
      ...facts,
      'response.search.alphaSearch': verdict.response,
      'response.usage.billable': billable,
      'response.http.headers': [...result.response.headers],
    });
  },
});
