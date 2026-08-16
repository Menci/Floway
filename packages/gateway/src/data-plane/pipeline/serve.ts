// The seam. Every family's route handler does the same things around its pipeline — read
// the body, build what the run is given, run it, turn the exit facts into a response — so
// it is written once here and each family adds only its own keys.
//
// This is also where "entering the pipeline system requires no capability" is concrete: a
// handler calls `run` like any other caller. What makes a run *recorded* is the prologue
// resolving a dump sink, not a flag anywhere below it.

import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import type { AttemptSelector, BillableEntity, GatewayFacts } from './facts.ts';
import type { GatewayServices } from './services.ts';
import { settleBillable } from './settlement.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { consoleLogSink } from '../../runtime/log.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse, type GatewayCtx } from '../shared/gateway-ctx.ts';
import { readRequestBody, takeRequestBody, type RequestBody } from '../shared/request-body.ts';
import { writeSSEFrames } from '../shared/sse.ts';
import type { Event, Pipeline } from '@floway-dev/pipeline';
import { run } from '@floway-dev/pipeline';
import { sseCommentFrame, type SseFrame } from '@floway-dev/protocols/common';
import type { ModelCandidate } from '@floway-dev/provider';

type Slice<K extends keyof GatewayFacts> = { [P in K]: GatewayFacts[P] };

/** What the client sent, read once, before anything has decided what it means. */
export interface Ingress {
  readonly body: RequestBody;
  readonly headers: readonly (readonly [string, string])[];
}

/**
 * Reads the request.
 *
 * This is separate from opening the run because whether a request streams is written *in*
 * the request — `stream: true` in a JSON body, a form field in a multipart upload — and the
 * body can only be read once. A run opened before the read would have to guess, and guessing
 * `false` is not harmless: the abort controller a streaming run cancels its upstream with is
 * minted from that flag, so a client that disconnected would stop cancelling anything.
 */
export const readIngress = async (c: Context): Promise<Ingress> => ({
  body: await readRequestBody(c),
  headers: [...c.req.raw.headers],
});

export interface Prologue {
  readonly services: GatewayServices;
  readonly gateway: GatewayCtx;
  readonly headers: readonly (readonly [string, string])[];
}

/**
 * Opens a run: the request context the telemetry stages read, and the services the stages
 * are given. It takes the bytes the handler has already read and hands them to the dump,
 * which is what leaves the handler's own copy free to be released.
 *
 * The candidate store is the resolver the ruling names — "the resolver is the service and
 * the selector is a fact". A `ModelCandidate` carries the provider's instance, its fetcher
 * and its models cache; those never enter the record, because `move()` would freeze them
 * and the provider's own cache refresh would break. So the stage that enumerates hands the
 * live ones here, and the stage that dials asks for one back by selector.
 */
export const openPrologue = (
  c: Context,
  ingress: Ingress,
  options: { readonly wantsStream: boolean; readonly model?: string },
): Prologue => {
  const gateway = createGatewayCtxFromHono(c, {
    wantsStream: options.wantsStream,
    ...(options.model === undefined ? {} : { model: options.model }),
    requestBody: takeRequestBody(ingress.body),
    backgroundScheduler: backgroundSchedulerFromContext(c),
  });

  const live = new Map<string, ModelCandidate>();

  return {
    gateway,
    headers: ingress.headers,
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
 *  the pipeline already carries, so what is left here is the answer itself. */
export type Rendered =
  | {
    readonly body: BodyInit;
    /** Owned by whichever stage serialized the body, never by the upstream — a media type
     *  describing bytes the gateway wrote itself is the one thing an upstream cannot say. */
    readonly contentType: string;
  }
  | {
    /** An answer that *is* a stream. The frames go out as they arrive, which is why nothing
     *  above waits for them and why what they billed is settled afterwards. */
    readonly frames: AsyncIterable<SseFrame>;
  };

/** Which of the two an answer turned out to be. A family's rendered fact carries whichever
 *  shape its run produced, and only the family knows the key it is under. */
export const isFrames = (rendered: unknown): rendered is AsyncIterable<SseFrame> =>
  typeof rendered === 'object' && rendered !== null && Symbol.asyncIterator in rendered;

/** What a streaming family will have been billed once its frames run out. A stream's usage
 *  arrives with its last chunk, which is after the run has answered — so the run hands up a
 *  promise and settlement of it belongs here, after the answer is on its way. */
export type DeferredUsage<Exit> = (facts: Exit) => Promise<readonly BillableEntity[]> | null;

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
  c: Context,
  prologue: Prologue,
  pipeline: Pipeline<Entry, Exit>,
  entry: Entry,
  render: (facts: Exit) => Rendered,
  deferredUsage?: DeferredUsage<Exit>,
): Promise<Response> => {
  const { facts, drain } = await run(pipeline, entry, prologue.services as never);
  const answer = render(facts);

  const pending = deferredUsage?.(facts) ?? null;
  if (pending !== null) {
    prologue.services.background(pending.then(billable => {
      settleBillable({ ...prologue.services, log: consoleLogSink }, billable, false);
    }));
  }

  const status = facts['response.http.status'] as ContentfulStatusCode;
  if ('frames' in answer) {
    // Hono's streamSSE builds the response itself, so what the client is to see has to be
    // staged on the context before it is called rather than passed to a constructor.
    for (const [name, value] of facts['response.http.headers']) c.header(name, value);
    c.status(status);
    return streamSSE(c, async stream => {
      try {
        await writeSSEFrames(stream, answer.frames, {
          keepAlive: { frame: sseCommentFrame('keepalive') },
          ...(prologue.gateway.downstreamAbortController === undefined
            ? {}
            : { downstreamAbortController: prologue.gateway.downstreamAbortController }),
        });
      } finally {
        // Reading the frames to the client *is* releasing the body they came from, so the
        // drain waits for that to finish. Draining alongside it would take frames out of the
        // client's own stream — one connection has one reader. A client that stopped reading
        // still gets here, which is what leaves nothing open behind it.
        await drain();
      }
    });
  }

  // Nothing is left to read: what the client is sent was serialized from facts the run
  // already held, so releasing can start at once.
  prologue.services.background(drain());
  const headers = new Headers(facts['response.http.headers'].map(([name, value]) => [name, value]));
  headers.set('content-type', answer.contentType);
  return finalizeGatewayResponse(prologue.gateway, new Response(answer.body, { status, headers }));
};
