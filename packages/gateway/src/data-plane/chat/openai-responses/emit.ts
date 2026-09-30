import { wrapOpenAIResponsesClientEgress } from './client-output.ts';
import { internalErrorEnvelope } from './errors.ts';
import type { OpenAIResponsesStreamFraming, Fields } from './facts.ts';
import { recordStream, streamReferenceOf } from '../../../dump/run-sink.ts';
import { isFailure, renderFailure, mintedErrorEnvelope } from '../../pipeline/facts.ts';
import { isForwardableUpstreamHeader } from '../../shared/upstream-response.ts';
import type { ChatServices } from '../services.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import { doneFrame, sseFrame, eventFrame, type ProtocolFrame, type SseFrame } from '@floway-dev/protocols/common';
import { collectOpenAIResponsesProtocolEventsToResult, openaiResponsesProtocolFrameToSSEFrame, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesStreamEvent, type ClientOpenAIResponsesStreamEvent, type ClientResponseResource } from '@floway-dev/protocols/openai-responses';
import { toInternalDebugError } from '@floway-dev/provider';

/**
 * The outermost edge. What reaches it is usually a stream — the upstream speaks SSE whatever
 * the client asked for — so what this decides is whether the client sees the frames or the
 * one response object they add up to.
 *
 * Collecting is therefore the edge's own work and not a second reading of the upstream: the
 * same frames that would have gone out are folded here instead, by the protocol's own
 * reassembly, which is what makes a stream that stopped short of its terminal event say so
 * rather than answer with half a response.
 *
 * The stored-items membrane's other half runs here too, and it takes the client's own
 * payload rather than the record's, because by the fork the record holds the prepared one —
 * `previous_response_id` expanded away — and the resource echoes what the client asked with.
 *
 * A streamed answer is handed on in the framing the transport that opened the run writes.
 * Only the last step differs: `renderSSE` is a wire format written over an HTTP body, and a
 * transport that frames each event itself takes the events it would have been written from.
 */
export const emitOpenAIResponses = (client: CanonicalOpenAIResponsesPayload, framing: OpenAIResponsesStreamFraming) => defineStage<
  Fields<'ingress.chat.openaiResponses.wantsStream'>,
  Fields<'ingress.chat.openaiResponses.wantsStream'>,
  Fields<'ingress.chat.openaiResponses.wantsStream' | 'response.chat.openaiResponses' | 'response.http.headers'>,
  Fields<'response.chat.openaiResponses.rendered' | 'response.http.status' | 'response.http.headers' | 'response.chat.clientFrames'>,
  ChatServices
>({
  name: 'emitOpenAIResponses',
  through: {
    request: { needs: ['ingress.chat.openaiResponses.wantsStream'], consumes: [], provides: [] },
    response: {
      needs: ['response.chat.openaiResponses', 'response.http.headers'],
      consumes: ['response.chat.openaiResponses', 'response.http.headers'],
      provides: ['response.chat.clientFrames', 'response.chat.openaiResponses.rendered', 'response.http.status', 'response.http.headers'],
    },
  },
  execute: async (facts, next, use) => {
    const back = await next(facts);
    const { 'response.chat.openaiResponses': answer, 'response.http.headers': headers, ...rest } = back;
    // Vendor traces and quota state stay visible; what an intermediary must strip, and what
    // would misdescribe a body this gateway serialized itself, does not. A filter that removed
    // nothing hands the same array on, so the record shows no change where none happened.
    const forwardable = headers.filter(([name]) => isForwardableUpstreamHeader(name));
    const forClient = forwardable.length === headers.length ? headers : move(forwardable);

    if (isFailure(answer)) {
      const failure = renderFailure(answer, mintedErrorEnvelope);
      return {
        ...rest,
        'response.chat.clientFrames': null,
        'response.http.headers': forClient,
        'response.chat.openaiResponses.rendered': move(failure.body),
        'response.http.status': failure.status,
      };
    }
    // A turn the upstream answered with one body rather than a stream — the compaction
    // envelope — is already the object the client is owed, so there is nothing to fold.
    if (answer.kind === 'value') {
      return {
        ...rest,
        'response.chat.clientFrames': null,
        'response.http.headers': forClient,
        'response.chat.openaiResponses.rendered': move(answer.body as Record<string, unknown>),
        'response.http.status': 200,
      };
    }

    // Everything this protocol writes back into its own frames, in one place because every
    // layer of it rewrites them and below the fold there would be nothing left to rewrite:
    // the terminal restated from the items that actually closed, the turn's own state sealed
    // into the carrier a follow-up comes back on, each complete item stored under its exact
    // id beneath one response id this gateway minted, and the resource completed to what the
    // schema requires of it. It runs before the fold rather than beside it, so a client that
    // did not ask to stream is answered with the object the persisted frames add up to.
    const egress = wrapOpenAIResponsesClientEgress(
      answer.frames as AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>,
      use.gateway,
      client,
    );
    // The record is teed above all of that, which is what makes it a record of what the client
    // was served rather than of what some layer below had still to rewrite. One tee covers both
    // shapes this edge hands out itself, because both read the same iterable: the SSE body, and
    // the object the fold assembles from the frames that would have gone out.
    //
    // Both transports too. A WebSocket turn is the same frames rendered differently, so it is
    // recorded here rather than where it is framed — one tee for the family, whatever writes
    // what it hands up. Reading is what records, so a transport that stopped early records
    // exactly what it took.
    const frames = recordStream(egress, use.gateway.dump);
    if (!back['ingress.chat.openaiResponses.wantsStream']) {
      try {
        return {
          ...rest,
          'response.chat.clientFrames': move(frames),
          'response.http.headers': forClient,
          'response.chat.openaiResponses.rendered': move(
            await collectOpenAIResponsesProtocolEventsToResult(frames) as unknown as Record<string, unknown>,
          ),
          'response.http.status': 200,
        };
      } catch (error) {
        // Nothing has gone out yet, so the fault is still a status. A turn the gateway could
        // not finish — the snapshot the next turn would read, most often — is not one it can
        // answer, and the client is told what broke rather than handed the half that arrived.
        return {
          ...rest,
          'response.chat.clientFrames': move(frames),
          'response.http.headers': forClient,
          'response.chat.openaiResponses.rendered': move(internalErrorEnvelope(error)),
          'response.http.status': 502,
        };
      }
    }
    return {
      ...rest,
      'response.chat.clientFrames': move(frames),
      'response.http.headers': forClient,
      'response.chat.openaiResponses.rendered': move(framing === 'sse' ? renderSSE(frames) : frames),
      'response.http.status': 200,
    };
  },
});

