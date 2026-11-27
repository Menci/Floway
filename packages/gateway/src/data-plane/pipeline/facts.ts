import type { UsageObservation } from './compute-usage.ts';
import type { GatewayServices } from './services.ts';
import { factSpace, type Deferred } from '@floway-dev/pipeline';
import type { AliasRules } from '@floway-dev/protocols/common';
import type { UpstreamModelSnapshot, UpstreamOperation, UpstreamRequestFacts, UpstreamResponseFacts, UpstreamSnapshot } from '@floway-dev/upstream';

export interface Candidate {
  readonly upstream: UpstreamSnapshot;
  readonly model: UpstreamModelSnapshot;
  readonly rules?: AliasRules;
}

export type AttemptTarget<Op extends UpstreamOperation> = Candidate & { readonly payload: UpstreamRequestFacts[Op] };

export interface SelectedCandidate {
  readonly upstreamId: string;
  readonly model: string;
}

export type GatewayRequestFacts = UpstreamRequestFacts & {
  'serve.startedAt': number;
  requestedModel: string;
  candidates: readonly Candidate[];
  aliasRules: AliasRules;
};

export type GatewayResponseFacts = UpstreamResponseFacts & {
  usage: Deferred<UsageObservation>;
  candidate: SelectedCandidate;
};

export const { defineStage, compose } = factSpace<GatewayRequestFacts, GatewayResponseFacts, GatewayServices>();
