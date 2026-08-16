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
import type { Secret, Owned } from '@floway-dev/pipeline';
import type { PricingRuntimeFacts } from '@floway-dev/protocols/common';
import type { TelemetryModelIdentity } from '@floway-dev/provider';

/** Everything about an attempt that is data: which upstream, which model row on it, and the
 *  flags that row carries. Enough to choose, to record and to price — and to look the live
 *  candidate back up when the time comes to dial. */
export interface AttemptSelector {
  readonly upstreamId: string;
  readonly modelId: string;
  /** Snapshotted rather than referenced, because the record must show what was true when
   *  the attempt was made rather than what the row says now. */
  readonly flags: readonly string[];
}

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
  /** What the gateway itself would write, when the refusal is its own. A protocol's envelope
   *  carries more than a status and a sentence — which field was at fault, which code names
   *  the condition — and only whoever refused knows those, so it is written where the refusal
   *  is made rather than derived from the status where it is rendered. */
  readonly envelope?: Record<string, unknown>;
}

export const isFailure = (value: unknown): value is Failure =>
  typeof value === 'object' && value !== null && 'status' in value && 'message' in value;

export interface GatewayFacts {
  /** What the client sent, before anything read it. Every family hands these over, because
   *  every ending forwards what a provider is allowed to forward of them. */
  'ingress.http.headers': readonly (readonly [string, string])[];

  /** The public model id the client asked for, and the candidates it resolves to. Nothing
   *  consumes these: they outlive an attempt. */
  'serve.model': string;
  'serve.candidates': readonly AttemptSelector[];

  /** Which upstream this attempt targets. Provided per attempt by the stage that forks.
   *
   *  A **selector**, not the candidate itself. A `ModelCandidate` carries the provider's
   *  live instance, its fetcher and its models cache, and a live handle is never a fact —
   *  the test being whether it can be rendered into the dump. Putting one in the record
   *  deep-freezes all three, and the writes the provider relies on then fail *silently*,
   *  because a frozen write only throws in strict mode and the provider's own code is not
   *  the caller. The SWR models cache would stop refreshing with nothing to see.
   *
   *  So the resolver is a service and the selector is the fact, which is the ruling as
   *  written. What travels is what identifies the attempt; what dials is injected. */
  'route.attempt': AttemptSelector;

  /** There is exactly one url and one headers. Headers are rewritten the whole way down,
   *  so the dump shows a header's entire history in one place, and a value may be secret. */
  'request.http.url': string;
  'request.http.headers': readonly (readonly [string, string | Secret<string>])[];

  'response.http.status': number;
  'response.http.headers': readonly (readonly [string, string])[];
  /** The upstream's body, still open, and marked as something the run answers for. `Owned`
   *  rather than `AsyncDisposable`: the language puts `Symbol.asyncDispose` on every async
   *  generator and on no `ReadableStream`, so a structural type would admit an iterator that
   *  is not a resource and reject the body that is. */
  'response.http.body': ReadableStream<Uint8Array> & Owned;

  /** The authoritative reading, provided closest to the upstream on the dialect it
   *  actually spoke. Every step that changes usage re-provides it. */
  'response.usage.billable': readonly BillableEntity[];
}
