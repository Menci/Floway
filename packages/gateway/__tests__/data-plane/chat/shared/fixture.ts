import type { GatewayProviders, RouteCandidate } from '../../../../src/data-plane/pipeline/services.ts';
import type { HttpResponseFacts } from '@floway-dev/http';
import { Bytes, compose, defineEnding, type StageEnv } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { type FlagId, type ProviderHttpOutput, type ProviderPipelines, type ProviderStreamOutput, toProviderModelFacts } from '@floway-dev/provider';
import { stubProvider, stubProviderModel } from '@floway-dev/test-utils';

type Upstream = ReturnType<GatewayProviders['resolve']>;
export interface ChatTestUpstream { readonly provider: Upstream; readonly candidate: RouteCandidate }

export const chatUpstream = (options: {
  readonly upstreamId?: string;
  readonly modelId?: string;
  readonly endpoints: RouteCandidate['endpoints'];
  readonly limits?: RouteCandidate['limits'];
  readonly rules?: RouteCandidate['rules'];
  readonly flags?: readonly FlagId[];
  readonly pipelines?: ProviderPipelines;
}): ChatTestUpstream => {
  const upstreamId = options.upstreamId ?? 'test-upstream';
  const modelId = options.modelId ?? 'test-model';
  const { endpoints, limits = {} } = options;
  const provider: Upstream = {
    upstreamId, name: upstreamId, kind: 'custom', modelsCache: null,
    disabledPublicModelIds: [], modelPrefix: null, inboundHeaderAllowlist: ['anthropic-beta'],
    configVersion: 1, modelsRefreshInputHash: '', instance: stubProvider(), pipelines: options.pipelines ?? {},
  };
  const providerModel = toProviderModelFacts(stubProviderModel({
    id: modelId, upstreamModelId: modelId, endpoints, limits, enabledFlags: new Set(options.flags),
  }));
  const candidate: RouteCandidate = {
    upstreamId, upstreamName: upstreamId, kind: provider.kind, modelId, upstreamModelId: modelId,
    endpoints, limits, providerModel, ...(options.rules === undefined ? {} : { rules: options.rules }),
  };
  return { provider, candidate };
};

const requestNeeds = ['provider.model', 'request.headers', 'request.payload'];

export const stubUpstreamPipeline = <Input, Output>(
  name: string,
  provides: readonly string[],
  answer: (facts: Input, env: StageEnv) => Output | Promise<Output>,
) => compose<Input, Output, {}>(name, {
  stages: [],
  ending: defineEnding<Input, Output>({
    name: 'stubProvider',
    request: { needs: requestNeeds },
    return: { provides },
    execute: async (facts, _into, env) => await answer(facts, env),
  }),
});

export const stubStreamProvider = <Input, Event>(
  name: string, answer: (facts: Input, env: StageEnv) => ProviderStreamOutput<Event> | Promise<ProviderStreamOutput<Event>>,
) => stubUpstreamPipeline(name, ['response.http', 'response.modelKey', 'response.events'], answer);

export const stubScalarProvider = <Input>(
  name: string, answer: (facts: Input, env: StageEnv) => ProviderHttpOutput | Promise<ProviderHttpOutput>,
) => stubUpstreamPipeline(name, ['response.http', 'response.modelKey'], answer);

export const httpReply = async (env: StageEnv, response: Response, modelKey = 'test-key'): Promise<ProviderHttpOutput> => {
  const now = env.clock();
  return {
    'response.http': {
      status: response.status, statusText: response.statusText, headers: [...response.headers],
      body: response.body === null ? null : Bytes.adopt(new Uint8Array(await response.arrayBuffer())),
      timing: { startedAt: now, headersAt: now },
    },
    'response.modelKey': modelKey,
  };
};

export const eventReply = <Event>(
  env: StageEnv,
  frames: AsyncIterable<ProtocolFrame<Event>>,
  headers: HttpResponseFacts['headers'] = [],
  modelKey = 'test-key',
): ProviderStreamOutput<Event> => {
  const now = env.clock();
  return {
    'response.http': { status: 200, statusText: '', body: null, headers, timing: { startedAt: now, headersAt: now } },
    'response.modelKey': modelKey,
    'response.events': env.createStream({ label: 'provider frames', iterate: () => frames }),
  };
};

export const providersFrom = (entries: readonly ChatTestUpstream[]): GatewayProviders => ({
  enumerate: async () => ({ candidates: entries.map(entry => entry.candidate), sawModel: entries.length > 0, failedUpstreams: [] }),
  resolve: id => {
    const entry = entries.find(entry => entry.provider.upstreamId === id);
    if (entry === undefined) throw new Error(`Unexpected fixture upstream ${id}`);
    return entry.provider;
  },
});

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