/** The spec nests the `error` event's payload under `error`, and both official SDKs key
 *  their mid-stream throw on exactly that key; the same fields at the top level are yielded
 *  to them as an ordinary event instead.
 *  https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L170-L177
 *  https://github.com/openai/openai-node/blob/d77cf24d9f3885739c6cba76bc009abf0ab97428/src/core/streaming.ts#L69-L71
 *  https://github.com/openai/openai-python/blob/3844843c277f42b0b18beaa58152cfda61df524a/src/openai/_streaming.py#L87-L98 */
const streamErrorEvent = (error: unknown): ClientOpenAIResponsesStreamEvent => {
  const debug = toInternalDebugError(error);
  return {
    type: 'error',
    error: {
      message: debug.message,
      code: debug.type,
      name: debug.name,
      stack: debug.stack,
      cause: debug.cause,
      target_api: debug.target_api,
    },
  } as unknown as ClientOpenAIResponsesStreamEvent;
};

/** "Any error incurred while streaming will be followed by a `response.failed` event."
 *  https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L430 */
const streamFailedEvent = (announced: ClientResponseResource, error: unknown): ClientOpenAIResponsesStreamEvent => {
  const debug = toInternalDebugError(error);
  return {
    type: 'response.failed',
    response: { ...announced, status: 'failed', error: { code: debug.type, message: debug.message } },
  } as ClientOpenAIResponsesStreamEvent;
};

/** Every OpenAI Responses event has an SSE form of its own, so the render is a straight map. What
 *  it adds is the two endings a client already being streamed to can be given. The ordinary
 *  one is the terminator: the client's stream ends on the literal `[DONE]` payload whether or
 *  not the upstream's stream carried one, because that is what the transport reads to know
 *  the turn is over.
 *  https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx?plain=1#L84
 *
 *  The other is a break — an upstream that died mid-stream, a turn that could not be stored,
 *  a stream that ran out before saying how it ended. The status went out with the headers, so
 *  the failure has to be said in the protocol's own words, and it is said *instead of* the
 *  terminator: a stream that ended on `[DONE]` is a stream that finished. */
const renderSSE = (frames: AsyncIterable<ProtocolFrame<ClientOpenAIResponsesStreamEvent>>): AsyncIterable<SseFrame> => ({
  // The frames the client reads are a reframing of the ones the record holds, so this key
  // points at that same stream rather than at nothing.
  ...streamReferenceOf(frames),
  [Symbol.asyncIterator]: () => (async function* () {
    // The last resource the client was shown, which is the one a `response.failed` restates:
    // the id it names has to be the id the client already saw this turn under.
    let announced: ClientResponseResource | undefined;
    try {
      for await (const frame of frames) {
        // The upstream's own terminator is not the client's — the ending stops reading at the
        // turn's terminal event, and one terminator is written below however the frames ended.
        if (frame.type === 'done') continue;
        if ('response' in frame.event) announced = frame.event.response;
        yield openaiResponsesProtocolFrameToSSEFrame(frame);
      }
      yield openaiResponsesProtocolFrameToSSEFrame(doneFrame());
    } catch (error) {
      yield sseFrame(JSON.stringify(streamErrorEvent(error)), 'error');
      // Nothing was announced when the break came before the first resource-bearing event,
      // and there is no response to restate as failed.
      if (announced !== undefined) {
        yield openaiResponsesProtocolFrameToSSEFrame(eventFrame(streamFailedEvent(announced, error)));
      }
    }
  })(),
});
