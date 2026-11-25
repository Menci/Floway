import type { ComputedUsage } from './compute-usage.ts';
import type { User } from '../../repo/types.ts';
import type { ChatDelivery } from '../chat/pipeline/delivery.ts';
import { factSpace, type Deferred } from '@floway-dev/pipeline';
import type { DecisionProtocol, RerankSourceProtocol, AliasRules } from '@floway-dev/protocols/common';
import type { GatewayFacts, ProviderModelFact, ProviderUpstream } from '@floway-dev/provider';

export type ClientDelivery =
  | ChatDelivery
  | { readonly kind: 'json' }
  | { readonly kind: 'sse' }
  | { readonly kind: 'bytes' }
  | { readonly kind: 'rerank'; readonly protocol: RerankSourceProtocol }
  | { readonly kind: 'decision'; readonly protocol: DecisionProtocol };

export interface ServeCandidate {
  readonly upstream: ProviderUpstream;
  readonly model: ProviderModelFact;
  readonly rules?: AliasRules;
}

export interface ServeCandidates {
  readonly candidates: readonly ServeCandidate[];
  readonly sawModel: boolean;
  readonly failedUpstreams: readonly string[];
}

export type PipelineSubject = Pick<User, 'id' | 'isAdmin'>;

export interface PipelineAuthFacts {
  readonly 'request.auth.apiKeyId': string;
  readonly 'request.auth.user': PipelineSubject;
  readonly 'request.auth.upstreamIds': readonly string[] | null;
  readonly 'request.auth.randomizeUpstreams': boolean;
}

export type GatewayPipelineFacts = GatewayFacts & PipelineAuthFacts & {
  readonly 'request.delivery': ClientDelivery;
  readonly 'serve.model': string;
  readonly 'serve.candidates': ServeCandidates;
  readonly 'serve.candidate': ServeCandidate;
  readonly 'response.usage': Deferred<ComputedUsage>;
};

export type ProtocolResponseKey = Exclude<Extract<keyof GatewayFacts, `response.${string}`>, 'response.http' | 'response.modelKey'>;

export const httpEntry = [
  'request.http',
  'request.auth.apiKeyId',
  'request.auth.user',
  'request.auth.upstreamIds',
  'request.auth.randomizeUpstreams',
] as const;

export type GatewayHttpInput = Pick<GatewayPipelineFacts, typeof httpEntry[number]>;
export type GatewayHttpOutput = Pick<GatewayPipelineFacts, 'response.http'>;

export const gatewayFactSpace = <Services>() => factSpace<GatewayPipelineFacts, Services>();
