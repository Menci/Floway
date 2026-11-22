import { mockChatGatewayCtx } from './gateway-ctx.ts';
import { createChatPipelineServices, type ChatPipelineServices } from '../../src/data-plane/chat/pipeline/index.ts';
import type { ChatGatewayCtx } from '../../src/data-plane/chat/shared/gateway-ctx.ts';
import type { GatewayRequestDirectory } from '../../src/data-plane/pipeline/index.ts';
import type { GatewayProvider } from '../../src/data-plane/providers/registry.ts';
import type { ConfiguredWebSearchProvider } from '../../src/data-plane/tools/web-search/types.ts';
import { pipeline, runPipeline, terminal } from '@floway-dev/pipeline';
import type { AnyStage, ManagedStream, Pipeline, RequestStage, RunTraceSink, Stage, StageEnv } from '@floway-dev/pipeline';
import type { AliasRules, ModelEndpoints, ModelKind, ProtocolFrame } from '@floway-dev/protocols/common';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import { directFetcher, toProviderModelFacts } from '@floway-dev/provider';
import type {
  Fetcher,
  FlagId,
  ProviderModel,
  ProviderPipelineServices,
  ProviderPipelineStreamOutcome,
  ProviderPipelines,
  RouteCandidate,
  UpstreamProviderKind,
} from '@floway-dev/provider';
import { stubProvider, stubProviderModel } from '@floway-dev/test-utils';

export interface StubRouteCandidateOptions {
  readonly upstreamId?: string;
  readonly upstreamName?: string;
  readonly kind?: UpstreamProviderKind;
  readonly modelId?: string;
  readonly upstreamModelId?: string;
  readonly endpoints?: ModelEndpoints;
  readonly limits?: ProviderModel['limits'];
  readonly enabledFlags?: Iterable<FlagId>;
  readonly rules?: AliasRules;
  readonly pricing?: ProviderModel['pricing'];
  readonly opaqueBlobCompatibilityScope?: ProviderModel['opaqueBlobCompatibilityScope'];
  readonly chat?: ProviderModel['chat'];
  readonly modelKind?: ModelKind;
}

export const stubRouteCandidate = (options: StubRouteCandidateOptions = {}): RouteCandidate => {
  const modelId = options.modelId ?? 'test-model';
  const upstreamModelId = options.upstreamModelId ?? modelId;
  const baseModel = stubProviderModel({
    id: modelId,
    upstreamModelId,
    ...(options.modelKind === undefined ? {} : { kind: options.modelKind }),
    ...(options.endpoints === undefined ? {} : { endpoints: options.endpoints }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.enabledFlags === undefined ? {} : { enabledFlags: new Set(options.enabledFlags) }),
    ...(options.pricing === undefined ? {} : { pricing: options.pricing }),
    ...(options.opaqueBlobCompatibilityScope === undefined
      ? {}
      : { opaqueBlobCompatibilityScope: options.opaqueBlobCompatibilityScope }),
    ...(options.chat === undefined ? {} : { chat: options.chat }),
  });
  const providerModel = Object.freeze(toProviderModelFacts(baseModel));
  return Object.freeze({
    upstreamId: options.upstreamId ?? 'up_test',
    upstreamName: options.upstreamName ?? options.upstreamId ?? 'up_test',
    kind: options.kind ?? 'custom',
    modelId,
    upstreamModelId,
    endpoints: Object.freeze({ ...providerModel.endpoints }),
    limits: Object.freeze({ ...providerModel.limits }),
    providerModel,
    ...(options.rules === undefined ? {} : { rules: options.rules }),
  });
};

export interface MockChatDirectoryEntry {
  readonly candidate: RouteCandidate;
  readonly pipelines?: ProviderPipelines;
  readonly inboundHeaderAllowlist?: readonly string[];
  readonly fetcher?: Fetcher;
}

export interface MockChatPipelineServicesOptions {
  readonly ctx?: ChatGatewayCtx;
  readonly ctxOverrides?: Partial<ChatGatewayCtx>;
  readonly entries?: readonly MockChatDirectoryEntry[];
  readonly enumerate?: (
    model: string,
    kind: ModelKind,
  ) => Promise<{
    readonly candidates: readonly RouteCandidate[];
    readonly sawModel: boolean;
    readonly failedUpstreams: readonly string[];
  }>;
  readonly sawModel?: boolean;
  readonly failedUpstreams?: readonly string[];
  readonly webSearchProvider?: () => Promise<ConfiguredWebSearchProvider>;
}

