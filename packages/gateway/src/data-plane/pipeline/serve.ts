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
import { openRunDump, type RunDump } from '../../dump/run-sink.ts';
import { apiKeyFromContext, type AuthedContext } from '../../middleware/auth.ts';
import { internalErrorResponse } from '../../middleware/internal-error-response.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { consoleLogSink } from '../../runtime/log.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse, type CreateGatewayCtxOptions, type GatewayCtx } from '../shared/gateway-ctx.ts';
import { readRequestBody, takeRequestBody, type RequestBody } from '../shared/request-body.ts';
import { writeSSEFrames } from '../shared/sse.ts';
import { run, type Deferred, type Pipeline } from '@floway-dev/pipeline';
import { sseCommentFrame, type SseFrame, type SseWritableFrame } from '@floway-dev/protocols/common';
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
  c: AuthedContext,
  ingress: Ingress,
  options: { readonly wantsStream: boolean; readonly model?: string },
): Prologue => {
  const options_ = gatewayCtxOptions(c, ingress, options);
  return prologueFor(createGatewayCtxFromHono(c, options_), ingress, runDumpOf(options_));
};

/** What a run's request context is built from. Exported because a family whose context is a
 *  richer one builds that instead, and both have to be built from the same read of the body:
 *  `takeRequestBody` empties what it is given, so calling this twice would hand the dump an
 *  empty buffer the second time. */
export const gatewayCtxOptions = (
  c: AuthedContext,
  ingress: Ingress,
  options: { readonly wantsStream: boolean; readonly model?: string },
): CreateGatewayCtxOptions => {
  const backgroundScheduler = backgroundSchedulerFromContext(c);
  // The shape follows the endpoint. A pipelined turn is recorded as its whole run — every
  // stage, both directions — so it opens that recording here instead of the edge one, and
  // no turn is ever written twice.
  const dump = openRunDump(
    apiKeyFromContext(c),
    { method: c.req.method, path: new URL(c.req.raw.url).pathname, body: ingress.body },
    backgroundScheduler,
  );
  return {
    wantsStream: options.wantsStream,
    ...(options.model === undefined ? {} : { model: options.model }),
    requestBody: takeRequestBody(ingress.body),
    backgroundScheduler,
    dump,
  };
};

/** The run recording those options opened, for the caller that has to hand its sink to
 *  `run`. A context carries the recording; only the prologue needs the sink. */
export const runDumpOf = (options: CreateGatewayCtxOptions): RunDump | null =>
  (options.dump ?? null) as RunDump | null;

/** The services every run is given, over whichever context it was opened with. */
export const prologueFor = (gateway: GatewayCtx, ingress: Ingress, runDump: RunDump | null = null): Prologue => {
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
      // Absent when this key has no retention configured, which is what keeps recording
      // conditional: the runner does none of it rather than doing it and discarding.
      ...(runDump === null ? {} : { dump: runDump.sink }),
      resolveAttempt: (selector: AttemptSelector) => {
        const candidate = live.get(selector.upstreamId);
        if (candidate === undefined) {
          throw new Error(`resolveAttempt: nothing live for ${selector.upstreamId}; the selector did not come from this run`);
        }
        return candidate;
      },
    },
  };
};

/** What a family writes for the client. The status and the upstream's own headers are facts
 *  the pipeline already carries, so what is left here is the answer itself. */
export type Rendered =
  | {
    readonly body: BodyInit;
    /** Owned by whichever stage serialized the body, never by the upstream — a media type
     *  describing bytes the gateway wrote itself is the one thing an upstream cannot say.
     *  `null` where a family carries an upstream's own body and the upstream declared none:
     *  inventing one would describe bytes nobody described. */
    readonly contentType: string | null;
  }
  | {
    /** An answer that *is* a stream. The frames go out as they arrive, which is why nothing
     *  above waits for them and why what they billed is settled afterwards. */
    readonly frames: AsyncIterable<SseFrame>;
    /** What is written on an idle connection to keep it open. A comment is invisible to any
     *  client, but a protocol that defines its own idle event is read by clients that expect
     *  one — Anthropic's `ping` is a frame Claude Code sees — so the family names it. */
    readonly keepAlive?: SseWritableFrame;
  };

