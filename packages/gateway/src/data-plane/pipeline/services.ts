// What a run is given beside its facts. Services are wiring: they are fixed for the run at
// the prologue and never change on a handoff, because what a stage hands to `next` is the
// next segment's facts — if it also supplied capabilities, the same pipeline value would
// run with different capabilities depending on who called it.
//
// Facts carry content and explicitly tagged run resources. Service handles bind application
// behavior and stay outside those values.

import type { AttemptSelector } from './facts.ts';
import type { RunDump } from '../../dump/run-sink.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import type { HttpServices } from '@floway-dev/http/pipeline';
import type { Event, Logger } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ModelCandidate } from '@floway-dev/provider';

export type RunGatewayCtx = GatewayCtx & { readonly dump: RunDump | null };

export interface GatewayServices extends HttpServices {
  readonly recordProtocolFrames: <T extends ProtocolFrame<unknown>>(frames: AsyncIterable<T>) => AsyncIterable<T>;
  /** The global sink. Every stage's lines reach it, tagged with the stage's name. */
  readonly log?: Logger;
  /** Present only when this request is being dumped, which is what keeps recording
   *  conditional: with no sink resolved here, the runner does none of it. */
  readonly dump?: (event: Event) => void | Promise<void>;

  /** The request-scoped context the settlement and telemetry stages read. It is a service
   *  and not a fact because it holds live handles — the scheduler, the abort signal. */
  readonly gateway: RunGatewayCtx;
  /** Turns a selector back into the thing that dials. The resolver is the service and the
   *  selector is the fact: a per-upstream transport is not a fact and is not pinned at the
   *  prologue either, so what is injected is the thing that resolves one and what travels
   *  is the identifier it resolves from. */
  readonly resolveAttempt: (selector: AttemptSelector) => ModelCandidate;
  /** The other half of the resolver: the stage that enumerates hands the live candidates
   *  here, so the ones that travel can be selectors. Per run, because a candidate list is. */
  readonly rememberCandidates: (candidates: readonly ModelCandidate[]) => readonly AttemptSelector[];
  /** Binds a promise to the request's lifetime: `waitUntil` on Workers, the event loop on
   *  Node. What the drain is handed to, so an answer is not held up by it. */
  readonly background: (work: Promise<unknown>) => void;
}
