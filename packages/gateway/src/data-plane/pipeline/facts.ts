// The keys every family's pipeline shares. A family extends this space with its own
// protocol keys by intersection and never merges into it, so a stage written here drops
// into any family's pipeline and a family's own keys are unreachable from a stage that
// was not written against them.
//
// Keys are namespaced, camelCase and family-first. `ingress.*` is what the client sent and
// stays put across a protocol switch; `serve.*` belongs to the served request as a whole
// and outlives an attempt; `request.*` and `response.*` are the two directions, mirrored
// key for key and semantically disjoint.

import type { UsageQuantities } from '../../repo/types.ts';
import type { Secret } from '@floway-dev/pipeline';
import type { PricingRuntimeFacts } from '@floway-dev/protocols/common';
import type { ModelCandidate, TelemetryModelIdentity } from '@floway-dev/provider';

/** What an upstream call is answerable for. Keyed by billed entity, because one call can
 *  bill in units that are not commensurable, and an entity with no quantities at all is
 *  how "the upstream was called and reported nothing" is said. */
export interface BillableEntity {
  readonly identity: TelemetryModelIdentity;
  readonly quantities: UsageQuantities;
  /** What pricing needs beyond the quantities, when a rate depends on more than how much
   *  there was. Absent is a real reading and not a missing one: most families price on the
   *  quantities alone. Observed where the reading is, because settlement is the last reader
   *  and not a second observer. */
  readonly pricingFacts?: PricingRuntimeFacts;
}

/** A failure is a value, never a throw, so an earlier stage can fail over a later stage's
 *  fault — even a 400, because the path and the flags may differ on the next candidate. */
export interface Failure {
  readonly status: number;
  readonly message: string;
  /** The upstream's own body, when there was one. A client is not owed the upstream's
   *  exact bytes, but a dump reader is owed what actually came back. */
  readonly body?: unknown;
}

export const isFailure = (value: unknown): value is Failure =>
  typeof value === 'object' && value !== null && 'status' in value && 'message' in value;

export interface GatewayFacts {
  /** What the client sent, before anything read it. Recorded on every request, so the
   *  dump can always show it. */
  'ingress.http.method': string;
  'ingress.http.path': string;
  'ingress.http.headers': readonly (readonly [string, string])[];
  'ingress.http.body': Uint8Array;

  /** The public model id the client asked for, and the candidates it resolves to. Nothing
   *  consumes these: they outlive an attempt. */
  'serve.model': string;
  'serve.candidates': readonly ModelCandidate[];

  /** Which upstream this attempt targets. Provided per attempt by the stage that forks. */
  'route.candidate': ModelCandidate;

  /** There is exactly one url and one headers. Headers are rewritten the whole way down,
   *  so the dump shows a header's entire history in one place, and a value may be secret. */
  'request.http.url': string;
  'request.http.headers': readonly (readonly [string, string | Secret<string>])[];

  'response.http.status': number;
  'response.http.headers': readonly (readonly [string, string])[];
  /** The upstream's body, still open. Whoever declares it consumed owns draining it. */
  'response.http.body': ReadableStream<Uint8Array> & AsyncDisposable;

  /** The authoritative reading, provided closest to the upstream on the dialect it
   *  actually spoke. Every step that changes usage re-provides it. */
  'response.usage.billable': readonly BillableEntity[];
}
