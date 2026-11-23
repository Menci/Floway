import type { ChatEgressInput, ChatEvent, ChatResult } from '../../../../src/data-plane/chat/shared/route-body.ts';
import type { GatewayProviders, RouteCandidate } from '../../../../src/data-plane/pipeline/services.ts';
import type { Fetcher } from '@floway-dev/http';
import { Bytes, compose, defineEnding, type Scope, secret } from '@floway-dev/pipeline';
import { type ChatTargetApi, type FlagId, type ProtocolOutcome, type ProviderBaseOutput, type ProviderFrame, toProviderModelFacts } from '@floway-dev/provider';
import type { CustomUpstreamConfigFacts, CustomUpstreamFacts } from '@floway-dev/provider-custom';
import { stubProviderModel } from '@floway-dev/test-utils';

export interface ChatTestUpstream {
  readonly candidate: RouteCandidate;
  readonly fetcher?: Fetcher;
}

export const chatUpstream = (options: {
  readonly upstreamId?: string;
  readonly modelId?: string;
  readonly endpoints: RouteCandidate['endpoints'];
  readonly limits?: RouteCandidate['limits'];
  readonly rules?: RouteCandidate['rules'];
  readonly flags?: readonly FlagId[];
  readonly baseUrl?: string;
  readonly ingressHeadersRules?: CustomUpstreamConfigFacts['ingressHeadersRules'];
  readonly pathOverrides?: CustomUpstreamConfigFacts['pathOverrides'];
  readonly fetcher?: Fetcher;
}): ChatTestUpstream => {
  const upstreamId = options.upstreamId ?? 'test-upstream';
  const modelId = options.modelId ?? 'test-model';
  const { endpoints, limits = {} } = options;
  const upstream: CustomUpstreamFacts = {
    kind: 'custom',
    id: upstreamId,
    name: upstreamId,
    config: {
      baseUrl: options.baseUrl ?? 'https://upstream.test',
      apiKey: secret('test-key'),
      ingressHeadersRules: options.ingressHeadersRules ?? [{ key: 'anthropic-beta', value: null }],
      ...(options.pathOverrides === undefined ? {} : { pathOverrides: options.pathOverrides }),
    },
  };
  const providerModel = toProviderModelFacts(stubProviderModel({
    id: modelId, upstreamModelId: modelId, endpoints, limits, enabledFlags: new Set(options.flags),
  }));
  const candidate: RouteCandidate = {
    upstreamId, upstreamName: upstreamId, kind: upstream.kind, upstream, modelId, upstreamModelId: modelId,
    endpoints, limits, providerModel, ...(options.rules === undefined ? {} : { rules: options.rules }),
  };
  return { candidate, ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }) };
};

export const httpReply = async (scope: Scope, response: Response, modelKey = 'test-key'): Promise<ProviderBaseOutput> => {
  const now = scope.clock();
  return {
    'response.http': {
      status: response.status, statusText: response.statusText, headers: [...response.headers],
      body: response.body === null ? null : Bytes.adopt(new Uint8Array(await response.arrayBuffer())),
      timing: { startedAt: now, headersAt: now },
      exchange: 'upstream',
    },
    'response.modelKey': modelKey,
  };
};

export const eventOutcome = <Event>(
  scope: Scope, frames: Iterable<ProviderFrame<Event>> | AsyncIterable<ProviderFrame<Event>>,
): Extract<ProtocolOutcome<Event>, { kind: 'stream' }> => ({
  kind: 'stream',
  events: scope.createStream({ label: 'provider frames', async *iterate() { yield* frames; } }),
});

type StubEgressReply<Api extends ChatTargetApi> = ProviderBaseOutput & {
  readonly outcome: ProtocolOutcome<ChatEvent<Api>, ChatResult<Api>>;
};

export const stubEgressPipeline = <Api extends ChatTargetApi>(
  api: Api,
  answer: (facts: ChatEgressInput<Api>, scope: Scope) => StubEgressReply<Api> | Promise<StubEgressReply<Api>>,
) => {
  const entry = ['request.http', 'request.payload', 'route.candidate', 'route.targetApi'] as const;
  type Outcomes = Readonly<Record<`response.${ChatTargetApi}`, StubEgressReply<Api>['outcome']>>;
  type Space = { readonly [K in typeof entry[number]]: ChatEgressInput<Api>[K] } & ProviderBaseOutput & Outcomes;
  const key = `response.${api}` as const;
  const exit = ['response.http', 'response.modelKey', key] as const;
  return compose<Space>()(`test ${api} egress`, {
    entry, exit, stages: [],
    ending: defineEnding<ChatEgressInput<Api>, ProviderBaseOutput & Partial<Outcomes>>({
      name: 'stubEgress',
      request: { needs: entry },
      return: { provides: exit },
      execute: async (facts, scope) => {
        const { outcome, ...http } = await answer(facts, scope);
        return { ...http, [key]: outcome };
      },
    }),
  });
};

export const providersFrom = (entries: readonly ChatTestUpstream[]): GatewayProviders => ({
  enumerate: async () => ({ candidates: entries.map(entry => entry.candidate), sawModel: entries.length > 0, failedUpstreams: [], staleRefreshes: [] }),
});

export const fetcherFrom = (entries: readonly ChatTestUpstream[]) => (upstreamId: string): Fetcher => {
  const fetcher = entries.find(entry => entry.candidate.upstreamId === upstreamId)?.fetcher;
  if (fetcher === undefined) throw new Error(`No fixture fetcher for upstream ${upstreamId}`);
  return fetcher;
};

export const interruptedUpload = (pathname: string): Request => {
  let uploaded = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (uploaded) {
        controller.error(new Error('client upload interrupted'));
        return;
      }
      uploaded = true;
      controller.enqueue(new TextEncoder().encode('{"unfinished":'));
    },
  });
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half',
  };
  return new Request(`https://gateway.test${pathname}`, init);
};
