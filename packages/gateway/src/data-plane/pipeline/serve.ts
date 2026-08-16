// The seam. Every family's route handler does the same things around its pipeline — read
// the body, build what the run is given, run it, turn the exit facts into a response — so
// it is written once here and each family adds only its own keys.
//
// This is also where "entering the pipeline system requires no capability" is concrete: a
// handler calls `run` like any other caller. What makes a run *recorded* is the prologue
// resolving a dump sink, not a flag anywhere below it.

import { run } from '@floway-dev/pipeline';
import type { Event, Pipeline } from '@floway-dev/pipeline';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ModelCandidate } from '@floway-dev/provider';

import type { AttemptSelector, GatewayFacts } from './facts.ts';
import type { GatewayServices } from './services.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { consoleLogSink } from '../../runtime/log.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse, type GatewayCtx } from '../shared/gateway-ctx.ts';
import { readRequestBody, takeRequestBody } from '../shared/request-body.ts';

type Slice<K extends keyof GatewayFacts> = { [P in K]: GatewayFacts[P] };

export interface Prologue {
  readonly services: GatewayServices;
  readonly gateway: GatewayCtx;
  /** What the client sent, read once. `takeRequestBody` empties the buffer it was given so
   *  the handler cannot retain the wire body past the dump's own copy, so what is kept here
   *  is the bytes themselves rather than the record they came from. */
  readonly bytes: Uint8Array;
  readonly streamError: string | null;
  readonly headers: readonly (readonly [string, string])[];
}

/**
 * Opens a run: the request context the telemetry stages read, the services the stages are
 * given, and the bytes the client sent.
 *
 * The candidate store is the resolver the ruling names — "the resolver is the service and
 * the selector is a fact". A `ModelCandidate` carries the provider's instance, its fetcher
 * and its models cache; those never enter the record, because `move()` would freeze them
 * and the provider's own cache refresh would break. So the stage that enumerates hands the
 * live ones here, and the stage that dials asks for one back by selector.
 */
export const openPrologue = async (
  c: Context,
  options: { readonly wantsStream: boolean; readonly model?: string },
): Promise<Prologue> => {
  const body = await readRequestBody(c);
  const bytes = body.bytes;
  const streamError = body.streamError;
  const gateway = createGatewayCtxFromHono(c, {
    wantsStream: options.wantsStream,
    ...(options.model === undefined ? {} : { model: options.model }),
    requestBody: takeRequestBody(body),
    backgroundScheduler: backgroundSchedulerFromContext(c),
  });

  const live = new Map<string, ModelCandidate>();

  return {
    gateway,
    bytes,
    streamError,
    headers: [...c.req.raw.headers],
    services: {
      gateway,
      log: consoleLogSink,
      background: work => { gateway.backgroundScheduler(work); },
      rememberCandidates: candidates => {
        for (const candidate of candidates) live.set(candidate.provider.upstreamId, candidate);
      },
      resolveAttempt: (selector: AttemptSelector) => {
        const candidate = live.get(selector.upstreamId);
        if (candidate === undefined) {
          throw new Error(`resolveAttempt: nothing live for ${selector.upstreamId}; the selector did not come from this run`);
        }
        return candidate;
      },
      // Absent when this key has no retention configured, which is what keeps recording
      // conditional: the runner does none of it rather than doing it and discarding.
      ...(gateway.dump === null ? {} : { dump: (_event: Event) => {} }),
    },
  };
};

/** What a family writes for the client. The status and the upstream's own headers are facts
 *  the pipeline already carries, so what is left here is the bytes and what they are. */
export interface Rendered {
  readonly body: BodyInit;
  /** Owned by whichever stage serialized the body, never by the upstream — a media type
   *  describing bytes the gateway wrote itself is the one thing an upstream cannot say. */
  readonly contentType: string;
}

/**
 * Runs a family's pipeline and turns what it answered with into a response.
 *
 * The drain is scheduled rather than awaited. A streaming family's answer *is* the stream,
 * so draining before returning would consume the frames the client is waiting for. Release
 * is not cancel — an aborted connection cannot be reused and leaves the upstream's own
 * billing unsettled — so it still happens, just after the answer is on its way.
 */
export const serveThrough = async <
  Entry extends object,
  Exit extends Slice<'response.http.status' | 'response.http.headers'>,
>(
  prologue: Prologue,
  pipeline: Pipeline<Entry, Exit>,
  entry: Entry,
  render: (facts: Exit) => Rendered,
): Promise<Response> => {
  const { facts, drain } = await run(pipeline, entry, prologue.services as never);
  prologue.services.background(drain());
  const answer = render(facts);

  const headers = new Headers(facts['response.http.headers'].map(([name, value]) => [name, value]));
  headers.set('content-type', answer.contentType);
  return finalizeGatewayResponse(
    prologue.gateway,
    new Response(answer.body, { status: facts['response.http.status'] as ContentfulStatusCode, headers }),
  );
};