export const mockChatPipelineServices = (
  options: MockChatPipelineServicesOptions = {},
): {
  readonly ctx: ChatGatewayCtx;
  readonly services: ChatPipelineServices;
} => {
  const ctx = options.ctx ?? mockChatGatewayCtx(options.ctxOverrides);
  const byUpstream = new Map<string, MockChatDirectoryEntry>();
  for (const entry of options.entries ?? []) byUpstream.set(entry.candidate.upstreamId, entry);

  const providers = new Map<string, GatewayProvider>();
  const providerFor = (upstreamId: string): GatewayProvider => {
    const existing = providers.get(upstreamId);
    if (existing !== undefined) return existing;
    const entry = byUpstream.get(upstreamId);
    const created: GatewayProvider = {
      upstreamId,
      kind: entry?.candidate.kind ?? 'custom',
      name: entry?.candidate.upstreamName ?? upstreamId,
      inboundHeaderAllowlist: entry?.inboundHeaderAllowlist ?? [],
      disabledPublicModelIds: [],
      modelPrefix: null,
      modelsCache: null,
      instance: stubProvider(),
      pipelines: entry?.pipelines ?? {},
      configVersion: 1,
      modelsRefreshInputHash: 'test',
    };
    providers.set(upstreamId, created);
    return created;
  };

  const directory = {
    ensureLoaded: async () => undefined,
    providerFor,
    fetcherFor: (upstreamId: string): Fetcher => byUpstream.get(upstreamId)?.fetcher ?? directFetcher,
    enumerateCandidates: async (model: string, kind: ModelKind) => {
      if (options.enumerate !== undefined) return await options.enumerate(model, kind);
      const candidates = (options.entries ?? [])
        .map(entry => entry.candidate)
        .filter(candidate => candidate.providerModel.kind === kind);
      return {
        candidates: Object.freeze(candidates),
        sawModel: options.sawModel ?? candidates.length > 0,
        failedUpstreams: Object.freeze([...(options.failedUpstreams ?? [])]),
      };
    },
  } as unknown as GatewayRequestDirectory;

  const base = createChatPipelineServices(ctx, { directory });
  if (options.entries?.[0] !== undefined) base.affinity.select(options.entries[0].candidate);
  const services: ChatPipelineServices = options.webSearchProvider === undefined
    ? base
    : Object.freeze({ ...base, webSearchProvider: options.webSearchProvider });
  return { ctx, services };
};

export const createManagedProtocolFrames = <TEvent>(
  env: StageEnv<any>,
  events: readonly TEvent[],
  options: { readonly emitDone?: boolean; readonly label?: string } = {},
): ManagedStream<ProtocolFrame<TEvent>> => env.createStream<ProtocolFrame<TEvent>>({
  label: options.label ?? 'protocol.events',
  async *iterate() {
    for (const event of events) yield eventFrame(event);
    if (options.emitDone !== false) yield doneFrame();
  },
});

export const stubStreamProviderPipeline = <In extends object, TEvent>(
  name: string,
  handler: (
    facts: Readonly<In>,
    env: StageEnv<ProviderPipelineServices>,
  ) => Promise<ProviderPipelineStreamOutcome<TEvent>> | ProviderPipelineStreamOutcome<TEvent>,
): Pipeline<In, ProviderPipelineStreamOutcome<TEvent>, ProviderPipelineServices> =>
  pipeline<In>(name).end(terminal<In, ProviderPipelineStreamOutcome<TEvent>, ProviderPipelineServices>({
    name: `${name}.end`,
    execute: async (facts, env) => await handler(facts, env),
  }));

export function runChatStage<
  Needs extends object,
  Provided extends object,
  Out,
  Consumed extends keyof Needs & string = never,
>(options: {
  readonly stage: RequestStage<Needs, Provided, Consumed, ChatPipelineServices>;
  readonly facts: Needs;
  readonly next: (
    facts: Readonly<Omit<Needs, Consumed | keyof Provided> & Provided>,
    env: StageEnv<ChatPipelineServices>,
  ) => Promise<Out> | Out;
  readonly services?: ChatPipelineServices;
  readonly signal?: AbortSignal;
  readonly traceSink?: RunTraceSink;
}): Promise<{ readonly outcome: Out; readonly services: ChatPipelineServices }>;
export function runChatStage<
  Needs extends object,
  Provided extends object,
  InnerOut,
  Out = InnerOut,
  Consumed extends keyof Needs & string = never,
>(options: {
  readonly stage: Stage<Needs, Provided, InnerOut, Out, Consumed, ChatPipelineServices>;
  readonly facts: Needs;
  readonly next: (
    facts: Readonly<Omit<Needs, Consumed | keyof Provided> & Provided>,
    env: StageEnv<ChatPipelineServices>,
  ) => Promise<InnerOut> | InnerOut;
  readonly services?: ChatPipelineServices;
  readonly signal?: AbortSignal;
  readonly traceSink?: RunTraceSink;
}): Promise<{ readonly outcome: Out; readonly services: ChatPipelineServices }>;
export async function runChatStage<
  Needs extends object,
  Provided extends object,
  InnerOut,
  Out = InnerOut,
  Consumed extends keyof Needs & string = never,
>(options: {
  readonly stage:
    | Stage<Needs, Provided, InnerOut, Out, Consumed, ChatPipelineServices>
    | RequestStage<Needs, Provided, Consumed, ChatPipelineServices>;
  readonly facts: Needs;
  readonly next: (
    facts: Readonly<Omit<Needs, Consumed | keyof Provided> & Provided>,
    env: StageEnv<ChatPipelineServices>,
  ) => Promise<InnerOut> | InnerOut;
  readonly services?: ChatPipelineServices;
  readonly signal?: AbortSignal;
  readonly traceSink?: RunTraceSink;
}): Promise<{ readonly outcome: Out; readonly services: ChatPipelineServices }> {
  const services = options.services ?? mockChatPipelineServices().services;
  const pipe: Pipeline<Needs, Out, ChatPipelineServices> = Object.freeze({
    name: `test.${options.stage.name}`,
    stages: Object.freeze([options.stage as AnyStage]),
    ending: terminal<Omit<Needs, Consumed | keyof Provided> & Provided, InnerOut, ChatPipelineServices>({
      name: `test.${options.stage.name}.end`,
      execute: async (facts, env) => await options.next(facts, env),
    }) as unknown as Pipeline<Needs, Out, ChatPipelineServices>['ending'],
  });
  const outcome = await runPipeline(pipe, options.facts, {
    services,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.traceSink === undefined ? {} : { traceSink: options.traceSink }),
  });
  return { outcome, services };
};