/** Which of the two an answer turned out to be. A family's rendered fact carries whichever
 *  shape its run produced, and only the family knows the key it is under. */
export const isFrames = (rendered: unknown): rendered is AsyncIterable<SseFrame> =>
  typeof rendered === 'object' && rendered !== null && Symbol.asyncIterator in rendered;

/** How a streaming turn ended, once its frames ran out. Both halves arrive together because
 *  both are known at the same moment — the last chunk states the usage, and running out
 *  without a terminal event is what "it did not finish" means. */
export interface StreamOutcome {
  readonly billable: readonly BillableEntity[];
  readonly failed: boolean;
}

/** What a streaming family will have been billed, and whether it got there. A stream's usage
 *  arrives with its last chunk, which is after the run has answered — so the run hands up a
 *  reading it has started and not finished, and settlement of it belongs here, after the answer
 *  is on its way. It is `Deferred` because that is what it is: the runner sees it in the record
 *  and waits for it at teardown, so a family that hands up a reading that never settles is
 *  reported rather than silently never billed. */
export type DeferredUsage<Exit> = (facts: Exit) => Deferred<StreamOutcome> | null;

/**
 * Runs a family's pipeline and turns what it answered with into a response.
 *
 * The drain is scheduled rather than awaited. A streaming family's answer *is* the stream,
 * so draining before returning would consume the frames the client is waiting for. Release
 * is not cancel — an aborted connection cannot be reused and leaves the upstream's own
 * billing unsettled — so it still happens, just after the answer is on its way.
 *
 * A run that threw is answered here rather than by the app's own handler, because the record
 * is closed here. Letting the throw out would lose the whole record: nothing above this knows
 * a dump is open, so the turn that most needs explaining would be the one that left nothing
 * behind. What goes to the client is the same envelope the app's handler writes, from the same
 * function — the stack included, which is what a gateway owes an operator for its own fault.
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
  try {
    return await serveRun(c, prologue, pipeline, entry, render, deferredUsage);
  } catch (error) {
    // `run` drains what it opened before it rethrows, so there is nothing left outstanding to
    // release here — only the record to close, and the reason to put on it.
    prologue.gateway.dump?.failed(error);
    return finalizeGatewayResponse(prologue.gateway, internalErrorResponse(asError(error), c));
  }
};

/** Anything can be thrown; only an `Error` carries a stack. A throw that was not one is
 *  reported as what it was rather than being dressed up as something with a call site. */
const asError = (thrown: unknown): Error =>
  thrown instanceof Error ? thrown : new Error(String(thrown));

const serveRun = async <
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
  // Registered while the request is still live, so the platform binds the write to it — and
  // resolved only when the stream ends, which is the one moment both what it billed and
  // whether it finished are known. A turn that stopped short is not recorded as one that
  // produced what it said it would.
  if (pending !== null) {
    prologue.services.background(pending.then(outcome => {
      settleBillable({ ...prologue.services, log: consoleLogSink }, outcome.billable, outcome.failed);
    }));
  }

  const status = facts['response.http.status'] as ContentfulStatusCode;
  if ('frames' in answer) {
    // Hono's streamSSE builds the response itself, so what the client is to see has to be
    // staged on the context before it is called rather than passed to a constructor.
    for (const [name, value] of facts['response.http.headers']) c.header(name, value);
    c.status(status);
    // The dump is closed the same way on both paths. Hono builds the streaming response
    // itself, so what is finalized is what it returned rather than one constructed here.
    return finalizeGatewayResponse(prologue.gateway, streamSSE(c, async stream => {
      try {
        await writeSSEFrames(stream, answer.frames, {
          keepAlive: { frame: answer.keepAlive ?? sseCommentFrame('keepalive') },
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
    }));
  }

  // Nothing is left to read either: what the client is sent was serialized from facts the run
  // already held, so releasing can start at once.
  prologue.services.background(drain());
  const headers = new Headers(facts['response.http.headers'].map(([name, value]): [string, string] => [name, value]));
  // An upstream that declared no media type is answered without one, rather than having one
  // invented for bytes nobody described.
  if (answer.contentType !== null) headers.set('content-type', answer.contentType);
  else headers.delete('content-type');
  return finalizeGatewayResponse(prologue.gateway, new Response(answer.body, { status, headers }));
};
