// Shared gateway content facts. Live providers, fetchers and model caches remain in services.

import type { UsageQuantities } from '../../repo/types.ts';
import type { Secret, Owned } from '@floway-dev/pipeline';
import type { PricingRuntimeFacts } from '@floway-dev/protocols/common';
import type { TelemetryModelIdentity } from '@floway-dev/provider';

/** Everything about an attempt that is data: which upstream, which model row on it, and the
 *  flags that row carries. Enough to choose, to record and to price — and to look the live
 *  candidate back up when the time comes to dial. */
export interface AttemptSelector {
  readonly candidateId: number;
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
  /** Complete parsed upstream error content when available. */
  readonly body?: unknown;
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

  /** A selector resolves a live candidate without freezing the provider's mutable catalog. */
  'route.attempt': AttemptSelector;

  /** Admitted headers remain values until the provider shapes its authenticated HTTP request. */
  'request.http.headers': readonly (readonly [string, string | Secret<string>])[];

  'response.http.status': number;
  /** Serialized client JSON, or null for a protocol stream or an upstream document. */
  'response.http.jsonBody': Uint8Array<ArrayBuffer> | null;
  'response.http.headers': readonly (readonly [string, string])[];
  /** The upstream's body, still open, and marked as something the run answers for. `Owned`
   *  rather than `AsyncDisposable`, because a structural type would say what the host happens
   *  to mark rather than what this run answers for — and what a host marks differs between the
   *  Node versions this ships on. Ownership is claimed, so the type says so too. */
  'response.http.body': (ReadableStream<Uint8Array> & Owned) | null;

  /** The authoritative reading, provided closest to the upstream on the dialect it
   *  actually spoke. Every step that changes usage re-provides it. */
  'response.usage.billable': readonly BillableEntity[];

  /** Completed calls carried into a nested attempt so an exceptional exit can settle them. */
  'serve.usage.prior': readonly BillableEntity[];
}
