import type { UsageObservation } from './compute-usage.ts';
import type { GatewayServices } from './services.ts';
import { factSpace, type Deferred, type Facts, type ManagedStream } from '@floway-dev/pipeline';
import type { AliasTarget } from '@floway-dev/protocols/common';
import type { GatewayFacts, ProviderModelFact, ProviderOperation, ProviderUpstream } from '@floway-dev/provider';

type EventOf<Outcome> = Outcome extends { stream: ManagedStream<infer Event, unknown> } ? Event : never;
type ResultOf<Outcome> = Outcome extends { result: infer Output } ? Output : never;

export type OperationEvent<Op extends ProviderOperation> = EventOf<GatewayFacts[`response.${Op}`]>;
export type OperationResult<Op extends ProviderOperation> = ResultOf<GatewayFacts[`response.${Op}`]>;
export type ResponseOutcome = 'success' | 'upstream' | 'local';

export interface Candidate {
  upstream: ProviderUpstream;
  model: ProviderModelFact;
  rules?: AliasTarget['rules'];
}

export type AttemptTarget<Op extends ProviderOperation> = Candidate & { payload: GatewayFacts[`request.${Op}`] };

export type GatewayPipelineFacts = GatewayFacts & {
  'request.auth.apiKeyId': string;
  'request.auth.userId': number;
  'request.auth.isAdmin': boolean;
  'request.auth.upstreamIds': readonly string[] | null;
  'request.auth.randomizeUpstreams': boolean;
  'serve.startedAt': number;
  'serve.runtimeLocation': string;
  'request.model': string;
  'request.candidates': readonly Candidate[];
  'request.aliasRules': AliasTarget['rules'];
  'response.candidate': { upstreamId: string; model: string };
  'response.outcome': Deferred<ResponseOutcome>;
  'response.performance': Deferred<{ ttftMs: number | null }>;
  'response.requestedModel': string;
  'response.usage': Deferred<UsageObservation>;
};

export const { compose, composeGroup, defineStage } = factSpace<GatewayPipelineFacts, GatewayServices>();

// Fact keys assembled from an operation name are checked by compose against
// the same statically selected provider handles.
export const { defineStage: defineOperationStage } = factSpace<Facts, GatewayServices>();
