// What a run is given beside its facts. Services are wiring: they are fixed for the run at
// the prologue and never change on a handoff, because what a stage hands to `next` is the
// next segment's facts — if it also supplied capabilities, the same pipeline value would
// run with different capabilities depending on who called it.
//
// Everything in facts is dumpable, and that is the test: a live handle dumps as nothing,
// so a live handle is never a fact.

import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import type { Event, Logger } from '@floway-dev/pipeline';

export interface GatewayServices {
  /** The global sink. Every stage's lines reach it, tagged with the stage's name. */
  readonly log?: Logger;
  /** Present only when this request is being dumped, which is what keeps recording
   *  conditional: with no sink resolved here, the runner does none of it. */
  readonly dump?: (event: Event) => void;

  /** The request-scoped context the settlement and telemetry stages read. It is a service
   *  and not a fact because it holds live handles — the scheduler, the abort signal. */
  readonly gateway: GatewayCtx;
  /** Binds a promise to the request's lifetime: `waitUntil` on Workers, the event loop on
   *  Node. What the drain is handed to, so an answer is not held up by it. */
  readonly background: (work: Promise<unknown>) => void;
}
